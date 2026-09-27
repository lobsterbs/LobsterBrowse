# AGENTS.md â LobsterBrowse

Guidance for AI agents and human contributors. Read this before changing the browser, proxy engine, UI, deployment configuration, or docs.

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
- `server/bin/server/src/engine-compat.js` — `COMPAT_JS`, the sandboxed-frame stubs (service workers, install prompts, notifications).
Never edit a patch away because it looks like a monkey patch; prove the behavior is no longer required first.

## Module import rewriting
`rewrite_js_imports` rewrites import/export/dynamic-import specifiers in inline `type=module` bodies and served `.js` files, for `"`, `'` and backtick quoting. Backtick templates containing `${` interpolation or escapes are left alone (runtime-computed, unresolvable server-side). This stays server-side: module loading happens below window.fetch, the shim cannot intercept it. Import maps with relative keys are a known gap.

## Anubis challenges (Startpage incident)
Responses whose HTML contains `id="anubis_challenge"` are served with `Cache-Control: no-store`: the Zeolite service worker serves /lj/ cache-first and a cached challenge page reloads itself forever. The worker honors no-store with TTL 0. Keep this for any interstitial/challenge page.

## Reproducible builds
- `server/Cargo.lock` is committed. CI runs `cargo build/test/clippy --locked` and `cargo fmt --all --check`; the ui job runs `npm ci`. Never add `|| cargo build` style fallbacks or swap `npm ci` for `npm install`.
- `zeolite-server` is pinned by `rev` in `server/bin/server/Cargo.toml` (not a branch). The Dockerfile pins `ARG ZEOLITE_COMMIT` (immutable Zeolite dist revision) instead of `refs/heads/dist`. To update either: bump the rev/ARG, run the `generate-rust-lockfile` workflow (or push under `server/`), commit the refreshed `server/Cargo.lock`, and deploy with `clearCache: true`.
- `.github/workflows/rustfmt-fix.yml` (manual/one-shot) runs `cargo fmt` and commits; do not use it to bypass the fmt gate habitually.

## Browser feature panels
`ui/src/browser/` holds the presentational panels split out of `pages/Browser.tsx`: `TabSwitcherCard`, `DownloadsCard`, `XpiPrompt`, `ExtensionsPanel`, plus `browserShared.ts` (tabLabel, dlIconFor, fmtBytes, DL_FILE_RE). All state stays in the browser page lifecycle; the panels take explicit props and do not own state or effects. Keep new panels there, not inside Browser.tsx.

## Engine route prefix
`settings.ts` `engineRoutePrefix(engine)` is the single place that decides `/lj/` vs `/r/`. Do not reintroduce engine ternaries in components.
