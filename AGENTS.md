# AGENTS.md — LobsterBrowse

Guidance for AI agents and human contributors. Read this before changing the browser, proxy engine, UI, deployment configuration, or docs.

## Roadmap

`ROADMAP.md` is the authoritative LobsterBrowse roadmap. Read it before undertaking major roadmap work. Do not create duplicate roadmap documents. LobsterBrowse uses chemical element codenames; Zeolite keeps its separate compound/material naming system.

## Project identity
LobsterBrowse is an open-source proxy browser built around Rust/Axum, React + TypeScript, Material 3 Expressive, Wisp transport, structured DevTools diagnostics, and Zeolite integration.
Make sites work first, then improve browser-like compatibility. Do not add a headless browser or attempt to become a full Chromium/Firefox replacement.

## Repository map
- `server/` — Rust workspace.
- `server/bin/server/src/main.rs` — current Axum proxy implementation.
- `server/crates/adblock/` — network filtering.
- `ui/` — React + TypeScript + Vite.
- `ui/src/App.tsx` — application shell/global state.
- `ui/src/pages/Browser.tsx` — tabs, toolbar and frame integrations.
- `ui/src/settings.ts` — settings/defaults/migrations.
- `ui/src/store.ts` — local browser state.
- `ui/public/lobsterjet.js` — legacy /lj cache/prefetch worker retained here.
- `/zlsw/` — published Zeolite bundle.
- `/zl-ext/` and `/zl-cs/` — Zeolite extension resource routes.

## Current proxy paths
`/r/<base64url target>` and `/lj/<base64url target>` use the existing server-side rewriting path. It rewrites URL-bearing HTML/CSS/srcset surfaces and injects runtime handling for APIs such as fetch/XHR, URL-bearing element properties, history and window.open.
Redirects are followed and relative URLs are resolved against the final document URL. Non-rewritable content should stream.
Do not remove this path while NativeTransit is being developed.

## URL fragments
Fragments are client-side only (SVG sprite symbol selection, in-page anchors). They must never become part of the encoded request target, a cache key, an upstream request identity or a fallback decision. The rewriter strips the fragment before encoding and re-attaches it after the route (`/lj/<b64>?lb_...#symbol`); the engine defensively strips fragments from decoded targets too. One sprite file stays one network identity however many `#symbol` references the page makes. Element-level resource failures have no observable HTTP status: diagnostics report `unknown`, never a fabricated `0`.

## Zeolite
Zeolite is a separate reusable engine repository. LobsterBrowse consumes its published browser bundle and must not make Zeolite depend on the UI.
Always check Zeolite's actual compatibility implementation before claiming browser or extension API support.

## NativeTransit direction
NativeTransit is the long-term transport/interception architecture:

    LobsterBrowse -> Zeolite -> Transport
                              |-> NativeTransit
                              |-> RewriteFallback -> Wisp -> Network

NativeTransit should become the preferred path when the browser/runtime architecture permits it. Existing rewriting remains the compatibility escape hatch until real tests prove it can become optional.

Rules:
- Do not delete the rewriter.
- Do not duplicate Wisp/network/cookie infrastructure.
- Do not claim NativeTransit is implemented without code/tests.
- Do not add Gecko-specific implementation to NativeTransit.
- Do not turn NativeTransit into a second browser engine.
- Record native/fallback decisions and reasons.
- Preserve original URLs/content whenever possible.
- Put reusable engine fixes in Zeolite instead of LobsterBrowse-only hacks.

## Security and privacy
LobsterBrowse is a proxy, so the server necessarily sees traffic it proxies. Never describe it as server-blind.
Preserve SSRF and DNS-rebinding protection, URL/redirect validation, header safety, origin/cookie isolation, extension permissions and diagnostic redaction.
Never store authorization headers, bearer tokens, passwords, API keys or raw cookies in diagnostics.

## DevTools
DevTools is a real diagnostic surface. Events should identify trace/request ID, subsystem, severity, redacted URL, lifecycle event and concrete cause where known.
Distinguish navigation, upstream HTTP, transport, rewrite, resource, WebSocket, extension/runtime and browser/runtime failures. A normal WebSocket close is not an error.
Every engine_proxy fetch carries a bounded `RES-XXXXXX` correlation id in the `/logs` ring (start, redirect, stream, done and failure lines). Browser-side resfail reports carry the resource URL; correlate by URL + timestamp. The server does not cache resources (the service-worker layer may), so `cache_hit` is not reported server-side — never invent one.
When NativeTransit is active, the network view should show NativeTransit vs RewriteFallback and the fallback reason.

