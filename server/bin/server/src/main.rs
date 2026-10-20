//! LobsterBrowse Zeolite engine + wisp server entrypoint.
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
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;
/* wreq replaces reqwest wholesale: same client API (hard fork),
 * BoringSSL + Chrome TLS/HTTP2 emulation underneath. The alias keeps
 * every reqwest:: path in this file meaningful. */
use wreq as reqwest;

struct AppState {
    /// Shared client for /suggest and /cert upstream lookups (SSRF-safe
    /// DNS, no cookie jar). Proxied traffic never touches this server:
    /// the Zeolite worker owns it.
    client: reqwest::Client,
    /// Zeolite #137 embedder relay client: native TLS, the same
    /// resolve-then-validate SSRF resolver, no cookie store (the
    /// engine's jar owns cookies; they ride as headers).
    relay_client: reqwest::Client,
    /// #110: optional deployment relay capability token
    /// (ZL_RELAY_TOKEN). When set, only requests carrying the same
    /// value in x-zl-relay-token are relayed at all.
    relay_token: Option<String>,
    /// #110: bounds concurrent upstream relay connects; a relay that
    /// cannot take a permit fails fast instead of piling up. Arc so the
    /// permit can be owned by the streamed body (#137): a borrowing
    /// permit would die with the handler while the body lives on.
    relay_permits: Arc<tokio::sync::Semaphore>,
    /// #110: per-client-IP sliding window of relay uses.
    relay_rate: Mutex<HashMap<IpAddr, VecDeque<u64>>>,
    /// Proxy hops in front of this server whose X-Forwarded-For entries
    /// are trusted (env TRUSTED_PROXY_HOPS). 0 means the TCP peer is the
    /// client, the safe default: X-Forwarded-For is client-controlled
    /// unless the proxy in front sets it.
    trusted_proxy_hops: usize,
    /// Ring buffer of recent log lines (JSON objects), newest last.
    /// Untagged (server-level) lines only; session-tagged lines live in
    /// `sessions` so /logs can never mix diagnostics across sessions.
    logs: Mutex<LogRing>,
    /// Per-session log rings keyed by the tab's lb_sess token. /logs
    /// requires the caller's token and returns only that ring, so one
    /// browser session can never read another's diagnostics.
    sessions: Mutex<HashMap<String, SessionRing>>,
    /// LB #138: TTL caches and a shared concurrency cap for the
    /// unauthenticated /suggest and /cert upstream lookups.
    suggest_cache: Mutex<HashMap<String, (u64, String)>>,
    cert_cache: Mutex<HashMap<String, (u64, String)>>,
    lookup_permits: tokio::sync::Semaphore,
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
            /* #127: the run holds only alnum/_/-/. bytes, so no other
            pattern can start inside it - advance to the end either
            way. Rescanning from i+1 on every non-JWT "eyJ" made
            redaction quadratic on hostile input. */
            if parts.len() == 3 && parts.iter().all(|p| !p.is_empty()) && run.len() >= 20 {
                out.push_str("[redacted-jwt]");
            } else {
                out.push_str(&run);
            }
            i = end;
            continue;
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

/// URL user-info credentials (scheme://user:pass@host) never
/// persist; the host and path stay for debugging. Mirrors the client
/// sanitizer (ui/src/sanitize.ts) - keep the patterns in sync.
fn redact_userinfo(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let Some(p) = s.find("://") else {
        out.push_str(s);
        return out;
    };
    out.push_str(&s[..p + 3]);
    let rest = &s[p + 3..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    match authority.rfind('@') {
        Some(a) if a > 0 => {
            out.push_str("[redacted-userinfo]");
            out.push_str(&rest[a..]);
        }
        _ => out.push_str(rest),
    }
    out
}

fn push_log(state: &AppState, level: &str, msg: &str) {
    let msg = truncate_bytes(&redact_secrets(&redact_userinfo(msg)), LOG_LINE_MAX_BYTES);
    let line = format!(
        "{{\"ts\":{},\"level\":\"{}\",\"msg\":\"{}\"}}",
        now_secs(),
        json_escape(level),
        json_escape(&msg)
    );
    let mut logs = state.logs.lock().unwrap_or_else(|e| e.into_inner());
    /* Split the guard deref once: two &mut guard.field borrows at one
    call would overlap through DerefMut. */
    let LogRing { ring, bytes, .. } = &mut *logs;
    ring_push_capped(ring, bytes, &line, 1000, GLOBAL_RING_MAX_BYTES);
}

/// Global (server-level) log ring with its byte budget (#135).
struct LogRing {
    ring: VecDeque<String>,
    bytes: usize,
}

/// Per-session diagnostic ring. Bounded independently so one noisy
/// session cannot exhaust the server's log budget, and idle sessions
/// are evicted so the map itself stays bounded.
struct SessionRing {
    ring: VecDeque<String>,
    bytes: usize,
    last_seen: u64,
}

/// LB #135: cap a log message at a byte budget without splitting a
/// UTF-8 character; the marker keeps truncation visible in /logs.
fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &s[..end])
}

/// LB #135: push a line into a ring, evicting oldest lines until both
/// the line-count cap and the byte budget hold.
fn ring_push_capped(
    ring: &mut VecDeque<String>,
    bytes: &mut usize,
    line: &str,
    max_lines: usize,
    max_bytes: usize,
) {
    while !ring.is_empty() && (ring.len() >= max_lines || *bytes + line.len() > max_bytes) {
        match ring.pop_front() {
            Some(old) => *bytes = bytes.saturating_sub(old.len()),
            None => break,
        }
    }
    ring.push_back(line.to_string());
    *bytes += line.len();
}

