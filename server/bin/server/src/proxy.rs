//! Wisp connection handler: handshake, auth, guard, adblock, and
//! task-per-stream multiplexing with CONTINUE-honoring flow control.
//! TCP and UDP streams are both supported; UDP datagrams carry the
//! Wisp address prefix ([len u8][host][port BE u16]) in each payload.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::HeaderMap;
use bytes::BytesMut;
use guard::{DestinationPolicy, Verdict};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{mpsc, Notify};
use wisp_core::packet::{CloseReason, Packet, StreamKind};
use wisp_core::{encode_packet, Frame, ServerHandshake};
use wisp_extensions::PasswordAuth;

const CHUNK: usize = 16 * 1024;
const MAX_UDP_REMOTE: usize = 32;

/// Shared server configuration for all connections.
pub struct ProxyState {
    pub policy: DestinationPolicy,
    pub motd: Option<String>,
    pub password_auth: Option<PasswordAuth>,
    /// Compiled adblock rule set; CONNECTs to matching hostnames are
    /// answered with CLOSE(0x48) without ever opening a socket.
    pub filters: adblock::FilterSet,
}

/// Minimal starter blocklist; deployments override/extend via
/// FILTER_LIST_PATH pointing at a full EasyList/uAssets download.
const STARTER_LIST: &str = "[Adblock Plus 2.0]\n||doubleclick.net^\n||googlesyndication.com^\n||google-analytics.com^\n||googletagmanager.com^\n||adnxs.com^\n||adservice.google.com^\n||scorecardresearch.com^\n||hotjar.com^\n||criteo.com^\n||taboola.com^\n||outbrain.com^\n||mixpanel.com^\n||branch.io^\n||amplitude.com^\n||segment.io^\n||quantserve.com^\n||adsystem.com^\n||advertising.com^\n||pubmatic.com^\n||rubiconproject.com^\n||moatads.com^\n||adsafeprotected.com^\n||chartbeat.com^\n||omtrdc.net^\n||demdex.net^\n||ads-twitter.com^\n||advertising.microsoft.com^\n";

impl ProxyState {
    pub fn new(password: Option<String>) -> Self {
        let password_auth = password.map(|pw| {
            let user = std::env::var("WISP_USERNAME").unwrap_or_else(|_| "user".into());
            PasswordAuth::new(true, vec![(user, pw)])
        });
        let mut list = STARTER_LIST.to_string();
        if let Ok(path) = std::env::var("FILTER_LIST_PATH") {
            if let Ok(extra) = std::fs::read_to_string(&path) {
                list.push_str(&extra);
            }
        }
        Self {
            policy: DestinationPolicy::default(),
            motd: std::env::var("WISP_MOTD").ok().or_else(|| {
                Some("LobsterBrowse: no traffic logging, private IPs blocked.".into())
            }),
            password_auth,
            filters: adblock::compile(&list),
        }
    }
}

/// Upstream events surfaced to the connection loop.
enum StreamEvent {
    Data(u32, Vec<u8>),
    Eof(u32),
    Errored(u32),
}

/// Per-stream flow-control budget (bytes of client buffer remaining).
struct Window {
    budget: Mutex<i32>,
    notify: Notify,
}

impl Window {
    fn new(bytes: u32) -> Arc<Self> {
        Arc::new(Self {
            budget: Mutex::new(bytes as i32),
            notify: Notify::new(),
        })
    }
    /// Wait until `need` bytes of window are available, then consume them.
    async fn acquire(self: &Arc<Self>, need: usize) {
        loop {
            // Register interest *before* checking, so a refill racing
            // with this loop cannot be lost.
            let notified = self.notify.notified();
            {
                let mut b = self.budget.lock().unwrap();
                if *b >= need as i32 {
                    *b -= need as i32;
                    return;
                }
            }
            notified.enable();
            notified.await;
        }
    }
    /// Client CONTINUE(buffer_remaining): refill and wake blocked readers.
    fn refill(&self, bytes: u32) {
        *self.budget.lock().unwrap() = bytes as i32;
        self.notify.notify_waiters();
    }
}

struct Stream {
    /// Sender of client payload into the upstream writer task.
    write_tx: mpsc::Sender<Vec<u8>>,
    window: Arc<Window>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
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
    let handshake = ServerHandshake::new(vec![]);

