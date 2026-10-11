//! Celadon Zeolite engine + wisp server entrypoint.
//!
//! Routes HTTP traffic normally and upgrades /wisp/ (configurable path)
//! to the Wisp protocol. Zeolite is the only proxy engine: its service
//! worker owns /zl/<base64url target> (client-side interception, native
//! wisp transport, in-worker rewriting). The server never rewrites
//! pages; the legacy /r/ and /lj/ prefixes answer the honest
//! gone-notice (stale bookmarks break by design). Also serves the
//! Zeolite worker bundle
//! (/zlsw/), the osjson suggest proxy, per-session /logs diagnostics
//! and certificate transparency lookups (/cert).

use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::Router;
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

struct AppState {
    /// Shared client for /suggest and /cert upstream lookups (SSRF-safe
    /// DNS, no cookie jar). Proxied traffic never touches this server:
    /// the Zeolite worker owns it.
    client: reqwest::Client,
    /// Zeolite #137 embedder relay client: native TLS, the same
    /// resolve-then-validate SSRF resolver, no cookie store (the
    /// engine's jar owns cookies; they ride as headers).
    relay_client: reqwest::Client,
    /// Ring buffer of recent log lines (JSON objects), newest last.
    /// Untagged (server-level) lines only; session-tagged lines live in
    /// `sessions` so /logs can never mix diagnostics across sessions.
    logs: Mutex<VecDeque<String>>,
    /// Per-session log rings keyed by the tab's lb_sess token. /logs
    /// requires the caller's token and returns only that ring, so one
    /// browser session can never read another's diagnostics.
    sessions: Mutex<HashMap<String, SessionRing>>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "")
}

