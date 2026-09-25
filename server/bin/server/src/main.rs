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

mod proxy;

use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

/// Engine shim + devtools hook injected right after <head> of every
/// rewritten HTML document. The shim routes runtime fetch/XHR, element
/// src/href assignments and history changes through /r routes; the hook
/// reports console output, errors, network traffic and page loads to
/// the parent UI window (same origin) via postMessage.
const ENGINE_JS: &str = r#"(function(){
  if (window.__lbHook) return; window.__lbHook = true;
  var PAGE = window.__lbPageUrl;
  var PARAMS = window.__lbParams || "";
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
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function b64u(s) {
    var bytes;
    try { bytes = new TextEncoder().encode(s); }
    catch (e) { bytes = []; for (var k = 0; k < s.length; k++) { var cc = s.charCodeAt(k); bytes.push(cc < 128 ? cc : 63); } }
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      var n = (b0 << 16) | (b1 << 8) | b2;
      out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
      if (i + 1 < bytes.length) out += B64.charAt((n >> 6) & 63);
      if (i + 2 < bytes.length) out += B64.charAt(n & 63);
    }
    return out;
  }
  /* Route prefix follows the engine that served this page: /lj/ when
     the navigation came through LobsterJet, /r/ for ScramJet. */
  var PREFIX = location.pathname.indexOf("/lj/") === 0 ? "/lj/" : "/r/";
  function route(u) {
    if (u === null || u === undefined) return u;
    var s = String(u);
    if (!s) return s;
    if (s.indexOf("/r/") === 0 || s.indexOf("/lj/") === 0) return s;
    if (s.indexOf(location.origin + "/r/") === 0 || s.indexOf(location.origin + "/lj/") === 0) return s;
    if (/^(data|blob|javascript|mailto|tel|about):/i.test(s)) return s;
    var abs;
    try { abs = new URL(s, PAGE).href; } catch (e) { return s; }
    if (abs.indexOf(location.origin) === 0) return s;
    if (!/^https?:/i.test(abs)) return s;
    return PREFIX + b64u(abs) + PARAMS;
  }
  window.__lbRoute = route;
  var of = window.fetch;
  if (of) { window.fetch = function(input, init){
    var url0 = (typeof input === "string") ? input : ((input && input.url) || "");
    var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    var t0 = Date.now();
    var routed = input;
    try {
      if (typeof input === "string") routed = route(input);
      else if (input && input.url) routed = new Request(route(input.url), input);
    } catch (e) {}
    return of.call(window, routed, init).then(function(resp){
      send("net", { url: String(url0), method: method, status: resp.status, ok: resp.ok, dur: Date.now() - t0, ts: Date.now() });
      return resp; }, function(err){
      send("net", { url: String(url0), method: method, status: 0, error: String(err), dur: Date.now() - t0, ts: Date.now() });
      throw err; }); }; }
  if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) {
      try { arguments[1] = route(u); } catch (e) {}
      this.__lb = { method: String(m).toUpperCase(), url: String(u), t0: Date.now() };
      var self = this;
      this.addEventListener("loadend", function(){ var i2 = self.__lb;
        if (i2) send("net", { url: i2.url, method: i2.method, status: self.status, dur: Date.now() - i2.t0, ts: Date.now() }); });
      return ox.apply(this, arguments); }; }
  var OWS = window.WebSocket;
  if (OWS) { var WS = function(u, p){ send("net", { url: String(u), method: "WS", status: 101, ts: Date.now() });
      var ws = p !== undefined ? new OWS(u, p) : new OWS(u);
      ws.addEventListener("close", function(){ send("net", { url: String(u), method: "WS", status: 1006, ts: Date.now() }); });
      return ws; };
    WS.prototype = OWS.prototype; window.WebSocket = WS; }
  function prop(clazz, name) {
    try {
      var proto = window[clazz] && window[clazz].prototype;
      if (!proto) return;
      var d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !d.set || !d.get) return;
      Object.defineProperty(proto, name, {
        get: d.get,
        set: function(v) { try { d.set.call(this, route(String(v))); } catch (e) { d.set.call(this, v); } },
        configurable: true });
    } catch (e) {}
  }
  prop("HTMLImageElement", "src");
  prop("HTMLScriptElement", "src");
  prop("HTMLIFrameElement", "src");
  prop("HTMLMediaElement", "src");
  prop("HTMLMediaElement", "poster");
  prop("HTMLSourceElement", "src");
  prop("HTMLLinkElement", "href");
  var sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(n, v) {
    try {
      var ln = String(n).toLowerCase();
      if ((ln === "href" || ln === "src" || ln === "action" || ln === "poster") && typeof v === "string" && v) v = route(v);
    } catch (e) {}
    return sa.call(this, n, v);
  };
  function unroute(s) {
    if (s.indexOf(location.origin + "/r/") === 0) s = s.slice(location.origin.length);
    if (s.indexOf(location.origin + "/lj/") === 0) s = s.slice(location.origin.length);
    var seg = null;
    if (s.indexOf("/r/") === 0) seg = s.slice(3).split('?')[0].split('#')[0];
    else if (s.indexOf("/lj/") === 0) seg = s.slice(4).split('?')[0].split('#')[0];
    if (seg === null) return s;
    var B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    var bytes = [];
    for (var i = 0; i < seg.length; i += 4) {
      var n0 = B.indexOf(seg.charAt(i)), n1 = B.indexOf(seg.charAt(i + 1));
      var n2 = i + 2 < seg.length ? B.indexOf(seg.charAt(i + 2)) : -1;
      var n3 = i + 3 < seg.length ? B.indexOf(seg.charAt(i + 3)) : -1;
      if (n0 < 0 || n1 < 0) return s;
      bytes.push((n0 << 2) | (n1 >> 4));
      if (n2 >= 0) bytes.push(((n1 & 15) << 4) | (n2 >> 2));
      if (n3 >= 0) bytes.push(((n2 & 3) << 6) | n3);
    }
    var out = "";
    try { out = decodeURIComponent(escape(String.fromCharCode.apply(null, bytes))); } catch (e) { out = ""; }
    return out || s;
  }
  document.addEventListener("click", function(e){
    if (e.defaultPrevented) return;
    var t = e.target; while (t && t.nodeType === 1 && t.tagName !== "A") t = t.parentNode;
    if (!t || !t.getAttribute) return;
    var tgt = (t.getAttribute("target") || "").toLowerCase();
    /* _blank and modified clicks open a new PROXY tab, never a real
       browser tab (a real tab would leak the /r/ route URL). */
    if (tgt !== "_blank" && tgt !== "blank" && !e.ctrlKey && !e.metaKey && !e.shiftKey) return;
    if (e.altKey) return;
    var href = t.getAttribute("href") || "";
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#') return;
    e.preventDefault();
    var real = unroute(new URL(href, PAGE).href);
    send("navigate", { href: real, newTab: true });
  }, true);
  window.open = function(u) {
    try { if (u) { send("navigate", { href: new URL(String(u), PAGE).href, newTab: true }); return null; } } catch (e) {}
    return null;
  };
  var ops = history.pushState, ors = history.replaceState;
  history.pushState = function(st, t, u) { try { if (u) arguments[2] = route(u); } catch (e) {} return ops.apply(history, arguments); };
  history.replaceState = function(st, t, u) { try { if (u) arguments[2] = route(u); } catch (e) {} return ors.apply(history, arguments); };
  window.addEventListener("load", function(){ send("ready", { title: document.title }); });
})();
"#;