    for pkt in handshake.opening_packets(use_v2) {
        if send_packet(&mut socket, &pkt).await.is_err() {
            return;
        }
    }

    // v2: expect a client INFO; run password-auth (extension 0x02) if enabled.
    let mut authenticated = state.password_auth.is_none();
    if use_v2 {
        match socket.recv().await {
            Some(Ok(Message::Binary(data))) => {
                let mut buf = BytesMut::from(&data[..]);
                if let Ok(Some(frame)) = Frame::decode(&mut buf) {
                    if let Ok(Packet::Info { extensions, .. }) = frame.parse_packet() {
                        if let Some(auth) = &state.password_auth {
                            authenticated = extensions
                                .iter()
                                .find(|(id, _)| *id == 0x02)
                                .map(|(_, meta)| auth.verify_payload(meta))
                                .unwrap_or(false);
                        }
                    } else {
                        authenticated = false;
                    }
                    if !authenticated {
                        let _ = send_packet(
                            &mut socket,
                            &Packet::Close { stream_id: 0, reason: CloseReason::AuthRequired },
                        )
                        .await;
                        return;
                    }
                }
            }
            _ => return,
        }
    }

    let mut streams: HashMap<u32, Stream> = HashMap::new();
    let (events_tx, mut events_rx) = mpsc::channel::<StreamEvent>(64);

    loop {
        tokio::select! {
            ev = events_rx.recv() => {
                let Some(ev) = ev else { break };
                match ev {
                    StreamEvent::Data(sid, payload) => {
                        if streams.contains_key(&sid) {
                            let _ = send_packet(
                                &mut socket,
                                &Packet::Data { stream_id: sid, payload },
                            )
                            .await;
                        }
                    }
                    StreamEvent::Eof(sid) | StreamEvent::Errored(sid) => {
                        if streams.remove(&sid).is_some() {
                            let _ = send_packet(
                                &mut socket,
                                &Packet::Close { stream_id: sid, reason: CloseReason::NetworkError },
                            )
                            .await;
                        }
                    }
                }
            }
            msg = socket.recv() => {
                let Some(Ok(msg)) = msg else { break };
                let Ok(Message::Binary(data)) = msg else { continue };
                let mut buf = BytesMut::from(&data[..]);
                let Ok(Some(frame)) = Frame::decode(&mut buf) else { continue };
                let Ok(pkt) = frame.parse_packet() else { continue };

                match pkt {
                    Packet::Connect { stream_id, kind, port, hostname } => {
                        // Guard: rate limit, stream cap, flood detection.
                        {
                            let mut rl = limiter.lock().unwrap();
                            let now = std::time::Instant::now();
                            let denied = rl
                                .connect_attempt(conn_id, now)
                                .is_err()
                                || rl.can_open_stream(streams.len()).is_err();
                            if denied {
                                let _ = send_packet(
                                    &mut socket,
                                    &Packet::Close { stream_id, reason: CloseReason::Throttled },
                                )
                                .await;
                                continue;
                            }
                        }
                        // Guard: SSRF / private-range destination policy.
                        if state.policy.check_hostname(&hostname) == Verdict::Block {
                            let _ = send_packet(
                                &mut socket,
                                &Packet::Close { stream_id, reason: CloseReason::Blocked },
                            )
                            .await;
                            continue;
                        }
                        // Adblock: hostname network filtering at CONNECT time.
                        if state.filters.is_blocked_hostname(&hostname) {
                            let _ = send_packet(
                                &mut socket,
                                &Packet::Close { stream_id, reason: CloseReason::Blocked },
                            )
                            .await;
                            continue;
                        }
                        match kind {
                            StreamKind::Tcp => {
                                match TcpStream::connect((hostname.as_str(), port)).await {
                                    Ok(tcp) => {
                                        let _ = send_packet(
                                            &mut socket,
                                            &Packet::Continue {
                                                stream_id,
                                                buffer_remaining: wisp_core::handshake::INITIAL_BUFFER_SIZE,
                                            },
                                        )
                                        .await;
                                        spawn_tcp_stream(&mut streams, events_tx.clone(), stream_id, tcp);
                                    }
                                    Err(_) => {
                                        let _ = send_packet(
                                            &mut socket,
                                            &Packet::Close { stream_id, reason: CloseReason::UnreachableHost },
                                        )
                                        .await;
                                    }
                                }
                            }
                            StreamKind::Udp => {
                                // Resolve the CONNECT hostname once so client
                                // datagrams without a prefix still reach it.
                                let resolved = match tokio::net::lookup_host((hostname.as_str(), port)).await {
                                    Ok(mut it) => it.next(),
                                    Err(_) => None,
                                };
                                let Some(primary) = resolved else {
                                    let _ = send_packet(
                                        &mut socket,
                                        &Packet::Close { stream_id, reason: CloseReason::UnreachableHost },
                                    )
                                    .await;
                                    continue;
                                };
                                match UdpSocket::bind(("0.0.0.0", 0)).await {
                                    Ok(udp) => {
                                        let _ = send_packet(
                                            &mut socket,
                                            &Packet::Continue {
                                                stream_id,
                                                buffer_remaining: wisp_core::handshake::INITIAL_BUFFER_SIZE,
                                            },
                                        )
                                        .await;
                                        spawn_udp_stream(&mut streams, events_tx.clone(), stream_id, udp, primary);
                                    }
                                    Err(_) => {
                                        let _ = send_packet(
                                            &mut socket,
                                            &Packet::Close { stream_id, reason: CloseReason::UnreachableHost },
                                        )
                                        .await;
                                    }
                                }
                            }
                        }
                    }
                    Packet::Data { stream_id, payload } => {
                        if let Some(stream) = streams.get(&stream_id) {
                            if stream.write_tx.send(payload).await.is_err() {
                                remove_stream(&mut streams, &stream_id);
                            }
                        }
                    }
                    Packet::Close { stream_id, .. } => {
                        if stream_id == 0 {
                            break;
                        }
                        remove_stream(&mut streams, &stream_id);
                    }
                    Packet::Continue { stream_id, buffer_remaining } => {
                        if stream_id == 0 {
                            for s in streams.values() {
                                s.window.refill(buffer_remaining);
                            }
                        } else if let Some(s) = streams.get(&stream_id) {
                            s.window.refill(buffer_remaining);
                        }
                    }
                    Packet::Info { .. } => {} // only valid during handshake
                }
            }
        }
    }