/// Cap on the session map (LRU-evicted) and idle expiry. Combined with
/// the per-ring cap this bounds worst-case session-log memory to
/// SESSIONS_CAP * SESSION_LOG_CAP lines.
const SESSIONS_CAP: usize = 128;
const SESSION_LOG_CAP: usize = 500;
const SESSION_IDLE_SECS: u64 = 1800;
/// LB #135: line-count caps alone let a few huge lines claim
/// megabytes, so every line is truncated and every ring also carries
/// a byte budget.
const LOG_LINE_MAX_BYTES: usize = 4 * 1024;
const SESSION_RING_MAX_BYTES: usize = 64 * 1024;
const GLOBAL_RING_MAX_BYTES: usize = 512 * 1024;

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
    let msg = truncate_bytes(&redact_secrets(&redact_userinfo(msg)), LOG_LINE_MAX_BYTES);
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
        bytes: 0,
        last_seen: 0,
    });
    ring_push_capped(
        &mut ring.ring,
        &mut ring.bytes,
        &line,
        SESSION_LOG_CAP,
        SESSION_RING_MAX_BYTES,
    );
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

/// Chrome's codec list, verbatim: the Accept-Encoding a real browser
/// advertises on every request. wreq's feature-derived default
/// ("gzip, br") is a client-library tell no Chrome emits (the engine
/// path's postman-echo probe showed it riding every relayed request),
/// so both upstream clients pin the real list; the enabled
/// gzip/deflate/brotli/zstd features still decode whatever upstream
/// sends back.
fn chrome_default_headers() -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(
        reqwest::header::ACCEPT_ENCODING,
        reqwest::header::HeaderValue::from_static("gzip, deflate, br, zstd"),
    );
    h
}

/// One persona major for the whole wire surface (2026-10-14 report,
/// issue 4): the wreq emulation profile, the User-Agent, and the
/// engine-side fingerprint data must all name the same Chrome major,
/// because the mismatch itself is a bot-scoring tell. Chrome149 is
/// the newest profile in the locked wreq-util 0.2.0. The drift test
/// in mod persona pins the emulation variant and the UA major
/// together (a persona bump is the two constant lines).
const CHROME_EMULATION: wreq_util::Profile = wreq_util::Emulation::Chrome149;
const CHROME_PERSONA_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

#[cfg(test)]
mod persona {
    use super::*;
    /* Drift check (2026-10-14 report): a UA naming a different major
    than the emulated TLS/h2 profile is exactly the class of mismatch
    the persona constant exists to remove. */
    #[test]
    fn chrome_persona_emulation_ua_and_major_agree() {
        let ua_major = CHROME_PERSONA_UA
            .split("Chrome/")
            .nth(1)
            .and_then(|rest| rest.split('.').next())
            .unwrap_or("");
        let emulation = format!("{:?}", CHROME_EMULATION);
        assert_eq!(ua_major, emulation.trim_start_matches("Chrome"));
    }
}

/// Shared lookup client: manual redirects (reqwest never follows a
/// 3xx on its own), the PolicyDns SSRF guard at connect time, and NO
/// cookie jar (#114): /suggest and /cert are stateless lookups, and a
/// shared jar would replay one user's provider cookies onto another
/// user's lookups. The engine's jar owns browser cookies; they ride
/// the relay as headers.
fn build_engine_client() -> reqwest::Client {
    reqwest::Client::builder()
        // Chrome persona TLS/HTTP2 emulation (CHROME_EMULATION): must
        // be set before any later builder call that reads TLS/HTTP
        // options (wreq applies the emulation over them). The
        // upstream sees a browser-shaped ClientHello, h2 SETTINGS
        // frame and header order instead of the rust/hyper
        // fingerprint (Zeolite #149/#160 class).
        .emulation(CHROME_EMULATION)
        .user_agent(CHROME_PERSONA_UA)
        .default_headers(chrome_default_headers())
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(std::sync::Arc::new(PolicyDns))
        .cookie_store(false)
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
        // Chrome persona TLS/HTTP2 emulation (CHROME_EMULATION), the
        // same profile the engine client uses: the relay exists
        // precisely because some hosts fingerprint-block the wasm
        // transports, so the embedder hop must look like a real
        // browser at the TLS and h2 layers too, not only in headers.
        .emulation(CHROME_EMULATION)
        .default_headers(chrome_default_headers())
        .connect_timeout(std::time::Duration::from_secs(8))
        .read_timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(std::sync::Arc::new(PolicyDns))
        .cookie_store(false)
        .build()
        .expect("reqwest relay client")
}

/// First-byte wait for relayed requests (2026-10-14 report, issue 3):
/// strictly shorter than the engine's navigation deadline (30s
/// NAV_TTFB_DEADLINE_MS) so the relay's own diagnostic 502 with the
/// failure source chain wins the race; the user sees the cause
/// instead of the service worker's generic deadline error. send()
/// resolves at the first response header, so a healthy streamed body
/// never pays it; the 30s read timeout still bounds a stalled one.
const RELAY_HEADER_WAIT: std::time::Duration = std::time::Duration::from_secs(20);

/// LB #137: total wall-clock budget for one relayed response body.
/// Generous by design - a healthy slow stream must never pay it - but
/// it exists so a drip-fed upstream cannot hold a relay task, socket
/// and permit forever. The stream errors at the deadline and the
/// engine surfaces the honest failure. ponytail: 10 min flat; make it
/// a per-request policy knob if a site legitimately needs longer.
const RELAY_TOTAL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(600);

/// #110: relay resource bounds. Concurrent upstream CONNECTS are
/// semaphore-bounded (the permit lives until the response headers are
/// in; bodies then stream under the client read timeout), and each
/// client IP may start at most this many relay connects per window.
const RELAY_MAX_CONCURRENT_CONNECTS: usize = 16;
const RELAY_RATE_WINDOW_SECS: u64 = 10;
const RELAY_RATE_MAX_PER_WINDOW: usize = 30;

