# Beta: Zeolite NativeTransit-First (/zl/)

Unstable experiment branch: beta/zeolite-nativetransit, branched from main
at 31bdc9e. Main is untouched; /r/ and /lj/ keep working exactly as on main.

## Architecture (verified against source, not old docs)

    LobsterBrowse (React UI, tabs, DevTools capture)
      -> Zeolite service worker (zlsw/sw.js, root scope, prefix "/zl/")
         -> request classification: only /zl/ engine paths are claimed;
            everything else (app routes, /r/, /lj/, cross-origin) passes through
         -> NativeTransit: vendored libcurl transport over Wisp v2.1
            (wss /wisp/). Streaming both ways, no full-body buffering,
            status/headers preserved, honest network errors, per-origin
            RFC 6265 cookie jars, hostile-header surgery.
         -> RewriteFallback: the wasm rewriter (emit-while-parsing) plus the
            <5KB bootstrap, applied ONLY to document/CSS/JS surfaces where
            the browser's origin model leaves no transparent option.
      -> Wisp -> target site. Responses stream back the same path.

The target site does not "run NativeTransit". NativeTransit is the network
path the Zeolite worker controls. The site's code runs in the browser,
inside the same-origin proxied frame, same as on main.

## What this branch changes vs main

1. Engine id "zeolite-beta" (settings.ts): explicit opt-in beta selection,
   /zl/ route prefix, accepted by loadSettings, routeUrl, engineRoutePrefix,
   decodeRoute. New zeoliteOwned() helper replaces every
   proxyEngine === "lobsterjet" UI check.
2. Settings panel: third engine segment "Zeolite Beta (/zl/)" plus an
   honest beta description. The persisted default remains "lobsterjet";
   the beta is opt-in per device.
3. App boot: zl:config prefix now follows the selected engine and is
   re-pushed when the engine changes.
4. Server: /zl/:target gets the same honest zl_sw_required answer as /lj/
   for pages no worker controls (cold start, worker restart, browsers
   without module service workers). No second server rewriter exists for
   /zl/; that is the point.

## What NativeTransit already handles (Zeolite 2.x engine)

Transport, streaming, headers, status, redirects, request bodies, range
passthrough, large responses, downloads (attachment detection), WebSocket
bridge (wss over wisp), dedicated/shared/module workers (prelude), cookie
jars per virtual origin, storage scoping, fingerprint profiles, session
export. Verified by Zeolite CI + vitest; see Zeolite docs/matrix.md.

## What still requires RewriteFallback (honest list)

- HTML/CSS/JS URL surfaces: our origin is the proxy origin, so relative
  and absolute URL resolution, form targets, iframe navigation,
  origin-sensitive JS need rewriting. No transport can remove this; it is
  the web platform's same-origin model.
- Set-Cookie on intermediate redirect hops inside the transport (only
  final responses surface to the worker).
- SameSite is parsed but not enforced (no site context exists in a worker).
- Anything new proven by testing must be added here with the trace that
  proves it, not silently.

## Failure behavior

No silent fallback to /r/. A failed /zl/ transport surfaces the engine's
honest error page (navigations) or a 502 text/plain body (subresources).
Diagnostics come from the engine's existing structured rings (DiagEvent,
trace, netLog) with secrets already redacted; the UI DevTools reads them
over the control plane. Nothing logs cookies, auth headers or bodies.

## Compatibility matrix (run before any merge; do not skip rows)

Tier 0 (local fixture): HTML, CSS, JS, JSON, redirect, POST, streaming,
large response, range, cookie endpoint.
Tier 1 static sites. Tier 2 React/Vite apps. Tier 3 auth-heavy apps.
Tier 4 streaming/media. Tier 5 complex modern apps. Tier 6 sites that
today need heavy rewriting.
Per site record: engine used, requests via NativeTransit vs fallback with
reason, cookies, redirects, WS/SSE, workers, memory.

## Promotion conditions (all must hold before any merge to main)

CI green (tsc + cargo + vitest), no change to /r/ or /lj/ behavior,
real-browser verification on Chromium (module SW) and an honest statement
for Firefox (no module SWs) and WebKit, cookies/auth verified, streaming/
range/downloads verified, WS/SSE behavior stated, worker behavior stated,
origin isolation re-verified (proxied JS cannot reach app storage or other
targets), no memory/perf regression vs /lj/, rollback = switch the
settings segment back. Removal of /r/ is a separate future phase and is
NOT part of this beta.

## Known limits (do not paper over)

- Real-browser verification exists as of 2026-09-28 (Chromium via
  Playwright against https://lobsterbrowse-beta.onrender.com at
  4614b57): Tier 0 fully executed and recorded below, plus one Tier 1
  sample (example.com). A Tier 1-3 sample site matrix was run 2026-09-28 and is
  recorded below; real credential flows remain blocked by the
  cookie-jar failure, and streaming media, worker behavior and the
  heaviest rewrite sites (Tier 4-6) remain untested. No local
  toolchain exists; CI plus the Render build are the compile gates.
