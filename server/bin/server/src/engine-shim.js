(function(){
  if (window.__lbHook) return; window.__lbHook = true;
  /* Patch classification (audit, do not delete patches wholesale):
     - required for proxy operation (any transport):
         route()/b64u/unroute, PREFIX detection, click/new-tab guard,
         history pushState/replaceState routing + nav reporting,
         window.open interception, console/error reporting, resfail.
     - required for the server-rewritten (ScramJet /r and /lj) path:
         fetch/XHR routing, element src/href/poster property setters
         (HTMLImage/Script/IFrame/Media/Source/Link), setAttribute
         routing. These exist because the page's runtime-assigned URLs
         must reach the engine route; static markup is rewritten
         server-side. They stay until the Zeolite service-worker
         transport owns the whole origin and real-world testing proves
         the injected-shim path unnecessary (RewriteFallback).
     - legacy/compat: COMPAT_JS (separate) gives proxied pages honest,
         immediately-failing stubs for service workers, notifications
         and install prompts (capabilities that cannot work on the
         proxy origin); it never claims success and never hangs.
     Each patch must keep the fragment rule: fragments are client-side
     and never become part of an encoded request target. */
  var PAGE = window.__lbPageUrl;
  var PARAMS = window.__lbParams || "";
  /* DIAGNOSTICS transport. Batching: busy pages used to fire one
     postMessage per console/network event, driving one React state
     update each. Events are now buffered and flushed as one
     {lb:"batch"} message after 120ms (or 32 events, whichever first);
     the parent accepts both batch and single-event shapes. Routing
     patches never go through this, only diagnostics. */
  var batch = [];
  var batchTimer = null;
  var flush = function(){
    batchTimer = null;
    if (!batch.length) return;
    var evs = batch; batch = [];
    try { parent.postMessage({ lb: "batch", data: { events: evs } }, location.origin); } catch (e) {}
  };
  var send = function(type, data){
    batch.push({ lb: type, data: data });
    if (batch.length >= 32) { if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; } flush(); return; }
    if (!batchTimer) batchTimer = setTimeout(flush, 120);
  };
  /* Resource-failure diagnostics: structured what-failed-and-why
     reports for the DevTools diagnostics view and the error page.
     Sensitive query parameters are redacted before anything leaves
     the page. */
  var redact = function(u){
    return String(u).replace(/([?&])(token|access_token|refresh_token|api_key|apikey|password|passwd|pwd|secret|authorization|session|sessionid|session_id|sid|client_secret)=[^&]*/gi, "$1$2=[redacted]");
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
      /* Inline <script type=module> failures (a static import that
         cannot resolve kills the module and fires error on the inline
         element with no src). Diagnose instead of shrugging: the
         first 100 chars of the inline body say which module died. */
      try {
        var tc = t.textContent || "";
        if (tc) note += "; inline body starts: " + String(tc).replace(/\s+/g, " ").slice(0, 100);
      } catch (er) {}
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
  /* CAPTCHA / anti-bot widget frames must stay genuinely cross-origin
     (mirrors is_frame_to_challenge_host in main.rs — keep CHALLENGE_HOSTS
     and this regex in sync): the widget's own scripts validate its real
     origin, and the embedding page's provider JS validates postMessage
     event.origin against the provider domain. Routing the frame through
     the engine makes it same-origin with the proxy, both checks fail,
     and the widget errors or spins forever instead of letting the user
     solve it. Leaving the src unrouted makes the browser load the widget
     directly from the provider, exactly like an unproxied page, so the
     human's solve works; only the final form submit travels through the
     proxy. This is compatibility, never solving. */
  /* Single source of truth: main.rs injects
     window.__LB_CHALLENGE_HOSTS (serialized from the Rust
     CHALLENGE_HOSTS const) before this script, so the Rust and JS
     lists cannot drift apart. The hardcoded literal is only a fallback
     for contexts without the injected list and must mirror the Rust
     const. See the comment above for why these frames stay
     cross-origin. */
  var CHALLENGE_HOSTS_FALLBACK = ["challenges.cloudflare.com","cloudflare.com","js.stripe.com","hcaptcha.com","www.google.com","recaptcha.net"];
  var CHALLENGE_HOST_LIST = (window.__LB_CHALLENGE_HOSTS && window.__LB_CHALLENGE_HOSTS.length) ? window.__LB_CHALLENGE_HOSTS : CHALLENGE_HOSTS_FALLBACK;
  /* ponytail: the replacement must be "\\$&" (escape every regex
     special in a hostname). A pass-2 splice once inlined the deleted
     fallback literal here instead; it parsed fine but matched nothing,
     so runtime-created captcha frames were routed through the engine
     and broke. The challenge_regex_construction Rust test guards it. */
  var CHALLENGE_HOST_RE = new RegExp("(^|\\.)(" + CHALLENGE_HOST_LIST.map(function(h){ return h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|") + ")$", "i");
  function chal(u) {
    try { return CHALLENGE_HOST_RE.test(new URL(String(u), PAGE).hostname); }
    catch (e) { return false; }
  }
  var chalNote = function(v){
    send("console", { level: "info",
      text: "[lb] challenge widget frame left cross-origin: " + String(v).slice(0, 120), ts: Date.now() });
  };
  var of = window.fetch;
  if (of) { window.fetch = function(input, init){
    /* url0 must survive every input shape: string, Request (url) and
       URL objects (href). Passing a URL object through unrouted used
       to escape the proxy and surface as "unknown resource". */
    var url0 = (typeof input === "string") ? input
             : ((input && input.url) || (input && input.href) || "");
    var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    var t0 = Date.now();
    var routed = input;
    try {
      if (typeof input === "string") routed = route(input);
      else if (input && input.href) routed = route(input.href);
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
      /* A page aborting its own request (autocomplete debounce,
         superseded searches) is a normal pattern, not a load failure.
         Report it on the net channel with an abort marker, never as a
         resfail. */
      var aborted = !!(err && (err.name === "AbortError" || String(err).indexOf("AbortError") >= 0));
      send("net", { url: String(url0), method: method, status: 0, aborted: aborted, error: String(err), dur: Date.now() - t0, ts: Date.now() });
      if (!aborted) fail("fetch", { url: String(url0), reason: "FETCH_FAILURE", note: String(err).slice(0, 200) });
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
      var t0 = Date.now();
      /* Foreign ws(s):// sockets must never silently connect: the
         native WebSocket ignores the proxy and would expose the user's
         real IP to the target host. There is no WebSocket transport
         through the engine, so the honest behavior is an immediate,
         loud failure (thrown SecurityError plus a diagnostic), the
         same thing a browser does for a blocked scheme. Same-origin
         sockets (the proxy origin's own, e.g. the Zeolite wisp
         server) pass through untouched. */
      var wsUrl = String(u);
      var wsOrigin = "";
      var isForeignWS = false;
      try {
        var parsed = new URL(wsUrl, location.href);
        wsOrigin = parsed.origin;
        isForeignWS = /^wss?:/i.test(parsed.protocol) && parsed.origin !== location.origin;
      } catch (e) {
        // Unparseable URL: let the native constructor produce its own
        // honest SyntaxError below.
      }
      if (isForeignWS) {
        var msg = "LobsterBrowse: direct WebSocket to '" + redact(wsUrl).slice(0, 200) + "' is blocked (would bypass the proxy and expose your IP); proxied WebSocket transport is not supported";
        fail("websocket", { url: wsUrl, reason: "WEBSOCKET_UNSUPPORTED", note: "foreign-origin WebSocket blocked by LobsterBrowse: " + wsOrigin });
        try { console.warn(msg); } catch (e) {}
        throw new DOMException(msg, "SecurityError");
      }
      var ws;
      try { ws = p !== undefined ? new OWS(u, p) : new OWS(u); }
      catch (e) {
        fail("websocket", { url: String(u), reason: "WEBSOCKET_FAILURE", note: "constructor threw: " + String(e).slice(0, 180) });
        throw e;
      }
      /* A closing WebSocket is NOT automatically a failure: servers and
         clients close sockets normally all the time. Report the close
         facts (code, reason, wasClean, duration) and only raise a
         failure for abnormal closes: an unclean shutdown, code 1006
         (abnormal closure / never established), or a transport error. */
      var failed = false;
      ws.addEventListener("open", function(){
        send("net", { url: String(u), method: "WS", status: 101, dur: Date.now() - t0, ts: Date.now() });
      });
      ws.addEventListener("error", function(){
        failed = true;
        fail("websocket", { url: String(u), reason: "WEBSOCKET_FAILURE", note: "transport error before close" });
      });
      ws.addEventListener("close", function(ev){
        var code = (ev && ev.code) || 0;
        var clean = !!(ev && ev.wasClean);
        send("net", { url: String(u), method: "WS", status: code, dur: Date.now() - t0,
          close: { code: code, reason: String((ev && ev.reason) || "").slice(0, 200), wasClean: clean }, ts: Date.now() });
        var abnormal = !clean || code === 1006;
        if (abnormal && !failed) {
          failed = true;
          fail("websocket", { url: String(u), reason: "WEBSOCKET_FAILURE", status: code,
            note: "abnormal close (code " + code + ", clean: " + clean + ")" });
        }
      });
      return ws; };
    WS.prototype = OWS.prototype; window.WebSocket = WS; }
  /* Guest workers from a foreign origin: the script fetch itself
     would bypass the proxy (real-IP request to the target host), and
     once running the worker's own subresource fetches are unshimmed
     by design. Same policy as foreign WebSockets: immediate, loud
     failure. Workers from same-origin/blob/data URLs (the rewritten,
     proxied case) run unchanged. In-worker subresource routing is
     engine-owned and documented as deferred work. */
  var OW = window.Worker;
  if (OW) { var WK = function(u, o){
      var foreign = false;
      try { var pu = new URL(String(u), location.href); foreign = /^https?:/i.test(pu.protocol) && pu.origin !== location.origin; } catch (e) {}
      if (foreign) {
        var wmsg = "LobsterBrowse: worker script from '" + redact(String(u)).slice(0, 200) + "' is blocked (the script fetch would bypass the proxy and expose your IP); guest worker transport is not supported";
        fail("worker", { url: String(u), reason: "WORKER_UNSUPPORTED", note: "foreign-origin Worker blocked by LobsterBrowse" });
        try { console.warn(wmsg); } catch (e) {}
        throw new DOMException(wmsg, "SecurityError");
      }
      return o !== undefined ? new OW(u, o) : new OW(u); };
    WK.prototype = OW.prototype; window.Worker = WK; }
  var OSW = window.SharedWorker;
  if (OSW) { var SWK = function(u, o){
      var foreign2 = false;
      try { var pu2 = new URL(String(u), location.href); foreign2 = /^https?:/i.test(pu2.protocol) && pu2.origin !== location.origin; } catch (e) {}
      if (foreign2) {
        var wmsg2 = "LobsterBrowse: shared worker script from '" + redact(String(u)).slice(0, 200) + "' is blocked (would bypass the proxy); guest worker transport is not supported";
        fail("worker", { url: String(u), reason: "WORKER_UNSUPPORTED", note: "foreign-origin SharedWorker blocked by LobsterBrowse" });
        try { console.warn(wmsg2); } catch (e) {}
        throw new DOMException(wmsg2, "SecurityError");
      }
      return o !== undefined ? new OSW(u, o) : new OSW(u); };
    SWK.prototype = OSW.prototype; window.SharedWorker = SWK; }
  function prop(clazz, name, keepCrossOrigin) {
    try {
      var proto = window[clazz] && window[clazz].prototype;
      if (!proto) return;
      var d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !d.set || !d.get) return;
      Object.defineProperty(proto, name, {
        get: d.get,
        set: function(v) {
          try {
            if (keepCrossOrigin && chal(v)) { chalNote(v); d.set.call(this, v); }
            else { d.set.call(this, route(String(v))); }
          } catch (e) { d.set.call(this, v); }
        },
        configurable: true });
    } catch (e) {}
  }
  prop("HTMLImageElement", "src");
  prop("HTMLScriptElement", "src");
  prop("HTMLIFrameElement", "src", true);
  prop("HTMLMediaElement", "src");
  prop("HTMLMediaElement", "poster");
  prop("HTMLSourceElement", "src");
  prop("HTMLLinkElement", "href");
  /* Runtime href/action assignment on anchors and forms is as much a
     proxy bypass as src on images: a runtime-assigned real URL would
     navigate the tab straight off the proxy origin. Routed like every
     other element URL (formaction rides along via setAttribute). */
  prop("HTMLAnchorElement", "href");
  prop("HTMLFormElement", "action");
  var baseNoted = false;
  var baseNote = function(v){
    if (baseNoted) return; baseNoted = true;
    send("console", { level: "info",
      text: "[lb] runtime <base href> mutation dropped (incompatible with URL rewriting): " + String(v).slice(0, 120), ts: Date.now() });
  };
  try {
    var bproto = window.HTMLBaseElement && window.HTMLBaseElement.prototype;
    var bdesc = bproto && Object.getOwnPropertyDescriptor(bproto, "href");
    if (bdesc && bdesc.set && bdesc.get) Object.defineProperty(bproto, "href", {
      get: bdesc.get, set: function(v){ baseNote(v); }, configurable: true });
  } catch (e) {}
  var sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(n, v) {
    try {
      var ln = String(n).toLowerCase();
      /* Challenge widget frames keep their real cross-origin src (see
         chal()); every other URL attribute routes as before. */
      /* A runtime <base href> would re-anchor every URL we do NOT
         route (they would resolve against the proxy origin path or a
         foreign origin); dropped with a one-time diagnostic, the
         element stays inert (server markup already strips base). */
      if (ln === "href" && this.tagName === "BASE" && typeof v === "string" && v) {
        baseNote(v); return;
      }
      if (ln === "src" && this.tagName === "IFRAME" && typeof v === "string" && v && chal(v)) {
        chalNote(v);
      } else if ((ln === "href" || ln === "src" || ln === "action" || ln === "formaction" || ln === "poster") && typeof v === "string" && v) {
        v = route(v);
      }
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
    /* Route segments are bounded (they encode a URL), but a hostile or
       corrupted path could hand us a huge string; fromCharCode.apply
       over an unbounded array overflows the call stack. */
    if (seg.length > 8192) return s;
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
