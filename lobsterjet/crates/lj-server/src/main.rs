//! LobsterJet standalone server.
//!
//! Two jobs:
//! 1. Static-host the built engine app (SW, bootstrap, rewriter wasm).
//! 2. Upgrade `GET /wisp/` to the Wisp v2.1 protocol and relay TCP.
//!
//! The wisp protocol itself comes from LobsterBrowse's `wisp-core`
//! crate: framing, packets and the server handshake state machine are
//! reused, not reimplemented. This binary only owns the sockets.

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::IntoResponse,
    routing::get,
    Router,
};
use bytes::BytesMut;
use futures::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use wisp_core::{encode_packet, CloseReason, Frame, Packet, ServerHandshake, StreamKind};

/// Sender into the single WebSocket (shared by the session loop and all
/// per-stream relay tasks).
type WsTx = mpsc::Sender<Message>;

/// One open wisp stream: input channel (wisp DATA -> socket) plus an
/// open flag. Dropping the input sender closes the writer side.
struct StreamEntry {
    input: mpsc::Sender<Vec<u8>>,
    open: bool,
}

struct ConnState {
    ws_tx: WsTx,
    streams: HashMap<u32, StreamEntry>,
}

impl ConnState {
    fn close_stream(&mut self, stream_id: u32) -> bool {
        match self.streams.get_mut(&stream_id) {
            Some(e) if e.open => {
                e.open = false;
                true
            }
            _ => false,
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lj_server=info".into()),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(6002);
    let static_dir = std::env::var("LJ_STATIC").unwrap_or_else(|_| "app/dist".into());

    let app = Router::new()
        .route("/wisp/", get(wisp_handler))
        .fallback_service(
            tower_http::services::ServeDir::new(&static_dir)
                .append_index_html_on_directories(true),
        )
        .with_state(Arc::new(()));

    let addr = format!("0.0.0.0:{}", port);
    tracing::info!("lj-server listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}

async fn wisp_handler(ws: WebSocketUpgrade, State(_s): State<Arc<()>>) -> impl IntoResponse {
    // v2 clients send the wisp subprotocol header; absence means v1.
    let v2 = ws.protocols().iter().any(|p| p.eq_ignore_ascii_case("wisp"));
    ws.protocols(["wisp"]).on_upgrade(move |socket| wisp_session(socket, v2))
}

async fn wisp_session(socket: WebSocket, v2: bool) {
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (ws_tx, mut ws_rx) = mpsc::channel::<Message>(64);

    // Pump relay output into the WebSocket.
    tokio::spawn(async move {
        while let Some(msg) = ws_rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut handshake = ServerHandshake::new(Vec::new());
    let mut state = ConnState { ws_tx: ws_tx.clone(), streams: HashMap::new() };

    for pkt in handshake.opening_packets(v2) {
        if send_packet(&ws_tx, &pkt).await.is_err() {
            return;
        }
    }

    while let Some(msg) = ws_stream.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        let data = match msg {
            Message::Binary(b) => b,
            Message::Close(_) => break,
            _ => continue, // ignore text/ping/pong
        };
        let mut buf = BytesMut::from(&data[..]);
        let frame = match Frame::decode(&mut buf) {
            Ok(Some(f)) => f,
            _ => break, // invalid frame: drop the connection
        };
        let pkt = match frame.parse_packet() {
            Ok(p) => p,
            Err(_) => {
                let _ = send_packet(
                    &ws_tx,
                    &wisp_core::handshake_reject(CloseReason::InvalidInfo),
                )
                .await;
                break;
            }
        };

        match pkt.clone() {
            // Handshake traffic (stream 0).
            Packet::Info { stream_id: 0, .. } | Packet::Continue { stream_id: 0, .. } => {
                match handshake.handle(&pkt) {
                    Ok(Some(reply)) => {
                        if send_packet(&ws_tx, &reply).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => {}
                    Err(reason) => {
                        let _ = send_packet(&ws_tx, &wisp_core::handshake_reject(reason)).await;
                        break;
                    }
                }
            }
            Packet::Connect { stream_id, kind, port, hostname } => {
                if state.streams.contains_key(&stream_id) {
                    continue; // duplicate CONNECT: ignore
                }
                match kind {
                    StreamKind::Tcp => spawn_tcp_relay(&mut state, stream_id, port, hostname),
                    StreamKind::Udp => {
                        // Phase 2: UDP relay (DNS is the main consumer).
                        let _ = send_packet(
                            &ws_tx,
                            &Packet::Close { stream_id, reason: CloseReason::Unspecified },
                        )
                        .await;
                    }
                }
            }
            Packet::Data { stream_id, payload } => {
                if let Some(entry) = state.streams.get(&stream_id) {
                    if entry.open {
                        // Send errors mean the relay task is gone: the
                        // writer side will notice and clean up.
                        let _ = entry.input.send(payload).await;
                    }
                }
            }
            Packet::Close { stream_id, .. } => {
                if stream_id == 0 {
                    break; // whole connection
                }
                if state.close_stream(stream_id) {
                    let _ = send_packet(
                        &ws_tx,
                        &Packet::Close { stream_id, reason: CloseReason::Voluntary },
                    )
                    .await;
                }
            }
            // Client-side window updates on live streams: not needed by
            // our simplified server flow (we always grant after sending).
            Packet::Continue { .. } | Packet::Info { .. } => {}
        }
    }

    // Teardown: dropping the map drops every input sender, which ends
    // each relay task's writer half; the tasks close their sockets.
    state.streams.clear();
}

fn spawn_tcp_relay(state: &mut ConnState, stream_id: u32, port: u16, hostname: String) {
    let ws_tx = state.ws_tx.clone();
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(64);
    state.streams.insert(stream_id, StreamEntry { input: input_tx, open: true });

    tokio::spawn(async move {
        let addr = format!("{}:{}", hostname, port);
        let sock = match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            TcpStream::connect(&addr),
        )
        .await
        {
            Ok(Ok(s)) => s,
            _ => {
                let _ = send_packet(
                    &ws_tx,
                    &Packet::Close { stream_id, reason: CloseReason::UnreachableHost },
                )
                .await;
                return;
            }
        };
        let (mut sock_read, mut sock_write) = sock.into_split();

        // Writer: wisp DATA payloads -> socket. Ends when the session
        // drops our input sender (close/teardown).
        let writer = tokio::spawn(async move {
            let mut input_rx = input_rx;
            while let Some(bytes) = input_rx.recv().await {
                if sock_write.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });

        // Reader: socket -> wisp DATA, grant window after each chunk.
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match sock_read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = Packet::Data { stream_id, payload: buf[..n].to_vec() };
                    if send_packet(&ws_tx, &data).await.is_err() {
                        break;
                    }
                    let cont = Packet::Continue { stream_id, buffer_remaining: 128 };
                    if send_packet(&ws_tx, &cont).await.is_err() {
                        break;
                    }
                }
            }
        }

        let _ = send_packet(
            &ws_tx,
            &Packet::Close { stream_id, reason: CloseReason::Voluntary },
        )
        .await;
        writer.abort(); // writer ends with us
    });
}

async fn send_packet(tx: &WsTx, pkt: &Packet) -> Result<(), mpsc::error::SendError<Message>> {
    let frame = encode_packet(pkt);
    let mut out = BytesMut::with_capacity(5 + frame.payload.len());
    frame.encode_into(&mut out);
    tx.send(Message::Binary(out.to_vec())).await
}