- /zl/ shares the Zeolite worker's single runtime prefix: switching
  engines re-pushes zl:config; already-open tabs keep their route prefix.
- Incognito isolation on the beta path inherits the engine's cookie-jar
  model (per virtual origin, not per browsing session) - same honest gap
  as /lj/ today.

## Tier 0 status (updated as phases land)

- Automated (CI "transit" job): deterministic fixture
  (tests/transit/fixture.mjs) + HTTP-level assertions
  (tests/transit/check.mjs) for HTML/CSS/JS/JSON/redirect/POST/stream/
  large/range/cookies/SSE, plus - when LB_ORIGIN is set - /zl/
  honest-notice and /r/ end-to-end regression checks. This proves
  fixture and route behavior, NOT the SW->NativeTransit->Wisp chain:
  no browser runs in CI.
- Browser-level Tier 0 (SW claims /zl/, transport over Wisp): RUN
  2026-09-28, Chromium (Playwright) against the deployed beta at
  4614b57, target = the public Tier-0 fixture
  (https://lobsterbrowse-fixture.onrender.com). Fresh-context
  sequence UI load -> engine "Zeolite Beta" -> SW install -> zl:config
  -> /zl/ navigation worked first try (the 5e0b7e3 controllerchange
  re-push is deployed). Results:
  PASS - HTML navigation 200, title/text correct, stylesheet applied
  (body bg rgb(17,34,51) = the fixture #123; sheet href is the /zl/
  encoded style.css route, rules=2).
  PASS - CSS 200 text/css, byte-exact body. (Was the one failing
  path before the /rewriter_wasm_bg.wasm root alias, 204ad95.)
  PASS - JS 200 text/javascript; JSON 200 application/json byte-exact
  {"ok":true,"n":42}; POST /echo 200 exact round-trip.
  PASS - /stream 200, 10240 bytes, first chunk byte-exact
  (7,10,13,16,19,22,25,28).
  PASS - Range bytes=0-1023 -> 206, 1024 bytes, firstByte 13,
  content-range bytes 0-1023/2097152.
  PASS - /large 200, 2097152 bytes, byte-exact spot checks incl.
  offset 12345 (2.1 s end to end through Wisp on the free tier).
  PASS - SSE 200 text/event-stream, all 3 events, delivered in 3
  separate stream reads.
  PASS - /r/ regression on the beta origin: fixture JSON proxies
  byte-exact through ScramJet, 200.
  PASS - Tier 1 sample: https://example.com/ via /zl/ loads (200,
  "Example Domain" rendered through the chain).
  FAIL - Transport redirect at navigation level: /zl/<b64 /redirect>
  (302, Location: "/") lands on the APP origin root (the
  LobsterBrowse UI), not the target virtual root. Root-relative
  Location must be mapped to the /zl/ virtual origin; NativeTransit
  currently surfaces it unrewritten. Same-origin fetch with
  redirect:manual sees opaqueredirect (standard for SW-responded
  redirects, not a bug).
  FAIL - Cookies do not round-trip on the /zl/ subresource path:
  /set-cookie then /cookie returns an empty Cookie header and
  document.cookie stays empty, so the per-virtual-origin jar did
  not apply between two /zl/ fetches. Blocks all auth-heavy tiers
  until fixed. Needs engine-side investigation.
  FAIL - JS string URL surfaces are not rewritten: the fixture
  page's own app.js does fetch('/data.json'); the string escapes
  unrewritten to the proxy origin, hits the SPA fallback (404 HTML)
  and the page's JSON fetch fails. RewriteFallback does not cover
  JS fetch string literals on /zl/.
  Ops - Render auto-deploy does NOT fire on pushes to this branch
  (verified: pushes at 08:53/09:14/09:16 produced zero deploys);
  every code change needs a manual deploy trigger. Free tier spins
  down and does not reliably wake on request; a manual redeploy
  restarts the instance.
- Origin isolation: ui/public/zl-isolation-probe.html run 2026-09-28
  on the beta origin at 4614b57; JSON recorded in the isolation
  record below. Everything is reachable BY DESIGN (same-origin
  architecture). This is the baseline the isolation phase must
  deliberately shrink, not a regression.

## Tier 1-3 site matrix (real browser, RUN 2026-09-28, beta at 4614b57)

Second real-browser pass, same fresh-context harness as browser-level
Tier 0 (UI load -> engine "Zeolite Beta" -> SW ready -> 4.5 s zl:config
wait -> /zl/<b64> navigation), Chromium via Playwright against the
deployed beta.

- PASS - Tier 1 https://example.com/ (recorded in Tier 0 above).
- PASS - Tier 1 https://news.ycombinator.com/: 200, title "Hacker
  News", 30 .athing rows, 16x200 + 1x404, zero target-side failures.