/// Central sanitizer for the /logs ring: proxied URLs and page-derived
/// diagnostics routinely carry session tokens, API keys and JWTs, and
/// the log ring is readable by anyone who can reach the deployment.
/// Every push_log message passes through here, so no call site has to
/// remember to redact. Mirrors ui/src/sanitize.ts — keep the patterns
/// in sync. Deliberately conservative: over-redaction destroys the
/// diagnostic value of the log.
fn redact_secrets(s: &str) -> String {
    const SECRET_KEYS: &[&str] = &[
        "token",
        "access_token",
        "refresh_token",
        "api_key",
        "apikey",
        "password",
        "passwd",
        "pwd",
        "secret",
        "authorization",
        "session",
        "sessionid",
        "session_id",
        "sid",
        "client_secret",
    ];
    let is_val_char =
        |c: char| !c.is_whitespace() && c != '&' && c != '"' && c != '\'' && c != '<' && c != '>';
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        // Secret-bearing query parameters: "?key=value" / "&key=value".
        if (c == '?' || c == '&') && i + 1 < chars.len() {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            let key_raw: String = chars[i + 1..j].iter().collect();
            let key = key_raw.to_ascii_lowercase();
            if chars.get(j) == Some(&'=') && SECRET_KEYS.contains(&key.as_str()) {
                let mut v = j + 1;
                while v < chars.len() && is_val_char(chars[v]) {
                    v += 1;
                }
                out.push(c);
                out.push_str(&key_raw);
                out.push_str("=[redacted]");
                i = v;
                continue;
            }
        }
        // JWT-shaped base64url runs: eyJxxx.yyy.zzz (exactly two dots).
        if c == 'e' && chars.len() >= i + 20 && chars[i..].starts_with(&['e', 'y', 'J']) {
            let mut end = i;
            while end < chars.len()
                && (chars[end].is_ascii_alphanumeric()
                    || chars[end] == '_'
                    || chars[end] == '-'
                    || chars[end] == '.')
            {
                end += 1;
            }
            let run: String = chars[i..end].iter().collect();
            let parts: Vec<&str> = run.split('.').collect();
            if parts.len() == 3 && parts.iter().all(|p| !p.is_empty()) && run.len() >= 20 {
                out.push_str("[redacted-jwt]");
                i = end;
                continue;
            }
        }
        // Labeled credentials in free text: "Bearer x", "apikey: x".
        let lower_ctx: String = chars[i..(i + 12).min(chars.len())]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        let mut matched = 0usize;
        for pat in [
            "bearer ",
            "basic ",
            "apikey:",
            "api_key:",
            "api-key:",
            "password:",
            "secret:",
        ] {
            if lower_ctx.starts_with(pat) {
                matched = pat.chars().count();
                break;
            }
        }
        if matched > 0 {
            out.push_str(&chars[i..i + matched].iter().collect::<String>());
            let mut v = i + matched;
            while v < chars.len() && is_val_char(chars[v]) {
                v += 1;
            }
            if v > i + matched {
                out.push_str("[redacted]");
            }
            i = v;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

fn push_log(state: &AppState, level: &str, msg: &str) {
    let msg = redact_secrets(msg);
    let line = format!(
        "{{\"ts\":{},\"level\":\"{}\",\"msg\":\"{}\"}}",
        now_secs(),
        json_escape(level),
        json_escape(&msg)
    );
    let mut logs = state.logs.lock().unwrap_or_else(|e| e.into_inner());
    if logs.len() >= 1000 {
        logs.pop_front();
    }
    logs.push_back(line);
}

/// Per-session diagnostic ring. Bounded independently so one noisy
/// session cannot exhaust the server's log budget, and idle sessions
/// are evicted so the map itself stays bounded.
struct SessionRing {
    ring: VecDeque<String>,
    last_seen: u64,
}

/// Cap on the session map (LRU-evicted) and idle expiry. Combined with
/// the per-ring cap this bounds worst-case session-log memory to
/// SESSIONS_CAP * SESSION_LOG_CAP lines.
const SESSIONS_CAP: usize = 128;
const SESSION_LOG_CAP: usize = 500;
const SESSION_IDLE_SECS: u64 = 1800;

/// Session tokens are generated by the UI (crypto.randomUUID) and
/// echoed on /r/ routes as lb_sess. Only well-formed tokens are
/// accepted, so a guest page cannot squat on arbitrary map keys or
/// spray junk into the map; unknown valid tokens simply get a fresh
/// ring (and occupy at most one of the 128 slots until evicted).
fn valid_session_token(s: &str) -> bool {
    (16..=64).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Drop idle sessions, then LRU-evict (oldest last_seen) down to the
/// cap. Called under the sessions lock by push_log_sess.
fn prune_sessions(sessions: &mut HashMap<String, SessionRing>) {
    let now = now_secs();
    sessions.retain(|_, r| now.saturating_sub(r.last_seen) <= SESSION_IDLE_SECS);
    while sessions.len() > SESSIONS_CAP {
        if let Some(oldest) = sessions
            .iter()
            .min_by_key(|(_, r)| r.last_seen)
            .map(|(k, _)| k.clone())
        {
            sessions.remove(&oldest);
        } else {
            break;
        }
    }
}

/// Session-tagged log push. Lines land ONLY in that session's ring —
/// never in the global ring — so /logs with the matching token sees
/// them and /logs without a token sees nothing of other sessions.
fn push_log_sess(state: &AppState, sess: Option<&str>, level: &str, msg: &str) {
    let Some(sess) = sess.filter(|s| valid_session_token(s)) else {
        push_log(state, level, msg);
        return;
    };
    let msg = redact_secrets(msg);
    let line = format!(
        "{{\"ts\":{},\"level\":\"{}\",\"msg\":\"{}\"}}",
        now_secs(),
        json_escape(level),
        json_escape(&msg)
    );
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    // Prune AFTER the insert as well: pruning only before would let the
    // map sit at SESSIONS_CAP + 1 between calls.
    prune_sessions(&mut sessions);
    let ring = sessions.entry(sess.to_string()).or_insert(SessionRing {
        ring: VecDeque::new(),
        last_seen: 0,
    });
    if ring.ring.len() >= SESSION_LOG_CAP {
        ring.ring.pop_front();
    }
    ring.ring.push_back(line);
    ring.last_seen = now_secs();
    prune_sessions(&mut sessions);
}

/// #16: SSRF guard installed as every engine client's DNS resolver.
/// Each RESOLVED address is checked against the Zeolite destination
/// policy (loopback, RFC1918, link-local/metadata, embedded-IPv6
/// forms, ...) and only allowed addresses reach the connection pool:
/// the validated address IS the one connected, so a DNS-rebinding
/// answer that passes a pre-fetch check has no window between check
/// and connect. Literal-IP destinations bypass the resolver; suggest
/// and cert hosts are domain names, so the resolver covers them.
/// The underlying lookup rides the engine's pinned resolver
/// (zeolite_server::dns): these lookups leave through Quad9 by
/// default, not the host resolver.
struct PolicyDns;

fn boxed_err<E: std::error::Error + Send + Sync + 'static>(
    e: E,
) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(e)
}

impl reqwest::dns::Resolve for PolicyDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().trim_end_matches('.').to_string();
        Box::pin(async move {
            // Pinned upstream DNS (Quad9 by default): the host resolver
            // is not consulted for these lookups either.
            let addrs = zeolite_server::dns::lookup(&host, 0u16)
                .await
                .map_err(boxed_err)?;
            let policy = zeolite_server::policy::DestinationPolicy::default();
            let allowed: Vec<std::net::SocketAddr> = addrs
                .into_iter()
                .filter(|sa| policy.check_ip(&sa.ip()) == zeolite_server::policy::Verdict::Allow)
                .collect();
            if allowed.is_empty() {
                // Every address resolved into blocked space (or nothing
                // resolved at all): fail closed.
                return Err("destination resolves to blocked or no addresses".into());
            }
            Ok(Box::new(allowed.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Shared lookup client: manual redirects (reqwest never follows a
/// 3xx on its own), the PolicyDns SSRF guard at connect time, and its
/// own cookie jar.
fn build_engine_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(std::sync::Arc::new(PolicyDns))
        .cookie_store(true)
        .build()
        .expect("reqwest client")
}

/// Zeolite #137 relay client: same SSRF resolver and no redirects (the
/// engine's hop chain re-issues 3xx itself), but NO cookie store - the
/// engine jar owns cookies and they ride as request headers.
/// The relay STREAMS bodies (Body::from_stream of bytes_stream), so a
/// total request timeout aborts any healthy body still streaming past
/// it (live evidence: a githubassets script died at exactly 20s
/// mid-body; the total cap guillotined the stream and the page paid a
/// relay TypeError). Only the IDLE read is bounded: a body that keeps
/// sending bytes never pays the limit, and a truly stalled upstream
/// dies at read_timeout, surfaced honestly by the engine deadlines
/// (#140 body-stall, navigation TTFB).
fn build_relay_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .read_timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(std::sync::Arc::new(PolicyDns))
        .cookie_store(false)
        .build()
        .expect("reqwest relay client")
}

/* ---- Zeolite #137 embedder relay --------------------------------- */

fn relay_b64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Standard-alphabet base64 decode for relayed binary bodies. Hand
/// rolled (no crate): the payload is small (form posts), and a wrong
/// decoder would corrupt every binary POST, so the unit test pins it
/// against round trips.
/// Base64 alphabet indexed by the decoder 6-bit values, so the
/// round-trip test can encode without a second encoder crate.
#[cfg(test)]
fn b64chars() -> [char; 64] {
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        .chars()
        .collect::<Vec<char>>()
        .try_into()
        .unwrap()
}

fn relay_base64_decode(input: &str) -> Option<Vec<u8>> {
    let cleaned: Vec<u8> = input.bytes().filter(|b| !b" \t\r\n".contains(b)).collect();
    if cleaned.is_empty() {
        return Some(Vec::new());
    }
    if !cleaned.len().is_multiple_of(4) {
        return None;
    }
    let pad = cleaned.iter().rev().take_while(|b| **b == b'=').count();
    if pad > 2 || cleaned[..cleaned.len() - pad].contains(&b'=') {
        return None;
    }
    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    for chunk in cleaned.chunks(4) {
        let v0 = relay_b64_val(chunk[0])?;
        let v1 = relay_b64_val(chunk[1])?;
        match (chunk[2], chunk[3]) {
            (b'=', b'=') => {
                out.push((v0 << 2 | v1 >> 4) as u8);
            }
            (c2, b'=') => {
                let v2 = relay_b64_val(c2)?;
                out.push((v0 << 2 | v1 >> 4) as u8);
                out.push((v1 << 4 | v2 >> 2) as u8);
            }
            (c2, c3) => {
                let v2 = relay_b64_val(c2)?;
                let v3 = relay_b64_val(c3)?;
                out.push((v0 << 2 | v1 >> 4) as u8);
                out.push((v1 << 4 | v2 >> 2) as u8);
                out.push((v2 << 6 | v3) as u8);
            }
        }
    }
    Some(out)
}

/// Request headers the relay never forwards upstream: hop-by-hop, the
/// ones reqwest owns (host, content-length), and accept-encoding (the
/// relay demands identity so the body rides decodable).
fn relay_request_header_allowed(name: &str) -> bool {
    !matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
            | "accept-encoding"
    )
}

/// Response headers the relay never hands back: hop-by-hop plus
/// framing the streamed body redefines.
fn relay_response_header_allowed(name: &str) -> bool {
    !matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-encoding"
            | "content-length"
    )
}

/// Zeolite #137 embedder relay endpoint. The service worker relays
/// fetches for hosts whose wasm TLS ClientHello is fingerprint-
/// blocked (engine policy route "relay"); the UI performs them here
/// because this server's TLS stack is the one those hosts accept.
/// Request: {dest, method, headers, body?, body_b64?}. Answer: the
/// upstream body streamed, with the upstream status, header pairs and
/// Set-Cookie lines in x-zl-relay-* headers (fetch hides raw
/// set-cookie from browser JS, so cookies ride as data). SSRF:
/// resolve-then-validate at connect time via the same PolicyDns
/// resolver the engine clients use. Redirects are NOT followed (the
/// engine hop chain re-issues them). ponytail: the shared 20s client
/// timeout covers the streamed body too; long-lived event-stream
/// relays are not a use case.
async fn zl_relay_endpoint(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Response {
    let bad = |code: StatusCode, msg: &str| -> Response { (code, msg.to_string()).into_response() };
    let req: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return bad(StatusCode::BAD_REQUEST, &format!("relay body: {}", e)),
    };
    let Some(dest) = req.get("dest").and_then(|v| v.as_str()) else {
        return bad(StatusCode::BAD_REQUEST, "relay: dest missing");
    };
    if !(dest.starts_with("http://") || dest.starts_with("https://")) {
        return bad(StatusCode::BAD_REQUEST, "relay: dest must be http(s)");
    }
    let method_s = req
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .to_uppercase();
    let Ok(method) = reqwest::Method::from_bytes(method_s.as_bytes()) else {
        return bad(StatusCode::BAD_REQUEST, "relay: bad method");
    };
    let mut out = state.relay_client.request(method, dest);
    if let Some(pairs) = req.get("headers").and_then(|v| v.as_array()) {
        for p in pairs {
            if let (Some(k), Some(v)) = (
                p.get(0).and_then(|x| x.as_str()),
                p.get(1).and_then(|x| x.as_str()),
            ) {
                if relay_request_header_allowed(&k.to_ascii_lowercase()) {
                    out = out.header(k, v);
                }
            }
        }
    }
    /* Identity encoding keeps the body decodable: a compressed
    upstream answer would ride the relay as opaque bytes with a
    content-encoding the SW fetch path never decodes. */
    out = out.header("accept-encoding", "identity");
    if let Some(b) = req.get("body").and_then(|v| v.as_str()) {
        out = out.body(b.to_string());
    } else if let Some(b64s) = req.get("body_b64").and_then(|v| v.as_str()) {
        match relay_base64_decode(b64s) {
            Some(bytes) => out = out.body(bytes),
            None => return bad(StatusCode::BAD_REQUEST, "relay: bad body_b64"),
        }
    }
    let upstream = match out.send().await {
        Ok(r) => r,
        Err(e) => {
            /* The reqwest Display alone says only "error sending request";
            the source chain says WHY (connect timeout, reset by peer,
            TLS failure). LB #75 needs that distinction on the wire. */
            let mut chain = e.to_string();
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                chain.push_str(" :: ");
                chain.push_str(&s.to_string());
                src = s.source();
            }
            return bad(StatusCode::BAD_GATEWAY, &chain);
        }
    };
    let mut pairs: Vec<(String, String)> = Vec::new();
    for (name, value) in upstream.headers().iter() {
        if name.as_str() == "set-cookie" || !relay_response_header_allowed(name.as_str()) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            pairs.push((name.as_str().to_string(), v.to_string()));
        }
    }
    let cookies: Vec<String> = upstream
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .collect();
    let headers_json = serde_json::to_string(&pairs).unwrap_or_else(|_| "[]".into());
    let cookies_json = serde_json::to_string(&cookies).unwrap_or_else(|_| "[]".into());
    let mut hm = axum::http::HeaderMap::new();
    let status_v = upstream.status().as_u16().to_string();
    match (
        axum::http::HeaderValue::from_str(&status_v),
        axum::http::HeaderValue::from_str(&headers_json),
        axum::http::HeaderValue::from_str(&cookies_json),
    ) {
        (Ok(a), Ok(b), Ok(c)) => {
            hm.insert("x-zl-relay-status", a);
            hm.insert("x-zl-relay-headers", b);
            hm.insert("x-zl-relay-set-cookie", c);
        }
        _ => return bad(StatusCode::INTERNAL_SERVER_ERROR, "relay: header encode"),
    }
    let streamed = Body::from_stream(upstream.bytes_stream());
    (StatusCode::OK, hm, streamed).into_response()
}

