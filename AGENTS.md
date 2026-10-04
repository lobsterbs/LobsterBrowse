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
- `/zlsw/` — published Zeolite bundle.
- `/zl-ext/` and `/zl-cs/` — Zeolite extension resource routes.

## Current proxy paths
`/zl/<base64url target>` is the only engine route: the Zeolite service worker owns it (client-side interception, native wisp transport, in-worker rewriting). The server never rewrites or proxies page traffic. The legacy `/r/` and `/lj/` prefixes 302 to `/zl/` (same target, query preserved) so stale bookmarks and history entries keep working; a `/zl/` request that reaches the server means no worker controls the page and gets the honest engine_error_page.

## URL fragments
Fragments are client-side only (SVG sprite symbol selection, in-page anchors). They must never become part of the encoded request target, a cache key, an upstream request identity or a fallback decision. One sprite file stays one network identity however many `#symbol` references the page makes. Element-level resource failures have no observable HTTP status: diagnostics report `unknown`, never a fabricated `0`.

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
Proxied traffic never touches this server: the `/logs` ring holds server-level diagnostics (suggest/cert/session lines) only, and the browser-side resfail reports carry the resource URL; correlate by URL + timestamp. Never invent a `cache_hit` line server-side.
When NativeTransit is active, the network view should show NativeTransit vs RewriteFallback and the fallback reason.
DevTools has three sections: Console, Network, Diagnostics. The separate Terminal page is gone. The Console is the single command surface: page eval plus the engine control-plane commands that used to live only in Terminal (zl:help lists them: zl:ping, zl:status, zl:transit, zl:netlog, zl:ext, zl:downloads; every engine reply passes the diagnostics sanitizers, and async replies append through the functional setDt patch).
The Diagnostics toolbar carries a Report button that opens the project issue tracker at https://github.com/lobsterbs/LobsterBrowse/issues/new.

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
AMO web pages are unreachable from this deployment's egress; the Settings extensions panel searches the public AMO API v5 over the engine route instead (AmoSearch.tsx), and .xpi downloads try the user's own connection first, then the engine route, before install via `zl:installExt`. Honest gap: the old server-side Firefox-UA spoof for addons.mozilla.org is gone with ScramJet; nothing forces a Firefox UA anywhere, and finished installs still raise the UI prompt (Install into the engine, Save file, Cancel).

## Diagnostic mode
Settings > Advanced has a Diagnostic mode toggle (`settings.diagnostics`): when on, every page console message and resfail is pushed to the app log with the tab id, and expected proxy interventions (CSP/SRI stripping) appear as DevTools failure entries. When off, CSP/SRI stripping is only a console warning, because stripping is expected behavior on every rewritten page, not a site failure.

## Deployment
The application is deployed on Render. The Docker build must successfully build both the Rust server and strict TypeScript/Vite UI.
After deployment changes verify `/healthz`, UI, `/zl/` (and the /r/, /lj/ redirects), `/zlsw/`, Wisp endpoints, and extension routes when relevant. Do not claim a deployment is healthy without checking it.

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

