//! LobsterBrowse Wisp server entrypoint.
//!
//! Routes HTTP traffic normally and upgrades /wisp/ (configurable path)
//! to the Wisp protocol: v2 INFO handshake when a Sec-WebSocket-Protocol
//! header is present, v1 fallback otherwise. All CONNECTs pass through
//! the guard layer (destination policy + rate limits) and the adblock
//! filter set before sockets open.
//!
//! The /p endpoint is the document fetch proxy used by the in-app browser.
//! It keeps a shared cookie jar so session/PoW-gated sites work across
//! requests, applies an optional User-Agent override, optionally strips
//! known ad/tracker script hosts from HTML, injects a devtools hook into
//! proxied documents, and records every request in a ring buffer served
//! at /logs.

mod proxy;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

/// Devtools hook injected at the top of every proxied HTML document.
/// Captures console output, errors, fetch/XHR/WebSocket traffic and
/// link/form navigation, forwarding everything to the parent window
/// (the LobsterBrowse UI, same origin) via postMessage.
const HOOK: &str = r#"(function(){
  if (window.__lbHook) return; window.__lbHook = true;
  var send = function(type, data){ try { parent.postMessage({ lb: type, data: data }, "*"); } catch (e) {} };
  var fmt = function(a){ if (typeof a === "string") return a;
    try { return JSON.stringify(a, null, 1); } catch (e) { return String(a); } };
  ["log","info","warn","error","debug"].forEach(function(m){
    var orig = console[m] ? console[m].bind(console) : function(){};
    console[m] = function(){ var args = Array.prototype.map.call(arguments, fmt);
      send("console", { level: m, text: args.join(" "), ts: Date.now() });
      orig.apply(null, arguments); };
  });
  window.addEventListener("error", function(e){
    send("console", { level: "error",
      text: (e.message || "error") + (e.filename ? " @ " + e.filename + ":" + e.lineno + ":" + e.colno : ""),
      ts: Date.now() }); });
  window.addEventListener("unhandledrejection", function(e){
    var r = e.reason;
    send("console", { level: "error", text: "Unhandled rejection: " + ((r && r.message) ? r.message : String(r)), ts: Date.now() }); });
  var of = window.fetch;
  if (of) { window.fetch = function(input, init){
    var url = (typeof input === "string") ? input : ((input && input.url) || "");
    var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    var t0 = Date.now();
    return of.apply(this, arguments).then(function(resp){
      send("net", { url: String(url), method: method, status: resp.status, ok: resp.ok, dur: Date.now() - t0, ts: Date.now() });
      return resp; }, function(err){
      send("net", { url: String(url), method: method, status: 0, error: String(err), dur: Date.now() - t0, ts: Date.now() });
      throw err; }); }; }
  if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u){ this.__lb = { method: String(m).toUpperCase(), url: String(u), t0: Date.now() };
      this.addEventListener("loadend", function(){ var i = this.__lb;
        if (i) send("net", { url: i.url, method: i.method, status: this.status, dur: Date.now() - i.t0, ts: Date.now() }); });
      return ox.apply(this, arguments); }; }
  var OWS = window.WebSocket;
  if (OWS) { var WS = function(u, p){ send("net", { url: String(u), method: "WS", status: 101, ts: Date.now() });
      var ws = p !== undefined ? new OWS(u, p) : new OWS(u);
      ws.addEventListener("close", function(){ send("net", { url: String(u), method: "WS", status: 1006, ts: Date.now() }); });
      return ws; };
    WS.prototype = OWS.prototype; window.WebSocket = WS; }
  document.addEventListener("click", function(e){
    var t = e.target; while (t && t.nodeType === 1 && t.tagName !== "A") t = t.parentNode;
    if (!t || !t.getAttribute) return;
    var href = t.getAttribute("href");
    if (!href || href.indexOf("javascript:") === 0) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
    e.preventDefault();
    send("navigate", { href: href, newTab: t.getAttribute("target") === "_blank" });
  }, true);
  document.addEventListener("submit", function(e){
    var f = e.target; if (!f || !f.tagName || f.tagName !== "FORM") return;
    e.preventDefault();
    try { var fd = new FormData(f); var parts = [];
      fd.forEach(function(v, k){ if (typeof v === "string") parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v)); });
      send("submit", { action: f.getAttribute("action") || location.href,
        method: (f.getAttribute("method") || "get").toUpperCase(), body: parts.join("&") });
    } catch (err) { send("console", { level: "error", text: "form capture failed: " + String(err), ts: Date.now() }); }
  }, true);
  window.addEventListener("load", function(){ send("ready", { title: document.title }); });
})();"#;