async fn relay_send_wait(
    req: reqwest::RequestBuilder,
    wait: std::time::Duration,
) -> Result<reqwest::Response, String> {
    match tokio::time::timeout(wait, req.send()).await {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => {
            /* The wreq Display alone says only "error sending request";
            the source chain says WHY (connect timeout, reset by peer,
            TLS failure). LB #75 needs that distinction on the wire. */
            let mut chain = e.to_string();
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                chain.push_str(" :: ");
                chain.push_str(&s.to_string());
                src = s.source();
            }
            Err(chain)
        }
        Err(_) => Err(format!(
            "relay: no response headers within {}s :: operation timed out",
            wait.as_secs()
        )),
    }
}

#[cfg(test)]
mod relay_wait {
    use super::*;
    /* 2026-10-14 report, issue 3: a tarpit upstream that accepts the
    connection but never sends a header must get the relay's own
    diagnostic before the engine's navigation deadline fires. */
    #[tokio::test]
    async fn stalled_upstream_gets_the_relay_diagnostic() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (_sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            /* never write a byte: the upstream tarpits */
        });
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(1))
            .build()
            .unwrap();
        let res = relay_send_wait(
            client.get(format!("http://{}/", addr)),
            std::time::Duration::from_millis(300),
        )
        .await;
        match res {
            Err(msg) => assert!(
                msg.contains("no response headers within"),
                "diagnostic: {}",
                msg
            ),
            Ok(_) => panic!("a stalled upstream must not produce headers"),
        }
    }
}

#[cfg(test)]
mod relay_guard_tests {
    use super::*;

    /* ---- #115: literal-IP destinations ---- */
    #[test]
    fn relay_dest_rejects_private_ip_literals() {
        for d in [
            "http://127.0.0.1/",
            "http://127.0.0.1:8080/x?y=1",
            "http://0.0.0.0/",
            "http://10.0.0.1/",
            "http://172.16.0.9/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://198.18.0.5/",
            "http://[::1]/",
            "http://[::]/",
            "http://[fe80::1]/",
            "http://[fc00::5]/",
            "http://[::ffff:127.0.0.1]/",
        ] {
            assert!(relay_dest_rejected(d).is_some(), "must reject {d}");
        }
    }

    #[test]
    fn relay_dest_numeric_spellings_normalize_before_the_policy_check() {
        // Same loopback destinations in alternate numeric spellings:
        // the URL parser canonicalizes, the string is never prefix-checked.
        for d in ["http://2130706433/", "http://0x7f.0.0.1/"] {
            assert!(relay_dest_rejected(d).is_some(), "must reject {d}");
        }
    }

    #[test]
    fn relay_dest_allows_policy_clean_destinations() {
        for d in [
            "https://example.com/",
            "http://8.8.8.8/",
            "https://[2606:4700::1111]/",
            "http://1.1.1.1:443/x",
        ] {
            assert!(relay_dest_rejected(d).is_none(), "must allow {d}");
        }
    }

    #[test]
    fn relay_dest_rejects_malformed_and_non_http_schemes() {
        for d in [
            "ftp://example.com/",
            "file:///etc/passwd",
            "not a url",
            "http://",
        ] {
            assert!(relay_dest_rejected(d).is_some(), "must reject {d}");
        }
    }

    /* ---- #110: authorization + resource bounds ---- */
    #[test]
    fn relay_authorizes_same_origin_browser_requests() {
        assert_eq!(
            relay_client_authorized(None, None, Some("same-origin"), None, None),
            Ok(())
        );
        assert_eq!(
            relay_client_authorized(None, None, Some("none"), None, None),
            Ok(())
        );
        assert_eq!(
            relay_client_authorized(Some("https://lb.test"), Some("lb.test"), None, None, None),
            Ok(())
        );
    }

    #[test]
    fn relay_rejects_cross_site_and_unauthorized_direct_requests() {
        assert_eq!(
            relay_client_authorized(None, None, Some("cross-site"), None, None),
            Err("relay: cross-site relay use is not allowed")
        );
        assert_eq!(
            relay_client_authorized(None, None, Some("same-site"), None, None),
            Err("relay: cross-site relay use is not allowed")
        );
        // Bare direct POST: no Sec-Fetch-Site, no Origin, no token.
        assert_eq!(
            relay_client_authorized(None, None, None, None, None),
            Err("relay: unauthorized")
        );
        // Foreign Origin.
        assert_eq!(
            relay_client_authorized(Some("https://evil.test"), Some("lb.test"), None, None, None),
            Err("relay: origin is not allowed")
        );
    }

    #[test]
    fn relay_token_mode_requires_the_capability_on_every_request() {
        let want = Some("deploy-secret");
        assert_eq!(
            relay_client_authorized(None, None, None, Some("deploy-secret"), want),
            Ok(())
        );
        assert_eq!(
            relay_client_authorized(None, None, Some("same-origin"), None, want),
            Err("relay: unauthorized (missing or wrong x-zl-relay-token)")
        );
        assert_eq!(
            relay_client_authorized(None, None, None, Some("wrong"), want),
            Err("relay: unauthorized (missing or wrong x-zl-relay-token)")
        );
    }

    #[test]
    fn client_ip_for_rate_ignores_headers_by_default() {
        let peer: IpAddr = "10.0.0.9".parse().unwrap();
        let mut h = axum::http::HeaderMap::new();
        h.insert("x-forwarded-for", "203.0.113.7".parse().unwrap());
        assert_eq!(client_ip_for_rate(&h, peer, 0), peer);
    }

    #[test]
    fn client_ip_for_rate_takes_entry_from_the_right() {
        let peer: IpAddr = "10.0.0.9".parse().unwrap();
        let mut h = axum::http::HeaderMap::new();
        // The client may prepend anything; only the trusted hop's entry counts.
        h.insert("x-forwarded-for", "198.51.100.1, 203.0.113.7".parse().unwrap());
        assert_eq!(client_ip_for_rate(&h, peer, 1), "203.0.113.7".parse::<IpAddr>().unwrap());
        assert_eq!(client_ip_for_rate(&h, peer, 2), "198.51.100.1".parse::<IpAddr>().unwrap());
        // Too few entries, or junk: fall back to the peer.
        assert_eq!(client_ip_for_rate(&h, peer, 3), peer);
        h.insert("x-forwarded-for", "not-an-ip".parse().unwrap());
        assert_eq!(client_ip_for_rate(&h, peer, 1), peer);
    }