/// Compatibility layer for proxied pages running inside a sandboxed
/// same-origin frame: service workers, install prompts and push
/// notifications either hang or misfire there, so stub them out.
const COMPAT_JS: &str = r#"(function(){
  if (window.__lbCompat) return; window.__lbCompat = true;
  var sw = { register: function(){ return Promise.reject(new Error("service workers unavailable")); },
             getRegistration: function(){ return Promise.resolve(undefined); },
             getRegistrations: function(){ return Promise.resolve([]); },
             addEventListener: function(){}, removeEventListener: function(){},
             ready: new Promise(function(){}) };
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: function(){ return sw; }, configurable: true }); } catch (e) {}
  try { if (window.Notification) { Notification.permission = "denied"; Notification.requestPermission = function(){ return Promise.resolve("denied"); }; } } catch (e) {}
  window.addEventListener("beforeinstallprompt", function(e){ e.preventDefault(); });
})();"#;

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
    CHALLENGE_HOSTS.iter().any(|c| h == *c || h.ends_with(&format!(".{c}")))
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

/// Drop <base> tags: every relative URL is resolved and rewritten
/// server-side against the real page URL anyway.
fn strip_base_tags(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut i = 0usize;
    while let Some(rel) = lower[i..].find("<base") {
        let start = i + rel;
        let nextc = lower[start + 5..].chars().next();
        let ok = matches!(nextc, Some(' ') | Some('\t') | Some('\n') | Some('\r') | Some('>') | Some('/'));
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
fn strip_integrity(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut i = 0usize;
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
    }
    out.push_str(&html[i.min(html.len())..]);
    out
}

const B64URL_CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
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
    let pathout = if joined.starts_with('/') { joined } else { format!("/{}", joined) };
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

fn rewrite_url_attr(value: &str, page_url: &str, suffix: &str) -> String {
    match resolve_url(page_url, value) {
        Some(abs) => format!("/r/{}{}", b64url_encode(abs.as_bytes()), suffix),
        None => value.to_string(),
    }
}

/// srcset="url 2x, url2 1x" — rewrite each candidate URL.
fn rewrite_srcset(value: &str, page_url: &str, suffix: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for item in value.split(',') {
        let it = item.trim();
        if it.is_empty() {
            continue;
        }
        let mut split = it.splitn(2, char::is_whitespace);
        let u = split.next().unwrap_or("");
        let desc = split.next().map(|d| d.trim()).unwrap_or("");
        let desc_s = if desc.is_empty() { String::new() } else { format!(" {}", desc) };
        if is_rewritable_url(u) {
            parts.push(format!("{}{}", rewrite_url_attr(u, page_url, suffix), desc_s));
        } else {
            parts.push(it.to_string());
        }
    }
    parts.join(", ")
}

/// Rewrite url(...) references in CSS against the stylesheet's own URL.
fn rewrite_css(css: &str, base: &str, suffix: &str) -> String {
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
                    out.push_str(&rewrite_url_attr(&v, base, suffix));
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
fn rewrite_tag(tag: &str, tag_lower: &str, page_url: &str, suffix: &str) -> String {
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
            1 => rewrite_srcset(&value, page_url, suffix),
            2 => rewrite_css(&value, page_url, suffix),
            _ => {
                if is_rewritable_url(&value) {
                    rewrite_url_attr(&value, page_url, suffix)
                } else {
                    value.clone()
                }
            }
        };
        out.push_str(&tag[pos..pos + nlen]);
        out.push_str(&new_value);
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
fn rewrite_html(html: &str, page_url: &str, suffix: &str) -> String {
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
            out.push_str(&rewrite_tag(tag, tag_lower, page_url, suffix));
            match lower[end + 1..].find("</script") {
                Some(c) => {
                    let cs = end + 1 + c;
                    let after_close = lower[cs..].find('>').map(|x| cs + x + 1).unwrap_or(html.len());
                    out.push_str(&html[end + 1..after_close]);
                    i = after_close;
                }
                None => {
                    out.push_str(&html[end + 1..]);
                    break;
                }
            }
            continue;
        }
        if tag_lower.starts_with("<style") {
            out.push_str(&rewrite_tag(tag, tag_lower, page_url, suffix));
            match lower[end + 1..].find("</style") {
                Some(c) => {
                    let cs = end + 1 + c;
                    let after_close = lower[cs..].find('>').map(|x| cs + x + 1).unwrap_or(html.len());
                    out.push_str(&rewrite_css(&html[end + 1..cs], page_url, suffix));
                    out.push_str(&html[cs..after_close]);
                    i = after_close;
                }
                None => {
                    out.push_str(&rewrite_css(&html[end + 1..], page_url, suffix));
                    break;
                }
            }
            continue;
        }
        out.push_str(&rewrite_tag(tag, tag_lower, page_url, suffix));
        i = end + 1;
    }
    out
}

