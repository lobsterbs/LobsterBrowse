//! Wisp connection handler: handshake, guard checks, stream multiplexing.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::HeaderMap;
use bytes::BytesMut;
use futures_util::{SinkExt, StreamExt};
use guard::{DestinationPolicy, Verdict};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use wisp_core::packet::{CloseReason, Packet, PacketType, StreamKind};
use wisp_core::{encode_packet, Frame, ServerHandshake};

/// Shared server configuration for all connections.
pub struct ProxyState {
    pub policy: DestinationPolicy,
    pub motd: Option<String>,
    pub password_required: Option<String>,
}

impl ProxyState {
    pub fn new(password: Option<String>) -> Self {
        Self {
            policy: DestinationPolicy::default(),
            motd: std::env::var("WISP_MOTD").ok().or_else(|| {
                Some("LobsterBrowse: no traffic logging, private IPs blocked.".into())
            }),
            password_required: password,
        }
    }
}

/// Active TCP stream bookkeeping for one connection.
struct StreamEntry {
    _kind: StreamKind,
    socket: Option<TcpStream>,
    /// Bytes received from the client, not yet flushed to the socket.
    pending: Vec<u8>,
}

pub async fn handle_upgrade(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    state: Arc<ProxyState>,
    limiter: Arc<Mutex<guard::RateLimiter>>,
) -> axum::response::Response {
    // Per the spec: v2 only when a Sec-WebSocket-Protocol header is present.
    let use_v2 = headers.contains_key("sec-websocket-protocol");
    ws.on_upgrade(move |socket| handle_connection(socket, use_v2, state, limiter))
}