## UI rules
- No hamburger menu. No toolbar Home button (removed by request, 2026-09-27).
- Do not override M3E nav-rail width/overflow.
- Tabs shrink at existing thresholds instead of becoming horizontally scrollable.
- Preserve existing tab close/switch animations.
- Toolbar URL editing remains inside the center pill.
- Preserve explicit URL/caret/placeholder color fallbacks.
- Bookmarks and the old nav-rail badge are intentionally removed.
- Settings are localStorage-backed and migration-safe.
- Check `ui/src/m3e.d.ts` before adding M3E elements and follow existing custom-element ref/class patterns.
- The tab switcher card is ALWAYS mounted; the `.open` class animates and gates interaction. Unmounting it destroys the preview iframes, which is why previews used to show blank tiles.
- M3E snackbars are repositioned to the top of the screen via document-level CSS (`m3e-snackbar`); the bottom slot belongs to the dock toolbar.
- The site info (lock) card content rows carry their own padding inside the m3e-card surface; the card itself is `overflow: hidden`.

## Search suggestions
`/suggest` owns the fallback chain server-side: the engine's native provider is tried first, then Brave, then Bing (several providers block or rate-limit the deployment's datacenter egress, DuckDuckGo among them). The client makes exactly one request per keystroke; do not reintroduce client-side double-fetch fallbacks. Startpage and Mojeek have no open suggest API and honestly fall back to the chain.

## Mozilla add-ons store
On `addons.mozilla.org` the proxy ALWAYS spoofs Firefox: the request header is forced in `engine_proxy` (user UA presets are ignored there, the store gates .xpi downloads on a Firefox client) and `navigator.userAgent` is patched client-side via `amo_spoof_script()`. Finished `.xpi` downloads raise an install prompt in the UI (Install into the engine via `zl:installExt`, Save file, Cancel).

## Diagnostic mode
Settings > Advanced has a Diagnostic mode toggle (`settings.diagnostics`): when on, every page console message and resfail is pushed to the app log with the tab id, and expected proxy interventions (CSP/SRI stripping) appear as DevTools failure entries. When off, CSP/SRI stripping is only a console warning, because stripping is expected behavior on every rewritten page, not a site failure.

## Legacy /lj worker
`ui/public/lobsterjet.js` is the browser cache/prefetch layer retained in LobsterBrowse. It is not the standalone Zeolite engine. Do not confuse the two.

## Deployment
The application is deployed on Render. The Docker build must successfully build both the Rust server and strict TypeScript/Vite UI.
After deployment changes verify `/healthz`, UI, `/r/`, `/lj/`, `/zlsw/`, Wisp endpoints, and extension routes when relevant. Do not claim a deployment is healthy without checking it.

### Stale engine bundle hazard (real incident, 2026-09-27)
The `zl-builder` Docker stage fetches the Zeolite `dist` tarball in a `RUN`
layer whose instruction text never changes, so Render's layer cache reuses it
forever: ordinary deploys silently shipped a months-old engine bundle while
`dist` had moved on. After a Zeolite `dist` publish, deploy with
`clearCache: true` (render trigger_deploy) or the bundle will not update.
`/build` reports `zlswSha` (sha256 prefix of the served `zlsw/sw.js`) and the
Zeolite version parsed out of that same file: compare against the dist branch
before believing a deploy picked the new engine up. `/build` reads the bundle
the server actually serves; it never invents a version ("unknown" when the
bundle is missing).

## Development workflow
Inspect the implementation and trace state/request flow first. Make the smallest coherent change, run applicable Rust/UI tests, inspect the diff, and update docs when behavior changes.
Test real website classes for engine changes: normal HTML, SPAs, fetch/XHR, WebSockets, modules, CSS/images, iframes, workers, redirects, authentication, MIME-sensitive resources and large responses.

## Documentation honesty
Use **Implemented**, **Partial**, **Experimental**, or **Planned**. Do not describe NativeTransit, full browser compatibility, client-side upstream fetching or extension coverage beyond what the code actually provides.