fn inject_shim(html: String, page_url: &str, suffix: &str) -> String {
    let pre = format!(
        "<script>window.__lbPageUrl=\"{}\";window.__lbParams=\"{}\";</script><script>{}</script><script>{}</script>",
        json_escape(page_url),
        json_escape(suffix),
        ENGINE_JS,
        COMPAT_JS
    );
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
            owned.insert_str(pos, &pre);
            owned
        }
        None => format!("{}{}", pre, html),
    }
}

/// Full HTML pipeline: ad/tracker stripping, CSP/base/SRI cleanup,
/// URL rewriting and shim injection.
fn rewrite_html_doc(
    html: &str,
    page_url: &str,
    params: &HashMap<String, String>,
    suffix: &str,
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
    let cleaned = strip_csp_meta(&cleaned);
    let cleaned = strip_base_tags(&cleaned);
    let cleaned = strip_integrity(&cleaned);
    let rewritten = rewrite_html(&cleaned, page_url, suffix);
    // Challenge/CAPTCHA widget documents are integrity-sensitive: the
    // injected shim (console hooks, fetch patches, page globals) trips
    // anti-bot checks and the widget refuses to run. URL rewriting is
    // kept so their subresources still route through the engine; only
    // the script injection is skipped.
    if is_challenge_host(&host_of(page_url)) {
        return rewritten;
    }
    inject_shim(rewritten, page_url, suffix)
}

