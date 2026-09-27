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
const ENGINE_JS: &str = r##"(function(){
  if (window.__lbHook) return; window.__lbHook = true;
  var PAGE = window.__lbPageUrl;
  var PARAMS = window.__lbParams || "";
  var send = function(type, data){ try { parent.postMessage({ lb: type, data: data }, "*"); } catch (e) {} };
  /* Resource-failure diagnostics: structured what-failed-and-why
     reports for the DevTools diagnostics view and the error page.
     Sensitive query parameters are redacted before anything leaves
     the page. */
  var redact = function(u){
    return String(u).replace(/([?&])(token|access_token|api_key|apikey|password|secret|authorization|session)=[^&]*/gi, "$1$2=[redacted]");
  };
  var fail = function(kind, info){
    try {
      info = info || {};
      /* Status is only reported when it was actually observed. Element
         load failures have no HTTP status the page can read, so the
         report carries none instead of a fabricated 0 that reads like
         a browser network error. */
      var payload = { kind: kind, url: redact(info.url || ""), reason: info.reason || "UNKNOWN",
        note: String(info.note || "").slice(0, 400), ts: Date.now() };
      if (info.status !== undefined && info.status !== null) payload.status = info.status;
      send("resfail", payload);
    } catch (e) {}
  };
  /* Resource load failures fire a capture-phase error event on the
     ELEMENT (script/style/img/source/media/iframe), not the window. */
  window.addEventListener("error", function(e){
    var t = e.target;
    if (!t || !t.tagName || t === window) return;
    var tag = String(t.tagName).toUpperCase();
    var kind = (tag === "IMG" || tag === "SOURCE") ? "image"
      : tag === "SCRIPT" ? "javascript"
      : tag === "LINK" ? ((t.rel && String(t.rel).toLowerCase().indexOf("stylesheet") >= 0) ? "css" : "link")
      : tag === "IFRAME" ? "iframe"
      : (tag === "VIDEO" || tag === "AUDIO") ? "media" : "resource";
    /* Keep the real resource identity: src, then href, then currentSrc
       (images/media resolve late), then data. A failing element with NO
       resolvable URL is reported with an honest note instead of an
       empty string the diagnostics render as "(no URL)". */
    var u = t.src || t.href || t.data || "";
    if (!u) { try { u = t.currentSrc || ""; } catch (er) {} }
    var note = "";
    if (!u) {
      note = "no URL on the failing element; tag <" + tag.toLowerCase() + ">"
        + (t.getAttribute("type") ? ", type " + t.getAttribute("type") : "")
        + (t.getAttribute("integrity") ? ", SRI present" : "")
        + " (element reported a load failure before a resource could be identified)";
    }
    fail(kind, { url: u, reason: "RESOURCE_LOAD_FAILURE", note: note });
  }, true);
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
    /* Fragments are client-side only (SVG sprite symbols, anchors).
       They must not become part of the encoded request target: every
       "#symbol" variant of one sprite is the same network resource.
       Re-attached after the route so <use href="...#icon"> still
       selects its symbol. */
    var frag = "";
    var hi = abs.indexOf("#");
    if (hi >= 0) { frag = abs.slice(hi); abs = abs.slice(0, hi); }
    return PREFIX + b64u(abs) + PARAMS + frag;
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
      if (!resp.ok) {
        fail("fetch", { url: String(url0), reason: "HTTP_ERROR", status: resp.status });
      } else {
        /* MIME mismatch: a script/css/font/image request answered with
           an HTML body (usually a proxy error page) is one of the most
           common "site looks broken" causes. */
        var ct = (resp.headers && resp.headers.get) ? (resp.headers.get("content-type") || "") : "";
        var path = String(url0).split("?")[0].split("#")[0];
        if (/text\/html/i.test(ct) && /\.(js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|webp|svg|json|wasm)$/i.test(path)) {
          fail("fetch", { url: String(url0), reason: "MIME_TYPE_ERROR", status: resp.status, note: "received content-type " + ct });
        }
      }
      return resp; }, function(err){
      send("net", { url: String(url0), method: method, status: 0, error: String(err), dur: Date.now() - t0, ts: Date.now() });
      fail("fetch", { url: String(url0), reason: "FETCH_FAILURE", note: String(err).slice(0, 200) });
      throw err; }); }; }
  if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) {
      try { arguments[1] = route(u); } catch (e) {}
      this.__lb = { method: String(m).toUpperCase(), url: String(u), t0: Date.now() };
      var self = this;
      this.addEventListener("loadend", function(){ var i2 = self.__lb;
        if (i2) send("net", { url: i2.url, method: i2.method, status: self.status, dur: Date.now() - i2.t0, ts: Date.now() });
        if (i2 && self.status === 0) fail("xhr", { url: i2.url, reason: "XHR_FAILURE" });
        else if (i2 && self.status >= 400) fail("xhr", { url: i2.url, reason: "HTTP_ERROR", status: self.status }); });
      return ox.apply(this, arguments); }; }
  var OWS = window.WebSocket;
  if (OWS) { var WS = function(u, p){
      send("net", { url: String(u), method: "WS", status: 101, ts: Date.now() });
      var ws;
      try { ws = p !== undefined ? new OWS(u, p) : new OWS(u); }
      catch (e) {
        fail("websocket", { url: String(u), reason: "WEBSOCKET_FAILURE", note: String(e).slice(0, 200) });
        throw e;
      }
      ws.addEventListener("close", function(){ send("net", { url: String(u), method: "WS", status: 1006, ts: Date.now() });
        fail("websocket", { url: String(u), reason: "WEBSOCKET_FAILURE" }); });
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
  /* Event-driven SPA navigation (74.6): report every history change
     the moment it happens so the UI syncs without poll latency. The
     URL is un-routed back to the real destination before it leaves
     the page. */
  var navSend = function(op) {
    try { send("nav", { op: op, url: unroute(location.href), ts: Date.now() }); } catch (e) {}
  };
  history.pushState = function(st, t, u) {
    try { if (u) arguments[2] = route(u); } catch (e) {}
    var r = ops.apply(history, arguments);
    navSend("push");
    return r; };
  history.replaceState = function(st, t, u) {
    try { if (u) arguments[2] = route(u); } catch (e) {}
    var r = ors.apply(history, arguments);
    navSend("replace");
    return r; };
  window.addEventListener("popstate", function(){ navSend("pop"); });
  window.addEventListener("hashchange", function(){ navSend("hash"); });
  window.addEventListener("load", function(){ send("ready", { title: document.title }); });
})();
"##;

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
    /// Separate cookie jar for incognito routes (74.9): requests with
    /// lb_inc=1 use this client, so incognito cookies never mix into
    /// the shared jar (and vice versa). RAM only, no persistence.
    incognito_client: reqwest::Client,
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