/// Built-in network-filter rules applied when ad blocking is enabled.
/// Hostnames are matched with the adblock crate (same engine the Wisp
/// CONNECT path uses). An optional `ADBLOCK_EXTRA` file in the working
/// directory extends this list at startup.
const AD_HOSTS: &str = "\
! LobsterBrowse built-in ad hosts\n\
||doubleclick.net^\n\
||googlesyndication.com^\n\
||googleadservices.com^\n\
||adservice.google.com^\n\
||adnxs.com^\n\
||adsrvr.org^\n\
||criteo.com^\n\
||taboola.com^\n\
||outbrain.com^\n\
||rubiconproject.com^\n\
||pubmatic.com^\n\
||openx.net^\n\
||smartadserver.com^\n\
||teads.tv^\n\
";

/// Tracker hosts stripped when tracker blocking is enabled.
const TRACKER_HOSTS: &str = "\
! LobsterBrowse built-in tracker hosts\n\
||google-analytics.com^\n\
||googletagmanager.com^\n\
||analytics.google.com^\n\
||scorecardresearch.com^\n\
||quantserve.com^\n\
||hotjar.com^\n\
||mouseflow.com^\n\
||fullstory.com^\n\
||clarity.ms^\n\
||segment.io^\n\
||mixpanel.com^\n\
||amplitude.com^\n\
";

struct AppState {
    client: reqwest::Client,
    /// Ring buffer of recent log lines (JSON objects), newest last.
    logs: Mutex<VecDeque<String>>,
    ads: adblock::FilterSet,
    trackers: adblock::FilterSet,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "")
}

fn push_log(state: &AppState, level: &str, msg: &str) {
    let line = format!(
        "{{\"ts\":{},\"level\":\"{}\",\"msg\":\"{}\"}}",
        now_secs(),
        json_escape(level),
        json_escape(msg)
    );
    let mut logs = state.logs.lock().unwrap_or_else(|e| e.into_inner());
    if logs.len() >= 1000 {
        logs.pop_front();
    }
    logs.push_back(line);
}

