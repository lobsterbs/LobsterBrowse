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
2. Settings panel: third engine segment "Zeolite Preview (/zl/)" plus an
   honest beta description. The Preview build ships the NativeTransit experiment as the DEFAULT engine (zeolite-beta) with diagnostics on; it is no longer opt-in.
3. App boot: zl:config prefix now follows the selected engine and is
   re-pushed when the engine changes.
4. Server: /zl/:target gets the same honest zl_sw_required answer as /lj/
   for pages no worker controls (cold start, worker restart, browsers
   without module service workers). No second server rewriter exists for
   /zl/; that is the point.
5. The no-worker notice for /zl/ and /lj/ navigations is now a real
   503 (62dbe7d2) with the wording "Open or reload the app once so the
   worker installs, then retry." Contract: the engine owns
   failed-navigation error pages; the embedder owns only this
   no-control notice.

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
  cookie-jar failure, a Tier 4 media sample and a Tier 5 openstreetmap.org
  sample were run 2026-09-28 (below); worker behavior, WS and a Tier 6 site sample are
  now recorded (Tier 6 workers/WS probe and the 2.3 Selenide
  re-verification pass below); real credential flows remain
  blocked by the cookie-jar failure (still reproducing on the
  served 2.3 dist, upstream issue #10). No local
  toolchain exists; CI plus the Render build are the compile gates.
- /zl/ shares the Zeolite worker's single runtime prefix: switching
  engines re-pushes zl:config; already-open tabs keep their route prefix.
- Incognito isolation on the beta path inherits the engine's cookie-jar
  model (per virtual origin, not per browsing session) - same honest gap
  as /lj/ today.
- Cold start: navigating straight to a /zl/ URL before the app has
  ever loaded answers with the 503 notice by design. The
  user-reported "every site fails with the notice" state on
  2026-09-28 did not reproduce in fresh browser profiles at
  fd756c2; suspected causes were the free-tier instance asleep or
  mid-deploy and stale service-worker state in long-lived profiles
  after engine bundle changes. Remediations shipped: Zeolite dist
  re-pinned to 2.3 Selenide (c5373afb, same as main) and the app
  retries the zl:config push three times when the worker does not
  answer during cold start (App.tsx). If the notice still appears,
  reload the app once so the worker reinstalls.

## Tier 0 status (updated as phases land)

- Automated (CI "transit" job): deterministic fixture
  (tests/transit/fixture.mjs) + HTTP-level assertions
  (tests/transit/check.mjs) for HTML/CSS/JS/JSON/redirect/POST/stream/
  large/range/cookies/SSE, plus - when LB_ORIGIN is set - /zl/
  honest-notice and /r/ end-to-end regression checks. This proves
  fixture and route behavior, NOT the SW->NativeTransit->Wisp chain:
  no browser runs in CI.
- CI transit history (2026-09-28): the workflow was broken from
  f2a83f6c (a `- uses: setup-node@v4` line lost its actions/ org;
  every run died before starting any job; fixed in 43761d91). The
  transit job then failed with node's silent exit code 13: check.mjs
  awaited the fixture's server.close(), which never settles while
  keep-alive or upgraded sockets linger, so node killed the module
  mid-await with zero output. Fixed in c02f251b: close is best-effort
  and the check exits explicitly with a real code. CI is green on
  c02f251b (rust, ui, transit); the LB_ORIGIN leg also asserts the
  503 notice and /r/ end to end.
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
  (3) CORRECTED 2026-09-28 (see the Tier 4-5 follow-up section):
  an earlier revision of this entry claimed escaped /assets/*
  requests were answered 200 with the app's own bundle files;
  that was a misread of the setup-phase request log (the 200s
  were the UI's own asset loads before the proxied navigation).
  Escaped root-relative subresources 404 on the proxy origin,
  verified on the openstreetmap.org run below. The actual
  excalidraw blocker is the silent module failure recorded in
  the Tier 4-5 follow-up section.
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

Embedder-side notes after the follow-up pass: no bootstrap.js
file exists anywhere in the engine repo (code search: zero
matches), so the origin-root injection cannot be satisfied by
the embedder and the fix must be engine-side inlining;
escaped root-relative subresources currently 404 cleanly and a
wrong-content 200 was never observed after the correction
above, so the SPA-fallback hardening item is downgraded to a
possible future hardening, not a demonstrated defect.

Auth tiers stay BLOCKED on the engine cookie-jar fix; no fake passes.

## Tier 4-5 follow-up (real browser, RUN 2026-09-28, pass 3, beta at 4614b57)

- PASS - Tier 4 media/range: 1.1MB MP4 (mdn.github.io shared
  asset) via /zl/: single request 206, content-range bytes
  0-1128374/1128375, accept-ranges bytes, the video decodes
  (readyState 4, duration 5.055s, fully buffered in ~6s). The
  old gtv-videos-bucket sample now 403s for everyone
  (deprecated bucket), not a proxy failure.
- FAIL - Tier 5 https://www.openstreetmap.org/: the document
  renders (title, nav, leaflet container 1280x665, jQuery
  runs, their application.js executes through a correctly
  encoded /zl/ route) but the map never initializes: 0 tile
  elements, 0 tile requests. Causes: (1) link rel=preload
  hrefs for /assets/*.css|js are left completely unrewritten
  and 404/abort at the proxy origin while script[src] on the
  same page is correctly encoded; (2) two requests hit a BARE
  /zl/ (prefix with no b64 segment at all) and got honest
  502s; (3) the usual /bootstrap.js origin-root 404. All
  engine-side, filed upstream.
- Controlled module-script experiment (fixture, after waking
  it): a JSON URL loaded as type=module through /zl/ gets
  200 + application/json and the browser's loud
  spec-correct MIME rejection; a JS URL as a classic script
  executes. The module pipeline itself works.
- excalidraw repro narrowed (Tier 2): the entry module gets
  200 + correct MIME, the full 2.2MB body is readable via
  in-page fetch, and executing the body as a classic script
  throws the import-statement SyntaxError (intact ESM), but
  as a module it NEVER evaluates: zero import-resolution
  requests, zero runtime fetches, zero console/page errors,
  #root stays empty; a later dynamic import() of the same URL
  fails with "Failed to fetch dynamically imported module"
  and makes no new network request (module-map cached
  failure). Suspects: CORS-mode script-destination handling
  (the transport preserves the target's ACAO header) or
  content-encoding br passthrough in script streaming.
  Filed upstream with the exact repro.
- Fixture ops: the fixture spun down mid-session (free tier,
  no wake on request, Render 502) and needed a manual
  redeploy; while it was down the engine 502ed honestly on
  every fixture subresource instead of hanging.

Auth tiers stay BLOCKED on the engine cookie-jar fix; no fake
passes.

## Tier 6 workers/WS probe (real browser, RUN 2026-09-28, beta at c02f251b)

Fresh-context harness as before; target = the public fixture's
workers.html (classic + module worker probes, relative + absolute
WebSocket probes).

- PASS - Document navigation: workers.html renders through /zl/
  (title "workers", all probe divs present).
- PASS with engine defect - Classic AND module workers spawn, run,
  and fetch through the engine transport - but a root-relative
  fetch("/data.json") inside the worker resolves against the page
  route instead of the virtual origin root, so the target's 404
  body comes back. Page-level fetch of the same URL through an
  encoded /zl/ route returns the correct JSON, so routes and
  transport are fine. Filed as Zeolite#4.
- FAIL - WebSocket from the proxied page: both the proxy-origin
  relative form and the absolute wss:// form close 1006 with no
  open/message events. Control: the same absolute wss endpoint
  from a normal page on another origin connects, echoes and closes
  cleanly, so the endpoint and cross-origin WS are fine; the
  failure is the engine's WS bridge inside proxied pages. Filed
  as Zeolite#4.
- Verified at c02f251b/a79d3401: /build reports Zeolite 2.3
  Selenide; the SW installs, activates and controls; /zl/
  example.com renders; a dead-target /zl/ navigation shows the
  ENGINE's error page (meta zl-error category tls, version 2.3
  Selenide, Retry button) - no server card for transport
  failures anymore; a direct /zl/ navigation with no SW answers
  503, and the notice card got its own honest heading "No engine
  worker yet" instead of the generic fetch-failure card (6bf1d036,
  deployed and verified at a79d3401).

## Firefox / WebKit status (honest, 2026-09-28)

- Firefox: no module service workers. The engine bundle registers as
  type: module; registration throws on Firefox, the worker never
  installs, and every /zl/ navigation answers with the server's 503
  no-worker notice. That is the honest ceiling: the Preview engine is
  Chromium-only until Gecko ships module SWs. /r/ and /lj/ are
  unaffected on Firefox.
- WebKit: untested end to end. Recent Safari supports module service
  workers, but no recorded run of the /zl/ chain exists on WebKit, so
  no claim is made either way.


## Re-verification pass at 2.3 Selenide (beta deploy a79d3401, 2026-09-28)

Fresh-context Chromium runs against the live beta (engine 2.3
Selenide, zlswSha 145916ddcd49c39f, buildShort a79d340), public
Tier-0 fixture (manually re-deployed first, dep-datc8nm7bikc73d0j5tg).

Verified FIXED at 2.3 (matching the closed upstream findings):
- 3xx Location mapping: /zl/ navigation to the fixture /redirect
  (302 Location: /) lands on the virtual root (title "fixture",
  h1 "fixture page"), not the app root.
- Escaped page-context fetches: fetch('/data.json') from inside the
  proxied page returns 200 application/json with the exact body.
- Downloads: engine-route navigation to a Content-Disposition:
  attachment URL (codeload zip of this repo) triggers the browser
  download with the correct suggested filename. PASS.
- The 503 no-worker notice card is live and honest; observed
  answering fresh-profile /zl/ navigations, including one run
  where the worker was already activated but not yet controlling
  (claim timing; retry succeeds - matches the cold-start section).

STILL BROKEN at 2.3 (engine-side; upstream issues filed):
- Cookie jar on /zl/ fetches: cache-busted /set-cookie1 + /cookie
  from a proxied page still round-trips EMPTY (Set-Cookie captured
  and stripped from the surfaced headers, never replayed). Filed
  upstream as Zeolite#10. Auth tiers stay BLOCKED; no fake passes.
- Tier 2 excalidraw.com: app still never mounts (entry module never
  evaluates; raw-path routes /zl/mermaid-to-excalidraw-*.js; the
  origin-root bootstrap.js 404). Same three causes as before.
- Tier 3 github.com/login: still PARTIAL - form renders with the
  action correctly encoded, but 78 raw-path engine routes emitted,
  40 chunk requests fail.
- Tier 5 openstreetmap.org: still FAIL - document renders,
  0 tiles; two bare /zl/ (no b64 segment) requests still emitted;
  bootstrap.js 404.
- Tier 1 wikipedia: content renders (13.2k chars) but the skin
  CSS is still lost - both load.php stylesheets now fail through
  their /zl/ routes outright.
- craigslist.org: NEW - document navigation dies 'connection
  interrupted mid-response' (502 engine error) consistently, while
  /r/ (ScramJet, same egress) loads the same URL fully (200, 363
  links). Engine streaming defect, filed as Zeolite#11.
- In-page anchors: NEW - fragment-only hrefs are rewritten to the
  bare prefix (/zl/#frag, no destination); navigating one answers
  404 'zeolite: bad route'. Every same-page anchor link on
  rewritten pages is dead. Filed as Zeolite#12.

Tier 6 site sample (heavy rewriting, same harness):
- PASS - www.tagesschau.de: 200, correct title, 261 links, 12.4KB
  of body text, only the global bootstrap.js 404. First fully
  passing real Tier 6 site.
- FAIL - www.craigslist.org: engine streaming (Zeolite#11 above).
- NOT REPRODUCIBLE - old.reddit.com (403 network-security block
  page; the block page itself proxied and link-rewritten
  correctly) and stackoverflow.com (Cloudflare 'Just a moment'
  403). Bot gates, not engine verdicts.

Perf/memory vs /lj/ (single sample, free tier, tagesschau.de):
/zl/ domContentLoaded 11.8s vs /lj/ 15.5s; JS heap after settle
21MB on BOTH; resource entries 25 vs 18. No regression observed
on this sample. Caveat: single run, free-tier variance is high;
both paths share the same worker on this build.

Isolation probe re-run at a79d3401: baseline UNCHANGED - every
check still reachable by design (same-origin architecture). New
concrete evidence of the known gap: localStorage on this origin
now contains keys written by target-site JS from proxied pages
(spark_*, ard_mediathek_*), confirming the shared-store model
recorded in the isolation record below.

Ops: fixture was spun down (502) and needed a manual redeploy
before this pass; beta autoDeploy still never fires on push.

Range-cache replay (finding B from the 2.2-era issue-#1 comment),
re-tested at 2.3: CONFIRMED STILL BROKEN. From a proxied page
context, fetching /zl/<b64 of /large> with no Range header returns
200 with the full 2097152-byte body and caches it; fetching the
SAME route again with Range: bytes=0-1023 returns 200 with the
full 2MiB body again, no content-range header (the stored entry
is replayed without revalidation). Control: a cache-busted URL for
the same resource returns the correct 206, content-range bytes
0-1023/2097152. The response cache serves stored full-body entries
to range requests. Filed as Zeolite#13.

zl:config push flakiness on fresh installs (EMBEDDER bug, ours):
four-plus consecutive fresh contexts at ~20:20-20:35 UTC had a
healthy SW (zl:ping ok) but a default route prefix - all /zl/
navigations hit the 503 notice with an empty netLog. The app's
3-attempt zl:config push raced the SW claim window and nothing
retried. A manual MessageChannel re-push of zl:config fixes it
instantly. Filed as LB#15 (retry with backoff, self-heal on
default-prefix detection, warn on no-reply).

FIXED at f087eec9 (deploy dep-datd44ou01pc73e5rj20, /build
buildShort f087eec, CI green): two defects in the App.tsx boot
push. (1) The controllerchange listener was attached inside the
async boot IIFE AFTER awaited getRegistrations/caches cleanup, so
a claim firing during those awaits was missed and nothing ever
retried; it is now attached synchronously before any awaited
cleanup. (2) The push loop accepted ANY truthy reply as success
('if (r)'); it now requires the engine's explicit ack shape
(r && r.ok; zl:config replies { ok: true }). The retry window is
now backoff 0/1/3/7/15/30s instead of 3 back-to-back attempts,
covering slow cold installs. Fresh-context verification pending
(shared browser contention); LB#15 stays open until it passes.
Residual, engine-side: a mid-session worker restart resets the
prefix without controllerchange and zl:ping exposes no route shape,
so drift is undetectable from the page; filed upstream as
Zeolite#17 (persist the prefix or echo it in zl:ping).

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