/// Firefox User-Agent for the /suggest provider fetches (Brave and
/// some other providers reject requests without a browser UA).
const FIREFOX_UA: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
/// Minimal RFC-3986 percent-encoding for query values we re-emit.
fn pct_enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Percent-decode a query value ('+' treated as space).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod redact_tests {
    use super::redact_secrets;

    #[test]
    fn redacts_secret_query_params() {
        let out = redact_secrets("engine GET https://x.test/login?session=abc123&ok=1");
        assert!(out.contains("session=[redacted]"), "{out}");
        assert!(out.contains("ok=1"), "{out}");
        assert!(!out.contains("abc123"), "{out}");
    }

    #[test]
    fn redacts_multiple_secret_params_case_insensitively() {
        let out = redact_secrets("?TOKEN=a&Access_Token=b&SID=c&client_secret=d&keep=e");
        assert!(out.contains("TOKEN=[redacted]"), "{out}");
        assert!(out.contains("Access_Token=[redacted]"), "{out}");
        assert!(out.contains("SID=[redacted]"), "{out}");
        assert!(out.contains("client_secret=[redacted]"), "{out}");
        assert!(out.contains("keep=e"), "{out}");
    }

    #[test]
    fn leaves_benign_params_alone() {
        let out = redact_secrets("?q=search&format=json&res=follow&sidewalk=1");
        assert_eq!(out, "?q=search&format=json&res=follow&sidewalk=1");
    }

    #[test]
    fn redacts_jwts() {
        let jwt =
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV";
        let out = redact_secrets(&format!("auth failed near {jwt} end"));
        assert!(out.contains("[redacted-jwt]"), "{out}");
        assert!(!out.contains("eyJhbGciOiJIUzI1NiJ9"), "{out}");
    }

    #[test]
    fn does_not_redact_ordinary_eyj_words() {
        // Two dots but not JWT-shaped (empty segment / too short).
        let out = redact_secrets("eyja..b and eyJx.y.z stay");
        assert!(out.contains("eyja..b"), "{out}");
    }

    #[test]
    fn redacts_labeled_credentials() {
        let out = redact_secrets("upstream said 401 for Bearer abcdef1234567890");
        assert!(out.contains("Bearer [redacted]"), "{out}");
        let out2 = redact_secrets("config password:hunter2 leaked");
        assert!(out2.contains("password:[redacted]"), "{out2}");
    }

    #[test]
    fn non_secret_values_survive() {
        let out = redact_secrets("engine done GET https://x.test/page -> 200 (12 ms, 3 B)");
        assert_eq!(
            out,
            "engine done GET https://x.test/page -> 200 (12 ms, 3 B)"
        );
    }
}

/// Honest answer for /zl/ routes: Zeolite's service worker owns
/// them (client-side interception, native wisp transport,
/// in-worker document rewriting). Reaching the server means no
/// worker controls the page: cold start, worker restart, or a
/// browser without module service workers. Zeolite's
/// docs/error-pages.md assigns this case to the embedding host:
/// a minimal notice, 503 (the failure is on the engine side of
/// the route, not an upstream failure) and one action (load the
/// app once so the worker installs, then retry). The LB-authored
/// error card is gone: every page a user can hit through a live
/// engine is Zeolite's own (app/src/errorpage.ts); the embedder
/// answers only the two cases the engine cannot. The notice
/// carries meta[zl-error] so the embedder's DevTools mirror
/// treats it like any engine failure, and it never prints the
/// destination (#32: plaintext destinations never land on
/// engine-origin documents).
async fn zl_sw_required(axum::extract::Path(target): axum::extract::Path<String>) -> Response {
    let _ = target;
    embedder_notice(
        "Engine offline",
        "The Zeolite engine service worker is not controlling this origin yet.",
        "Open the app once so the worker installs, then try again.",
        "offline",
        "no controlling service worker",
        true,
        StatusCode::SERVICE_UNAVAILABLE,
    )
}

/// Legacy engine route prefixes are unowned (#67): stale /r/ and
/// /lj/ bookmarks must break honestly instead of being rescued by
/// a 302. Zeolite owns the error pages users hit through the live
/// engine; these LB-only prefixes keep the minimal embedder
/// gone-notice (502), never a redirect and never the SPA fallback
/// (index.html with 200 would be a silent lie about the route).
async fn legacy_engine_route_gone(
    axum::extract::Path(target): axum::extract::Path<String>,
) -> Response {
    let _ = target;
    embedder_notice(
        "Gone",
        "The legacy engine route prefix is gone.",
        "The engine lives at /zl/ now: update the stale bookmark or history entry.",
        "route",
        "legacy engine route prefix is gone",
        false,
        StatusCode::BAD_GATEWAY,
    )
}