    #[test]
    fn relay_rate_window_bounds_each_ip_independently() {
        let map = Mutex::new(HashMap::new());
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        for _ in 0..RELAY_RATE_MAX_PER_WINDOW {
            assert!(relay_rate_allow(&map, ip, 1000));
        }
        assert!(!relay_rate_allow(&map, ip, 1005), "window is full");
        let other: IpAddr = "203.0.113.10".parse().unwrap();
        assert!(relay_rate_allow(&map, other, 1005), "per-IP window");
        // The window slides: after it expires the IP is allowed again.
        assert!(relay_rate_allow(&map, ip, 1000 + RELAY_RATE_WINDOW_SECS));
    }

    /* ---- #111 mirror: user-info credentials never persist ---- */
    #[test]
    fn redact_userinfo_strips_embedded_credentials() {
        let out = redact_userinfo("engine GET https://user:secret@example.com/reset");
        assert!(out.contains("[redacted-userinfo]@"), "{out}");
        assert!(out.contains("example.com/reset"), "{out}");
        assert!(!out.contains("secret"), "{out}");
        assert_eq!(redact_userinfo("no url here"), "no url here");
        assert_eq!(
            redact_userinfo("https://example.com/x"),
            "https://example.com/x"
        );
    }
}

#[cfg(test)]
mod engine_client_cookie_tests {
    use super::*;

    /* #114: the shared lookup client (/suggest, /cert) must be
    cookie-less. A Set-Cookie answer from one user's lookup must
    never be replayed on another user's request to the same provider.
    The upstream is addressed by literal IP, so PolicyDns is not
    consulted (literal destinations bypass the DNS resolver). */
    #[tokio::test]
    async fn lookup_client_never_replays_upstream_cookies() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        tokio::spawn(async move {
            let app = Router::new().route(
                "/",
                get(move |hm: axum::http::HeaderMap| async move {
                    seen2.lock().unwrap().push(
                        hm.get(header::COOKIE)
                            .and_then(|v| v.to_str().ok().map(String::from)),
                    );
                    ([(header::SET_COOKIE, "probe=1; Path=/")], "ok")
                }),
            );
            axum::serve(listener, app).await.unwrap();
        });
        let client = build_engine_client();
        client.get(format!("http://{addr}/")).send().await.unwrap();
        client.get(format!("http://{addr}/")).send().await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].is_none(), "first request carries no cookie");
        assert!(
            seen[1].is_none(),
            "Set-Cookie must not persist into a later lookup: {:?}",
            seen[1]
        );
    }
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
            /* Proxy-injected hop headers describe the proxy in front
               of the server, never the virtual page; real browsers do
               not send them upstream and strict WAF zones read them as
               a proxy tell (#160). Defense in depth behind the engine's
               own strip: the relay never re-sends them even if a
               client includes them in the relay header pairs. */
            | "x-forwarded-for"
            | "x-forwarded-proto"
            | "x-forwarded-host"
            | "x-forwarded-port"
            | "x-forwarded-server"
            | "x-forwarded-cluster"
            | "x-real-ip"
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

/// #115: validate a relay destination BEFORE any upstream connect.
/// PolicyDns only sees DNS names - literal-IP destinations bypass the
/// resolver entirely - so the destination is parsed once with the URL
/// parser (every numeric spelling normalizes inside it: 2130706433,
/// 0x7f.0.0.1 and [::ffff:127.0.0.1] all become canonical hosts, no
/// string-prefix checks) and the canonical host is judged by the SAME
/// DestinationPolicy the resolver applies to resolved addresses.
/// Malformed destinations and non-HTTP(S) schemes never reach the
/// client. DNS names keep the resolve-then-validate path (PolicyDns
/// checks every resolved address, fail-closed) and also get the
/// local-name pre-check here.
fn relay_dest_rejected(dest: &str) -> Option<String> {
    let url = match ::url::Url::parse(dest) {
        Ok(u) => u,
        Err(_) => return Some("relay: dest must be an absolute http(s) URL".into()),
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return Some("relay: dest must be http(s)".into());
    }
    let Some(host_raw) = url.host_str() else {
        return Some("relay: dest has no host".into());
    };
    // URL parsers keep the brackets on IPv6 literals; strip them so
    // the IP parser below sees a bare address.
    let host = host_raw
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_string();
    let policy = zeolite_server::policy::DestinationPolicy::default();
    match policy.check_hostname(&host) {
        zeolite_server::policy::Verdict::Allow => None,
        zeolite_server::policy::Verdict::Block => {
            Some(format!("relay: destination {host} is blocked by policy"))
        }
    }
}

/// #110: authorization model for the public relay endpoint, enforced
/// server-side before any outbound work. Browser requests must be
/// same-origin: Sec-Fetch-Site (always set by the Chromium engine
/// host, on every fetch method) must be same-origin/none, which kills
/// cross-site form/simple-request abuse; without it, an explicit
/// Origin matching the deployment's own Host passes, everything else
/// is refused. A deployment that sets ZL_RELAY_TOKEN requires the
/// same capability value in x-zl-relay-token on EVERY request - that
/// is the authorization boundary for direct (non-browser) clients.
/// A bare direct POST (no Sec-Fetch-Site, no Origin) is refused; a
/// forged-header client is only stopped by the token mode, which the
/// engine host cannot use yet (the SW would have to send it).
fn relay_client_authorized(
    origin: Option<&str>,
    host: Option<&str>,
    sec_fetch_site: Option<&str>,
    token: Option<&str>,
    want_token: Option<&str>,
) -> Result<(), &'static str> {
    if let Some(want) = want_token {
        return if Some(want) == token {
            Ok(())
        } else {
            Err("relay: unauthorized (missing or wrong x-zl-relay-token)")
        };
    }
    match sec_fetch_site {
        Some("same-origin") | Some("none") => Ok(()),
        Some(_) => Err("relay: cross-site relay use is not allowed"),
        None => match origin {
            None => Err("relay: unauthorized"),
            Some(o) => {
                let host = host.unwrap_or("");
                if o == format!("https://{host}") || o == format!("http://{host}") {
                    Ok(())
                } else {
                    Err("relay: origin is not allowed")
                }
            }
        },
    }
}

