//! LobsterBrowse Wisp server entrypoint.
//!
//! Routes HTTP traffic normally and upgrades /wisp/ (configurable path)
//! to the Wisp protocol: v2 INFO handshake when a Sec-WebSocket-Protocol
//! header is present, v1 fallback otherwise. All CONNECTs pass through
//! the guard layer (destination policy + rate limits) and the adblock
//! filter set before sockets open. The /p endpoint is a simple
//! server-side fetch proxy used by the UI for proxied search/browsing.

mod proxy;

use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

/// Server-side fetch proxy: GET /p?url=http(s) target.
///
/// Fetches the target with a spoofed browser user-agent and returns the
/// body from this origin. For HTML documents a base tag is injected so
/// relative links resolve against the original site.
async fn proxy_fetch(Query(params): Query<HashMap<String, String>>) -> Response {
    let Some(url) = params.get("url").cloned() else {
        return (StatusCode::BAD_REQUEST, "missing url parameter").into_response();
    };
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return (StatusCode::BAD_REQUEST, "url must be http(s)").into_response();
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap_or_default();

    match client.get(&url).send().await {
        Ok(resp) => {
            let ct = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("text/html; charset=utf-8")
                .to_string();
            let is_html = ct.contains("html");
            let bytes = resp.bytes().await.unwrap_or_default();

            let body: Vec<u8> = if is_html {
                let text = String::from_utf8_lossy(&bytes);
                let base = format!("<base href=\"{}\">", url);
                let lower = text.to_lowercase();
                let head_end = match lower.find("<head>") {
                    Some(i) => Some(i + "<head>".len()),
                    None => lower.find("<head ").and_then(|i| lower[i..].find('>').map(|j| i + j + 1)),
                };
                match head_end {
                    Some(pos) => {
                        let mut owned = text.into_owned();
                        owned.insert_str(pos, &base);
                        owned.into_bytes()
                    }
                    None => format!("{}{}", base, text).into_bytes(),
                }
            } else {
                bytes.to_vec()
            };

            ([(header::CONTENT_TYPE, ct)], body).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("proxy error: {}", e)).into_response(),
    }
}

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
        // Server-side fetch proxy used by the UI for proxied search/browsing.
        .route("/p", get(proxy_fetch))
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
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("LobsterBrowse wisp server listening on {} at {}", addr, wisp_path);
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind failed");
    axum::serve(listener, app).await.expect("server error");
}