## Architecture goal
LobsterBrowse = host application + browser UI.
Zeolite = reusable interception/transport engine.
Wisp = transport foundation.
RewriteFallback = compatibility escape hatch.
## Engine shim layout (2026-09-27 refactor)
The injected page JavaScript no longer lives inside main.rs as a raw string. It is embedded at compile time:
- `server/bin/server/src/engine-shim.js` — `ENGINE_JS`, the routing + diagnostics shim. Patch categories are labeled inside it (ENGINE CORE / REWRITE COMPATIBILITY / DIAGNOSTICS / LEGACY COMPAT); read them before deleting a patch. Diagnostics events are buffered and flushed as one `{lb:"batch"}` postMessage every 120ms (or 32 events); the UI message handler accepts both batch and single-event shapes.
- `server/bin/server/src/engine-compat.js` — `COMPAT_JS`, the honest compat layer for guest pages (service workers, notifications, install prompts). Every stub fails immediately and predictably, produces a one-time console diagnostic explaining WHY the real API cannot exist on the proxy origin, and never claims success or hangs (`ready` resolves, `register` rejects). See docs/COMPATIBILITY-AUDIT.md for the full inventory and threat model.
Never edit a patch away because it looks like a monkey patch; prove the behavior is no longer required first.

## Diagnostic secret sanitization (2026-09-27)
Two central sanitizers own redaction; call sites must not hand-roll it:
- `ui/src/sanitize.ts` (`sanitizeUrl`/`sanitizeText`) — applied in Browser.tsx to every console text, net URL/error, resfail URL/note and url-sync log line before it enters DevTools state or the persisted app log.
- `main.rs` `redact_secrets()` — called inside `push_log`, so the whole `/logs` ring is sanitized at write time. Patterns (secret query params, JWTs, Bearer/basic/labeled credentials) mirror the TS module; keep them in sync. Unit tests: `redact_tests` in main.rs. Deliberately conservative — no email or generic-string redaction.
The shim's diagnostics postMessage uses `targetOrigin: location.origin` (never `"*"`); the UI handler additionally validates origin, matches `e.source` to a known tab frame, and caps/bounds everything (docs/COMPATIBILITY-AUDIT.md §4).

## Downloads (2026-09-27)
`startDownload` in Browser.tsx uses an AbortController per download: the downloads card's close button on an ACTIVE item cancels the transfer (honest "Cancelled" state), and a 1 GiB in-memory ceiling aborts oversized files instead of exhausting device memory. Blob assembly remains the sink (File System Access API needs a top-level user gesture the proxied frame cannot provide); the cap is the honest ceiling of that design.

## Session restoration (2026-09-27)
`saveSessionTabs`/`loadSessionTabs` (ui/src/store.ts) persist the FULL per-tab history stack and index; the old flatten-to-current-URL behavior destroyed back/forward history on reload. Old saves are normalized on load.

## Incognito log hygiene (2026-09-27)
`store.setIncognitoLogging(on)` (wired from App.tsx incognito state) keeps the technical log ring in memory only during incognito sessions; page diagnostics no longer persist to the `lobsterbrowse-logs` localStorage key while incognito is on.

## Module import rewriting
`rewrite_js_imports` rewrites import/export/dynamic-import specifiers in inline `type=module` bodies and served `.js` files, for `"`, `'` and backtick quoting. Backtick templates containing `${` interpolation or escapes are left alone (runtime-computed, unresolvable server-side). This stays server-side: module loading happens below window.fetch, the shim cannot intercept it. Import maps with relative keys are a known gap.

## Anubis challenges (Startpage incident)
Responses whose HTML contains `id="anubis_challenge"` are served with `Cache-Control: no-store`: the Zeolite service worker serves /lj/ cache-first and a cached challenge page reloads itself forever. The worker honors no-store with TTL 0. Keep this for any interstitial/challenge page.

