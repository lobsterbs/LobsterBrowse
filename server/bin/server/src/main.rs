//! LobsterBrowse native engine + wisp server entrypoint.
//!
//! Routes HTTP traffic normally and upgrades /wisp/ (configurable path)
//! to the Wisp protocol. The /r/* route is the native rewriting engine:
//! a target URL is base64url-encoded into the path, fetched server-side
//! with a shared cookie jar, and every URL-bearing attribute and CSS
//! url() reference is rewritten to another /r route so the page keeps
//! working same-origin. An injected shim patches fetch/XHR and element
//! setters at runtime, and the devtools hook reports console and
//! network activity to the UI.

use axum::body::{Body, Bytes};
use axum::extract::{OriginalUri, Path, RawQuery, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

/// Engine shim + devtools hook injected right after <head> of every
/// Engine shim + devtools hook injected right after <head> of every
/// rewritten HTML document. The shim routes runtime fetch/XHR, element
/// src/href assignments and history changes through /r routes; the hook
/// reports console output, errors, network traffic and page loads to
/// the parent UI window (same origin) via postMessage.
///
/// The JavaScript lives in engine-shim.js next to this file (readable
/// and lintable as JS) and is embedded verbatim at compile time; the
/// same binary self-containment as before, none of the Rust-side
/// escaping. Patch categories and their why-comments are inside it:
/// ENGINE CORE (routing), REWRITE COMPATIBILITY (URL/module/element
/// setters required by the server rewriter), DIAGNOSTICS (console/
/// network/error reporting) and LEGACY COMPAT (kept for known sites).
const ENGINE_JS: &str = include_str!("engine-shim.js");

/// Compatibility layer for proxied pages running inside a sandboxed
/// same-origin frame: service workers, install prompts and push
/// notifications either hang or misfire there, so stub them out.
/// The compat stubs live in engine-compat.js, embedded like the shim.
const COMPAT_JS: &str = include_str!("engine-compat.js");

/// Built-in network-filter rules applied when ad blocking is enabled.
/// Hostnames are matched with the adblock crate (same engine the Wisp
/// CONNECT path uses). An optional ADBLOCK_EXTRA file in the working
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
    /// Separate cookie jar for incognito routes (74.9): requests with
    /// lb_inc=1 use this client, so incognito cookies never mix into
    /// the shared jar (and vice versa). RAM only, no persistence.
    incognito_client: reqwest::Client,
    /// Ring buffer of recent log lines (JSON objects), newest last.
    logs: Mutex<VecDeque<String>>,
    /// Monotonic engine request counter for RES-XXXXXX correlation ids.
    /// Every proxied subresource gets one so a browser-side resource
    /// failure can be matched to its server-side fetch by URL + time.
    res_ids: AtomicU64,
    ads: adblock::FilterSet,
    trackers: adblock::FilterSet,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// RES-XXXXXX correlation id for engine requests. Bounded width (the
/// counter wraps at a million), one per proxied resource fetch, so a
/// browser-side resource failure can be traced to its server-side log
/// lines by URL + timestamp even when the page cannot know the id.
fn next_res_id(counter: &AtomicU64) -> String {
    let n = counter.fetch_add(1, Ordering::Relaxed) % 1_000_000;
    format!("RES-{n:06}")
}

fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "")
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

/// Hosts that must never be stripped by ad/tracker filters: they serve
/// CAPTCHA / anti-bot widgets (Cloudflare Turnstile and the challenge
/// interstitial). A filter-list false positive here silently kills
/// every captcha on the web.
const CHALLENGE_HOSTS: &[&str] = &[
    "challenges.cloudflare.com",
    "cloudflare.com",
    "js.stripe.com",
    "hcaptcha.com",
    "www.google.com", // reCAPTCHA
    "recaptcha.net",
];

fn is_challenge_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    CHALLENGE_HOSTS
        .iter()
        .any(|c| h == *c || h.ends_with(&format!(".{c}")))
}

/// Firefox User-Agent used for the suggestion providers (several reject
/// non-browser UAs) and force-applied to the Mozilla add-ons store:
/// AMO gates downloads on a Firefox client, so on addons.mozilla.org
/// the proxy always spoofs Firefox unless the user set an explicit UA.
const FIREFOX_UA: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

fn is_amo_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "addons.mozilla.org" || h.ends_with(".addons.mozilla.org")
}

/// Client-side companion to the AMO UA spoof: the store's JS reads
/// navigator.userAgent directly, so the header alone is not enough.
/// Injected into AMO documents right after the engine shim.
fn amo_spoof_script() -> &'static str {
    r#"<script>(function(){try{var ua="Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";Object.defineProperty(navigator,"userAgent",{get:function(){return ua;}});Object.defineProperty(navigator,"vendor",{get:function(){return "";}});Object.defineProperty(navigator,"oscpu",{get:function(){return "X11; Linux x86_64";}});Object.defineProperty(navigator,"userAgentData",{get:function(){return undefined;}});window.InstallTrigger={};}catch(e){}})();</script>"#
}

/// Insert a raw string right after the opening <head> tag (or prepend
/// when there is none), keeping the doctype intact.
fn insert_in_head(html: String, snippet: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let head_end = match lower.find("<head>") {
        Some(i) => Some(i + "<head>".len()),
        None => lower
            .find("<head ")
            .and_then(|i| lower[i..].find('>').map(|j| i + j + 1)),
    };
    match head_end {
        Some(pos) => {
            let mut owned = html;
            owned.insert_str(pos, snippet);
            owned
        }
        None => format!("{}{}", snippet, html),
    }
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
        let blocked = !host.is_empty()
            && !is_challenge_host(&host)
            && filters.iter().any(|f| f.is_blocked_hostname(&host));
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
/// would block the injected engine shim and break same-origin framing.
/// Returns the cleaned HTML plus how many CSP/XFO meta tags were removed
/// (74.7: the count feeds the lb-diag diagnostic meta so the UI can
/// attribute breakage to CSP stripping).
fn strip_csp_meta(html: &str) -> (String, usize) {
    let lower = html.to_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut i = 0usize;
    let mut search = 0usize;
    let mut removed = 0usize;
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
            removed += 1;
        }
        search = tag_end;
    }
    out.push_str(&html[i.min(html.len())..]);
    (out, removed)
}

/// Drop <base> tags: every relative URL is resolved and rewritten
/// server-side against the real page URL anyway.
fn strip_base_tags(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut i = 0usize;
    while let Some(rel) = lower[i..].find("<base") {
        let start = i + rel;
        let nextc = lower[start + 5..].chars().next();
        let ok = matches!(
            nextc,
            Some(' ') | Some('\t') | Some('\n') | Some('\r') | Some('>') | Some('/')
        );
        if !ok {
            out.push_str(&html[i..start + 5]);
            i = start + 5;
            continue;
        }
        let Some(endrel) = lower[start..].find('>') else {
            break;
        };
        out.push_str(&html[i..start]);
        i = start + endrel + 1;
    }
    out.push_str(&html[i.min(html.len())..]);
    out
}

/// Drop integrity="..." attributes: rewritten resources legitimately
/// differ from upstream bytes, so SRI would reject every one of them.
/// Returns the cleaned HTML plus the removed-attribute count (74.7:
/// feeds the lb-diag diagnostic meta).
fn strip_integrity(html: &str) -> (String, usize) {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut i = 0usize;
    let mut removed = 0usize;
    while let Some(rel) = lower[i..].find("integrity=") {
        let start = i + rel;
        let prev_ok = start == 0 || {
            let b = lower.as_bytes()[start - 1];
            b == b' ' || b == b'\t' || b == b'\n' || b == b'\r'
        };
        if !prev_ok {
            out.push_str(&html[i..start + 10]);
            i = start + 10;
            continue;
        }
        let after = &html[start + 10..];
        let Some(fc) = after.chars().next() else {
            break;
        };
        let skip = if fc == '"' || fc == '\'' {
            after[1..].find(fc).map(|e| e + 2).unwrap_or(after.len())
        } else {
            after.find([' ', '>']).unwrap_or(after.len())
        };
        out.push_str(&html[i..start]);
        i = start + 10 + skip;
        removed += 1;
    }
    out.push_str(&html[i.min(html.len())..]);
    (out, removed)
}