## Anubis and challenge pages (honest gap, ScramJet removal 2026-10-01)
ScramJet's anubis_bridge and the /.within.website/ server route are gone. The Zeolite engine is challenge-DETECT only (no solve verb), so PoW-protected hosts — Anubis; Startpage, the DEFAULT search engine, fronts every page with one — show the honest engine error instead of solving. Filed against Zeolite as a challenge-cookie handoff surface. Third-party widget frames must stay genuinely cross-origin; the engine's navguard owns that decision (Zeolite #28). Never fake a solved challenge, and never claim challenge support the code does not have.

## Reproducible builds
- `server/Cargo.lock` is committed. CI runs `cargo build/test/clippy --locked` and `cargo fmt --all --check`; the ui job runs `npm ci`. Never add `|| cargo build` style fallbacks or swap `npm ci` for `npm install`.
- `zeolite-server` is pinned by `rev` in `server/bin/server/Cargo.toml` (not a branch). The Dockerfile pins `ARG ZEOLITE_COMMIT` (immutable Zeolite dist revision) instead of `refs/heads/dist`. To update either: bump the rev/ARG, run the `generate-rust-lockfile` workflow (or push under `server/`), commit the refreshed `server/Cargo.lock`, and deploy with `clearCache: true`.
- `.github/workflows/rustfmt-fix.yml` (manual/one-shot) runs `cargo fmt` and commits; do not use it to bypass the fmt gate habitually.

## Browser feature panels
`ui/src/browser/` holds the presentational panels split out of `pages/Browser.tsx`: `TabSwitcherCard`, `DownloadsCard`, `XpiPrompt`, `ExtensionsPanel`, plus `browserShared.ts` (tabLabel, dlIconFor, fmtBytes, DL_FILE_RE). All state stays in the browser page lifecycle; the panels take explicit props and do not own state or effects. Keep new panels there, not inside Browser.tsx.

## Zeolite engine mode (client-side, the only engine)
Zeolite is the ONLY engine: its service worker owns /zl/ (client-side interception, native wisp transport, in-worker rewriting by the wasm rewriter). App.tsx unregisters the legacy v3 page-cache worker if found (it owned the "/" scope and silently blocked the Zeolite SW registration), drops its caches, and pushes `zl:config` (prefix from `engineRoutePrefix()`, scheme "b64u", navHandles true — LB#53/Zeolite#63: the plaintext ?url= embed shape is refused engine-side and initial navigations ride opaque zl:navHandle routes minted by the worker; Browser.tsx initialRoute() falls back to the legacy b64u routeUrl when the worker cannot mint) on every boot, because the prefix is runtime state that resets to "/j/" on worker restart. A /zl/ request that reaches the server means no worker controls the page (cold start, worker restart, no module SW support) and gets the honest engine_error_page — the server never rewrites /zl/ traffic. The /rewriter_wasm_bg.wasm origin-root alias serves the engine rewriter wasm root-absolute, exactly like /bootstrap.js. Both surfaces are gated by the transit CI job: /zl/<b64> must answer 502 with the honest card, the wasm alias 200 application/wasm with the \0asm magic, and the legacy /r/ and /lj/ prefixes must 302 to /zl/ with the target and query preserved. routeUrl sends no option params on engine routes because the SW forwards the query string to the target; settings reach the engine through control-plane pushes instead. `zl:adblock` {enabled} mirrors settings.adblock. `zl:rules` carries the per-site rules (host + adblock + UA) plus a global default UA, built from the same loadSiteRules() store Settings and the lock card read; the adblock override can only disable per site, the global toggle still wins, and an active engine fingerprint profile still wins over any UA override. `zl:jarProfile` gives incognito a throwaway jar (the incognito sid while incognito is on, null otherwise; re-pushed on boot, on the toggle and on controllerchange; the engine keeps session-profile cookies in memory only and drops them when the profile switches back). `zl:sameSite` {policy} ("off"/"approx") and `zl:fingerprint` (one-field profile with the resolved global UA while on — the engine derives platform, languages and the canvas seed, timezone and hardware stay native — null while off) are both re-pushed on the toggle and on controllerchange. Known limits: a SW restart mid-incognito briefly admits cookies into the default jar until the re-push lands, and the engine page cache is shared across profiles (cookies never are). Engine-mode WebSockets bridge end to end over wisp (zl:wsOpen); the bridge assigns each page origin its own virtual WS identity, so a page cannot fingerprint the bridge across origins. The engine ships the migrated ad/tracker host lists as its own /rules.json and evaluates them client-side in its worker (request-level 403 before cache and transport, captcha hosts allowlisted). Settings #46: Browser.tsx listens for the engine's `zl:downloadOp` broadcast (extensions calling downloads.download() hand the save to the UI) and routes it into the same startDownload machinery as the a[download] capture; state reports back to the engine wait on a zl:downloadState receiver in Zeolite. Engine extension surfaces (#47/#50): Browser.tsx renders zl:notifyOp broadcasts as note cards (clicked / buttonClicked / closed report back over zl:notifyEvent, auto-dismiss reports closed) and lists the context-menu registry (zl:listMenus) on right-click inside proxied frames, reporting clicks over zl:menuClick with the frame URL. Current pin: Zeolite main e581d07, dist bundle 09297e27 — see DEPLOY.md; the pin note there is kept accurate.


## Poll guards (2026-10-04)
The 1200ms same-origin poll's blank-frame guard (about:blank frames, Zeolite #31) errors only when no navigation is pending for the tab or a pending one outlives the engine's 20s transport timeout (blankPolls + statusRef in Browser.tsx): the engine legitimately holds a frame on about:blank for the whole upstream fetch, and the old fixed 4-tick threshold errored every slow load mid-flight. Upstream redirect chains longer than 10 hops (or loops) surface a 3xx with a mapped Location that the browser follows as a visible reload; the engine records a TRANSPORT diag event (cause proxy) on every surfaced redirect, so DevTools explains reload cycles instead of guessing.

## Engine route prefix
`settings.ts` `engineRoutePrefix()` is the single place that decides the engine route prefix (`/zl/`). Do not reintroduce engine ternaries or per-engine branches in components.
## Server log session isolation (2026-09-27 pass 2)
/logs is session-scoped: the UI mints a per-tab token (store.ts Tab.sess, crypto.randomUUID, never persisted, regenerated on restore) and sends it as lb_sess= on its /logs requests. Server side: AppState.sessions holds one bounded SessionRing (500 lines) per token; push_log_sess writes tagged lines ONLY there; /logs requires a valid lb_sess and answers 403 without one. Map cap 128 with LRU eviction, idle expiry 1800s. Suggest/cert diagnostics are tagged too. Tests: session_log_tests in main.rs. Tokens are UI state: guest pages cannot read or forge another session's token.

## WebSocket policy (2026-09-27 pass 2)
Engine pages bridge WebSockets end to end over wisp (zl:wsOpen, per-origin virtual WS identities). There is no other proxied WebSocket transport; do not fake one.

## Download streaming (2026-09-27 pass 2)
startDownload streams to disk via the File System Access API when available (showSaveFilePicker + createWritable, O(1) memory; writable.abort() discards the partial file on cancel/error; a dismissed save dialog is an honest "cancelled"). Browsers/contexts without the API fall back to capped in-memory Blob assembly (1 GiB ceiling, the honest limit of that path). "cancelled" is a DlItem status, not a fake error.

## Guest worker policy (2026-09-27 pass 3)
Worker/SharedWorker handling is engine-owned: in-worker subresource routing belongs to Zeolite (ROADMAP.md "Phase: Zeolite Integration — Deferred"); do not fake it from LB. A guest worker whose script fetch would bypass the proxy must fail honestly, never leak the real IP silently.

## Find in page (#9)
The toolbar find button scopes window.find() to the active same-origin frame (non-standard but supported in Chromium; engine frames are same-origin by design). The match label is a case-insensitive textContent scan of the frame body: approximate by design (no shadow-DOM crawl); window.find owns the real highlighting and scrolling. No Range-walking highlighter until window.find disappears.

## Per-site rules (#10, merged into the lock card by #26)
The lock site-info card (opened from the identity pill) is the single entry point for connection facts, cookies and per-site settings; the former toolbar tune chip and its standalone rules card are gone. The per-site switch and User-Agent select inside the card edit the same site-rule store as Settings (settings.ts loadSiteRules/saveSiteRules). A rule is created lazily and deleted when it carries no overrides. Ad-block semantics: global on unless the site rule disables it; a site rule cannot enable ad-block while the global setting is off (the switch is disabled then, with an honest note). Per-site rules reach the engine through the zl:rules push from App.tsx (docs/zeolite-integration-plan.md, item 1 — implemented) and apply from the next navigation.

## Density (#21)
Settings carries settings.density ("normal" | "compact"), migration-safe in loadSettings. App.tsx maps it onto m3e-theme's numeric density attribute ("compact" -> "-1", "normal" -> attribute omitted, M3E scale 0). The raw app string must never reach m3e-theme directly: the attribute is a Lit Number property, so "normal" converts to NaN and the theme emits --md-sys-density-scale: NaN, which poisons every DensityToken.calc() in the density-aware components (the #27 "line over the components" breakage). The downloads toolbar button carries an m3e-badge with the item count, and every contextual toolbar icon button has an m3e-tooltip.