/// Hostname of an absolute URL ("" when not absolute).
fn host_of(url: &str) -> String {
    let s = url.trim();
    let Some(i) = s.find("://") else {
        return String::new();
    };
    let rest = &s[i + 3..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    rest[..end].to_string()
}

/// Strip <script> / <iframe> tags whose src host is blocked.
/// Naive scanner: adequate for ad/tracker delivery tags which are
/// simple, single-line includes.
fn strip_blocked(html: &str, filters: &[&adblock::FilterSet]) -> String {
    if filters.is_empty() {
        return html.to_string();
    }
    let lower = html.to_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut copy_from = 0usize;
    let mut i = 0usize;
    while i < lower.len() {
        let Some(rel) = lower[i..].find('<') else {
            break;
        };
        i += rel;
        let rest = &lower[i..];
        let is_script = rest.starts_with("<script");
        let is_iframe = rest.starts_with("<iframe");
        if !is_script && !is_iframe {
            i += 1;
            continue;
        }
        let Some(g) = rest.find('>') else {
            break;
        };
        let tag = &html[i..i + g + 1];
        let host = extract_src_host(tag).unwrap_or_default();
        let blocked = !host.is_empty() && filters.iter().any(|f| f.is_blocked_hostname(&host));
        if blocked {
            out.push_str(&html[copy_from..i]);
            if is_script {
                // Drop through the matching </script> so no stray text remains.
                let skip = match lower[i + g..].find("</script") {
                    Some(c) => {
                        let cs = i + g + c;
                        cs + lower[cs..].find('>').map(|x| x + 1).unwrap_or(9)
                    }
                    None => i + g + 1,
                };
                i = skip;
                copy_from = skip;
            } else {
                i = i + g + 1;
                copy_from = i;
            }
        } else {
            i = i + g + 1;
        }
    }
    out.push_str(&html[copy_from.min(html.len())..]);
    out
}

/// Extract the hostname from a src="..." attribute inside a tag.
fn extract_src_host(tag: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let idx = lower.find("src=")?;
    let rest = &tag[idx + 4..];
    let quote = rest.chars().next()?;
    let value_end = match quote {
        '"' | '\'' => rest[1..].find(quote).map(|e| e + 1)?,
        _ => rest.find([' ', '>']).unwrap_or(rest.len()),
    };
    let value = if quote == '"' || quote == '\'' {
        &rest[1..value_end]
    } else {
        &rest[..value_end]
    };
    let host = host_of(value);
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Remove <meta http-equiv="content-security-policy"> tags; the page CSP
/// would block the injected devtools hook and break same-origin framing.
fn strip_csp_meta(html: &str) -> String {
    let lower = html.to_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut i = 0usize;
    let mut search = 0usize;
    while let Some(rel) = lower[search..].find("<meta") {
        let start = search + rel;
        let Some(tag_end_rel) = lower[start..].find('>') else {
            break;
        };
        let tag_end = start + tag_end_rel;
        let tag = &lower[start..tag_end];
        if tag.contains("content-security-policy") || tag.contains("x-frame-options") {
            out.push_str(&html[i..start]);
            i = tag_end + 1;
        }
        search = tag_end;
    }
    out.push_str(&html[i.min(html.len())..]);
    out
}

/// Inject base tag + devtools hook right after <head> (or at document start).
fn inject_head(html: String, url: &str) -> String {
    let base = format!("<base href=\"{}\">", json_escape(url));
    let head = format!("<script>{}</script>", HOOK);
    let lower = html.to_lowercase();
    let head_end = match lower.find("<head>") {
        Some(i) => Some(i + "<head>".len()),
        None => lower
            .find("<head ")
            .and_then(|i| lower[i..].find('>').map(|j| i + j + 1)),
    };
    match head_end {
        Some(pos) => {
            let mut owned = html;
            owned.insert_str(pos, &head);
            owned.insert_str(pos, &base);
            owned
        }
        None => format!("{}{}{}", base, head, html),
    }
}

fn proxy_error(status: StatusCode, url: &str, detail: &str, state: &AppState) -> Response {
    push_log(state, "error", &format!("fetch failed for {url}: {detail}"));
    let body = format!(
        "{{\"error\":\"proxy_fetch_failed\",\"engine\":\"document-fetch\",\"url\":\"{}\",\"detail\":\"{}\",\"ts\":{}}}",
        json_escape(url),
        json_escape(detail),
        now_secs()
    );
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response()
}

/// Server-side document fetch proxy: GET/POST /p?url=<http(s) target>.
///
/// Query params:
/// - url (required): absolute http(s) target
/// - ua (optional): User-Agent override, max 512 printable chars
/// - ab (optional): "1" strips known ad script/iframe tags from HTML
/// - trk (optional): "1" strips known tracker script tags from HTML
/// - https (optional): "1" rejects plain-http targets
///
/// The shared client keeps a cookie jar, so sites that set session or
/// challenge cookies keep working across navigations.
async fn proxy_fetch(
    State(state): State<Arc<AppState>>,
    method: Method,
    Query(params): Query<HashMap<String, String>>,
    body: Option<Bytes>,
) -> Response {
    let started = Instant::now();
    let Some(url) = params.get("url").cloned() else {
        return (StatusCode::BAD_REQUEST, "missing url parameter").into_response();
    };
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return (StatusCode::BAD_REQUEST, "url must be http(s)").into_response();
    }
    if params.get("https").map(|v| v == "1").unwrap_or(false) && url.starts_with("http://") {
        return proxy_error(StatusCode::BAD_REQUEST, &url, "HTTPS-only mode: plain-http target rejected", &state);
    }

    let is_post = method == Method::POST;
    push_log(
        &state,
        "info",
        &format!("proxy {} {}{}", method, url, if is_post { " (body)" } else { "" }),
    );

    let mut req = state.client.request(method.clone(), &url);
    if let Some(ua) = params.get("ua") {
        let cleaned: String = ua
            .chars()
            .filter(|c| c.is_ascii_graphic() || *c == ' ')
            .take(512)
            .collect();
        if !cleaned.is_empty() {
            req = req.header(reqwest::header::USER_AGENT, cleaned);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            let ct = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("text/html; charset=utf-8")
                .to_string();
            let is_html = ct.contains("html");
            let bytes = resp.bytes().await.unwrap_or_default();

            let body: Vec<u8> = if is_html {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                let mut filters: Vec<&adblock::FilterSet> = Vec::new();
                if params.get("ab").map(|v| v == "1").unwrap_or(false) {
                    filters.push(&state.ads);
                }
                if params.get("trk").map(|v| v == "1").unwrap_or(false) {
                    filters.push(&state.trackers);
                }
                let stripped = if filters.is_empty() {
                    text
                } else {
                    strip_blocked(&text, &filters)
                };
                inject_head(strip_csp_meta(stripped), &url).into_bytes()
            } else {
                bytes.to_vec()
            };

            push_log(
                &state,
                "info",
                &format!("proxy done {} {} -> {} ({} ms)", method, url, status, started.elapsed().as_millis()),
            );
            let axum_status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (axum_status, [(header::CONTENT_TYPE, ct)], body).into_response()
        }
        Err(e) => proxy_error(StatusCode::BAD_GATEWAY, &url, &e.to_string(), &state),
    }
}

/// Recent server-side proxy log entries, newest last. JSON array.
async fn logs_endpoint(State(state): State<Arc<AppState>>) -> Response {
    let logs = state.logs.lock().unwrap_or_else(|e| e.into_inner());
    let body = format!("[{}]", logs.iter().cloned().collect::<Vec<String>>().join(","));
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

fn load_filters(extra_path: &str, builtin: &str) -> adblock::FilterSet {
    let mut text = builtin.to_string();
    if let Ok(extra) = std::fs::read_to_string(extra_path) {
        text.push('\n');
        text.push_str(&extra);
    }
    adblock::compile(&text)
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

    // Shared fetch client: cookie jar enabled so session/challenge-gated
    // sites work across /p navigations.
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(25))
        .cookie_store(true)
        .build()
        .expect("reqwest client");

    let state = Arc::new(AppState {
        client,
        logs: Mutex::new(VecDeque::new()),
        ads: load_filters("adblock-extra.txt", AD_HOSTS),
        trackers: load_filters("tracker-extra.txt", TRACKER_HOSTS),
    });
    push_log(&state, "info", "proxy log buffer initialised");

    let wisp_state = Arc::new(proxy::ProxyState::new(auth_password));
    let limiter = Arc::new(Mutex::new(guard::RateLimiter::default()));

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        // Document fetch proxy used by the in-app browser.
        .route("/p", get(proxy_fetch).post(proxy_fetch))
        // Server-side proxy log ring buffer.
        .route("/logs", get(logs_endpoint))
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
                let state = wisp_state.clone();
                let limiter = limiter.clone();
                move |ws, headers| proxy::handle_upgrade(ws, headers, state, limiter)
            }),
        )
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("LobsterBrowse wisp server listening on {} at {}", addr, wisp_path);
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind failed");
    axum::serve(listener, app).await.expect("server error");
}