/// #110: per-IP sliding window for relay connects. The now parameter
/// is injected so the regression test can move the window without
/// sleeping.
/// The address the relay rate limit keys on. With no trusted proxy
/// (hops == 0) that is the TCP peer. With N trusted hops it is the entry
/// N places from the right of X-Forwarded-For, the address the nearest
/// trusted proxy recorded for the client. An absent or malformed header
/// falls back to the peer, so a spoofed header can only change the key
/// when the operator has said proxies are trusted.
fn client_ip_for_rate(headers: &axum::http::HeaderMap, peer: IpAddr, hops: usize) -> IpAddr {
    if hops == 0 {
        return peer;
    }
    let Some(raw) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) else {
        return peer;
    };
    let entries: Vec<&str> = raw.split(',').map(str::trim).collect();
    if entries.len() < hops {
        return peer;
    }
    entries[entries.len() - hops].parse().unwrap_or(peer)
}

fn relay_rate_allow(map: &Mutex<HashMap<IpAddr, VecDeque<u64>>>, ip: IpAddr, now: u64) -> bool {
    let mut map = map.lock().unwrap();
    if map.len() > 4096 {
        // Bound map growth: drop fully-expired idle windows.
        map.retain(|_, w| !w.is_empty());
    }
    let win = map.entry(ip).or_default();
    while let Some(&t) = win.front() {
        if now.saturating_sub(t) >= RELAY_RATE_WINDOW_SECS {
            win.pop_front();
        } else {
            break;
        }
    }
    if win.len() < RELAY_RATE_MAX_PER_WINDOW {
        win.push_back(now);
        true
    } else {
        false
    }
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
/// engine hop chain re-issues them). ponytail: RELAY_HEADER_WAIT
/// bounds only the wait for the first response header, so a healthy
/// streamed body never pays it; long-lived event-stream relays are
/// not a use case.
async fn zl_relay_endpoint(
    State(state): State<Arc<AppState>>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let bad = |code: StatusCode, msg: &str| -> Response { (code, msg.to_string()).into_response() };
    /* #110: authorize BEFORE any JSON parsing or outbound work. The
    request body stays bounded by axum's default 2 MiB extractor
    limit, so a relay envelope can never balloon memory. */
    if let Err(msg) = relay_client_authorized(
        headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()),
        headers.get(header::HOST).and_then(|v| v.to_str().ok()),
        headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()),
        headers
            .get("x-zl-relay-token")
            .and_then(|v| v.to_str().ok()),
        state.relay_token.as_deref(),
    ) {
        return bad(StatusCode::FORBIDDEN, msg);
    }
    let rate_ip = client_ip_for_rate(&headers, peer.ip(), state.trusted_proxy_hops);
    if !relay_rate_allow(&state.relay_rate, rate_ip, now_secs()) {
        return bad(
            StatusCode::TOO_MANY_REQUESTS,
            "relay: rate limit exceeded, retry later",
        );
    }
    let relay_permit = match state.relay_permits.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return bad(
                StatusCode::SERVICE_UNAVAILABLE,
                "relay: too many concurrent relay connects",
            )
        }
    };
    let req: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return bad(StatusCode::BAD_REQUEST, &format!("relay body: {}", e)),
    };
    let Some(dest) = req.get("dest").and_then(|v| v.as_str()) else {
        return bad(StatusCode::BAD_REQUEST, "relay: dest missing");
    };
    /* #115: literal-IP destinations bypass PolicyDns; the parsed,
    canonical host must pass the same DestinationPolicy first. */
    if let Some(msg) = relay_dest_rejected(dest) {
        return bad(StatusCode::FORBIDDEN, &msg);
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
    /* The relay client negotiates real content encoding: wreq
    advertises gzip/br/zstd/deflate and transparently decodes the
    answer, so the SW still receives identity bytes while the
    upstream request carries a browser-shaped Accept-Encoding
    instead of the identity tell (Zeolite #160 header diff). The
    response filter strips content-encoding/content-length the
    decoded stream redefines. */
    if let Some(b) = req.get("body").and_then(|v| v.as_str()) {
        out = out.body(b.to_string());
    } else if let Some(b64s) = req.get("body_b64").and_then(|v| v.as_str()) {
        match relay_base64_decode(b64s) {
            Some(bytes) => out = out.body(bytes),
            None => return bad(StatusCode::BAD_REQUEST, "relay: bad body_b64"),
        }
    }
    let upstream = match relay_send_wait(out, RELAY_HEADER_WAIT).await {
        Ok(r) => r,
        Err(msg) => return bad(StatusCode::BAD_GATEWAY, &msg),
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
    /* LB #137: the permit moves into the stream so it is held for the
    body's whole life, and the stream carries a total deadline - the
    idle read_timeout cannot stop a drip-fed upstream. */
    let deadline = tokio::time::Instant::now() + RELAY_TOTAL_DEADLINE;
    let mut upstream_stream = Box::pin(upstream.bytes_stream());
    let streamed = Body::from_stream(futures_util::stream::poll_fn(move |cx| {
        let _hold_permit = &relay_permit;
        if tokio::time::Instant::now() >= deadline {
            return std::task::Poll::Ready(Some(Err(
                "relay: total body deadline exceeded".to_string()
            )));
        }
        futures_util::Stream::poll_next(upstream_stream.as_mut(), cx)
            .map(|opt| opt.map(|res| res.map_err(|e| e.to_string())))
    }));
    (StatusCode::OK, hm, streamed).into_response()
}

/// LB #138: bounds for the unauthenticated /suggest and /cert
/// upstream lookups: response body caps, TTL caches and a shared
/// concurrency cap so neither endpoint can be turned into an
/// unbounded-memory or connection-flooding primitive.
const SUGGEST_BODY_CAP: usize = 256 * 1024;
const CT_BODY_CAP: usize = 1024 * 1024;
const SUGGEST_CACHE_TTL_SECS: u64 = 120;
const CERT_CACHE_TTL_SECS: u64 = 300;
const LOOKUP_CACHE_MAX: usize = 256;
const LOOKUP_MAX_CONCURRENT: usize = 8;

/* LB #138: read a response body up to a byte cap. reqwest's .text()
buffers the whole body; the cap is the honest bound for an
unauthenticated endpoint fed by upstreams we do not control. */
async fn read_body_capped(resp: reqwest::Response, cap: usize) -> Result<String, String> {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("body read failed: {}", e))?;
        if buf.len() + chunk.len() > cap {
            return Err("body exceeds cap".to_string());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/* LB #138: TTL cache get/put shared by the suggest and cert lookups. */
fn cache_get(cache: &Mutex<HashMap<String, (u64, String)>>, key: &str, now: u64) -> Option<String> {
    let map = cache.lock().unwrap_or_else(|e| e.into_inner());
    match map.get(key) {
        Some((expires, v)) if *expires > now => Some(v.clone()),
        _ => None,
    }
}

fn cache_put(
    cache: &Mutex<HashMap<String, (u64, String)>>,
    key: &str,
    value: String,
    ttl_secs: u64,
    now: u64,
) {
    let mut map = cache.lock().unwrap_or_else(|e| e.into_inner());
    if map.len() >= LOOKUP_CACHE_MAX && !map.contains_key(key) {
        // ponytail: arbitrary eviction at the cap; a real LRU only if
        // hit locality ever measurably matters.
        if let Some(oldest) = map.keys().next().cloned() {
            map.remove(&oldest);
        }
    }
    map.insert(key.to_string(), (now + ttl_secs, value));
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
            /* #136: the hex pair is read from the BYTE slice;
            slicing the &str at i+1..i+3 panics on a char
            boundary when raw multi-byte characters follow
            the '%' (http 1.5 accepts high bytes in
            the query string). An invalid-UTF-8 or non-hex
            pair falls through as literal bytes. */
            if let Ok(pair) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(v) = u8::from_str_radix(pair, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
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
/* #136 regression: the hex pair read must never slice the &str
on a char boundary; a raw UTF-8 query used to panic the
connection handler here. */
#[cfg(test)]
mod percent_decode_tests {
    use super::percent_decode;

    #[test]
    fn decodes_pairs_and_plus() {
        assert_eq!(percent_decode("a%20b+c"), "a b c");
    }

    #[test]
    fn non_ascii_after_percent_stays_literal() {
        assert_eq!(percent_decode("%1é"), "%1é");
    }
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
.dt {{ margin:-0.9em 0 1.2em; font-size:.8125rem; opacity:.7; }}
button {{ font:inherit; padding:.45em 1.6em; background:none; color:inherit;
  border:1px solid currentColor; border-radius:6px; cursor:pointer; }}
@media (prefers-color-scheme: dark) {{ body {{ background:#0f0f10; color:#e8e8ea; }} p {{ color:#9b9ba0; }} }}
</style></head><body><main>
<h1>{title}</h1>
<p>{line}</p>
<p>{action}</p>
<p class="dt">{category} · HTTP {status}</p>
{retry_form}
</main></body></html>"#,
        meta = meta,
        title = json_escape(title),
        line = json_escape(line),
        action = json_escape(action),
        category = json_escape(category),
        status = code.as_u16(),
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
    /* #127: the query is attacker-sized input; a 256-char prefix
    keeps the log useful while bounding the redaction scan. */
    let q_log: String = q.chars().take(256).collect();
    push_log_sess(
        &state,
        sess.as_deref(),
        "info",
        &format!("suggest {} {}", engine, q_log),
    );
    let now = now_secs();
    let cache_key = format!("{}|{}", engine, q);
    /* LB #138: repeats inside the TTL serve from the cache, and the
    upstream fan-out holds one of a small shared permit set. */
    if let Some(cached) = cache_get(&state.suggest_cache, &cache_key, now) {
        return ([("content-type", "application/json")], cached).into_response();
    }
    let _lookup_permit = match state.lookup_permits.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            push_log_sess(
                &state,
                sess.as_deref(),
                "warn",
                "suggest lookup capacity exceeded",
            );
            return (
                [("content-type", "application/json")],
                "{\"suggestions\":[],\"source\":\"\"}",
            )
                .into_response();
        }
    };
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
            // LB #138: per-try budget so one dead provider cannot pin
            // the shared permit for the client timeout.
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
        {
            Ok(r) => match r.error_for_status() {
                Ok(r) => match read_body_capped(r, SUGGEST_BODY_CAP).await {
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
    cache_put(
        &state.suggest_cache,
        &cache_key,
        out.clone(),
        SUGGEST_CACHE_TTL_SECS,
        now,
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
        .header("user-agent", CHROME_PERSONA_UA)
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("status {}", status));
    }
    read_body_capped(resp, CT_BODY_CAP).await
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
/// #128: browsers set Sec-Fetch-Site: same-origin for a
/// same-origin fetch; non-browser clients and cross-site pages
/// do not. The wisp URL bypasses the standalone wisp service's
/// own password, so only the UI boot gets to see it.
fn same_origin_fetch(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("same-origin"))
        .unwrap_or(false)
}

async fn build_endpoint(headers: axum::http::HeaderMap) -> Response {
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
    // ScramJet engine option: the vendored upstream bundle version
    // (pinned in the Dockerfile, surfaced via SCRAMJET_VERSION) and
    // its scramjet.js sha256 prefix — same stale-bundle detection as
    // zlswSha. The wisp URL (SCRAMJET_WISP_URL, the standalone
    // wisp-js backend service) is reported empty honestly when unset.
    let scramjet = {
        let v = std::env::var("SCRAMJET_VERSION").unwrap_or_default();
        if v.is_empty() {
            "unknown".to_string()
        } else {
            v
        }
    };
    let sj_sha = match tokio::fs::read("sj/scramjet.js").await {
        Ok(bytes) => {
            use sha2::{Digest, Sha256};
            let hash = Sha256::digest(&bytes);
            hash.iter()
                .take(8)
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        }
        Err(_) => "unknown".to_string(),
    };
    let sj_wisp = match std::env::var("SCRAMJET_WISP_URL") {
        Ok(v) if !v.is_empty() && same_origin_fetch(&headers) => v,
        _ => String::new(),
    };
    let lb_version = format!("{} Cobalt", env!("CARGO_PKG_VERSION"));
    let body = format!(
        "{{\"ok\":true,\"lb\":\"{}\",\"zeolite\":\"{}\",\"zlswSha\":\"{}\",\"scramjet\":\"{}\",\"sjSha\":\"{}\",\"sjWisp\":\"{}\",\"build\":\"{}\",\"buildShort\":\"{}\"}}",
        lb_version,
        json_escape(&zeolite),
        json_escape(&zlsw_sha),
        json_escape(&scramjet),
        json_escape(&sj_sha),
        json_escape(&sj_wisp),
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
    /* LB #138: same cache-and-cap posture as /suggest - repeats serve
    from the TTL cache, and the upstream fan-out holds one of the
    shared lookup permits. */
    let now = now_secs();
    if let Some(cached) = cache_get(&state.cert_cache, &host, now) {
        return ([(header::CONTENT_TYPE, "application/json")], cached).into_response();
    }
    let _lookup_permit = match state.lookup_permits.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            push_log(
                &state,
                "warn",
                &format!("cert lookup {}: lookup capacity exceeded", host),
            );
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::CONTENT_TYPE, "application/json")],
                "{\"ok\":false,\"error\":\"certificate lookup busy\"}",
            )
                .into_response();
        }
    };
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
            cache_put(
                &state.cert_cache,
                &host,
                out.clone(),
                CERT_CACHE_TTL_SECS,
                now,
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

use std::io::Write;
use std::sync::mpsc::{self, SyncSender, TrySendError};

/* Logs must never stall serving (mirror of the zeolite-server fix).
 * tracing_subscriber::fmt() writes each event with a blocking write
 * on the caller thread, and on the async runtime that thread is a
 * tokio worker. A stdout consumer that stops draining (a paused
 * container log driver, a full disk, a stalled log shipper) fills the
 * OS pipe and wedges the whole proxy: the standalone zeolite-server
 * reproduced a full serving freeze this way after ~64 KiB of undrained
 * log output. Each event now goes through a bounded channel to one
 * drain thread. A full buffer DROPS the event: a lost log line is
 * honest, a blocked runtime worker is not. */
struct NonBlockingWriter {
    tx: SyncSender<Vec<u8>>,
}

impl NonBlockingWriter {
    fn new() -> (Self, std::thread::JoinHandle<()>) {
        // 1024 events of head room: generous for normal traffic,
        // bounded so a stalled drain thread cannot grow memory.
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(1024);
        let handle = std::thread::Builder::new()
            .name("log-drain".to_owned())
            .spawn(move || {
                // This thread owns the blocking stdout writes. It is
                // outside the async runtime, so a slow consumer can
                // only ever stall itself, never request serving.
                let mut out = std::io::stdout().lock();
                for chunk in rx {
                    let _ = out.write_all(&chunk);
                }
                let _ = out.flush();
            })
            .expect("spawn log drain thread");
        (Self { tx }, handle)
    }
}

impl Write for NonBlockingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self.tx.try_send(buf.to_vec()) {
            Ok(()) => Ok(buf.len()),
            // Full buffer or dead drain thread: drop the event.
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => Ok(buf.len()),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for NonBlockingWriter {
    type Writer = NonBlockingWriter;
    fn make_writer(&'a self) -> Self::Writer {
        NonBlockingWriter {
            tx: self.tx.clone(),
        }
    }
}

#[tokio::main]
async fn main() {
    let (log_writer, _log_drain) = NonBlockingWriter::new();
    tracing_subscriber::fmt()
        .with_writer(log_writer)
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
        /* #110: strict token mode is opt-in per deployment; unset on
        Render so the engine's unauthenticated SW relay keeps working
        (the origin gate plus the rate/concurrency bounds are the
        default posture). */
        relay_token: std::env::var("ZL_RELAY_TOKEN")
            .ok()
            .filter(|t| !t.is_empty()),
        relay_permits: Arc::new(tokio::sync::Semaphore::new(RELAY_MAX_CONCURRENT_CONNECTS)),
        relay_rate: Mutex::new(HashMap::new()),
        trusted_proxy_hops: std::env::var("TRUSTED_PROXY_HOPS")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0),
        logs: Mutex::new(LogRing {
            ring: VecDeque::new(),
            bytes: 0,
        }),
        sessions: Mutex::new(HashMap::new()),
        suggest_cache: Mutex::new(HashMap::new()),
        cert_cache: Mutex::new(HashMap::new()),
        lookup_permits: tokio::sync::Semaphore::new(LOOKUP_MAX_CONCURRENT),
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
        // ScramJet engine bundle (upstream MercuryWorkshop, vendored
        // into sj/ at build time): the controller worker loads from
        // /sj/sw.js with the default /sj/ scope, so it coexists with
        // the Zeolite root worker (each fetch goes to the longest
        // matching scope). Its assets are plain static files under
        // the same prefix; the UI drives the engine from
        // ui/src/scramjet.ts.
        .route("/sj/sw.js", get(sj_sw_js))
        .nest_service("/sj", ServeDir::new("sj"))
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
        "LobsterBrowse native engine server listening on {} at {}",
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

/// ScramJet controller worker loader (the upstream
/// @mercuryworkshop/proxy-bootstrap sw.js template): hands fetch
/// events to $scramjetController from the vendored controller.sw.js.
/// Default /sj/ scope from the script path - no Service-Worker-Allowed
/// needed; no-cache so bundle updates are picked up promptly.
async fn sj_sw_js() -> Response {
    const SJ_SW: &str = concat!(
        "importScripts(\"/sj/controller.sw.js\");\n",
        "addEventListener(\"fetch\", (e) => {\n",
        "  if ($scramjetController.shouldRoute(e)) {\n",
        "    e.respondWith($scramjetController.route(e));\n",
        "  }\n",
        "});\n",
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/javascript")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(SJ_SW))
        .expect("static response build")
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
            relay_token: None,
            relay_permits: Arc::new(tokio::sync::Semaphore::new(RELAY_MAX_CONCURRENT_CONNECTS)),
            relay_rate: Mutex::new(HashMap::new()),
            trusted_proxy_hops: 0,
            logs: Mutex::new(LogRing {
                ring: VecDeque::new(),
                bytes: 0,
            }),
            sessions: Mutex::new(HashMap::new()),
            suggest_cache: Mutex::new(HashMap::new()),
            cert_cache: Mutex::new(HashMap::new()),
            lookup_permits: tokio::sync::Semaphore::new(LOOKUP_MAX_CONCURRENT),
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
        /* Proxy-injected hop headers must never ride the relay
        upstream (the engine strips them too; this is the
        server-side backstop). */
        assert!(!relay_request_header_allowed("x-forwarded-for"));
        assert!(!relay_request_header_allowed("x-forwarded-proto"));
        assert!(!relay_request_header_allowed("x-forwarded-host"));
        assert!(!relay_request_header_allowed("x-forwarded-port"));
        assert!(!relay_request_header_allowed("x-real-ip"));
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
        assert!(state.logs.lock().unwrap().ring.is_empty());
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
                bytes: 0,
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
        assert_eq!(state.logs.lock().unwrap().ring.len(), 1);
        assert!(state.sessions.lock().unwrap().is_empty());
    }

    /* LB #135 regression tests: the byte budgets are real bounds - a
    huge line must come back truncated and a noisy session must not
    blow past its ring budget. */
    #[test]
    fn log_lines_are_truncated_and_byte_capped() {
        let state = test_state();
        let big = "x".repeat(64 * 1024);
        push_log(&state, "info", &big);
        let logs = state.logs.lock().unwrap();
        assert_eq!(logs.ring.len(), 1);
        let line = logs.ring.back().unwrap();
        assert!(line.len() < big.len());
        assert!(line.contains("[truncated]"));
        assert!(line.len() <= LOG_LINE_MAX_BYTES + 256);
    }

    #[test]
    fn session_ring_respects_byte_budget() {
        let state = test_state();
        // 60 x ~2KiB lines exceed the 64KiB session budget; eviction
        // must keep the ring's byte total under the cap.
        for i in 0..60 {
            let msg = format!("line {i} {}", "y".repeat(2048));
            push_log_sess(&state, Some("session-a-token-111"), "info", &msg);
        }
        let sessions = state.sessions.lock().unwrap();
        let ring = sessions.get("session-a-token-111").unwrap();
        assert!(ring.bytes <= SESSION_RING_MAX_BYTES);
        assert!(!ring.ring.is_empty());
    }
}

#[cfg(test)]
mod lookup_cache_tests {
    use super::*;

    #[test]
    fn cache_put_then_get_within_ttl() {
        let cache = Mutex::new(HashMap::new());
        cache_put(&cache, "k", "v".to_string(), 100, 1);
        assert_eq!(cache_get(&cache, "k", 50).as_deref(), Some("v"));
        assert_eq!(cache_get(&cache, "k", 101), None); /* expired */
    }

    #[test]
    fn cache_is_capped() {
        let cache = Mutex::new(HashMap::new());
        for i in 0..(LOOKUP_CACHE_MAX + 10) {
            cache_put(&cache, &format!("k{i}"), "v".to_string(), 100, 1);
        }
        let map = cache.lock().unwrap();
        assert!(map.len() <= LOOKUP_CACHE_MAX);
    }
}

#[cfg(test)]
mod log_writer_tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn writer_from(tx: SyncSender<Vec<u8>>) -> NonBlockingWriter {
        NonBlockingWriter { tx }
    }

    #[test]
    fn a_full_buffer_drops_the_event_instead_of_blocking() {
        // Nobody drains the channel; after the buffer fills every
        // write must still return immediately. A stall here would
        // stall a runtime worker (the serving-freeze reproduction).
        let (tx, _rx) = mpsc::sync_channel::<Vec<u8>>(4);
        let mut w = writer_from(tx);
        let t0 = Instant::now();
        for _ in 0..2000 {
            assert_eq!(w.write(&[b'x'; 256]).unwrap(), 256);
        }
        assert!(
            t0.elapsed() < Duration::from_millis(500),
            "log writes must never block on a full pipe"
        );
    }

    #[test]
    fn the_drain_thread_preserves_content_and_fifo_order() {
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(16);
        let sink = std::thread::spawn(move || {
            let mut v = Vec::new();
            for chunk in rx {
                v.extend_from_slice(&chunk);
            }
            v
        });
        let mut w = writer_from(tx);
        let nl = char::from(10);
        for i in 0..5 {
            let line = format!("line-{i}{nl}");
            w.write_all(line.as_bytes()).unwrap();
        }
        drop(w);
        let text = String::from_utf8(sink.join().unwrap()).unwrap();
        let positions: Vec<usize> = (0..5)
            .map(|i| {
                let want = format!("line-{i}{nl}");
                text.find(&want).unwrap_or_else(|| {
                    panic!("missing {want:?} in drained output");
                })
            })
            .collect();
        let mut sorted = positions.clone();
        sorted.sort_unstable();
        assert_eq!(positions, sorted, "drain must be FIFO");
    }
}
