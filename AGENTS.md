# AGENTS.md â LobsterBrowse

Guidance for AI agents and human contributors. Read this before changing the browser, proxy engine, UI, deployment configuration, or docs.

## Roadmap

`ROADMAP.md` is the authoritative LobsterBrowse roadmap. Read it before undertaking major roadmap work. Do not create duplicate roadmap documents. LobsterBrowse uses chemical element codenames; Zeolite keeps its separate compound/material naming system.

## Project identity
LobsterBrowse is an open-source proxy browser built around Rust/Axum, React + TypeScript, Material 3 Expressive, Wisp transport, structured DevTools diagnostics, and Zeolite integration.
Make sites work first, then improve browser-like compatibility. Do not add a headless browser or attempt to become a full Chromium/Firefox replacement.

## Repository map
- `server/` â Rust workspace.
- `server/bin/server/src/main.rs` â current Axum proxy implementation.
- `server/crates/adblock/` â network filtering.
- `ui/` â React + TypeScript + Vite.
- `ui/src/App.tsx` â application shell/global state.
- `ui/src/pages/Browser.tsx` â tabs, toolbar and frame integrations.
- `ui/src/settings.ts` â settings/defaults/migrations.
- `ui/src/store.ts` â local browser state.
- `ui/public/lobsterjet.js` â legacy /lj cache/prefetch worker retained here.
- `/zlsw/` â published Zeolite bundle.
- `/zl-ext/` and `/zl-cs/` â Zeolite extension resource routes.

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
Zeolite is NOT the server rewriter: its service worker owns /lj/ routes. App.tsx unregisters the legacy v3 page-cache worker (it owned the "/" scope and silently blocked the Zeolite SW registration), drops its caches, and pushes `zl:config` (prefix "/lj/", scheme "b64u") on every boot because the prefix is runtime state that resets to "/j/" on worker restart. The SW intercepts /lj/ requests: subresources travel natively over wisp (NativeTransit), documents/CSS are rewritten by the wasm rewriter inside the worker. The server route /lj/:target only answers when NO worker controls the page (cold start, worker restart, no module SW support) and returns the honest engine_error_page — the server never rewrites /lj/ traffic. The lb_ engine options (adblock, trackers, https-only, image re-encode, UA override, incognito jar) are ScramJet-only; routeUrl sends no params on /lj/ routes because the SW forwards the query string to the target. Honest gaps: incognito tabs share the Zeolite cookie jar (no lb_inc equivalent wired), LB's server adblock chain does not run for Zeolite mode; instead the engine ships the migrated ad/tracker host lists as its own /rules.json and evaluates them client-side in its worker (request-level 403 before cache and transport, captcha hosts allowlisted; Zeolite 1.1 Oxide). App.tsx pushes `zl:adblock` {enabled} from the same settings.adblock that drives lb_ab/lb_trk on /r/ routes. Per-site adblock overrides apply to the server chain only (documented gap). The rules engine reaches LB users once ZEOLITE_COMMIT is bumped to a dist built from 1.1 Oxide (still pinned to 5c3ce0c6; the pinned worker answers zl:adblock with an honest unknown-message, harmless). The Settings Decentraleyes toggle remains dead UI (it posted to the legacy worker) until reimplemented as a Zeolite site-rule/plugin.

## Engine route prefix
`settings.ts` `engineRoutePrefix(engine)` is the single place that decides `/lj/` vs `/r/`. Do not reintroduce engine ternaries in components.