    for s in streams.values() {
        for t in &s.tasks {
            t.abort();
        }
    }
    limiter.lock().unwrap().forget_connection(conn_id, None);
}

fn spawn_tcp_stream(
    streams: &mut HashMap<u32, Stream>,
    events: mpsc::Sender<StreamEvent>,
    stream_id: u32,
    tcp: TcpStream,
) {
    let (mut reader, mut writer) = tcp.into_split();
    let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(64);
    let window = Window::new(wisp_core::handshake::INITIAL_BUFFER_SIZE);

    // Socket writer: drains client payload into the upstream socket.
    let writer_task = tokio::spawn(async move {
        while let Some(chunk) = write_rx.recv().await {
            if writer.write_all(&chunk).await.is_err() {
                break;
            }
        }
    });

    // Socket reader: pushes upstream data toward the client, pausing
    // whenever the client buffer window (via CONTINUE) is exhausted.
    let win = window.clone();
    let reader_task = tokio::spawn(async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => {
                    let _ = events.send(StreamEvent::Eof(stream_id)).await;
                    break;
                }
                Ok(n) => {
                    let chunk = buf[..n].to_vec();
                    win.acquire(chunk.len()).await;
                    if events.send(StreamEvent::Data(stream_id, chunk)).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = events.send(StreamEvent::Errored(stream_id)).await;
                    break;
                }
            }
        }
    });

    streams.insert(
        stream_id,
        Stream { write_tx, window, tasks: vec![writer_task, reader_task] },
    );
}