/// The two notices the engine cannot answer by design
/// (docs/error-pages.md): no controlling worker on an engine
/// route, and LB-only legacy prefixes. Minimal, deterministic,
/// scriptless, color-scheme aware, meta[zl-error] for the
/// embedder's DevTools mirror, no destination URLs (#32). The
/// retry flag adds a GET-form retry button back to the same
/// route (the offline case can recover once the worker installs;
/// a gone prefix cannot).
fn embedder_notice(
    title: &str,
    line: &str,
    action: &str,
    category: &str,
    reason: &str,
    retry: bool,
    code: StatusCode,
) -> Response {
    let meta = json_escape(&format!(
        "{{\"category\":\"{}\",\"reason\":\"{}\"}}",
        category, reason
    ));
    let body = format!(
        r#"<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="zl-error" content="{meta}">
<title>{title}</title>
<style>
:root {{ color-scheme: light dark; }}
body {{ margin:0; min-height:100vh; display:grid; place-items:center; text-align:center;
  font:15px/1.6 system-ui,sans-serif; background:#fff; color:#1c1c1e; }}
main {{ max-width:32em; padding:1.5em; }}
h1 {{ font-size:1.0625rem; font-weight:600; margin:0 0 .4em; }}
p {{ margin:0 0 1.2em; color:#6b6b70; }}
button {{ font:inherit; padding:.45em 1.6em; background:none; color:inherit;
  border:1px solid currentColor; border-radius:6px; cursor:pointer; }}
@media (prefers-color-scheme: dark) {{ body {{ background:#0f0f10; color:#e8e8ea; }} p {{ color:#9b9ba0; }} }}
</style></head><body><main>
<h1>{title}</h1>
<p>{line}</p>
<p>{action}</p>
{retry_form}
</main></body></html>"#,
        meta = meta,
        title = json_escape(title),
        line = json_escape(line),
        action = json_escape(action),
        retry_form = if retry {
            r#"<form method="get" action=""><button type="submit">Try again</button></form>"#
        } else {
            ""
        },
    );
    (
        code,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        body,
    )
        .into_response()
}
/// Search-engine suggestions, proxied server-side to dodge CORS.
/// Every provider returns the same osjson shape: ["query", ["s1", ...]].
async fn suggest_endpoint(State(state): State<Arc<AppState>>, RawQuery(raw): RawQuery) -> Response {
    let mut q = String::new();
    let mut engine = String::new();
    // Suggestion lookups are tagged with the asking tab's session token
    // so they land in that tab's /logs ring, not the global one.
    let sess = raw
        .as_deref()
        .and_then(|rq| {
            rq.split('&')
                .find_map(|p| p.strip_prefix("lb_sess=").map(|v| v.to_string()))
        })
        .filter(|s| valid_session_token(s));
    if let Some(rq) = raw.as_deref() {
        for part in rq.split('&') {
            let (k, v) = match part.find('=') {
                Some(p) => (&part[..p], &part[p + 1..]),
                None => (part, ""),
            };
            let v = percent_decode(v);
            if k == "q" {
                q = v;
            } else if k == "engine" {
                engine = v;
            }
        }
    }
    if q.trim().is_empty() {
        return (
            [("content-type", "application/json")],
            r#"{"suggestions":[],"source":""}"#,
        )
            .into_response();
    }
    let q_enc = pct_enc(&q);
    // Honest mapping: providers with a working open suggestion API get
    // their native endpoint; Startpage and Mojeek have none, so they
    // fall back to DuckDuckGo's endpoint first.
    let native = match engine.as_str() {
        "google" => Some(format!(
            "https://suggestqueries.google.com/complete/search?client=firefox&q={}",
            q_enc
        )),
        "bing" => Some(format!("https://api.bing.com/osjson.aspx?q={}", q_enc)),
        "brave" => Some(format!("https://search.brave.com/api/suggest?q={}", q_enc)),
        _ => Some(format!(
            "https://ac.duckduckgo.com/ac/?q={}&type=list",
            q_enc
        )),
    };
    // Fallback chain, server-side: some providers rate-limit or block
    // this deployment's datacenter egress (DuckDuckGo does), and an
    // empty suggestion box is worse than a second opinion. Brave and
    // Bing both answer from this network with the same osjson shape,
    // so they are tried (in order) before answering empty.
    let mut providers: Vec<String> = Vec::new();
    if let Some(p) = native {
        providers.push(p);
    }
    for fallback in [
        format!("https://search.brave.com/api/suggest?q={}", q_enc),
        format!("https://api.bing.com/osjson.aspx?q={}", q_enc),
    ] {
        if !providers.contains(&fallback) {
            providers.push(fallback);
        }
    }
    push_log_sess(
        &state,
        sess.as_deref(),
        "info",
        &format!("suggest {} {}", engine, q),
    );
    let mut list: Vec<String> = Vec::new();
    /* Which provider actually answered: the fallback chain can hide the
    asked-for engine, and the suggestion UI tells the user where
    their completions came from. */
    let mut source = String::new();
    let mut last_err = String::new();
    for provider in &providers {
        match state
            .client
            .get(provider)
            // Brave (and some others) reject requests without a browser UA.
            .header("User-Agent", FIREFOX_UA)
            .header("Accept", "*/*")
            .header("Sec-GPC", "1")
            .header("DNT", "1")
            .send()
            .await
        {
            Ok(r) => match r.error_for_status() {
                Ok(r) => match r.text().await {
                    Ok(text) => {
                        list = parse_osjson(&text);
                        if !list.is_empty() {
                            source = if provider.contains("suggestqueries.google.com") {
                                "google".to_string()
                            } else if provider.contains("api.bing.com") {
                                "bing".to_string()
                            } else if provider.contains("search.brave.com") {
                                "brave".to_string()
                            } else {
                                "duckduckgo".to_string()
                            };
                            break;
                        }
                    }
                    Err(e) => last_err = e.to_string(),
                },
                Err(e) => last_err = e.to_string(),
            },
            Err(e) => last_err = e.to_string(),
        }
    }
    if list.is_empty() && !last_err.is_empty() {
        push_log_sess(
            &state,
            sess.as_deref(),
            "warn",
            &format!("suggest failed: {}", last_err),
        );
    }
    let out = format!(
        "{{\"suggestions\":[{}],\"source\":\"{}\"}}",
        list.join(","),
        source
    );
    ([("content-type", "application/json")], out).into_response()
}

/* Pull up to 8 non-empty suggestion strings out of an osjson body
(["query", ["s1", ...]]). Any other shape yields an empty list. */
fn parse_osjson(text: &str) -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(suggs) = v
            .as_array()
            .and_then(|a| a.get(1))
            .and_then(|x| x.as_array())
        {
            for item in suggs.iter().take(8) {
                if let Some(t) = item.as_str() {
                    if !t.is_empty() {
                        list.push(format!("\"{}\"", json_escape(t)));
                    }
                }
            }
        }
    }
    list
}

/// Recent server-side engine log entries, newest last. JSON array.
async fn logs_endpoint(State(state): State<Arc<AppState>>, RawQuery(raw): RawQuery) -> Response {
    // /logs is session-scoped: the caller must present its own lb_sess
    // token and receives ONLY that session's ring. Without a token the
    // endpoint refuses (403) rather than serving the global ring, so a
    // guest page running same-origin inside a proxied tab cannot read
    // another session's diagnostics.
    let sess = raw
        .as_deref()
        .and_then(|rq| {
            rq.split('&')
                .find_map(|p| p.strip_prefix("lb_sess=").map(|v| v.to_string()))
        })
        .filter(|s| valid_session_token(s));
    let Some(sess) = sess else {
        return (
            StatusCode::FORBIDDEN,
            [(header::CONTENT_TYPE, "application/json")],
            "{\"error\":\"missing or invalid lb_sess session token\"}",
        )
            .into_response();
    };
    let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let body = match sessions.get(&sess) {
        Some(ring) => format!(
            "[{}]",
            ring.ring.iter().cloned().collect::<Vec<String>>().join(",")
        ),
        // Unknown-but-valid token: no logs for this session yet. Empty
        // array is the honest answer (the session genuinely has none).
        None => "[]".to_string(),
    };
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

/* Pull one string value out of raw JSON without a parser: find the
key, skip to the opening quote of the value, then read until an
unescaped closing quote (handles \" and \\ escapes). */
fn scan_json_str(body: &str, key: &str) -> Option<String> {
    let key_pat = format!("\"{}\"", key);
    let start = body.find(&key_pat)? + key_pat.len();
    let rest = &body[start..];
    let q1 = rest.find('"')? + 1;
    let mut out = String::new();
    let mut esc = false;
    for ch in rest[q1..].chars() {
        if esc {
            esc = false;
            out.push(match ch {
                'n' => '\n',
                other => other,
            });
            continue;
        }
        match ch {
            '\\' => esc = true,
            '"' => return Some(out),
            other => out.push(other),
        }
    }
    None
}

/* Days from today until a "YYYY-MM-DD..." date prefix, via the civil
epoch-day formula (Howard Hinnant). None when unparseable. */
fn days_until(date: &str) -> Option<i64> {
    let mut parts = date.splitn(3, '-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts
        .next()?
        .split(&['T', ' ', '/'][..])
        .next()?
        .parse()
        .ok()?;
    let (y2, m2) = if m <= 2 { (y - 1, m + 12) } else { (y, m) };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m2 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let today = (now_secs() / 86400) as i64;
    Some(days - today)
}

/* Fetch raw JSON from a CT-log API. Errors carry the reason so the
log line explains the failure instead of guessing. */
async fn ct_fetch(state: &AppState, url: &str) -> Result<String, String> {
    let resp = state
        .client
        .get(url)
        .header("user-agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("status {}", status));
    }
    resp.text()
        .await
        .map_err(|e| format!("body read failed: {}", e))
}

/* Does a crt.sh record cover the host? crt.sh matches substring, so a
query for github.com also returns random subdomain certs; prefer
records whose common_name is the host, a wildcard for it, or whose
name_value (newline-separated SANs) lists it. */
fn cert_covers_host(rec: &str, host: &str) -> bool {
    if let Some(cn) = scan_json_str(rec, "common_name") {
        if cn == host {
            return true;
        }
        if let Some(suffix) = cn.strip_prefix("*.") {
            if host.ends_with(suffix) {
                return true;
            }
        }
    }
    if let Some(nv) = scan_json_str(rec, "name_value") {
        if nv.split('\n').any(|n| n == host) {
            return true;
        }
    }
    false
}

/* Pick the best record from a crt.sh array: newest not_after among
the records that cover the host, else the newest overall. ISO-8601
dates compare correctly as plain strings. Returns (issuer,
not_after). */
fn best_crtsh(body: &str, host: &str) -> Option<(String, String)> {
    let mut best_covered: Option<(String, String)> = None;
    let mut best_any: Option<(String, String)> = None;
    for rec in body.split("{\"issuer_ca_id\"") {
        if rec.is_empty() {
            continue;
        }
        let issuer = scan_json_str(rec, "issuer_name");
        let not_after = scan_json_str(rec, "not_after");
        let (issuer, not_after) = match (issuer, not_after) {
            (Some(i), Some(n)) => (i, n),
            _ => continue,
        };
        let newer = |slot: &Option<(String, String)>, na: &str| {
            slot.as_ref().is_none_or(|(cur, _)| na > cur.as_str())
        };
        if cert_covers_host(rec, host) && newer(&best_covered, &not_after) {
            best_covered = Some((issuer.clone(), not_after.clone()));
        }
        if newer(&best_any, &not_after) {
            best_any = Some((issuer, not_after));
        }
    }
    best_covered.or(best_any)
}

/* Pick the best Cert Spotter issuance (their list is newest-first):
the first one whose dns_names include the host. Returns (issuer,
not_after). */
fn best_certspotter(body: &str, host: &str) -> Option<(String, String)> {
    for rec in body.split("{\"id\"") {
        if rec.is_empty() {
            continue;
        }
        if !rec.contains(&format!("\"{}\"", host)) {
            continue;
        }
        let issuer = rec
            .split("\"issuer\"")
            .nth(1)
            .and_then(|seg| scan_json_str(seg, "name"))
            .unwrap_or_default();
        let not_after = scan_json_str(rec, "not_after")?;
        return Some((issuer, not_after));
    }
    None
}

/// Build/identity endpoint: the single authoritative source the Settings
/// About section reads. Versions come from the compiler (this exact
/// binary); the deployment identifier from the git commit the platform
/// built from (RENDER_GIT_COMMIT on Render, LB_BUILD_ID as a portable
/// fallback, "unknown" honestly when neither is set). No invented data.
async fn build_endpoint() -> Response {
    let build = std::env::var("RENDER_GIT_COMMIT")
        .or_else(|_| std::env::var("LB_BUILD_ID"))
        .unwrap_or_else(|_| "unknown".to_string());
    let build_short: String = build.chars().take(7).collect();
    // The Zeolite version is read from the vendored engine worker the
    // deployment actually serves, so it tracks the dist bundle instead
    // of a hardcoded string (a stale "1.1 Chabazite" once lied here).
    // The bundle's sha256 goes out too: the zl-builder Docker layer
    // caches the dist tarball, so a deploy can silently ship an old
    // engine — the hash makes that detectable from the outside.
    // "unknown" when the bundle is missing or unreadable: never invented.
    let (zeolite, zlsw_sha) = match tokio::fs::read("zlsw/sw.js").await {
        Ok(bytes) => {
            use sha2::{Digest, Sha256};
            let hash = Sha256::digest(&bytes);
            let hex: String = hash.iter().take(8).map(|b| format!("{b:02x}")).collect();
            (zeolite_version(&String::from_utf8_lossy(&bytes)), hex)
        }
        Err(_) => ("unknown".to_string(), "unknown".to_string()),
    };
    let lb_version = format!("{} Cobalt", env!("CARGO_PKG_VERSION"));
    let body = format!(
        "{{\"ok\":true,\"lb\":\"{}\",\"zeolite\":\"{}\",\"zlswSha\":\"{}\",\"build\":\"{}\",\"buildShort\":\"{}\"}}",
        lb_version,
        json_escape(&zeolite),
        json_escape(&zlsw_sha),
        json_escape(&build),
        json_escape(&build_short),
    );
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(body.into())
        .unwrap()
}

/// Zeolite version out of the vendored engine worker source. The dist
/// sw.js keeps its identity as the only quoted "MAJOR.MINOR Substance"
/// string (e.g. "1.0 Nitride"). The scan anchors the shape check at
/// every quote: pairing quotes (split parity or quote-to-quote
/// skipping) desyncs on real minified bundles, whose escaped and
/// unpaired quotes made both earlier cuts report "unknown" against a
/// file that contains the version. "unknown" when absent, never
/// invented.
fn zeolite_version(js: &str) -> String {
    let b = js.as_bytes();
    let mut i = 0;
    while i + 4 < b.len() {
        if b[i] != b'"' {
            i += 1;
            continue;
        }
        let mut p = i + 1;
        let start_num = p;
        while p < b.len() && b[p].is_ascii_digit() {
            p += 1;
        }
        if p == start_num || p >= b.len() || b[p] != b'.' {
            i += 1;
            continue;
        }
        p += 1;
        let start_min = p;
        while p < b.len() && b[p].is_ascii_digit() {
            p += 1;
        }
        if p == start_min || p >= b.len() || b[p] != b' ' {
            i += 1;
            continue;
        }
        p += 1;
        let start_name = p;
        while p < b.len() && b[p].is_ascii_alphabetic() {
            p += 1;
        }
        if p == start_name || p >= b.len() || b[p] != b'"' {
            i += 1;
            continue;
        }
        return js[i + 1..p].to_string();
    }
    "unknown".to_string()
}

/// TLS certificate details for the site info card. The browser never
/// makes a direct TLS connection to proxied sites, so this reads the
/// host's public CT-log record: crt.sh first, Cert Spotter as the
/// fallback. Field scanning instead of serde_json keeps dependencies
/// unchanged. Honest failure: the card says the data is unavailable,
/// never invents a certificate.
async fn cert_endpoint(State(state): State<Arc<AppState>>, RawQuery(q): RawQuery) -> Response {
    let sess = q
        .as_deref()
        .and_then(|rq| {
            rq.split('&')
                .find_map(|p| p.strip_prefix("lb_sess=").map(|v| v.to_string()))
        })
        .filter(|s| valid_session_token(s));
    let host = q
        .as_deref()
        .and_then(|qs| qs.split('&').find_map(|kv| kv.strip_prefix("host=")))
        .map(percent_decode)
        .unwrap_or_default();
    /* The host reaches two upstream query strings: validate it as a
    plain hostname (no scheme, path or query) and percent-encode it so
    it cannot inject query keys into the CT APIs. */
    let host_valid = !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_');
    if !host_valid {
        return (
            [(header::CONTENT_TYPE, "application/json")],
            "{\"ok\":false,\"error\":\"certificate data unavailable\"}",
        )
            .into_response();
    }
    push_log_sess(
        &state,
        sess.as_deref(),
        "info",
        &format!("cert lookup {}", host),
    );
    /* crt.sh first: query the host, pick the best record. */
    let crtsh_url = format!("https://crt.sh/?q={}&output=json", pct_enc(&host));
    let picked = match ct_fetch(&state, &crtsh_url).await {
        Ok(body) => best_crtsh(&body, &host),
        Err(err) => {
            push_log(
                &state,
                "warn",
                &format!("cert lookup {}: crt.sh {}", host, err),
            );
            None
        }
    };
    let picked = match picked {
        Some(p) => Some(p),
        None => {
            /* Fallback: Cert Spotter public issuances API. */
            let cs_url = format!(
                "https://api.certspotter.com/v1/issuances?domain={}&include_certificates=false",
                pct_enc(&host)
            );
            match ct_fetch(&state, &cs_url).await {
                Ok(body) => {
                    let p = best_certspotter(&body, &host);
                    if p.is_none() {
                        push_log(
                            &state,
                            "warn",
                            &format!("cert lookup {}: no parseable Cert Spotter record", host),
                        );
                    }
                    p
                }
                Err(err) => {
                    push_log(
                        &state,
                        "warn",
                        &format!("cert lookup {}: certspotter {}", host, err),
                    );
                    None
                }
            }
        }
    };
    match picked {
        Some((issuer, not_after)) if !issuer.is_empty() && !not_after.is_empty() => {
            let days = days_until(&not_after).unwrap_or(0);
            let out = format!(
                "{{\"ok\":true,\"host\":\"{}\",\"issuer\":\"{}\",\"notAfter\":\"{}\",\"days\":{}}}",
                json_escape(&host),
                json_escape(&issuer),
                json_escape(&not_after),
                days
            );
            push_log(
                &state,
                "info",
                &format!("cert lookup {} ok: {} ({} days left)", host, issuer, days),
            );
            ([(header::CONTENT_TYPE, "application/json")], out).into_response()
        }
        _ => (
            [(header::CONTENT_TYPE, "application/json")],
            "{\"ok\":false,\"error\":\"certificate data unavailable\"}",
        )
            .into_response(),
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
    let wisp_path = std::env::var("WISP_PATH").unwrap_or_else(|_| "/wisp/".into());
    let auth_password = std::env::var("WISP_PASSWORD").ok();

    /* One shared client for /suggest and /cert lookups. Proxied traffic
    never touches this server (the Zeolite worker owns it), so there is
    no proxy cookie jar to keep. */
    let client = build_engine_client();

    let state = Arc::new(AppState {
        client,
        relay_client: build_relay_client(),
        logs: Mutex::new(VecDeque::new()),
        sessions: Mutex::new(HashMap::new()),
    });
    push_log(&state, "info", "server log buffer initialised");

    // Zeolite is the authoritative wisp server: resolve-then-validate
    // SSRF policy (DNS-rebinding safe), real UDP datagram relay, credit
    // windows, connection/stream limits and extension auth all live there.
    // The old local wisp handler (proxy.rs) was removed.
    // from_env went fail-closed in the 2026-10-07 Zeolite audit round:
    // a half-set or malformed auth env is a startup error, not a
    // silently disabled auth (zeolite-server exits 2 for the same
    // class of config error).
    let mut zl_cfg = zeolite_server::Config::from_env().unwrap_or_else(|e| {
        eprintln!("zeolite-server auth config error: {}", e);
        std::process::exit(2);
    });
    if zl_cfg.password.is_none() {
        // Preserve the previous WISP_USERNAME / WISP_PASSWORD deployment
        // knobs for existing deployments.
        if let Some(pw) = auth_password.filter(|p| !p.is_empty()) {
            let user = std::env::var("WISP_USERNAME").unwrap_or_else(|_| "user".into());
            zl_cfg.password = Some((user, pw));
        }
    }
    // Zeolite #133: the crate default stream ceiling (24) starves sequential
    // browsing - browsers hold keepalive sockets and Close(Throttled) has no
    // client recovery yet. Raise the LB default unless the deploy set it.
    if std::env::var("MAX_STREAMS_PER_CONNECTION").is_err() {
        zl_cfg.max_streams_per_conn = 128;
    }
    let wisp_state = zeolite_server::Shared::new(zl_cfg);

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        // Legacy prefixes are unowned (#67): stale /r/ and /lj/
        // bookmarks get the honest gone-notice, never the SPA fallback.
        .route("/r/:target", any(legacy_engine_route_gone))
        .route("/lj/:target", any(legacy_engine_route_gone))
        // The Zeolite engine uses the /zl/ prefix (engineRoutePrefix in
        // settings.ts): its worker owns those routes, so a /zl/ request
        // that reaches the server means no worker controls the page and
        // gets the honest load-error card.
        .route("/zl/:target", any(zl_sw_required))
        .route("/suggest", get(suggest_endpoint))
        .route("/zlrelay", post(zl_relay_endpoint))
        .route("/logs", get(logs_endpoint))
        .route("/cert", get(cert_endpoint))
        .route("/build", get(build_endpoint))
        // Zeolite engine bundle, vendored into zlsw/ at build time.
        // The service worker script gets Service-Worker-Allowed so it
        // registers at the "/" scope (ui/src/zeolite.ts): it intercepts
        // the engine routes and passes every non-engine path through
        // untouched. Its chunks and wasm assets are plain static files
        // under the same prefix.
        .route("/zlsw/sw.js", get(zl_sw_js))
        .nest_service("/zlsw", ServeDir::new("zlsw"))
        // The engine rewriter injects <script src="/bootstrap.js">
        // (root-absolute): pages served from engine routes resolve
        // that URL at the origin root, and the missing route 404ed
        // silently - the SW consumes the error during init, then
        // storage virtualization and the WS relay die on SPAs. Serve
        // the bundle's copy at that exact URL (issue #19).
        .route("/bootstrap.js", get(zl_bootstrap_js))
        // The engine rewriter resolves rewriter_wasm_bg.wasm
        // root-absolute too: serve the vendored copy at the origin root
        // so the rewriter's wasm init does not 404 silently.
        .route("/rewriter_wasm_bg.wasm", get(zl_rewriter_wasm))
        // The engine worker fetches its data files root-absolute
        // (rules.ts /rules.kdl, siteconfig.ts /siteconfig.kdl,
        // policy.ts /policy.kdl), same pattern as /bootstrap.js: the
        // SPA fallback would otherwise answer index.html with 200 and
        // the engine would silently run with no adblock rules, site
        // overrides or compatibility policy.
        .route("/rules.kdl", get(zl_rules_kdl))
        .route("/siteconfig.kdl", get(zl_siteconfig_kdl))
        .route("/policy.kdl", get(zl_policy_kdl))
        // The engine worker's transport adapter resolves the vendored
        // libcurl bundle at the origin root (/libcurl/index.mjs);
        // serve the vendored copy from the bundle directory.
        .nest_service("/libcurl", ServeDir::new("zlsw/libcurl"))
        // The epoxy transport adapter (selectable second engine,
        // Zeolite #64) resolves its vendored bundle at the origin root
        // (/epoxy/epoxy.js + epoxy.wasm): serve it like /libcurl.
        .nest_service("/epoxy", ServeDir::new("zlsw/epoxy"))
        // Extension subsystem routes live in the Zeolite worker
        // (IndexedDB-backed), NOT on this server: any request that
        // slips past the worker gets an honest 404, never the SPA
        // fallback (see extension_route_not_found).
        .route("/zl-ext/*path", any(extension_route_not_found))
        .route("/zl-cs/*path", any(extension_route_not_found))
        .fallback_service(
            ServeDir::new("ui")
                .append_index_html_on_directories(true)
                .not_found_service(ServeFile::new("ui/index.html")),
        )
        .route(
            &wisp_path,
            get({
                let state = wisp_state.clone();
                move |ws: axum::extract::ws::WebSocketUpgrade,
                      headers: axum::http::HeaderMap,
                      peer: axum::extract::connect_info::ConnectInfo<SocketAddr>| {
                    let state = state.clone();
                    async move { zeolite_server::wisp_handler(State(state), peer, ws, headers).await }
                }
            }),
        )
        /* #18: no CorsLayer. The UI, engine frames and every subresource
        are same-origin, so cross-origin ACAO headers serve nobody — the
        permissive layer that used to sit here turned the deployment
        into a CORS-stripping relay any web page could read. */
        .with_state(state);

    info!(
        "wisp upstream DNS: {}",
        zeolite_server::dns::mode_description()
    );
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!(
        "Celadon native engine server listening on {} at {}",
        addr, wisp_path
    );
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind failed");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("server error");
}

/// Extension asset/content-script routes (/zl-ext/, /zl-cs/) are served
/// ONLY by the Zeolite extension worker from its IndexedDB store in the
/// browser. The server has no extension store, so direct requests that
/// bypass the worker must fail honestly with a 404 instead of falling
/// through the SPA fallback (which would hand back index.html with a
/// 200 and a text/html MIME — a silent lie about the resource).
///
/// Traversal safety: the path is never mapped to the filesystem here;
/// ServeDir (used for the real static trees) rejects dot-dot sequences
/// on its own, and the extension worker's own getResource enforces the
/// web_accessible_resources globs per extension id (32-hex, no
/// separators), so an encoded traversal (%2e%2e) cannot resolve to a
/// sibling origin path.
async fn extension_route_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "extension resources are served by the engine worker only",
    )
        .into_response()
}

/// Zeolite engine service worker (vendored build, zlsw/sw.js). The
/// Service-Worker-Allowed header permits a "/" scope registration;
/// no-cache so UI updates pick up new bundle builds promptly.
async fn zl_sw_js() -> Response {
    match tokio::fs::read("zlsw/sw.js").await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/javascript")
            .header(header::CACHE_CONTROL, "no-cache")
            .header("service-worker-allowed", "/")
            .body(Body::from(bytes))
            .expect("static response build"),
        Err(_) => (StatusCode::NOT_FOUND, "zeolite bundle not vendored").into_response(),
    }
}

/// Zeolite bootstrap at the origin root (vendored build,
/// zlsw/bootstrap.js): the engine rewriter injects a root-absolute
/// /bootstrap.js, so that exact URL must exist here (issue #19).
/// no-cache so bundle updates are picked up promptly.
async fn zl_bootstrap_js() -> Response {
    match tokio::fs::read("zlsw/bootstrap.js").await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/javascript")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(bytes))
            .expect("static response build"),
        Err(_) => (StatusCode::NOT_FOUND, "zeolite bundle not vendored").into_response(),
    }
}

/// Engine rewriter wasm at the origin root (vendored build,
/// zlsw/rewriter_wasm_bg.wasm): the engine dist resolves it
/// root-absolute, same pattern as /bootstrap.js.
/// no-cache so bundle updates are picked up promptly.
async fn zl_rewriter_wasm() -> Response {
    match tokio::fs::read("zlsw/rewriter_wasm_bg.wasm").await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/wasm")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(bytes))
            .expect("static response build"),
        Err(_) => (StatusCode::NOT_FOUND, "zeolite bundle not vendored").into_response(),
    }
}
/// Engine data file at the origin root (vendored build, zlsw/<name>):
/// the worker fetches /rules.kdl (adblock host lists), /siteconfig.kdl
/// (per-site overrides) and /policy.kdl (transit compatibility policy)
/// root-absolute, same pattern as /bootstrap.js. text/plain, no-cache
/// so bundle updates are picked up promptly.
async fn zl_data_file(name: &str) -> Response {
    match tokio::fs::read(format!("zlsw/{name}")).await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(bytes))
            .expect("static response build"),
        Err(_) => (StatusCode::NOT_FOUND, "zeolite data file not vendored").into_response(),
    }
}

/// Adblock host lists (the worker fetches this root-absolute).
async fn zl_rules_kdl() -> Response {
    zl_data_file("rules.kdl").await
}

/// Per-site compatibility overrides.
async fn zl_siteconfig_kdl() -> Response {
    zl_data_file("siteconfig.kdl").await
}

/// Transit compatibility policy (Zeolite #135/#136).
async fn zl_policy_kdl() -> Response {
    zl_data_file("policy.kdl").await
}

#[cfg(test)]
mod version_tests {
    use super::zeolite_version;

    #[test]
    fn reads_the_bundle_identity() {
        // Shape from the real dist sw.js: `const pt="1.0 Nitride";`
        let js = r#"const fe=[];const pt="1.0 Nitride";console.info("[Zeolite] runtime "+pt);const mt="zeolite-pages-v1";"#;
        assert_eq!(zeolite_version(js), "1.0 Nitride");
    }

    #[test]
    fn unpaired_and_escaped_quotes_do_not_desync_the_scan() {
        // Real minified bundles carry escaped and unpaired quotes; both
        // quote-pairing scans skipped past the version on the actual
        // dist bundle and reported unknown.
        let js = r#"const a="he said \"hi\" ok;const b="1.0 Nitride";"#;
        assert_eq!(zeolite_version(js), "1.0 Nitride");
        // Multi-digit minor must still parse (a future "1.10 Fullerene").
        assert_eq!(zeolite_version("x=\"1.10 Fullerene\";"), "1.10 Fullerene");
    }

    #[test]
    fn no_version_shape_means_unknown() {
        assert_eq!(zeolite_version("const x=\"zeolite-pages-v1\";"), "unknown");
        assert_eq!(
            zeolite_version("1.2.3 semver but not the identity"),
            "unknown"
        );
        assert_eq!(zeolite_version(""), "unknown");
    }
}

#[cfg(test)]
mod suggest_tests {
    use super::parse_osjson;

    #[test]
    fn osjson_shapes_parse_or_empty() {
        assert_eq!(
            parse_osjson(r#"["weather",["weather tomorrow","weather radar"]]"#),
            vec!["\"weather tomorrow\"", "\"weather radar\""]
        );
        assert!(parse_osjson(r#"{"suggestions":[]}"#).is_empty());
        assert!(parse_osjson("not json at all").is_empty());
        /* Empty strings never make it into the list. */
        assert_eq!(parse_osjson(r#"["q",["", "a"]]"#), vec!["\"a\""]);
    }

    #[test]
    fn suggest_items_are_valid_json_strings() {
        /* The response body joins the items with commas inside
        {"suggestions":[...]}; each item must be a quoted, escaped
        JSON string or the whole body fails to parse client-side. */
        let items = parse_osjson(r#"["q",["a\"b", "plain text", "e"]]"#);
        let body = format!("{{\"suggestions\":[{}]}}", items.join(","));
        let v: serde_json::Value =
            serde_json::from_str(&body).expect("suggest body must be valid JSON");
        let arr = v
            .get("suggestions")
            .and_then(|s| s.as_array())
            .expect("suggestions array");
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0].as_str(), Some("a\"b"));
        assert_eq!(arr[1].as_str(), Some("plain text"));
    }
}

#[cfg(test)]
mod session_log_tests {
    use super::*;

    fn test_state() -> AppState {
        AppState {
            client: reqwest::Client::new(),
            relay_client: reqwest::Client::new(),
            logs: Mutex::new(VecDeque::new()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn relay_base64_round_trips_and_rejects_junk() {
        /* Round trips over all byte-value classes and lengths. */
        for len in [0usize, 1, 2, 3, 7, 32, 251] {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let mut s = String::new();
            for chunk in bytes.chunks(3) {
                let b = [
                    chunk[0],
                    *chunk.get(1).unwrap_or(&0),
                    *chunk.get(2).unwrap_or(&0),
                ];
                s.push(b64chars()[((b[0] >> 2) & 63) as usize]);
                s.push(b64chars()[(((b[0] << 4) | (b[1] >> 4)) & 63) as usize]);
                s.push(if chunk.len() > 1 {
                    b64chars()[(((b[1] << 2) | (b[2] >> 6)) & 63) as usize]
                } else {
                    '='
                });
                s.push(if chunk.len() > 2 {
                    b64chars()[(b[2] & 63) as usize]
                } else {
                    '='
                });
            }
            assert_eq!(
                relay_base64_decode(&s).as_deref(),
                Some(bytes.as_slice()),
                "len {}",
                len
            );
        }
        assert_eq!(relay_base64_decode("Zg=="), Some(b"f".to_vec()));
        assert_eq!(relay_base64_decode("Zm8="), Some(b"fo".to_vec()));
        assert_eq!(relay_base64_decode("Zm9v"), Some(b"foo".to_vec()));
        assert!(relay_base64_decode("!!!!").is_none());
        assert!(relay_base64_decode("Zm9").is_none()); /* bad length */
        assert!(relay_base64_decode("Z=g=").is_none()); /* pad inside */
    }

    #[test]
    fn relay_header_filters_cover_hop_by_hop_and_framing() {
        for h in [
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
        ] {
            assert!(!relay_request_header_allowed(h));
            assert!(!relay_response_header_allowed(h));
        }
        assert!(!relay_request_header_allowed("host"));
        assert!(!relay_request_header_allowed("content-length"));
        assert!(!relay_request_header_allowed("accept-encoding"));
        assert!(!relay_response_header_allowed("content-encoding"));
        assert!(!relay_response_header_allowed("content-length"));
        /* The engine jar's cookie header must pass upstream, and the
        page-visible headers must pass back. */
        assert!(relay_request_header_allowed("cookie"));
        assert!(relay_request_header_allowed("user-agent"));
        assert!(relay_response_header_allowed("content-type"));
        assert!(relay_response_header_allowed("location"));
    }

    #[test]
    fn token_validation_rejects_malformed_tokens() {
        assert!(valid_session_token("0123456789abcdef"));
        assert!(valid_session_token("a".repeat(64).as_str()));
        assert!(!valid_session_token("short"));
        assert!(!valid_session_token(&"a".repeat(65)));
        assert!(!valid_session_token("has spaces in it 12345"));
        assert!(!valid_session_token("unicode-\u{00e9}-token-12345"));
    }

    #[test]
    fn sessions_are_isolated_from_each_other() {
        let state = test_state();
        push_log_sess(&state, Some("session-a-token-111"), "info", "from A");
        push_log_sess(&state, Some("session-b-token-222"), "info", "from B");
        let sessions = state.sessions.lock().unwrap();
        let a = sessions.get("session-a-token-111").unwrap();
        assert_eq!(a.ring.len(), 1);
        assert!(a.ring[0].contains("from A"));
        assert!(!a.ring[0].contains("from B"));
        let b = sessions.get("session-b-token-222").unwrap();
        assert!(b.ring[0].contains("from B"));
        assert!(!b.ring[0].contains("from A"));
    }

    #[test]
    fn tagged_lines_never_land_in_the_global_ring() {
        let state = test_state();
        push_log_sess(&state, Some("session-a-token-111"), "info", "secret to A");
        assert!(state.logs.lock().unwrap().is_empty());
    }

    #[test]
    fn per_session_ring_is_bounded() {
        let state = test_state();
        for i in 0..(SESSION_LOG_CAP + 50) {
            push_log_sess(
                &state,
                Some("session-a-token-111"),
                "info",
                &format!("line {i}"),
            );
        }
        let sessions = state.sessions.lock().unwrap();
        let ring = &sessions.get("session-a-token-111").unwrap().ring;
        assert_eq!(ring.len(), SESSION_LOG_CAP);
        // Oldest lines were evicted, newest kept.
        assert!(ring.front().unwrap().contains("line 50"));
        assert!(ring
            .back()
            .unwrap()
            .contains(&format!("line {}", SESSION_LOG_CAP + 49)));
    }

    #[test]
    fn session_map_is_bounded_and_evicts_idle_sessions() {
        let state = test_state();
        // Fill with more sessions than the cap.
        for i in 0..(SESSIONS_CAP + 20) {
            push_log_sess(&state, Some(&format!("session-token-{i:05}")), "info", "x");
        }
        let sessions = state.sessions.lock().unwrap();
        assert!(sessions.len() <= SESSIONS_CAP);
        drop(sessions);
        // Idle expiry: a ring whose last_seen is older than the idle
        // window is dropped on the next prune.
        state.sessions.lock().unwrap().insert(
            "session-old-but-valid1".to_string(),
            SessionRing {
                ring: VecDeque::new(),
                last_seen: now_secs().saturating_sub(SESSION_IDLE_SECS + 60),
            },
        );
        push_log_sess(&state, Some("session-a-token-111"), "info", "prune trigger");
        assert!(!state
            .sessions
            .lock()
            .unwrap()
            .contains_key("session-old-but-valid1"));
    }

    #[test]
    fn invalid_tokens_fall_back_to_the_global_ring() {
        let state = test_state();
        push_log_sess(&state, Some("bad token!"), "info", "unified");
        assert_eq!(state.logs.lock().unwrap().len(), 1);
        assert!(state.sessions.lock().unwrap().is_empty());
    }
}