/// Engine option query string carried on to every rewritten URL.
fn params_suffix(params: &HashMap<String, String>) -> String {
    let mut parts: Vec<String> = Vec::new();
    for k in ["ab", "trk", "https", "img"] {
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
    let looks_amp = page_url.contains("/amp") || html.contains("<html amp") || html.contains("⚡");
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

fn engine_error_page(url: &str, detail: &str) -> Response {
    // Scramjet compatibility layer: when the rewriter cannot handle a
    // site, offer the deployed headless-browser service as fallback.
    let scramjet = format!("https://lobsterbrowse-scramjet.onrender.com/?url={}", pct_enc(url));
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
    Path(target): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    body: Option<Bytes>,
) -> Response {
    let started = Instant::now();
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
    for k in ["ab", "trk", "https", "ua", "hdrs", "img"] {
        if let Some(v) = params.remove(&format!("lb_{}", k)) {
            params.insert(k.to_string(), v);
        }
    }
    let fetch_url = if page_query.is_empty() {
        url.clone()
    } else {
        let sep = if url.contains('?') { '&' } else { '?' };
        format!("{}{}{}", url, sep, page_query.join("&"))
    };
    if params.get("https").map(|v| v == "1").unwrap_or(false) && fetch_url.starts_with("http://") {
        return engine_error_page(&url, "HTTPS-only mode: plain-http target rejected");
    }

    let suffix = params_suffix(&params);
    push_log(&state, "info", &format!("engine {} {}", method, url));

    let mut req = state.client.request(method.clone(), &fetch_url);
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
                    let value: String = value.chars().filter(|c| *c != '\u{000d}' && *c != '\u{000a}').take(512).collect();
                    let lower = name.to_ascii_lowercase();
                    let valid = !name.is_empty()
                        && !value.is_empty()
                        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                        && !["host", "content-length", "connection", "transfer-encoding", "cookie"]
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
        if let Some(rest) = path.strip_prefix("/r/") {
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
            if base_url != url {
                push_log(&state, "info", &format!("engine redirect {} -> {}", url, base_url));
            }
            let ct = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            let is_html = ct.contains("html");
            let is_css = !is_html && ct.contains("css");
            let compress_img = params.get("img").map(|v| v == "1").unwrap_or(false)
                && ct.starts_with("image/jpeg");
            // Anything that is neither rewritten nor re-encoded streams
            // straight through: large downloads and media must not be
            // buffered in the server's RAM.
            if !is_html && !is_css && !compress_img {
                push_log(
                    &state,
                    "info",
                    &format!("engine stream {} {} -> {}", method, url, status),
                );
                let axum_status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                let stream = resp.bytes_stream();
                return Response::builder()
                    .status(axum_status)
                    .header(header::CONTENT_TYPE, ct)
                    .body(Body::from_stream(stream))
                    .unwrap_or_else(|_| (StatusCode::BAD_GATEWAY, "stream error").into_response());
            }
            let bytes = resp.bytes().await.unwrap_or_default();
            let out: Vec<u8> = if is_html {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                // De-AMP: an AMP variant page redirects itself to its
                // canonical URL, routed through the engine with the same
                // options.
                if let Some(canon) = amp_canonical(&text, &base_url) {
                    if canon != base_url {
                        push_log(&state, "info", &format!("de-amp {} -> {}", base_url, canon));
                        let route = format!("/r/{}{}", b64url_encode(canon.as_bytes()), suffix);
                        return de_amp_redirect(&route);
                    }
                }
                rewrite_html_doc(&text, &base_url, &params, &suffix, &state).into_bytes()
            } else if is_css {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                rewrite_css(&text, &base_url, &suffix).into_bytes()
            } else if compress_img {
                compress_jpeg(&bytes).unwrap_or_else(|| bytes.to_vec())
            } else {
                bytes.to_vec()
            };
            push_log(
                &state,
                "info",
                &format!("engine done {} {} -> {} ({} ms)", method, url, status, started.elapsed().as_millis()),
            );
            let axum_status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (axum_status, [(header::CONTENT_TYPE, ct)], out).into_response()
        }
        Err(e) => engine_error_page(&url, &e.to_string()),
    }
}

/// Search-engine suggestions, proxied server-side to dodge CORS.
/// Every provider returns the same osjson shape: ["query", ["s1", ...]].
async fn suggest_endpoint(
    State(state): State<Arc<AppState>>,
    RawQuery(raw): RawQuery,
) -> Response {
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
        return ([("content-type", "application/json")], r#"{"suggestions":[]}"#).into_response();
    }
    let q_enc = pct_enc(&q);
    // Honest mapping: only providers with a working open suggestion API.
    // Brave, Startpage and Mojeek have none, so they fall back to
    // DuckDuckGo's endpoint.
    let provider = match engine.as_str() {
        "google" => format!("https://suggestqueries.google.com/complete/search?client=firefox&q={}", q_enc),
        "bing" => format!("https://api.bing.com/osjson.aspx?q={}", q_enc),
        _ => format!("https://ac.duckduckgo.com/ac/?q={}&type=list", q_enc),
    };
    push_log(&state, "info", &format!("suggest {}", q));
    let body: Result<String, String> = match state
        .client
        .get(&provider)
        .header("Sec-GPC", "1")
        .header("DNT", "1")
        .send()
        .await
    {
        Ok(r) => match r.error_for_status() {
            Ok(r) => r.text().await.map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        },
        Err(e) => Err(e.to_string()),
    };
    let out = match body {
        Ok(text) => {
            let mut list: Vec<String> = Vec::new();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(arr) = v.as_array() {
                    if let Some(suggs) = arr.get(1).and_then(|x| x.as_array()) {
                        for item in suggs.iter().take(8) {
                            if let Some(t) = item.as_str() {
                                if !t.is_empty() {
                                    list.push(json_escape(t));
                                }
                            }
                        }
                    }
                }
            }
            format!("{{\"suggestions\":[{}]}}", list.join(","))
        }
        Err(e) => {
            push_log(&state, "warn", &format!("suggest failed: {}", e));
            r#"{"suggestions":[]}"#.to_string()
        }
    };
    ([("content-type", "application/json")], out).into_response()
}

/// Recent server-side engine log entries, newest last. JSON array.
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
    let wisp_path = std::env::var("WISP_PATH").unwrap_or_else(|_| "/wisp/".into());
    let auth_password = std::env::var("WISP_PASSWORD").ok();

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
    push_log(&state, "info", "native engine log buffer initialised");

    let wisp_state = Arc::new(proxy::ProxyState::new(auth_password));
    let limiter = Arc::new(Mutex::new(guard::RateLimiter::default()));

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/r/:target", any(engine_proxy))
        // LobsterJet entry: same engine handler, so pages work even when
        // the service worker is not installed/ready yet. The worker layers
        // its client-side cache on top of this route.
        .route("/lj/:target", any(engine_proxy))
                .route("/suggest", get(suggest_endpoint))
.route("/logs", get(logs_endpoint))
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
    info!("LobsterBrowse native engine server listening on {} at {}", addr, wisp_path);
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind failed");
    axum::serve(listener, app).await.expect("server error");
}