fn spawn_udp_stream(
    streams: &mut HashMap<u32, Stream>,
    events: mpsc::Sender<StreamEvent>,
    stream_id: u32,
    udp: UdpSocket,
    primary: SocketAddr,
) {
    let socket = Arc::new(udp);
    let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(64);
    let window = Window::new(wisp_core::handshake::INITIAL_BUFFER_SIZE);

    // Datagrams from the client. Each payload usually begins with the
    // Wisp address prefix [len u8][hostname][port BE u16]; when absent
    // or malformed the CONNECT-time remote is used.
    let send_socket = socket.clone();
    let writer_task = tokio::spawn(async move {
        let mut remotes: HashMap<String, SocketAddr> = HashMap::new();
        let default_remote = primary;
        while let Some(payload) = write_rx.recv().await {
            let (remote, data) = match split_udp_prefix(&payload) {
                Some((host, port, tail)) => {
                    let key = format!("{host}:{port}");
                    let addr = if let Some(a) = remotes.get(&key) {
                        *a
                    } else {
                        match tokio::net::lookup_host((host.as_str(), port)).await {
                            Ok(mut it) => match it.next() {
                                Some(a) => {
                                    if remotes.len() >= MAX_UDP_REMOTE {
                                        remotes.clear();
                                    }
                                    remotes.insert(key, a);
                                    a
                                }
                                None => continue,
                            },
                            Err(_) => continue,
                        }
                    };
                    (addr, tail.to_vec())
                }
                None => (default_remote, payload),
            };
            let _ = send_socket.send_to(&data, remote).await;
        }
    });

    // Datagrams from upstream; prefixed with the sender address.
    let recv_socket = socket.clone();
    let win = window.clone();
    let reader_task = tokio::spawn(async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match recv_socket.recv_from(&mut buf).await {
                Ok((0, _)) => continue,
                Ok((n, peer)) => {
                    let mut frame = encode_udp_prefix(&peer);
                    frame.extend_from_slice(&buf[..n]);
                    win.acquire(frame.len()).await;
                    if events.send(StreamEvent::Data(stream_id, frame)).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = events.send(StreamEvent::Errored(stream_id)).await;
                    break;
                }
            }
        }
    });

    streams.insert(
        stream_id,
        Stream { write_tx, window, tasks: vec![writer_task, reader_task] },
    );
}

/// Split a Wisp UDP address prefix off the front of a client datagram.
/// Returns (hostname, port, payload tail) when a valid prefix exists.
fn split_udp_prefix(payload: &[u8]) -> Option<(String, u16, &[u8])> {
    if payload.is_empty() {
        return None;
    }
    let host_len = payload[0] as usize;
    if host_len == 0 || payload.len() < 1 + host_len + 2 {
        return None;
    }
    let host = std::str::from_utf8(&payload[1..1 + host_len]).ok()?;
    let port = u16::from_be_bytes([payload[1 + host_len], payload[2 + host_len]]);
    // Port 0 is never a valid remote; treat such frames as prefix-less.
    if port == 0 {
        return None;
    }
    Some((host.to_string(), port, &payload[3 + host_len..]))
}

/// Build the Wisp UDP address prefix for a datagram sent to the client.
fn encode_udp_prefix(peer: &SocketAddr) -> Vec<u8> {
    let host = match peer {
        SocketAddr::V4(a) => a.ip().to_string(),
        SocketAddr::V6(a) => a.ip().to_string(),
    };
    let mut out = Vec::with_capacity(1 + host.len() + 2);
    out.push(host.len() as u8);
    out.extend_from_slice(host.as_bytes());
    out.extend_from_slice(&peer.port().to_be_bytes());
    out
}

fn remove_stream(streams: &mut HashMap<u32, Stream>, stream_id: &u32) {
    if let Some(s) = streams.remove(stream_id) {
        for t in s.tasks {
            t.abort();
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn udp_prefix_roundtrip() {
        let mut frame = encode_udp_prefix(&"93.184.216.34:443".parse().unwrap());
        frame.extend_from_slice(b"hello");
        let (host, port, tail) = split_udp_prefix(&frame).unwrap();
        assert_eq!(host, "93.184.216.34");
        assert_eq!(port, 443);
        assert_eq!(tail, b"hello");
    }

    #[test]
    fn prefixless_datagram_is_raw() {
        // A raw DNS query has no prefix; must not be misparsed.
        assert!(split_udp_prefix(b"\x00\x01abc").is_none());
        assert!(split_udp_prefix(b"short").is_none());
        assert!(split_udp_prefix(&[]).is_none());
    }
}