async fn handle_connection(
    mut socket: WebSocket,
    use_v2: bool,
    state: Arc<ProxyState>,
    limiter: Arc<Mutex<guard::RateLimiter>>,
) {
    let conn_id: u64 = rand_conn_id();
    let mut handshake = ServerHandshake::new(vec![]);

    // Send opening packets (INFO for v2, CONTINUE for v1).
    for pkt in handshake.opening_packets(use_v2) {
        if send_packet(&mut socket, &pkt).await.is_err() {
            return;
        }
    }

    // Handshake phase (v2 expects a client INFO; v1 starts streaming).
    let mut authenticated = state.password_required.is_none();
    if use_v2 {
        match socket.recv().await {
            Some(Ok(Message::Binary(data))) => {
                let mut buf = BytesMut::from(&data[..]);
                if let Ok(Some(frame)) = Frame::decode(&mut buf) {
                    if let Ok(Packet::Info { extensions, .. }) = frame.parse_packet() {
                        if let Some(pw) = &state.password_required {
                            // Look for the password-auth extension payload from the client.
                            if let Some((_, meta)) = extensions.iter().find(|(id, _)| *id == 0x02) {
                                let mut h = sha2_placeholder();
                                let _ = &mut h;
                                // simple constant comparison
                                authenticated = constant_time_eq(meta, pw.as_bytes());
                            }
                        }
                    }
                    if !authenticated {
                        let _ = send_packet(&mut socket, &Packet::Close {
                            stream_id: 0,
                            reason: CloseReason::AuthRequired,
                        }).await;
                        return;
                    }
                }
            }
            _ => return,
        }
    }

    // Stream loop.
    let mut streams: HashMap<u32, StreamEntry> = HashMap::new();
    let mut rx_bufs: HashMap<u32, tokio::sync::mpsc::Receiver<Vec<u8>>> = HashMap::new();
    let _ = &mut rx_bufs; // populated below per stream

    while let Some(msg) = socket.recv().await {
        let Ok(Message::Binary(data)) = msg else { continue };
        let mut buf = BytesMut::from(&data[..]);
        let Ok(Some(frame)) = Frame::decode(&mut buf) else { continue };
        let Ok(pkt) = frame.parse_packet() else { continue };

        match pkt {
            Packet::Connect { stream_id, kind, port, hostname } => {
                // Rate limit + flood detection.
                {
                    let mut rl = limiter.lock().unwrap();
                    if rl.connect_attempt(conn_id, std::time::Instant::now()).is_err() {
                        let _ = send_packet(&mut socket, &Packet::Close {
                            stream_id,
                            reason: CloseReason::Throttled,
                        }).await;
                        continue;
                    }
                    if rl.can_open_stream(streams.len()).is_err() {
                        let _ = send_packet(&mut socket, &Packet::Close {
                            stream_id,
                            reason: CloseReason::Throttled,
                        }).await;
                        continue;
                    }
                }
                // Destination policy: block private/loopback/metadata targets.
                if state.policy.check_hostname(&hostname) == Verdict::Block {
                    let _ = send_packet(&mut socket, &Packet::Close {
                        stream_id,
                        reason: CloseReason::Blocked,
                    }).await;
                    continue;
                }
                match kind {
                    StreamKind::Tcp => {
                        match TcpStream::connect((hostname.as_str(), port)).await {
                            Ok(tcp) => {
                                let _ = send_packet(&mut socket, &Packet::Continue {
                                    stream_id,
                                    buffer_remaining: wisp_core::handshake::INITIAL_BUFFER_SIZE,
                                }).await;
                                streams.insert(stream_id, StreamEntry {
                                    _kind: kind,
                                    socket: Some(tcp),
                                    pending: Vec::new(),
                                });
                            }
                            Err(_) => {
                                let _ = send_packet(&mut socket, &Packet::Close {
                                    stream_id,
                                    reason: CloseReason::UnreachableHost,
                                }).await;
                            }
                        }
                    }
                    StreamKind::Udp => {
                        // UDP relay is a roadmap item; refuse cleanly for now.
                        let _ = send_packet(&mut socket, &Packet::Close {
                            stream_id,
                            reason: CloseReason::Blocked,
                        }).await;
                    }
                }
            }
            Packet::Data { stream_id, payload } => {
                if let Some(entry) = streams.get_mut(&stream_id) {
                    if let Some(sock) = entry.socket.as_mut() {
                        if sock.write_all(&payload).await.is_err() {
                            let _ = send_packet(&mut socket, &Packet::Close {
                                stream_id,
                                reason: CloseReason::NetworkError,
                            }).await;
                            streams.remove(&stream_id);
                        }
                    }
                }
            }
            Packet::Close { stream_id, .. } => {
                if stream_id == 0 {
                    break;
                }
                streams.remove(&stream_id);
            }
            Packet::Continue { .. } => {} // client grants us buffer; ignored in this simple relay
            Packet::Info { .. } => {} // only valid during handshake
        }

        // Drain readable sockets back to the client (single-frame-at-a-time relay).
        let to_close = {
            let mut closed = Vec::new();
            for (sid, entry) in streams.iter_mut() {
                if let Some(sock) = entry.socket.as_mut() {
                    let mut chunk = [0u8; 16 * 1024];
                    match sock.try_read(&mut chunk) {
                        Ok(0) => closed.push(*sid),
                        Ok(n) => {
                            let _ = send_packet(&mut socket, &Packet::Data {
                                stream_id: *sid,
                                payload: chunk[..n].to_vec(),
                            }).await;
                            let _ = send_packet(&mut socket, &Packet::Continue {
                                stream_id: 0,
                                buffer_remaining: wisp_core::handshake::INITIAL_BUFFER_SIZE,
                            }).await;
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(_) => closed.push(*sid),
                    }
                }
            }
            closed
        };
        for sid in to_close {
            let _ = send_packet(&mut socket, &Packet::Close {
                stream_id: sid,
                reason: CloseReason::Voluntary,
            }).await;
            streams.remove(&sid);
        }
    }

    limiter.lock().unwrap().forget_connection(conn_id, None);
}

async fn send_packet(socket: &mut WebSocket, pkt: &Packet) -> Result<(), ()> {
    let frame = encode_packet(pkt);
    let mut buf = BytesMut::new();
    frame.encode_into(&mut buf);
    socket.send(Message::Binary(buf.to_vec())).await.map_err(|_| ())
}

fn rand_conn_id() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ (std::process::id() as u64) << 32
}

fn sha2_placeholder() -> u8 { 0 }

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}
