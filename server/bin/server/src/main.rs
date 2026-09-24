//! LobsterBrowse Wisp server entrypoint.
//!
//! Routes HTTP traffic normally and upgrades /wisp/ (configurable path)
//! to the Wisp protocol: v2 INFO handshake when a Sec-WebSocket-Protocol
//! header is present, v1 fallback otherwise. All CONNECTs pass through
//! the guard layer (destination policy + rate limits) and the adblock
//! filter set before sockets open.

mod proxy;

use axum::{routing::get, Router};
use tower_http::services::{ServeDir, ServeFile};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use tracing::info;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lobster_server=info,tower_http=info".into()),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(6001);
    // Endpoint path is configurable so deployments are not trivially discoverable
    // at the default /wisp/ location.
    let wisp_path = std::env::var("WISP_PATH").unwrap_or_else(|_| "/wisp/".into());
    let auth_password = std::env::var("WISP_PASSWORD").ok();

    let state = Arc::new(proxy::ProxyState::new(auth_password));
    let limiter = Arc::new(Mutex::new(guard::RateLimiter::default()));

    let app = Router::new()
        .route(
            "/healthz",
            get(|| async { "ok" }),
        )
        // Single-site: serve the built UI (ui/dist) from this same origin.
        // Unknown paths fall back to index.html so the SPA always loads.
        .fallback_service(
            ServeDir::new("ui")
                .append_index_html_on_directories(true)
                .not_found_service(ServeFile::new("ui/index.html")),
        )
        .route(
            &wisp_path,
            get({
                let state = state.clone();
                let limiter = limiter.clone();
                move |ws, headers| proxy::handle_upgrade(ws, headers, state, limiter)
            }),
        )
        // The static UI reads /healthz from the browser to show server status.
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("LobsterBrowse wisp server listening on {addr} at {wisp_path}");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind failed");
    axum::serve(listener, app).await.expect("server error");
}