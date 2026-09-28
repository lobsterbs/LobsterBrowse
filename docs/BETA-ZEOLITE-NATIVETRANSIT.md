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

- This branch has not yet been exercised in a real browser; no local
  toolchain exists, CI + Render build are the only gates run so far.
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
- Browser-level Tier 0 (SW claims /zl/, transport over Wisp): NOT yet
  run. Requires a live beta origin; blocked until the beta branch has
  a deployment. Do not mark done until executed and recorded here.
- Origin isolation: ui/public/zl-isolation-probe.html measures the real
  reachability surface on any origin that serves the UI (it has the
  same privileges as JS in a same-origin proxied frame). Run it on the
  beta origin and record the JSON in the isolation record below.