## Anubis pass-challenge bridge
Challenge JS that solves the proof does location.replace() on a ROOT-RELATIVE /.within.website/... URL. Served same-origin that escapes the engine route (the SPA fallback used to answer it with the app shell), so the proof never reached the protected host, no cookie was set, and the challenge reloaded forever. The server now routes /.within.website/*path to anubis_bridge: it decodes the engine route from Anubis's own redir param (or the Referer), fetches the pass-challenge upstream against that route's page (shared cookie jar keeps the Anubis cookie) and 303s the frame back to its engine route.

The redir forwarded upstream is NOT the one the browser sent. The challenge script sets redir to the frame's full engine-route URL on this origin, which upstream Anubis rejects with 400 redirect_domain_not_allowed. Dropping redir is equally fatal: 400 invalid_redirect. anubis_bridge rewrites redir to the decoded upstream page URL (the one redirect target the protected host always accepts) and forwards every other query param verbatim. If pass-challenge ever 400s again, check what redir upstream received first.

## engine-compat.js integrity
The compat shim is an IIFE: the file must end with a closing `)();`. The 2026-09-27 extraction dropped that line and every proxied page died with a console SyntaxError "Unexpected end of input" attributed to the page URL. If the shim files are ever regenerated, syntax-check them (node --check or equivalent) in CI-reachable form before deploy.

## Challenge-widget compatibility layer (captcha compat, not bypass)
Goal: a human's challenge solve must WORK through the proxy; the engine never solves anything itself. Three rules:

1. Same-site PoW challenges (Anubis): the challenge JS runs in the frame, the proof is submitted upstream by the anubis_bridge (see above) against the shared cookie jar. Fully supported.
2. Third-party widget frames (Turnstile, hCaptcha, reCAPTCHA, Stripe challenges) must stay GENUINELY cross-origin. Their scripts validate the frame's own origin and the embedding page validates postMessage event.origin against the provider domain. Routing the frame through the engine makes it same-origin with the proxy and the widget errors or spins forever. So: rewrite_tag leaves `<iframe>/<frame src` untouched when the resolved host is in CHALLENGE_HOSTS (is_frame_to_challenge_host), and engine-shim.js does the same at runtime (prop("HTMLIFrameElement","src", keepCrossOrigin) and the setAttribute src/IFRAME case, regex CHALLENGE_HOST_RE kept in sync with CHALLENGE_HOSTS in main.rs). The browser then loads the widget directly from the provider; the human solves it; only the form submit travels through the proxy. The shim logs "[lb] challenge widget frame left cross-origin: <url>" to the console diagnostics channel — that is the detection signal for the UI.
3. Honest limits: providers may additionally bind the sitekey to the site's real hostname (Turnstile 110200, hCaptcha, reCAPTCHA ERROR_FOR_DOMAIN). That check sees the proxy origin and no compatibility layer can honestly pass it; the widget then shows the provider's own domain error, which is the honest outcome. Never spoof the widget's origin to defeat it.
Also: upstream CSP/X-Frame-Options headers never reach the browser (engine_proxy forwards only content-type + cache headers), so they cannot break widget scripts; the meta-tag CSP strip (strip_csp_meta) plus this is the whole story. Loader scripts (challenges.cloudflare.com/turnstile/v0/api.js etc.) still route through the engine like any other script — only frames are exempt.

## Reproducible builds
- `server/Cargo.lock` is committed. CI runs `cargo build/test/clippy --locked` and `cargo fmt --all --check`; the ui job runs `npm ci`. Never add `|| cargo build` style fallbacks or swap `npm ci` for `npm install`.
- `zeolite-server` is pinned by `rev` in `server/bin/server/Cargo.toml` (not a branch). The Dockerfile pins `ARG ZEOLITE_COMMIT` (immutable Zeolite dist revision) instead of `refs/heads/dist`. To update either: bump the rev/ARG, run the `generate-rust-lockfile` workflow (or push under `server/`), commit the refreshed `server/Cargo.lock`, and deploy with `clearCache: true`.
- `.github/workflows/rustfmt-fix.yml` (manual/one-shot) runs `cargo fmt` and commits; do not use it to bypass the fmt gate habitually.

## JS string-literal asset rewriting
Vite-built SPAs (chatgpt.com) bake full root-relative asset paths ("/cdn/assets/x.js") into ordinary string literals in their route manifest and import() them through a variable, so the import-spec pass cannot see them. rewrite_js_literals scans string literals in inline module script bodies and served .js files (after rewrite_js_imports, before js_antiframe) and routes any literal that points at a static asset (absolute, protocol-relative, or root-relative; extension-gated) through the engine. Non-asset literals are left alone on purpose: pathname/origin comparisons and API endpoints must never be rewritten server-side, and the engine shim handles runtime fetches. Root-relative literals must also carry at least two path segments ("/cdn/assets/x.js"): single-segment pieces like gatsby's "/page-data.json" are concatenation fragments, and rewriting them turns page-data fetches into requests against the host root. Ported from Zeolite rewriter js::literals.

## Engine upstream body reads
engine_proxy buffers upstream bodies; a mid-stream decode failure (truncated CDN gzip/brotli) must never surface as a silent empty 200. The Err arm of the body read logs `engine body read failed`, then retries the cloned request once (`engine body retry ok`) before falling back to engine_error_page. Partial JS bodies are what produce "No result found for routeId" class app crashes.

## Browser feature panels
`ui/src/browser/` holds the presentational panels split out of `pages/Browser.tsx`: `TabSwitcherCard`, `DownloadsCard`, `XpiPrompt`, `ExtensionsPanel`, plus `browserShared.ts` (tabLabel, dlIconFor, fmtBytes, DL_FILE_RE). All state stays in the browser page lifecycle; the panels take explicit props and do not own state or effects. Keep new panels there, not inside Browser.tsx.

## Zeolite engine mode (client-side)
Zeolite is NOT the server rewriter: its service worker owns /lj/ routes. App.tsx unregisters the legacy v3 page-cache worker (it owned the "/" scope and silently blocked the Zeolite SW registration), drops its caches, and pushes `zl:config` (prefix "/lj/", scheme "b64u") on every boot because the prefix is runtime state that resets to "/j/" on worker restart. The SW intercepts /lj/ requests: subresources travel natively over wisp (NativeTransit), documents/CSS are rewritten by the wasm rewriter inside the worker. The server route /lj/:target only answers when NO worker controls the page (cold start, worker restart, no module SW support) and returns the honest engine_error_page — the server never rewrites /lj/ traffic. The lb_ engine options (adblock, trackers, https-only, image re-encode, UA override, incognito jar) are ScramJet-only; routeUrl sends no params on /lj/ routes because the SW forwards the query string to the target. Honest gaps: incognito tabs share the Zeolite cookie jar (no lb_inc equivalent wired), LB's server adblock chain does not run for Zeolite mode; instead the engine ships the migrated ad/tracker host lists as its own /rules.json and evaluates them client-side in its worker (request-level 403 before cache and transport, captcha hosts allowlisted; Zeolite 1.1 Oxide). App.tsx pushes `zl:adblock` {enabled} from the same settings.adblock that drives lb_ab/lb_trk on /r/ routes. Per-site adblock overrides apply to the server chain only (documented gap). The rules engine has reached LB users since the pin moved past 1.1 Oxide (current pin: Zeolite rev 1d818fc0, 3.0 Diamond — see DEPLOY.md; the pin note there is kept accurate). The legacy Settings Decentraleyes toggle was removed (2026-10-01): it only ever posted to the legacy worker that App.tsx unregisters on boot. Reimplement it as a Zeolite site-rule/plugin if it returns.

## Engine route prefix
`settings.ts` `engineRoutePrefix(engine)` is the single place that decides `/lj/` vs `/r/`. Do not reintroduce engine ternaries in components.

## Server log session isolation (2026-09-27 pass 2)
/logs is session-scoped: the UI mints a per-tab token (store.ts Tab.sess, crypto.randomUUID, never persisted, regenerated on restore) and threads it on /r/ routes as lb_sess= (settings.ts proxyParams/routeUrl; the engine carries it onto every rewritten subresource via params_suffix). Server side: AppState.sessions holds one bounded SessionRing (500 lines) per token; push_log_sess writes tagged lines ONLY there; /logs requires a valid lb_sess and answers 403 without one. Map cap 128 with LRU eviction, idle expiry 1800s. Suggest/cert/Anubis diagnostics are tagged too. Tests: session_log_tests in main.rs. Tokens are UI state: guest pages cannot read or forge another session's token.

## WebSocket policy (2026-09-27 pass 2)
engine-shim.js blocks foreign-origin ws(s):// WebSockets: the native constructor would connect straight to the target host, bypassing the proxy and leaking the user's real IP. Blocked sockets throw a SecurityError immediately and emit a WEBSOCKET_UNSUPPORTED resfail diagnostic; same-origin sockets (proxy origin, e.g. the Zeolite wisp server) pass through. There is no proxied WebSocket transport; do not fake one.

## Challenge-host single source (2026-09-27 pass 2)
main.rs injects window.__LB_CHALLENGE_HOSTS (serialized from CHALLENGE_HOSTS) into the page head before ENGINE_JS; engine-shim.js builds CHALLENGE_HOST_RE from it (hardcoded fallback retained). Never hand-edit one list without the other; change CHALLENGE_HOSTS in main.rs only.

## Download streaming (2026-09-27 pass 2)
startDownload streams to disk via the File System Access API when available (showSaveFilePicker + createWritable, O(1) memory; writable.abort() discards the partial file on cancel/error; a dismissed save dialog is an honest "cancelled"). Browsers/contexts without the API fall back to capped in-memory Blob assembly (1 GiB ceiling, the honest limit of that path). Incognito downloads carry lb_inc. "cancelled" is a DlItem status, not a fake error.

## Challenge-host regex construction (2026-09-27 pass 3)
The CHALLENGE_HOST_RE build line in engine-shim.js escaped hostnames with replace(/[.*+?^${}()|[\]\\]/g, "\\$&"). A pass-2 splice once replaced that "\\$&" with the deleted fallback literal text: the line still parsed, but the regex matched nothing and runtime-created captcha frames (reCAPTCHA etc. create their iframes via JS) were routed through the engine and broke silently. The challenge_regex_construction test in main.rs asserts the exact construction line; keep test and line in sync. engine-shim.js is include_str!'d and never executed as JS by CI — only this byte-level test and live browser verification cover it.

## Runtime URL property routing (2026-09-27 pass 3)
engine-shim.js routes runtime property assignments through the same prop() wrapper as the element setters: HTMLAnchorElement.href, HTMLFormElement.action (and the formaction attribute via setAttribute). A runtime-assigned real URL navigated the tab straight off the proxy origin before. Anything that assigns a URL at runtime must go through route(); if a new element class appears (e.g. srcset, which needs list-aware routing), add it there rather than ad-hoc.

## Base-tag mutation policy (2026-09-27 pass 3)
Runtime <base href> mutation (property setter or setAttribute) is dropped with a one-time diagnostic. The server resolves every URL against the real page URL, so a surviving base would re-anchor unrouted URLs; the element stays inert. Do not "support" base by routing its href — a routed base re-anchors differently and is worse.

## Guest worker policy (2026-09-27 pass 3)
Worker/SharedWorker with a foreign-origin script URL throw a SecurityError plus a WORKER_UNSUPPORTED resfail, mirroring the WebSocket policy: the script fetch itself would bypass the proxy (real-IP request), and in-worker subresources are unshimmed by design. Same-origin (rewritten), blob: and data: workers run unchanged. In-worker subresource routing is Zeolite-owned (ROADMAP.md "Phase: Zeolite Integration — Deferred"); do not fake it from the shim.

## Find in page (#9)
The toolbar find button scopes window.find() to the active same-origin frame (non-standard but supported in Chromium; engine frames are same-origin by design). The match label is a case-insensitive textContent scan of the frame body: approximate by design (no shadow-DOM crawl); window.find owns the real highlighting and scrolling. No Range-walking highlighter until window.find disappears.

## Per-site rules chip (#10)
The toolbar tune chip (inline SVG glyph, same pattern as the incognito mask) edits the same site-rule store as Settings (settings.ts loadSiteRules/saveSiteRules). A rule is created lazily and deleted when it carries no overrides. Ad-block semantics follow proxyParams: global on unless the site rule disables it; a site rule cannot enable ad-block while the global setting is off (the switch is disabled then, with an honest note). Unchanged honest gap: per-site rules apply to /r/ ScramJet routes; the Zeolite engine honors the global ad-block toggle only. Wiring per-site rules into the engine lives on the unstable integration branch.

## Content-Disposition passthrough (#11)
engine_proxy's non-rewritten stream path forwards content-disposition alongside the caching/range headers; the UI download manager reads it for the saved filename (the download attribute and the URL basename remain the fallbacks).

## Density (#21)
Settings carries settings.density ("normal" | "compact"), applied as the m3e-theme density attribute; migration-safe in loadSettings. The downloads toolbar button carries an m3e-badge with the item count, and every contextual toolbar icon button has an m3e-tooltip.
## Navigation poll routing (reload-loop incident, 2026-10-03)
Browser.tsx polls the active frame every 1200ms and hands the frame protocol/path plus the tab URL to pollAction() (ui/src/browser/pollRecovery.ts). "wait" for about: documents: a navigation still in flight leaves the frame on about:blank, whose location.pathname is literally "blank"; the recovery used to fabricate <site>/blank from it, abort the real in-flight navigation and reload the tab in a loop (m.ome.tv after the org-block bypass). Past four blank ticks the poll surfaces an honest stuck-bootstrap error instead. "sync" for engine-owned paths (/r/, /lj/, /zl/ and the service worker's /__zl_nav__/ marker). "recover" for genuine escapes to bare app paths; recovery also records lastNav so the URL sync never auto-loads the recovered URL twice. tests/poll-recovery/check.mjs runs the decision table in CI with node --experimental-strip-types; keep the check, the module and the poll in sync.