- PASS with caveat - Tier 1 https://en.wikipedia.org/wiki/Main_Page:
  200, title "Wikipedia, the free encyclopedia", 13171 chars of body
  text, 8 requests via /zl/. Caveat: both load.php?only=styles
  stylesheets came back with Content-Type text/javascript and
  Chromium refused to apply them, so the skin CSS was lost (content
  still readable). Engine finding, filed upstream.
- PARTIAL - Tier 3 https://github.com/login: 200, title
  "Sign in to GitHub", login form renders, the form action is
  correctly rewritten to /zl/<b64 https://github.com/session>, 113
  requests via /zl/ (84x200). But 40 chunk/modulepreload requests
  were emitted as raw-path engine routes (/zl/wp-runtime-*.js,
  /zl/react-core-*.js, no b64 segment) and 404ed. Engine rewriter
  defect, filed upstream. Real credential flow NOT attempted:
  blocked by the Tier-0 cookie-jar failure.
- FAIL - Tier 2 https://excalidraw.com/ (React/Vite SPA): 200, the
  document and the main bundle load through correctly encoded /zl/
  routes, cross-origin woff2 fonts (excalidraw.nyc3.cdn
  .digitaloceanspaces.com) are correctly wrapped, but the React app
  never mounts (0 canvas elements, 0 buttons). Three causes observed:
  (1) the engine injects <script src="/bootstrap.js"> at the proxy
  origin root; the server has no such route, so it 404s on every
  proxied page (harmless for static pages, fatal when the page needs
  the bootstrap);
  (2) raw-path engine routes again (/zl/mermaid-to-excalidraw-*.js,
  /zl/apple-touch-icon.png, 404);
  (3) escaped root-relative requests /assets/index-*.css and
  /assets/index-*.js hit the app's OWN /assets/ routes and were
  answered 200 with the embedder UI's bundle files (both projects
  are Vite apps with /assets/index-* names), feeding wrong-content
  200s into the proxied page.
- NOT REPRODUCIBLE - Tier 5 https://chatgpt.com/ in the automated
  context: the transport reaches the target, but chatgpt.com answers
  the Render egress with a Cloudflare challenge (403 "Just a
  moment..."), so the bot gate, not the engine, ends the run. A real
  interactive session (user-reported 2026-09-28) rendered substantial
  UI with NativeTransit (354 NativeTransit vs 40 RewriteFallback
  requests) plus resfail entries showing nested double-wrap URLs and
  CSS fallback classifications; decoded and filed upstream.

All engine findings (redirect Location mapping, cookie jar on the
/zl/ path, JS fetch string literals, nested double-wrap loop,
fallback misreported as load failures, raw-path engine routes, the
/bootstrap.js origin-root assumption, wrong MIME on some CSS) are
filed as lobsterbs/Zeolite#1 with a follow-up evidence comment.

Embedder-side action items from this matrix (this repo, not the
engine): consider hardening so root-relative requests that escape
rewriting cannot be answered 200 with the app's own /assets/ files
inside a proxied page, and decide whether to serve a bootstrap route
or push the engine to inline its bootstrap.

Auth tiers stay BLOCKED on the engine cookie-jar fix; no fake passes.

## Isolation record (zl-isolation-probe.html, beta origin, 4614b57)

```json
[
  {"check":"localStorage read/write","verdict":"reachable","detail":"write + read + remove ok"},
  {"check":"localStorage keys visible","verdict":"reachable","detail":"lobsterbrowse-tabs, lobsterbrowse-settings, lobsterbrowse-logs"},
  {"check":"sessionStorage read/write","verdict":"reachable","detail":"ok"},
  {"check":"document.cookie write/read","verdict":"reachable","detail":"ok"},
  {"check":"IndexedDB API","verdict":"reachable","detail":"present (open attempted below)"},
  {"check":"Cache API","verdict":"reachable","detail":"present (keys listed below)"},
  {"check":"serviceWorker API","verdict":"reachable","detail":"present (registrations listed below)"},
  {"check":"fetch /build (app internals)","verdict":"reachable","detail":"fetch allowed (status below)"},
  {"check":"parent frame access","verdict":"reachable","detail":"not framed (top-level): same privileges as a proxied frame on this origin"},
  {"check":"BroadcastChannel to other tabs","verdict":"reachable","detail":"channel opens; other tabs on this origin receive messages"},
  {"check":"Cache API keys (async)","verdict":"reachable","detail":"zeolite-pages-v1"},
  {"check":"SW registrations (async)","verdict":"reachable","detail":"/ -> /zlsw/sw.js"},
  {"check":"IndexedDB open (async)","verdict":"reachable","detail":"opened, name: zl-isolation-probe"},
  {"check":"fetch /build (async)","verdict":"reachable","detail":"HTTP 200 build 4614b57"}
]
```