const B64URL_CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64URL_CHARS[(n >> 18 & 63) as usize] as char);
        out.push(B64URL_CHARS[(n >> 12 & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64URL_CHARS[(n >> 6 & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL_CHARS[(n & 63) as usize] as char);
        }
    }
    out
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut vals: Vec<u8> = Vec::with_capacity(s.len());
    for ch in s.bytes() {
        let v = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        vals.push(v);
    }
    let mut out = Vec::with_capacity(vals.len() * 3 / 4);
    for chunk in vals.chunks(4) {
        let n = ((chunk[0] as u32) << 18)
            | (chunk.get(1).map_or(0, |&v| (v as u32) << 12))
            | (chunk.get(2).map_or(0, |&v| (v as u32) << 6))
            | chunk.get(3).map_or(0, |&v| v as u32);
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

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

/// Resolve a possibly-relative reference against a base URL.
/// Returns None for schemes the engine does not touch.
fn resolve_url(base: &str, href: &str) -> Option<String> {
    let h = href.trim();
    if h.is_empty() {
        return Some(base.split('#').next().unwrap_or(base).to_string());
    }
    if let Some(rest) = h.strip_prefix("//") {
        return Some(format!("https://{}", rest));
    }
    if let Some(i) = h.find("://") {
        let scheme = h[..i].to_ascii_lowercase();
        if scheme == "http" || scheme == "https" {
            return Some(h.to_string());
        }
        return None;
    }
    let hl = h.to_ascii_lowercase();
    if hl.starts_with('#')
        || hl.starts_with("data:")
        || hl.starts_with("blob:")
        || hl.starts_with("javascript:")
        || hl.starts_with("mailto:")
        || hl.starts_with("tel:")
        || hl.starts_with("about:")
    {
        return None;
    }
    let bi = base.find("://")?;
    let after = &base[bi + 3..];
    let slash = after.find('/').unwrap_or(after.len());
    let origin = &base[..bi + 3 + slash];
    let path = &after[slash..];
    if h.starts_with('?') {
        let stripped = path.split(['?', '#']).next().unwrap_or(path);
        return Some(format!("{}{}{}", origin, stripped, h));
    }
    if h.starts_with('/') {
        return Some(format!("{}{}", origin, h));
    }
    let path_base = path.split(['?', '#']).next().unwrap_or(path);
    let dir = match path_base.rfind('/') {
        Some(p) => &path_base[..p + 1],
        None => "/",
    };
    let combined = format!("{}{}", dir, h);
    let mut segs: Vec<&str> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "." => {}
            ".." => {
                segs.pop();
            }
            s => segs.push(s),
        }
    }
    let joined = segs.join("/");
    let pathout = if joined.starts_with('/') {
        joined
    } else {
        format!("/{}", joined)
    };
    Some(format!("{}{}", origin, pathout))
}

/// Values the engine leaves untouched (fragments, inline schemes).
fn is_rewritable_url(v: &str) -> bool {
    let t = v.trim();
    if t.is_empty() || t.starts_with('#') {
        return false;
    }
    let tl = t.to_ascii_lowercase();
    !(tl.starts_with("data:")
        || tl.starts_with("blob:")
        || tl.starts_with("javascript:")
        || tl.starts_with("mailto:")
        || tl.starts_with("tel:")
        || tl.starts_with("about:"))
}

fn rewrite_url_attr(value: &str, page_url: &str, suffix: &str, prefix: &str) -> String {
    match resolve_url(page_url, value) {
        Some(abs) => {
            // Fragments are client-side only (SVG sprite symbols, in-page
            // anchors). They must never become part of the encoded request
            // target: the server would treat every "#symbol" variant of one
            // sprite as a distinct resource (distinct upstream fetch, cache
            // key, redirect log). The fragment is re-attached AFTER the
            // route so the browser keeps its fragment semantics (SVG <use>
            // symbol selection) while the network identity stays the
            // fragmentless URL. The browser never sends a fragment to the
            // server, so the two sides finally agree on resource identity.
            let (bare, frag) = match abs.split_once('#') {
                Some((b, f)) => (b, format!("#{}", f)),
                None => (abs.as_str(), String::new()),
            };
            format!(
                "{}{}{}{}",
                prefix,
                b64url_encode(bare.as_bytes()),
                suffix,
                frag
            )
        }
        None => value.to_string(),
    }
}

/// Next `import` or `from` keyword at a JavaScript identifier
/// boundary (not part of a longer identifier or a property access).
fn next_import_kw(js: &str, from: usize) -> Option<(usize, &'static str)> {
    let bytes = js.as_bytes();
    let mut best: Option<(usize, &'static str)> = None;
    for kw in ["import", "from"] {
        let mut s = from;
        while let Some(p) = js[s..].find(kw) {
            let abs = s + p;
            let boundary = abs == 0
                || !(bytes[abs - 1].is_ascii_alphanumeric()
                    || bytes[abs - 1] == b'_'
                    || bytes[abs - 1] == b'$'
                    || bytes[abs - 1] == b'.');
            if boundary {
                if best.map_or(true, |(p, _)| abs < p) {
                    best = Some((abs, kw));
                }
                break;
            }
            s = abs + kw.len();
        }
    }
    best
}

/// Rewrite import/export specifiers in JavaScript module code.
///
/// The browser's module loader resolves root-absolute and relative
/// specifiers against the DOCUMENT URL, which on the proxy origin is
/// /lj/<b64> (or /r/<b64>): `import "/cdn/assets/x.js"` in an inline
/// module therefore points at the proxy origin, 404s, and kills the
/// whole module graph before any script runs - chatgpt.com boots
/// exactly this way and surfaces as a resfail on the inline module
/// with no URL. The injected shim cannot help: module loading happens
/// below window.fetch. Specifiers are rewritten to the routed form
/// here, resolved against the upstream page/file URL. The same pass
/// on served .js bodies keeps nested module imports working.
///
/// Only import syntax positions are touched (bare `import "...`,
/// dynamic `import(...)` and `from "..."`, each with ', " or `
/// quoting), and only path-like specifiers (./ ../ / but not //).
/// Backtick templates containing `${` interpolation or backslash
/// escapes are left alone: those specifiers are runtime-computed
/// and cannot be resolved server-side. Bare import-map specifiers and
/// absolute data:/blob:/foreign URLs are left alone. A quoted
/// path-like string directly after the keyword AND followed by
/// statement punctuation is required; prose like `from "/db"` inside
/// template literals is a known rare false positive, and the rewrite
/// only changes string content, never syntax.
fn rewrite_js_imports(js: &str, page_url: &str, suffix: &str, prefix: &str) -> String {
    fn path_like(s: &str) -> bool {
        (s.starts_with("./")
            || s.starts_with("../")
            || (s.starts_with('/') && !s.starts_with("//")))
            && !s.contains(['"', '\''])
    }
    let mut out = String::with_capacity(js.len() + 256);
    let mut i = 0usize;
    loop {
        let Some((kw_pos, kw)) = next_import_kw(js, i) else {
            out.push_str(&js[i..]);
            return out;
        };
        let kw_end = kw_pos + kw.len();
        let after = &js[kw_end..];
        let a = after.as_bytes();
        let skip_ws = |j: &mut usize| {
            while *j < a.len() && matches!(a[*j], b' ' | b'\t' | b'\r' | b'\n') {
                *j += 1;
            }
        };
        let mut j = 0usize;
        skip_ws(&mut j);
        // Dynamic import: import(...) - consume the paren.
        if kw == "import" && j < a.len() && a[j] == b'(' {
            j += 1;
            skip_ws(&mut j);
        }
        let mut handled = false;
        if j < a.len() && (a[j] == b'"' || a[j] == b'\'' || a[j] == b'`') {
            let q = a[j] as char;
            if let Some(rl) = after[j + 1..].find(q) {
                let spec = &after[j + 1..j + 1 + rl];
                // Template literals with substitutions cannot be rewritten
                // (the value only exists at runtime); only plain-literal
                // templates (the common minifier output for dynamic
                // imports) are safe. chatgpt.com boots exactly this way.
                let interpolated = q == '`' && (spec.contains("${") || spec.contains('\\'));
                let close = j + 1 + rl;
                let mut k = close + 1;
                skip_ws(&mut k);
                let stmt_end = k >= a.len() || matches!(a[k], b';' | b')' | b'\n' | b',');
                if path_like(spec) && stmt_end && !interpolated {
                    out.push_str(&js[i..kw_end]);
                    out.push_str(&after[..j + 1]);
                    out.push_str(&rewrite_url_attr(spec, page_url, suffix, prefix));
                    out.push(q);
                    i = kw_end + close + 1;
                    handled = true;
                }
            }
        }
        if !handled {
            out.push_str(&js[i..kw_end]);
            i = kw_end;
        }
    }
}

#[cfg(test)]
mod js_import_tests {
    use super::rewrite_js_imports;

    #[test]
    fn root_absolute_specifiers_are_routed() {
        let out = rewrite_js_imports(
            "import \"/cdn/assets/a.js\";import*as r from\"/cdn/assets/b.js\";",
            "https://chatgpt.com/",
            "",
            "/lj/",
        );
        assert!(out.starts_with("import \"/lj/"), "bare import: {out}");
        assert!(out.contains("from\"/lj/"), "from clause: {out}");
    }

    #[test]
    fn dynamic_and_relative_specifiers() {
        let out = rewrite_js_imports(
            "const m=await import ( \"./x.js\" );export{a}from\"../y.js\";",
            "https://chatgpt.com/cdn/entry.js",
            "",
            "/lj/",
        );
        assert!(out.contains("import ( \"/lj/"), "dynamic: {out}");
        assert!(out.contains("from\"/lj/"), "export from: {out}");
    }

    #[test]
    fn non_import_text_survives() {
        let js = "const s=\"a from \\\"/db\\\";\";x.import(\"/no.js\");";
        assert_eq!(rewrite_js_imports(js, "https://a.com/", "", "/lj/"), js);
    }

    #[test]
    fn bare_and_absolute_specifiers_untouched() {
        let js =
            "import \"lodash\";import \"https://cdn.other.com/x.js\";import \"data:text/js,1\";";
        assert_eq!(rewrite_js_imports(js, "https://a.com/", "", "/lj/"), js);
    }

    #[test]
    fn template_literal_dynamic_imports_are_routed() {
        // chatgpt.com's entry client lazy-loads chunks exactly this way;
        // unresolved, ./x.js resolves against /lj/<b64> and 404s.
        let out = rewrite_js_imports(
            "const m=()=>import(`./conversation-small-abc.js`);const n=()=>import(`/cdn/assets/root.js`);",
            "https://chatgpt.com/cdn/assets/entry.js",
            "",
            "/lj/",
        );
        assert!(out.contains("import(`/lj/"), "template: {out}");
        // ./conversation-small-abc.js resolved against the entry's dir and
        // routed; the specifier is base64 so match the encoded prefix and
        // that the closing backtick survived.
        assert!(
            out.contains("/lj/aHR0cHM6Ly9jaGF0Z3B0LmNvbS9jZG4vYXNzZXRzL2NvbnZlcnNhdGlvbi1zbWFsbC1hYmMuanM`);"),
            "routed backtick: {out}"
        );
    }

    #[test]
    fn interpolated_templates_are_left_alone() {
        let js = "const m=()=>import(`./${name}.js`);";
        assert_eq!(rewrite_js_imports(js, "https://a.com/", "", "/lj/"), js);
    }
}

/// srcset="url 2x, url2 1x" â rewrite each candidate URL.
fn rewrite_srcset(value: &str, page_url: &str, suffix: &str, prefix: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for item in value.split(',') {
        let it = item.trim();
        if it.is_empty() {
            continue;
        }
        let mut split = it.splitn(2, char::is_whitespace);
        let u = split.next().unwrap_or("");
        let desc = split.next().map(|d| d.trim()).unwrap_or("");
        let desc_s = if desc.is_empty() {
            String::new()
        } else {
            format!(" {}", desc)
        };
        if is_rewritable_url(u) {
            parts.push(format!(
                "{}{}",
                rewrite_url_attr(u, page_url, suffix, prefix),
                desc_s
            ));
        } else {
            parts.push(it.to_string());
        }
    }
    parts.join(", ")
}

/// Rewrite url(...) references in CSS against the stylesheet's own URL.
fn rewrite_css(css: &str, base: &str, suffix: &str, prefix: &str) -> String {
    let lower = css.to_ascii_lowercase();
    let mut out = String::with_capacity(css.len());
    let mut i = 0usize;
    while let Some(rel) = lower[i..].find("url(") {
        let start = i + rel;
        out.push_str(&css[i..start + 4]);
        let after = &css[start + 4..];
        let mut value = String::new();
        let mut q: Option<char> = None;
        let mut end_off: Option<usize> = None;
        for (idx, ch) in after.char_indices() {
            if q.is_none() && (ch == '"' || ch == '\'') {
                q = Some(ch);
                value = String::new();
                continue;
            }
            if let Some(qc) = q {
                if ch == qc {
                    end_off = Some(idx + ch.len_utf8());
                    break;
                }
                value.push(ch);
            } else if ch == ')' {
                end_off = Some(idx);
                break;
            } else {
                value.push(ch);
            }
        }
        match end_off {
            Some(off) => {
                let v = value.trim().to_string();
                if is_rewritable_url(&v) {
                    out.push_str(&rewrite_url_attr(&v, base, suffix, prefix));
                } else {
                    out.push_str(&v);
                }
                i = start + 4 + off;
            }
            None => {
                out.push_str(after);
                i = css.len();
            }
        }
    }
    out.push_str(&css[i.min(css.len())..]);
    out
}

/// Rewrite URL-bearing attributes inside a single tag.
/// kind: 0 = plain URL attr, 1 = srcset, 2 = inline style CSS.
fn rewrite_tag(tag: &str, tag_lower: &str, page_url: &str, suffix: &str, prefix: &str) -> String {
    let attrs: [(&str, u8); 6] = [
        ("href=", 0),
        ("src=", 0),
        ("action=", 0),
        ("poster=", 0),
        ("srcset=", 1),
        ("style=", 2),
    ];
    let mut out = String::with_capacity(tag.len() + 64);
    let mut i = 0usize;
    loop {
        let mut best: Option<(usize, usize, u8)> = None;
        for (name, kind) in attrs {
            if let Some(p) = tag_lower[i..].find(name) {
                let abs = i + p;
                let prev_ok = abs == 0 || {
                    let b = tag_lower.as_bytes()[abs - 1];
                    b == b' ' || b == b'\t' || b == b'\n' || b == b'\r' || b == b'/'
                };
                if prev_ok && (best.is_none() || abs < best.unwrap().0) {
                    best = Some((abs, name.len(), kind));
                }
            }
        }
        let Some((pos, nlen, kind)) = best else {
            out.push_str(&tag[i..]);
            break;
        };
        out.push_str(&tag[i..pos]);
        let after = &tag[pos + nlen..];
        let Some(fc) = after.chars().next() else {
            out.push_str(&tag[pos..]);
            break;
        };
        let (value, consumed) = if fc == '"' || fc == '\'' {
            match after[1..].find(fc) {
                Some(e) => (after[1..1 + e].to_string(), e + 2),
                None => (after[1..].to_string(), after.len()),
            }
        } else {
            match after.find([' ', '\t', '\n', '\r']) {
                Some(e) => (after[..e].to_string(), e),
                None => (after.to_string(), after.len()),
            }
        };
        let new_value = match kind {
            1 => rewrite_srcset(&value, page_url, suffix, prefix),
            2 => rewrite_css(&value, page_url, suffix, prefix),
            _ => {
                if is_rewritable_url(&value) {
                    rewrite_url_attr(&value, page_url, suffix, prefix)
                } else {
                    value.clone()
                }
            }
        };
        out.push_str(&tag[pos..pos + nlen]);
        // Quote preservation: rewritten attributes used to lose their
        // quotes (b64 targets have no spaces so pages limped along,
        // but any rewritten value with a space — srcset descriptors,
        // style — bled into the following markup as bogus attributes).
        if fc == '"' || fc == '\'' {
            out.push(fc);
            out.push_str(&new_value);
            out.push(fc);
        } else {
            out.push_str(&new_value);
        }
        i = pos + nlen + consumed;
        if i >= tag.len() {
            break;
        }
    }
    out
}

/// Walk every tag in the document and rewrite URL-bearing attributes.
/// Script bodies are copied verbatim (runtime fetch/XHR are patched by
/// the injected shim); style blocks get CSS url() rewriting.
fn rewrite_html(html: &str, page_url: &str, suffix: &str, prefix: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() + 1024);
    let mut i = 0usize;
    while i < html.len() {
        let Some(rel) = lower[i..].find('<') else {
            out.push_str(&html[i..]);
            break;
        };
        let start = i + rel;
        let Some(endrel) = lower[start..].find('>') else {
            out.push_str(&html[start..]);
            break;
        };
        let end = start + endrel;
        let tag = &html[start..=end];
        let tag_lower = &lower[start..=end];
        if tag_lower.starts_with("<!--") {
            match lower[start..].find("-->") {
                Some(c) => {
                    out.push_str(&html[start..start + c + 3]);
                    i = start + c + 3;
                }
                None => {
                    out.push_str(&html[start..]);
                    break;
                }
            }
            continue;
        }
        if tag_lower.starts_with("<script") {
            out.push_str(&rewrite_tag(tag, tag_lower, page_url, suffix, prefix));
            /* type=module bodies: the module loader resolves import
            specifiers against the document URL (the /lj/ or /r/
            route), not the upstream site, so an inline module's
            imports must be rewritten or the app never boots
            (chatgpt.com's whole entry graph is exactly this). */
            let is_module = tag_lower.contains("type=\"module\"")
                || tag_lower.contains("type='module'")
                || tag_lower.contains("type=module");
            match lower[end + 1..].find("</script") {
                Some(c) => {
                    let cs = end + 1 + c;
                    let after_close = lower[cs..]
                        .find('>')
                        .map(|x| cs + x + 1)
                        .unwrap_or(html.len());
                    let body = &html[end + 1..cs];
                    if is_module {
                        out.push_str(&rewrite_js_imports(body, page_url, suffix, prefix));
                    } else {
                        out.push_str(body);
                    }
                    out.push_str(&html[cs..after_close]);
                    i = after_close;
                }
                None => {
                    let body = &html[end + 1..];
                    if is_module {
                        out.push_str(&rewrite_js_imports(body, page_url, suffix, prefix));
                    } else {
                        out.push_str(body);
                    }
                    break;
                }
            }
            continue;
        }
        if tag_lower.starts_with("<style") {
            out.push_str(&rewrite_tag(tag, tag_lower, page_url, suffix, prefix));
            match lower[end + 1..].find("</style") {
                Some(c) => {
                    let cs = end + 1 + c;
                    let after_close = lower[cs..]
                        .find('>')
                        .map(|x| cs + x + 1)
                        .unwrap_or(html.len());
                    out.push_str(&rewrite_css(&html[end + 1..cs], page_url, suffix, prefix));
                    out.push_str(&html[cs..after_close]);
                    i = after_close;
                }
                None => {
                    out.push_str(&rewrite_css(&html[end + 1..], page_url, suffix, prefix));
                    break;
                }
            }
            continue;
        }
        out.push_str(&rewrite_tag(tag, tag_lower, page_url, suffix, prefix));
        i = end + 1;
    }
    out
}

/// Neutralize frame-buster code in served scripts and inline JS.
///
/// The browser renders engine pages inside its UI frame, so `top` is
/// cross-origin from the page's perspective. Classic frame-buster code
/// (`if (top != self) top.location = location`) then throws a
/// SecurityError at the top level of the script, aborting every
/// statement after it - sites like detectmybrowser.com lose their
/// whole app to this. Two rewrites restore top-level semantics:
///
/// - framed-detection guards fold to their "not framed" values;
/// - `top.location` navigation writes sink into a harmless property
///   (page code must never navigate the UI shell), reads map to the
///   page's own location.
fn js_antiframe(js: &str) -> String {
    let mut s = replace_bound(js, "window.self", "self");
    s = replace_bound(&s, "window.top", "top");
    for (pat, rep) in [
        ("top !== self", "self !== self"),
        ("top != self", "self != self"),
        ("top === self", "self === self"),
        ("top == self", "self == self"),
        ("self !== top", "self !== self"),
        ("self != top", "self != self"),
        ("self === top", "self === self"),
        ("self == top", "self == self"),
        ("top!==self", "self!==self"),
        ("top!=self", "self!=self"),
        ("top===self", "self===self"),
        ("top==self", "self==self"),
        ("self!==top", "self!==self"),
        ("self!=top", "self!=self"),
        ("self===top", "self===self"),
        ("self==top", "self==self"),
    ] {
        s = replace_bound(&s, pat, rep);
    }
    js_antiframe_scan(&s)
}

fn lb_is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// Substring replace that respects identifier boundaries, so
/// `window.topology` never matches the `window.top` pattern.
fn replace_bound(s: &str, pat: &str, rep: &str) -> String {
    let bytes = s.as_bytes();
    let pb = pat.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i..].starts_with(pb)
            && (i == 0 || !lb_is_ident(bytes[i - 1]))
            && (i + pb.len() >= bytes.len() || !lb_is_ident(bytes[i + pb.len()]))
        {
            out.push_str(rep);
            i += pb.len();
            continue;
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Second pass: classify each `top.location` use. Navigation writes sink
/// into the LB_antiframe property (no navigation, no exception, the
/// script keeps running); reads become same-origin reads of the page's
/// own location. The noop sinks are defined by the injected shim.
fn js_antiframe_scan(s: &str) -> String {
    let bytes = s.as_bytes();
    let tok = b"top.location";
    let tok_len = tok.len();
    let mut out = String::with_capacity(s.len() + 32);
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i..].starts_with(tok)
            && (i == 0 || !(bytes[i - 1] == b'.' || lb_is_ident(bytes[i - 1])))
            && (i + tok_len >= bytes.len() || !lb_is_ident(bytes[i + tok_len]))
        {
            let after = i + tok_len;
            let mut j = after;
            while j < bytes.len() && matches!(bytes[j], b' ' | b'\t' | b'\n' | b'\r') {
                j += 1;
            }
            let is_write = j < bytes.len()
                && bytes[j] == b'='
                && (j + 1 >= bytes.len() || bytes[j + 1] != b'=');
            if is_write {
                out.push_str("self.LB_antiframe");
                i += tok_len;
                continue;
            }
            if bytes[j..].starts_with(b".href") {
                let mut k = j + 5;
                while k < bytes.len() && matches!(bytes[k], b' ' | b'\t' | b'\n' | b'\r') {
                    k += 1;
                }
                if k < bytes.len()
                    && bytes[k] == b'='
                    && (k + 1 >= bytes.len() || bytes[k + 1] != b'=')
                {
                    out.push_str("self.LB_antiframe");
                    i += tok_len + 5;
                    continue;
                }
            }
            if bytes[j..].starts_with(b".replace") {
                out.push_str("self.LB_antiframe_replace");
                i += tok_len + 8;
                continue;
            }
            if bytes[j..].starts_with(b".reload") {
                out.push_str("self.LB_antiframe_reload");
                i += tok_len + 7;
                continue;
            }
            if bytes[j..].starts_with(b".assign") {
                out.push_str("self.LB_antiframe_assign");
                i += tok_len + 7;
                continue;
            }
            out.push_str("self.location");
            i += tok_len;
            continue;
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn inject_shim(html: String, page_url: &str, suffix: &str, diag: &str) -> String {
    let pre = format!(
        "<script>window.__lbPageUrl=\"{}\";window.__lbParams=\"{}\";</script>{}<script>window.LB_antiframe=0;window.LB_antiframe_replace=function(){{}};window.LB_antiframe_reload=function(){{}};window.LB_antiframe_assign=function(){{}};</script><script>{}</script><script>{}</script>",
        json_escape(page_url),
        json_escape(suffix),
        diag,
        ENGINE_JS,
        COMPAT_JS
    );
    insert_in_head(html, &pre)
}

/// Full HTML pipeline: ad/tracker stripping, CSP/base/SRI cleanup,
/// URL rewriting and shim injection.
fn rewrite_html_doc(
    html: &str,
    page_url: &str,
    params: &HashMap<String, String>,
    suffix: &str,
    prefix: &str,
    state: &AppState,
) -> String {
    let mut filters: Vec<&adblock::FilterSet> = Vec::new();
    if params.get("ab").map(|v| v == "1").unwrap_or(false) {
        filters.push(&state.ads);
    }
    if params.get("trk").map(|v| v == "1").unwrap_or(false) {
        filters.push(&state.trackers);
    }
    let cleaned = if filters.is_empty() {
        html.to_string()
    } else {
        strip_blocked(html, &filters)
    };
    let (cleaned, csp_removed) = strip_csp_meta(&cleaned);
    let cleaned = strip_base_tags(&cleaned);
    let (cleaned, sri_removed) = strip_integrity(&cleaned);
    let rewritten = rewrite_html(&cleaned, page_url, suffix, prefix);
    // Frame-buster neutralization for inline scripts: the same pass the
    // engine applies to served .js bodies.
    let rewritten = js_antiframe(&rewritten);
    // Challenge/CAPTCHA widget documents are integrity-sensitive: the
    // injected shim (console hooks, fetch patches, page globals) trips
    // 74.7 diagnostics: record how much CSP/SRI hygiene the engine
    // performed on this document, so the UI can attribute breakage to
    // stripping instead of guessing. Meta placement inside <head> comes
    // free via inject_shim's pre-script insertion; for challenge hosts
    // (no shim) the meta is prepended inside the rewritten head by the
    // same lower/insert helper to keep the doctype intact.
    let diag = if csp_removed + sri_removed > 0 {
        format!(
            "<meta name=\"lb-diag\" content=\"csp={};sri={}\">",
            csp_removed, sri_removed
        )
    } else {
        String::new()
    };
    // anti-bot checks and the widget refuses to run. URL rewriting is
    // kept so their subresources still route through the engine; only
    // the script injection is skipped.
    if is_challenge_host(&host_of(page_url)) {
        if diag.is_empty() {
            return rewritten;
        }
        let lower = rewritten.to_ascii_lowercase();
        let mut owned = rewritten;
        if let Some(hpos) = lower
            .find("<head")
            .and_then(|i| lower[i..].find('>').map(|j| i + j + 1))
        {
            owned.insert_str(hpos, &diag);
        }
        return owned;
    }
    let shimmed = inject_shim(rewritten, page_url, suffix, &diag);
    /* AMO: spoof Firefox both on the wire (engine_proxy applies the
    header) and in the page (navigator.userAgent), because the
    add-ons store gates .xpi downloads on a Firefox client. */
    if is_amo_host(&host_of(page_url)) {
        insert_in_head(shimmed, amo_spoof_script())
    } else {
        shimmed
    }
}

/// Engine option query string carried on to every rewritten URL.
fn params_suffix(params: &HashMap<String, String>) -> String {
    let mut parts: Vec<String> = Vec::new();
    for k in ["ab", "trk", "https", "img", "inc"] {
        if let Some(v) = params.get(k) {
            if v == "1" {
                parts.push(format!("lb_{}=1", k));
            }
        }
    }
    if let Some(ua) = params.get("ua") {
        if !ua.is_empty() {
            parts.push(format!("lb_ua={}", pct_enc(ua)));
        }
    }
    if let Some(h) = params.get("hdrs") {
        if !h.is_empty() {
            parts.push(format!("lb_hdrs={}", pct_enc(h)));
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// De-AMP: when the fetched page is an AMP variant, follow its
/// <link rel="canonical"> back to the real page. Conservative: only
/// triggered when the URL or the markup actually looks like AMP.
fn amp_canonical(html: &str, page_url: &str) -> Option<String> {
    let looks_amp = page_url.contains("/amp") || html.contains("<html amp") || html.contains("â¡");
    if !looks_amp {
        return None;
    }
    let lower = html.to_ascii_lowercase();
    let mut search = 0;
    while let Some(i) = lower[search..].find("<link") {
        let start = search + i;
        let end = lower[start..].find('>').map(|j| start + j + 1)?;
        let tag = &lower[start..end];
        let is_canonical = tag.contains("rel=\"canonical\"")
            || tag.contains("rel='canonical'")
            || tag.contains("rel=canonical");
        if is_canonical {
            let tag_orig = &html[start..end];
            let hp = tag_orig.find("href")?;
            let eq = tag_orig[hp..].find('=')? + hp + 1;
            let rest = tag_orig[eq..].trim_start();
            let val = if rest.starts_with('"') || rest.starts_with('\'') {
                let q = rest.chars().next().unwrap();
                rest[1..].split(q).next()?
            } else {
                rest.split([' ', '>', '/']).next()?
            };
            let abs = resolve_url(page_url, val)?;
            if abs.starts_with("http://") || abs.starts_with("https://") {
                return Some(abs);
            }
            return None;
        }
        search = end;
    }
    None
}

/// Self-contained same-origin redirect page used by de-AMP: replaces the
/// proxied iframe with the canonical URL routed through the engine.
fn de_amp_redirect(route: &str) -> Response {
    let attr = route.replace('&', "&amp;").replace('"', "&quot;");
    let js = json_escape(route);
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <meta http-equiv=\"refresh\" content=\"0; url={attr}\">\
         <script>try {{ location.replace(\"{js}\"); }} catch (e) {{}}</script>\
         </head><body></body></html>"
    );
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

/// Re-encode a JPEG at lower quality to save bandwidth (Settings:
/// image compression). Falls back to the original bytes on any error,
/// and refuses inputs that are not clearly images (size cap guards RAM).
fn compress_jpeg(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() > 8 * 1024 * 1024 || bytes.len() < 128 {
        return None;
    }
    use image::codecs::jpeg::JpegEncoder;
    let img = image::load_from_memory(bytes).ok()?;
    let mut out: Vec<u8> = Vec::new();
    let enc = JpegEncoder::new_with_quality(&mut out, 72);
    img.write_with_encoder(enc).ok()?;
    if out.len() < bytes.len() {
        Some(out)
    } else {
        None
    }
}

/// Engine-side error response.
///
/// Root cause of the historical MIME-mismatch noise (74.3): the engine
/// forwards the upstream status and content-type verbatim, so a script or
/// style request answered upstream with 200 + text/html (soft-404 page,
/// bot check) arrives as text/html, and the browser refuses to execute
/// it. The second source was this very function: it used to answer EVERY
/// failed fetch, including subresource requests, with a text/html 502
/// page, so a failed <script src> produced a MIME mismatch instead of a
/// clean network error. The client shim now detects and reports the
/// first case (MIME_TYPE_ERROR); this function fixes the second: only
/// navigation requests (sec-fetch-dest document/iframe, or no header at
/// all) get the interactive HTML error card. Subresource requests get an
/// honest 502 text/plain body.
fn engine_error_page(url: &str, detail: &str, wants_html: bool) -> Response {
    if !wants_html {
        return (
            StatusCode::BAD_GATEWAY,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            format!("lobsterbrowse proxy error: {}\nurl: {}\n", detail, url),
        )
            .into_response();
    }
    // Scramjet compatibility layer: when the rewriter cannot handle a
    // site, offer the deployed headless-browser service as fallback.
    let scramjet = format!(
        "https://lobsterbrowse-scramjet.onrender.com/?url={}",
        pct_enc(url)
    );
    let direct = pct_enc(url);
    let detail = json_escape(detail);
    let url_js = json_escape(url);
    // Standalone page inside the proxied iframe: matches the app's
    // dynamic-color look as closely as a plain page can (prefers the
    // M3 tokens when the parent app set them, falls back to a palette
    // that follows light/dark mode), reports the failure to the UI's
    // DevTools capture, and offers real actions.
    let body = format!(
        r#"<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="lb-load-error" content="{detail}">
<title>Load failed</title>
<style>
:root {{ color-scheme: light dark; }}
* {{ box-sizing: border-box; }}
body {{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
  font-family: "Google Sans Flex", Roboto, system-ui, sans-serif;
  background: #f7f5ff; color: #1b1b1f; }}
@media (prefers-color-scheme: dark) {{ body {{ background:#141218; color:#e6e1e9; }} }}
.card {{ max-width: 560px; width:calc(100% - 48px); padding:36px 36px 28px; border-radius:28px;
  background:rgba(127,127,140,.12); border:1px solid rgba(127,127,140,.25); }}
h1 {{ font-size:22px; margin:0 0 4px; }}
.muted {{ opacity:.65; font-size:13px; }}
.url {{ font-family:ui-monospace,monospace; font-size:12px; word-break:break-all;
  background:rgba(127,127,140,.18); padding:10px 12px; border-radius:12px; margin:14px 0; }}
.detail {{ font-size:13px; opacity:.8; word-break:break-word; margin:0 0 18px; }}
.row {{ display:flex; gap:10px; flex-wrap:wrap; }}
a.btn, button {{ appearance:none; border:none; cursor:pointer; text-decoration:none;
  display:inline-flex; align-items:center; gap:6px; padding:10px 18px; border-radius:999px;
  font:500 14px "Google Sans Flex", Roboto, system-ui, sans-serif; }}
.primary {{ background:#6750a4; color:#fff; }}
.dark .primary, :root.dark .primary {{ background:#cfbcff; color:#381e72; }}
.plain {{ background:rgba(127,127,140,.2); color:inherit; }}
.hint {{ margin-top:20px; font-size:12px; opacity:.55; }}
</style></head><body>
<div class="card" role="alert">
  <h1>This page could not load</h1>
  <p class="muted">The proxy engine failed to fetch the destination.</p>
  <div class="url">{url_js}</div>
  <p class="detail">{detail}</p>
  <div class="row">
    <button class="primary" onclick="location.reload()">Retry</button>
    <a class="plain btn" href="{direct}" target="_blank" rel="noreferrer">Open directly (exposes your IP)</a>
    <a class="plain btn" href="{scramjet}">Try Scramjet (headless browser)</a>
  </div>
  <p class="hint">Retry re-runs the request. "Open directly" bypasses the proxy: the site sees
  your real IP. If this is a CAPTCHA-protected site, solving it directly may unblock the proxied
  version afterwards (shared cookie jar does not apply).</p>
</div>
<script>
try {{ parent.postMessage({{ lb:"net", data:{{ url:{url_json}, method:"GET", status:0,
  error:{detail_json}, dur:0, ts:Date.now() }} }}, "*"); }} catch (e) {{}}
</script>
</body></html>"#,
        detail = detail,
        url_js = url_js,
        direct = direct,
        scramjet = scramjet,
        url_json = format!("\"{}\"", url_js),
        detail_json = format!("\"{}\"", detail),
    );
    (
        StatusCode::BAD_GATEWAY,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        body,
    )
        .into_response()
}

/// Native rewriting engine: /r/<base64url target>[?opts][&page-query].
///
/// Known query keys (ab, trk, https, ua) are engine options; every other
/// query key belongs to the target page, so GET forms submitting
/// straight to a /r route keep working. HTML and CSS responses are
/// rewritten; everything else streams through untouched.
async fn engine_proxy(
    State(state): State<Arc<AppState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    Path(target): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    body: Option<Bytes>,
) -> Response {
    let started = Instant::now();
    let res_id = next_res_id(&state.res_ids);
    let Some(decoded) = b64url_decode(&target) else {
        return (StatusCode::BAD_REQUEST, "bad route").into_response();
    };
    let Ok(url) = String::from_utf8(decoded) else {
        return (StatusCode::BAD_REQUEST, "bad route encoding").into_response();
    };
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return (StatusCode::BAD_REQUEST, "target must be http(s)").into_response();
    }

    let mut params: HashMap<String, String> = HashMap::new();
    let mut page_query: Vec<&str> = Vec::new();
    if let Some(rq) = raw.as_deref() {
        for part in rq.split('&') {
            if part.is_empty() {
                continue;
            }
            let (k, v) = match part.find('=') {
                Some(p) => (&part[..p], &part[p + 1..]),
                None => (part, ""),
            };
            params.insert(k.to_string(), percent_decode(v));
            // Engine options are lb_-prefixed, so a target page can keep
            // query keys like ?ua= or ?ab= of its own without the engine
            // swallowing them. Legacy bare keys (routes saved before the
            // rename) are still recognized for compatibility.
            if !k.starts_with("lb_") {
                page_query.push(part);
            }
        }
    }
    for k in ["ab", "trk", "https", "ua", "hdrs", "img", "inc"] {
        if let Some(v) = params.remove(&format!("lb_{}", k)) {
            params.insert(k.to_string(), v);
        }
    }
    // Defensive fragment strip: fragments are client-side only. Legacy
    // routes (and older clients) can still carry one inside the encoded
    // target; it must never reach the upstream request identity.
    let bare_url = url.split('#').next().unwrap_or("").to_string();
    let fetch_url = if page_query.is_empty() {
        bare_url.clone()
    } else {
        let sep = if bare_url.contains('?') { '&' } else { '?' };
        format!("{}{}{}", bare_url, sep, page_query.join("&"))
    };
    /* 74.3: only navigations get the interactive HTML error card.
    The browser sets sec-fetch-dest on same-origin subresource
    requests (script/style/image/font/fetch) and it cannot be forged
    by page script, so it is a reliable discriminator. Missing header
    (curl, tests, old browsers) keeps the HTML page. */
    let fetch_dest = headers
        .get("sec-fetch-dest")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let wants_html_page = matches!(fetch_dest.as_str(), "" | "document" | "iframe");
    if params.get("https").map(|v| v == "1").unwrap_or(false) && fetch_url.starts_with("http://") {
        return engine_error_page(
            &url,
            "HTTPS-only mode: plain-http target rejected",
            wants_html_page,
        );
    }

    let suffix = params_suffix(&params);
    /* Rewritten links keep the entry route: pages loaded through
    LobsterJet (/lj/) rewrite subresources and links to /lj/ so the
    service worker's cache intercepts them; ScramJet entries stay
    on /r/. */
    let prefix = if uri.path().starts_with("/lj/") {
        "/lj/"
    } else {
        "/r/"
    };
    push_log(
        &state,
        "info",
        &format!("engine {} {} {}", res_id, method, url),
    );

    /* 74.9 engine-side incognito enforcement: lb_inc=1 requests use a
    separate client with its own cookie jar, so incognito cookies
    never mix into the shared jar (and back). The suffix keeps the
    flag on every rewritten subresource and link. */
    let use_incognito = params.get("inc").map(|v| v == "1").unwrap_or(false);
    let client = if use_incognito {
        &state.incognito_client
    } else {
        &state.client
    };
    let mut req = client.request(method.clone(), &fetch_url);
    /* Effective UA: on AMO the proxy ALWAYS spoofs Firefox (the store
    refuses .xpi downloads to non-Firefox clients, so a user-preset
    Chrome UA must not leak there); everywhere else the user's
    explicit override wins. */
    let eff_ua = if is_amo_host(&host_of(&fetch_url)) {
        Some(FIREFOX_UA.to_string())
    } else {
        params.get("ua").filter(|ua| !ua.trim().is_empty()).cloned()
    };
    if let Some(ua) = eff_ua {
        let cleaned: String = ua
            .chars()
            .filter(|c| c.is_ascii_graphic() || *c == ' ')
            .take(512)
            .collect();
        if !cleaned.is_empty() {
            req = req.header(reqwest::header::USER_AGENT, cleaned);
        }
    }
    // Forward a couple of harmless request headers from the browser frame.
    // (HeaderMap::get consumes its key, so use Copy &str keys here.)
    for h in ["accept", "accept-language"] {
        if let Some(v) = headers.get(h) {
            if let Ok(vs) = v.to_str() {
                if !vs.is_empty() {
                    req = req.header(h, vs);
                }
            }
        }
    }
    // Privacy signals on every upstream request: Global Privacy Control
    // and Do Not Track. The target site (and its trackers) receive an
    // explicit "do not sell or share" signal, same as a privacy-first
    // browser would send.
    req = req.header("Sec-GPC", "1");
    req = req.header("DNT", "1");
    // Custom outbound header profile (Settings > Advanced): lines of
    // "Name: value", base64url-encoded in the lb_hdrs param. Applied
    // last so a profile can override the defaults above. Hop-by-hop and
    // jar-managed headers are blocked.
    if let Some(hdrs_b64) = params.get("hdrs") {
        if let Some(raw) = b64url_decode(hdrs_b64) {
            if let Ok(text) = String::from_utf8(raw) {
                for line in text.lines().take(16) {
                    let Some((name, value)) = line.split_once(':') else {
                        continue;
                    };
                    let name = name.trim();
                    let value: String = value
                        .chars()
                        .filter(|c| *c != '\u{000d}' && *c != '\u{000a}')
                        .take(512)
                        .collect();
                    let lower = name.to_ascii_lowercase();
                    let valid = !name.is_empty()
                        && !value.is_empty()
                        && name
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                        && ![
                            "host",
                            "content-length",
                            "connection",
                            "transfer-encoding",
                            "cookie",
                        ]
                        .contains(&lower.as_str());
                    if valid {
                        req = req.header(name, value);
                    }
                }
            }
        }
    }
    // Referer recovery: the browser sends the engine-local route as the
    // Referer of subresource requests. Decoding it back to the real page
    // URL means upstream sites (and CAPTCHA providers like Cloudflare
    // Turnstile, which validate the embedding page) see a sane Referer
    // instead of an opaque /r/<base64> path.
    if let Some(ref_hdr) = headers.get("referer").and_then(|v| v.to_str().ok()) {
        let mut path = ref_hdr;
        if let Some(idx) = ref_hdr.find("://") {
            if let Some(start) = ref_hdr[idx + 3..].find('/') {
                path = &ref_hdr[idx + 3 + start..];
            }
        }
        let mut decoded_target: Option<String> = None;
        let stripped = path
            .strip_prefix("/r/")
            .or_else(|| path.strip_prefix("/lj/"));
        if let Some(rest) = stripped {
            let seg = rest.split(['?', '#']).next().unwrap_or("");
            if let Some(bytes) = b64url_decode(seg) {
                if let Ok(real) = String::from_utf8(bytes) {
                    if real.starts_with("http://") || real.starts_with("https://") {
                        decoded_target = Some(real);
                    }
                }
            }
        }
        if let Some(real) = decoded_target {
            req = req.header(reqwest::header::REFERER, real);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            // Follows redirects: resolve relative URLs against the FINAL
            // URL, not the one the user typed, or redirected pages
            // rewrite every link against the wrong origin.
            let base_url = resp.url().to_string();
            // Compare against the fragmentless target: a legacy route
            // carrying "#symbol" inside the encoded URL used to log a
            // phantom "redirect" because reqwest strips fragments from
            // the final URL. There was never a redirect.
            if base_url != bare_url {
                push_log(
                    &state,
                    "info",
                    &format!("engine redirect {} {} -> {}", res_id, bare_url, base_url),
                );
            }
            let ct = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            let is_html = ct.contains("html");
            // Rate-limit loop breaker: Brave (and other engines) answer
            // a captcha challenge with 429 + HTML that self-refreshes
            // inside the proxied iframe forever — the challenge scripts
            // never pass through our shim, so the loop cannot be solved.
            // Instead of serving that hostile page, render our own
            // honest error card telling the user the site rate-limited
            // the proxy and to retry later.
            if status.as_u16() == 429 && is_html && wants_html_page {
                push_log(
                    &state,
                    "warn",
                    &format!("engine 429 rate-limit page suppressed for {}", url),
                );
                return engine_error_page(
                    &url,
                    "The site rate-limited the proxy (HTTP 429) and served a captcha page that cannot be solved inside the proxy. Wait a moment and retry.",
                    wants_html_page,
                );
            }
            let is_css = !is_html && ct.contains("css");
            let is_js =
                !is_html && !is_css && (ct.contains("javascript") || ct.contains("ecmascript"));
            let compress_img = params.get("img").map(|v| v == "1").unwrap_or(false)
                && ct.starts_with("image/jpeg");
            // Anything that is neither rewritten nor re-encoded streams
            // straight through: large downloads and media must not be
            // buffered in the server's RAM.
            if !is_html && !is_css && !is_js && !compress_img {
                push_log(
                    &state,
                    "info",
                    &format!(
                        "engine stream {} {} {} -> {} ({})",
                        res_id, method, url, status, ct
                    ),
                );
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                // Validation/caching headers pass through byte-identical:
                // the body is upstream's own, so etag/last-modified/cache
                // -control/expires must travel with it or browser (and SW)
                // revalidation silently breaks. (Collected before
                // bytes_stream: that consumes the response.)
                let mut cache_headers: Vec<(&str, String)> = Vec::new();
                for h in ["etag", "last-modified", "cache-control", "expires"] {
                    if let Some(v) = resp.headers().get(h).and_then(|v| v.to_str().ok()) {
                        cache_headers.push((h, v.to_owned()));
                    }
                }
                let stream = resp.bytes_stream();
                let mut builder = Response::builder()
                    .status(axum_status)
                    .header(header::CONTENT_TYPE, ct);
                for (h, v) in &cache_headers {
                    builder = builder.header(*h, v.as_str());
                }
                return builder
                    .body(Body::from_stream(stream))
                    .unwrap_or_else(|_| (StatusCode::BAD_GATEWAY, "stream error").into_response());
            }
            // Body read failure must NOT become a silent empty 200: an
            // empty JS/CSS body served as success is exactly how pages
            // break with the server log claiming everything was fine.
            let bytes = match resp.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    push_log(
                        &state,
                        "warn",
                        &format!(
                            "engine body read failed {} {} -> {}: {}",
                            res_id, url, status, e
                        ),
                    );
                    return engine_error_page(
                        &url,
                        &format!("upstream body read failed: {}", e),
                        wants_html_page,
                    );
                }
            };
            let mut is_anubis = false;
            let out: Vec<u8> = if is_html {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                // De-AMP: an AMP variant page redirects itself to its
                // canonical URL, routed through the engine with the same
                // options.
                if let Some(canon) = amp_canonical(&text, &base_url) {
                    if canon != base_url {
                        push_log(&state, "info", &format!("de-amp {} -> {}", base_url, canon));
                        let route =
                            format!("{}{}{}", prefix, b64url_encode(canon.as_bytes()), suffix);
                        return de_amp_redirect(&route);
                    }
                }
                // Anubis anti-bot challenge shells must never be cached:
                // the Zeolite service worker serves /lj/ navigations
                // cache-first, so a cached challenge page reloads itself
                // forever (solve PoW, pass, reload, cache hit, solve...).
                // The worker honors no-store with TTL 0; everything else
                // keeps its normal freshness.
                is_anubis = text.contains(r#"id="anubis_challenge""#);
                rewrite_html_doc(&text, &base_url, &params, &suffix, prefix, &state).into_bytes()
            } else if is_css {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                rewrite_css(&text, &base_url, &suffix, prefix).into_bytes()
            } else if is_js {
                // The antiframe pass is best-effort hardening, never a
                // correctness requirement. Non-UTF-8 JS (latin1 string
                // literals are legal) used to go through from_utf8_lossy,
                // which rewrites bytes into U+FFFD and corrupts the
                // script. Invalid-UTF-8 bodies are served unmodified.
                match std::str::from_utf8(&bytes) {
                    Ok(text) => js_antiframe(&rewrite_js_imports(text, &base_url, &suffix, prefix))
                        .into_bytes(),
                    Err(_) => {
                        push_log(
                            &state,
                            "info",
                            &format!("engine js non-utf8 served unmodified: {}", url),
                        );
                        bytes.to_vec()
                    }
                }
            } else if compress_img {
                compress_jpeg(&bytes).unwrap_or_else(|| bytes.to_vec())
            } else {
                bytes.to_vec()
            };
            push_log(
                &state,
                "info",
                &format!(
                    "engine done {} {} {} -> {} ({} ms, {} B, {})",
                    res_id,
                    method,
                    url,
                    status,
                    started.elapsed().as_millis(),
                    out.len(),
                    ct
                ),
            );
            let axum_status =
                StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let mut resp = (axum_status, [(header::CONTENT_TYPE, ct)], out).into_response();
            if is_anubis {
                resp.headers_mut()
                    .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                push_log(
                    &state,
                    "info",
                    &format!("anubis challenge served no-store: {}", url),
                );
            }
            resp
        }
        Err(e) => engine_error_page(&url, &e.to_string(), wants_html_page),
    }
}

/// Search-engine suggestions, proxied server-side to dodge CORS.
/// Every provider returns the same osjson shape: ["query", ["s1", ...]].
async fn suggest_endpoint(State(state): State<Arc<AppState>>, RawQuery(raw): RawQuery) -> Response {
    let mut q = String::new();
    let mut engine = String::new();
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
            r#"{"suggestions":[]}"#,
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
    push_log(&state, "info", &format!("suggest {} {}", engine, q));
    let mut list: Vec<String> = Vec::new();
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
        push_log(&state, "warn", &format!("suggest failed: {}", last_err));
    }
    let out = format!("{{\"suggestions\":[{}]}}", list.join(","));
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
                        list.push(json_escape(t));
                    }
                }
            }
        }
    }
    list
}

/// Recent server-side engine log entries, newest last. JSON array.
async fn logs_endpoint(State(state): State<Arc<AppState>>) -> Response {
    let logs = state.logs.lock().unwrap_or_else(|e| e.into_inner());
    let body = format!(
        "[{}]",
        logs.iter().cloned().collect::<Vec<String>>().join(",")
    );
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
            slot.as_ref().map_or(true, |(cur, _)| na > cur.as_str())
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
    let body = format!(
        "{{\"ok\":true,\"lb\":\"{}\",\"zeolite\":\"{}\",\"zlswSha\":\"{}\",\"build\":\"{}\",\"buildShort\":\"{}\"}}",
        format!("{} Molt", env!("CARGO_PKG_VERSION")),
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
    let host = q
        .as_deref()
        .and_then(|qs| qs.split('&').find_map(|kv| kv.strip_prefix("host=")))
        .map(percent_decode)
        .unwrap_or_default();
    if host.is_empty() {
        return (
            [(header::CONTENT_TYPE, "application/json")],
            "{\"ok\":false,\"error\":\"certificate data unavailable\"}",
        )
            .into_response();
    }
    push_log(&state, "info", &format!("cert lookup {}", host));
    /* crt.sh first: query the host, pick the best record. */
    let crtsh_url = format!("https://crt.sh/?q={}&output=json", json_escape(&host));
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
                json_escape(&host)
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
    let wisp_path = std::env::var("WISP_PATH").unwrap_or_else(|_| "/wisp/".into());
    let auth_password = std::env::var("WISP_PASSWORD").ok();

    let build_client = || {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .connect_timeout(std::time::Duration::from_secs(8))
            .timeout(std::time::Duration::from_secs(20))
            .cookie_store(true)
            .build()
            .expect("reqwest client")
    };
    let client = build_client();
    /* 74.9: a second client means a second cookie jar. Incognito routes
    (lb_inc=1) use it; cookies never cross between the two jars. */
    let incognito_client = build_client();

    let state = Arc::new(AppState {
        client,
        incognito_client,
        logs: Mutex::new(VecDeque::new()),
        res_ids: AtomicU64::new(0),
        ads: load_filters("adblock-extra.txt", AD_HOSTS),
        trackers: load_filters("tracker-extra.txt", TRACKER_HOSTS),
    });
    push_log(&state, "info", "native engine log buffer initialised");

    // Zeolite is the authoritative wisp server: resolve-then-validate
    // SSRF policy (DNS-rebinding safe), real UDP datagram relay, credit
    // windows, connection/stream limits and extension auth all live there.
    // The old local wisp handler (proxy.rs) was removed.
    let mut zl_cfg = zeolite_server::Config::from_env();
    if zl_cfg.password.is_none() {
        // Preserve the previous WISP_PASSWORD / WISP_PASSWORD deployment
        // knobs for existing deployments.
        if let Some(pw) = auth_password.filter(|p| !p.is_empty()) {
            let user = std::env::var("WISP_USERNAME").unwrap_or_else(|_| "user".into());
            zl_cfg.password = Some((user, pw));
        }
    }
    let wisp_state = zeolite_server::Shared::new(zl_cfg);

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/r/:target", any(engine_proxy))
        // LobsterJet entry: same engine handler, so pages work even when
        // the service worker is not installed/ready yet. The worker layers
        // its client-side cache on top of this route.
        .route("/lj/:target", any(engine_proxy))
        .route("/suggest", get(suggest_endpoint))
        .route("/logs", get(logs_endpoint))
        .route("/cert", get(cert_endpoint))
        .route("/build", get(build_endpoint))
        // Zeolite engine bundle, vendored into zlsw/ at build time.
        // The service worker script gets Service-Worker-Allowed so a
        // "/" scope registration is possible later; its chunks and
        // wasm assets are plain static files under the same prefix.
        // The worker registers at its natural /zlsw/ scope today and
        // acts purely as the extension control plane: it controls no
        // pages, so proxied /lj/ and /r/ browsing is untouched.
        .route("/zlsw/sw.js", get(zl_sw_js))
        .nest_service("/zlsw", ServeDir::new("zlsw"))
        // The engine worker's transport adapter resolves the vendored
        // libcurl bundle at the origin root (/libcurl/index.mjs);
        // serve the vendored copy from the bundle directory.
        .nest_service("/libcurl", ServeDir::new("zlsw/libcurl"))
        // Extension subsystem routes live in the Zeolite worker
        // (IndexedDB-backed), NOT on this server: any request that
        // slips past the worker gets an honest 404, never the SPA
        // fallback (see extension_route_not_found).
        .route("/zl-ext/*path", any(extension_route_not_found))
        .route("/zl-cs/*path", any(extension_route_not_found))
        // Anubis challenge bridge: challenge JS solves the proof and then
        // location.replace()s a root-relative pass-challenge URL, which on
        // this origin escapes the engine route and used to hit the SPA
        // fallback — the proof never reached the protected host, no cookie
        // was set, and the challenge reloaded forever. The bridge proxies
        // the pass-challenge upstream (the shared jar keeps the Anubis
        // cookie) and bounces the frame back to its engine route.
        .route("/.within.website/*path", any(anubis_bridge))
        .fallback_service(
            ServeDir::new("ui")
                .append_index_html_on_directories(true)
                .not_found_service(ServeFile::new("ui/index.html")),
        )
        .route(
            &wisp_path,
            get({
                let state = wisp_state.clone();
                move |ws: axum::extract::ws::WebSocketUpgrade, headers: axum::http::HeaderMap| {
                    let state = state.clone();
                    async move { zeolite_server::wisp_handler(State(state), ws, headers).await }
                }
            }),
        )
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!(
        "LobsterBrowse native engine server listening on {} at {}",
        addr, wisp_path
    );
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind failed");
    axum::serve(listener, app).await.expect("server error");
}

/// Percent-decode a query component (redir arrives encodeURIComponent'd).
fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    b'A'..=b'F' => Some(c - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The engine route ("/lj/..." or "/r/...") inside a URL or path string,
/// if any. The Anubis challenge script sets its `redir` param to the
/// frame's full engine-route URL, so this recovers where to go back.
fn engine_route_in(s: &str) -> Option<String> {
    let i = s.find("/lj/").or_else(|| s.find("/r/"))?;
    Some(s[i..].to_string())
}

/// Anubis pass-challenge bridge (see the route registration). The proof
/// must reach the protected host for Anubis to set its cookie, and the
/// frame must land back on its engine route; both happen here. The
/// upstream response body is irrelevant (reqwest follows Anubis's own
/// redirect chain and the jar records the Set-Cookie) — only the fetch
/// and the bounce-back matter.
async fn anubis_bridge(
    State(state): State<Arc<AppState>>,
    OriginalUri(uri): OriginalUri,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let mut params: Vec<(String, String)> = Vec::new();
    if let Some(rq) = raw.as_deref() {
        for part in rq.split('&') {
            if part.is_empty() {
                continue;
            }
            let (k, v) = match part.find('=') {
                Some(p) => (&part[..p], &part[p + 1..]),
                None => (part, ""),
            };
            params.push((k.to_string(), pct_decode(v)));
        }
    }
    let mut back = params
        .iter()
        .find(|(k, _)| k == "redir")
        .map(|(_, v)| v.clone())
        .and_then(|v| engine_route_in(&v));
    if back.is_none() {
        if let Some(r) = headers.get(header::REFERER).and_then(|v| v.to_str().ok()) {
            back = engine_route_in(r);
        }
    }
    let Some(back) = back else {
        push_log(
            &state,
            "warn",
            "anubis bridge: no engine route in redir or referer",
        );
        return (StatusCode::NOT_FOUND, "no engine route to return to").into_response();
    };
    let route_target = back
        .split('?')
        .next()
        .unwrap_or("")
        .trim_start_matches("/lj/")
        .trim_start_matches("/r/")
        .to_string();
    let page = b64url_decode(&route_target).and_then(|b| String::from_utf8(b).ok());
    let Some(page) = page else {
        push_log(&state, "warn", "anubis bridge: undecodable route target");
        return (StatusCode::NOT_FOUND, "undecodable route target").into_response();
    };
    // Forward the original query minus `redir` (Anubis would reject a
    // foreign-origin redirect target anyway; the browser is bounced back
    // to the engine route below). Raw parts keep their encoding intact.
    let mut q = String::new();
    if let Some(rq) = raw.as_deref() {
        for part in rq.split('&') {
            if part.is_empty() || part.starts_with("redir=") {
                continue;
            }
            if !q.is_empty() {
                q.push('&');
            }
            q.push_str(part);
        }
    }
    let url = if q.is_empty() {
        format!("{}{}", page.trim_end_matches('/'), uri.path())
    } else {
        format!("{}{}?{}", page.trim_end_matches('/'), uri.path(), q)
    };
    let client = if back.contains("lb_inc=1") {
        &state.incognito_client
    } else {
        &state.client
    };
    match client.get(&url).send().await {
        Ok(resp) => {
            // Anubis answers pass-challenge with 302 + Set-Cookie; the
            // redirect chain must land on the protected page. Log the
            // verdict: status, final URL after redirects, cookie count.
            let sc = resp.headers().get_all(header::SET_COOKIE).iter().count();
            let status = resp.status();
            let final_url = resp.url().to_string();
            let mut body_snip = String::new();
            if !status.is_success() {
                if let Ok(b) = resp.text().await {
                    body_snip = b.chars().take(300).collect();
                }
            }
            push_log(
                &state,
                "info",
                &format!(
                    "anubis pass-challenge upstream {} final {} cookies {} body [{}] -> {}",
                    status, final_url, sc, body_snip, back
                ),
            );
        }
        Err(e) => push_log(
            &state,
            "warn",
            &format!("anubis bridge upstream failed: {}", e),
        ),
    }
    (StatusCode::SEE_OTHER, [(header::LOCATION, back.as_str())]).into_response()
}

#[cfg(test)]
mod anubis_bridge_tests {
    use super::{engine_route_in, pct_decode};

    #[test]
    fn finds_engine_routes() {
        assert_eq!(
            engine_route_in("https://x.example/lj/aHR0cHM6?lb_ab=1"),
            Some("/lj/aHR0cHM6?lb_ab=1".to_string())
        );
        assert_eq!(engine_route_in("/r/abc"), Some("/r/abc".to_string()));
        assert_eq!(engine_route_in("https://plain.example/"), None);
    }

    #[test]
    fn decodes_redir_values() {
        assert_eq!(
            pct_decode("https%3A%2F%2Fx.example%2Flj%2FaHR0"),
            "https://x.example/lj/aHR0"
        );
        assert_eq!(pct_decode("plain"), "plain");
        assert_eq!(pct_decode("100%"), "100%");
    }
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

#[cfg(test)]
mod url_fragment_tests {
    use super::{b64url_decode, rewrite_tag, rewrite_url_attr};

    /// SVG sprite symbols: the fragment selects the symbol client-side,
    /// it must never become part of the encoded request target. One
    /// sprite file = one network identity, however many "#symbol"
    /// references the page makes.
    #[test]
    fn fragment_stays_out_of_the_route_target() {
        let out = rewrite_url_attr(
            "https://chatgpt.com/cdn/assets/sprites-shell-f705d3e2.svg#sidebar",
            "https://chatgpt.com/",
            "?lb_ab=1",
            "/lj/",
        );
        assert!(out.starts_with("/lj/"));
        assert!(out.ends_with("#sidebar"));
        let seg = out
            .strip_prefix("/lj/")
            .unwrap()
            .split('?')
            .next()
            .unwrap()
            .split('#')
            .next()
            .unwrap();
        let decoded = String::from_utf8(b64url_decode(seg).unwrap()).unwrap();
        assert_eq!(
            decoded,
            "https://chatgpt.com/cdn/assets/sprites-shell-f705d3e2.svg"
        );
    }

    #[test]
    fn fragmentless_urls_keep_their_shape() {
        let out = rewrite_url_attr(
            "https://example.com/app.js",
            "https://example.com/",
            "",
            "/lj/",
        );
        let seg = out.strip_prefix("/lj/").unwrap();
        let decoded = String::from_utf8(b64url_decode(seg).unwrap()).unwrap();
        assert_eq!(decoded, "https://example.com/app.js");
        assert!(!out.contains('#'));
    }

    /// Full <use> tag: href rewritten, fragment preserved for the
    /// browser's symbol selection.
    #[test]
    fn svg_use_tag_keeps_the_fragment_after_the_route() {
        let tag = r#"<use href="/cdn/assets/sprites.svg#voice-regular-24">"#;
        let lower = tag.to_ascii_lowercase();
        let out = rewrite_tag(tag, &lower, "https://chatgpt.com/", "?lb_ab=1", "/lj/");
        assert!(out.starts_with(r#"<use href="/lj/"#));
        assert!(out.ends_with("#voice-regular-24\">"));
        assert!(out.contains("?lb_ab=1#voice-regular-24"));
    }
}

#[cfg(test)]
mod res_id_tests {
    use super::next_res_id;
    use std::sync::atomic::AtomicU64;

    #[test]
    fn ids_are_six_digits_and_monotonic() {
        let c = AtomicU64::new(0);
        assert_eq!(next_res_id(&c), "RES-000000");
        assert_eq!(next_res_id(&c), "RES-000001");
        assert_eq!(next_res_id(&c), "RES-000002");
    }

    #[test]
    fn ids_wrap_at_a_million_keeping_the_bounded_width() {
        let c = AtomicU64::new(999_999);
        assert_eq!(next_res_id(&c), "RES-999999");
        assert_eq!(next_res_id(&c), "RES-000000");
    }
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
mod antiframe_tests {
    use super::js_antiframe;

    #[test]
    fn classic_buster_is_neutralized() {
        assert_eq!(
            js_antiframe(
                "if (top != self) {\n  top.location = location;\n}\nalert('rest of app');"
            ),
            "if (self != self) {\n  self.LB_antiframe = location;\n}\nalert('rest of app');"
        );
    }

    #[test]
    fn href_write_and_calls_sink() {
        assert_eq!(
            js_antiframe("top.location.href = u; top.location.replace(x); top.location.reload();"),
            "self.LB_antiframe = u; self.LB_antiframe_replace(x); self.LB_antiframe_reload();"
        );
    }

    #[test]
    fn reads_and_comparisons_survive() {
        assert_eq!(
            js_antiframe(
                "var u = top.location.href; if (top.location == x) {} if (top == self) boot();"
            ),
            "var u = self.location.href; if (self.location == x) {} if (self == self) boot();"
        );
    }

    #[test]
    fn window_forms_and_boundaries() {
        assert_eq!(
            js_antiframe(
                "if (window.top != window.self) { window.top.location = document.location; }"
            ),
            "if (self != self) { self.LB_antiframe = document.location; }"
        );
        assert_eq!(
            js_antiframe("var window.topology; var laptop = 1;"),
            "var window.topology; var laptop = 1;"
        );
    }

    #[test]
    fn minified_guards_fold() {
        assert_eq!(
            js_antiframe("if(top!=self){top.location=location}"),
            "if(self!=self){self.LB_antiframe=location}"
        );
    }
}

#[cfg(test)]
mod suggest_tests {
    use super::{is_amo_host, parse_osjson};

    #[test]
    fn osjson_shapes_parse_or_empty() {
        assert_eq!(
            parse_osjson(r#"["weather",["weather tomorrow","weather radar"]]"#),
            vec!["weather tomorrow", "weather radar"]
        );
        assert!(parse_osjson(r#"{"suggestions":[]}"#).is_empty());
        assert!(parse_osjson("not json at all").is_empty());
        /* Empty strings never make it into the list. */
        assert_eq!(parse_osjson(r#"["q",["", "a"]]"#), vec!["a"]);
    }

    #[test]
    fn amo_host_detection() {
        assert!(is_amo_host("addons.mozilla.org"));
        assert!(is_amo_host("Sub.Addons.Mozilla.Org"));
        assert!(!is_amo_host("mozilla.org"));
        assert!(!is_amo_host("evil-addons.mozilla.org.example.com"));
    }
}
