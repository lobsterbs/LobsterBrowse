# AGENTS.md — LobsterBrowse

Guidance for AI agents (and humans) working on this repository. Read this before changing anything.

## What this is

LobsterBrowse is a web proxy browser. A Rust axum server fetches and rewrites upstream pages (URL-bearing attributes, CSS url(), srcset, inline styles) so every navigation and subresource flows through same-origin routes, then re-injects a JS shim that routes runtime fetch/XHR and element assignments. A React + TypeScript + M3E (Material 3 Expressive) web component UI manages tabs, DevTools capture, and settings.

- Server: `server/bin/server/src/main.rs` (single large file, ~57KB), Cargo workspace at `server/`.
- UI: `ui/src/` (React 18 + TS + Vite). Build runs `tsc -b && vite build` and typechecks are strict.
- Live deployment: https://lobsterbrowse-server.onrender.com (Render).

## Architecture map

### Proxy routes

- `/r/<base64url-of-target>?<options>&<page-query>` — ScramJet, the server-side rewriter. Any non-`lb_` query keys belong to the target page and are forwarded to it.
- `/lj/<base64url-of-target>?...` — LobsterJet entry. Same handler (`engine_proxy`). Pages entered via `/lj/` get their links and subresources rewritten to `/lj/` so the service worker can cache them; pages entered via `/r/` stay on `/r/`.

Engine option keys (all `lb_`-prefixed; legacy bare keys are still accepted for old saved routes):

- `lb_ab=1` — adblock filter stripping (built-in host list + `adblock-extra.txt`)
- `lb_trk=1` — tracker stripping (+ `tracker-extra.txt`)
- `lb_https=1` — reject plain-http targets
- `lb_img=1` — re-encode JPEGs at lower quality
- `lb_ua=<urlencoded UA>` — user-agent override
- `lb_hdrs=<base64url of "Name: value" lines>` — custom outbound headers (still honored server-side, but the UI option was removed by request and nothing sends it)

The server also sends `Sec-GPC: 1` and `DNT: 1` on every upstream request, decodes the engine route in the `Referer` back to the real page URL, follows redirects and rewrites against the final URL, de-AMPs AMP pages to their canonical URL, and skips shim injection on challenge/CAPTCHA hosts (integrity-sensitive widgets break otherwise). Non-rewritable content types stream through without buffering.

### LobsterJet (service worker)

`ui/public/lobsterjet.js` (page cache `lobsterjet-v3`, library cache `lobsterjet-decentraleyes-v1`). Intercepts GET requests to same-origin `/lj/` paths only:

- fresh hit (< 10 min; stored Responses carry an `lb-cached-at` header): served straight from the cache;
- stale hit: served immediately AND revalidated in the background (stale-while-revalidate);
- miss: fetched from the server, cached when the content type is html/css/js/image;
- network failure: 504 (no stale copy available).

Cache cap: 60 entries; oldest-by-timestamp evicted on every write. Known gap: the cap is entry-count based, not byte based.

Decentraleyes pass: the worker base64url-decodes the `/lj/` target; if it matches a known CDN library regex (jquery from code.jquery.com / ajax.googleapis.com / cdnjs, lodash, moment, d3 from cdnjs) it answers from the dedicated library cache, primed on first use from pinned jsDelivr URLs (7-day freshness). Version mapping is approximate (pinned major line); the goal is removing the third-party CDN request, not byte-identical files. If jsDelivr is unreachable the normal /lj/ flow takes over. Adding a library means adding a regex + asset pair in `LIBS`. The pass can be turned off from Settings: `settings.decentraleyes` (default true) is posted to the worker controller as `{lb:"decentraleyes", enabled}` by App.tsx on change and on `controllerchange`; the worker keeps it in `decentraleyesEnabled` and skips the localLibrary call when off.

Link prefetch: the React app (not the shim — the app has same-origin access to the proxied frame documents) attaches pointerover/focusin listeners to each frame document and fetches hovered links' routes through the worker, warming the cache before the click. Wiring lives in the same-origin poll effect in `ui/src/pages/Browser.tsx`, guarded by a WeakSet of wired documents. It skips `target="_blank"` and download links.

The app registers the worker in `ui/src/App.tsx`. `routeUrl()` in `ui/src/settings.ts` builds `/lj/` routes when `settings.proxyEngine === "lobsterjet"` (the default); the shim inside proxied pages derives its own route prefix from `location.pathname`. Without the worker installed, everything still works — the server answers `/lj/` identically.

### Search suggestions

`GET /suggest?engine=<id>&q=<query>` — server-side proxy for open suggestion (osjson) APIs to dodge CORS:

- google -> `suggestqueries.google.com/complete/search?client=firefox&q=`
- bing -> `api.bing.com/osjson.aspx?q=`
- brave -> `search.brave.com/api/suggest?q=`
- everything else (duckduckgo, startpage, mojeek) -> `ac.duckduckgo.com/ac/?type=list&q=`

Startpage and Mojeek have no open suggestion API; they fall back to DuckDuckGo. Do not claim otherwise.

The UI consumes this via `fetchSuggestions()` in `ui/src/settings.ts`, debounced 160ms, in the Home search field, the toolbar URL pill, and the proxy New Tab search.

### UI notes that have bitten us before

- `m3e-icon` uses ligatures against a self-hosted Material Symbols font. Some glyphs (e.g. `lock`, `incognito`) are missing and render as raw text or nothing. The toolbar lock uses inline SVG via Vite `?raw` imports from `@material-symbols/svg-400` (`outlined/lock.svg`, `outlined/no_encryption.svg`); the incognito indicator is a text pill for the same reason. `vite-env.d.ts` references `vite/client` so `?raw` typechecks.
- The `m3e-icon-button` custom element has no `title` prop (build failure if you add one).
- `tsc` is strict: custom-element props in JSX must exist in `m3e.d.ts`.
- Hooks must not appear after early returns in components (conditional hook = crash).
- The tab strip is `overflow-x: hidden` on purpose: tabs shrink (compact tier at >=6 tabs, tight/favicon-only at >=10) instead of scrolling. Do not reintroduce `overflow-x: auto`. When the strip tucks idle it slides up leaving a sliver; the real tabs keep their shape (no fake single-tab collapse).
- Tab close is animated client-side: the tab gets `.closing` for 240ms before the real `closeTab` prop call lands (`closeTabSmooth` in Browser.tsx). Tab switching fades via the `.lb-page` opacity transition.
- Tab hover preview: a fixed panel under the strip renders a live but scriptless iframe (`sandbox="allow-same-origin"`, no allow-scripts — the page's JS never runs twice and audio can never double) plus a mute toggle. Muting records the tab in `mutedTabs`; the same-origin poll tick re-asserts `muted = true` on every audio/video in that tab's frame because pages keep creating new media elements.
- While the browser view is active the rail collapses to its hamburger (`railHidden` state in App.tsx adds `.lb-rail-hidden`, which hides the nav items but keeps the rail and its hamburger); clicking the hamburger shows the items again. The hamburger is always visible on every page. Rail geometry is trimmed via the `--m3e-nav-rail-*` tokens (4.5rem compact width, 0.5rem inline padding, centered icon button), never via width/overflow overrides.
- The nav rail badge (tab count) was removed by request. Do not re-add it.
- Bookmarks were removed entirely by request (store functions, Home suggestion source, toolbar button, new-tab links, panel). Do not re-add them.
- Do not override m3e-nav-rail width or overflow in CSS. A previous width:60px + overflow:hidden combo collapsed the rail to an invisible sliver on every page; the component owns its own width.
- The toolbar lock is a clickable inline SVG: green closed lock (https), red broken lock (http). Clicking toggles a real M3E card (`m3e-card` variant="elevated", `.lb-site-card`, absolutely positioned above the pill): header with lock + status + close button, content with scheme/host/port and the cookies the page can read in a scrollable box (capped at 12 shown), and actions with clear-site-cookies (expires them on the host and every parent domain) and CSV export buttons. HttpOnly cookies live server-side in the proxy and are honestly documented as invisible in that card. Certificate status was explicitly dropped from scope. New m3e elements must be added to ui/src/m3e.d.ts or tsc fails the build.
- Settings `suggestQueries`, `prefetchLinks`, `autoHideChrome`, `decentraleyes` (all default true, migration-safe in `loadSettings`) gate the suggestion fetches, the link prefetch wiring, the idle tuck of the toolbar/tab strip, and the worker's Decentraleyes pass respectively. `adblock` drives both `lb_ab` and `lb_trk`; JPEG compression (`lb_img=1`) is always on; the proxy-off option and custom outbound headers were removed by request — do not re-add them.
- The server's error page (meta `lb-load-error`) is surfaced client-side as a full-area overlay (URL, message, technical log from the DevTools capture, single Try Again). No server changes are needed for it.
- The bottom dock and tab strip share the `dockTucked` idle-tuck state; transforms must be applied to plain wrapper divs (`.lb-dock-pill`), not the m3e-toolbar host — Lit host display makes transforms silently do nothing.
- The toolbar's center pill (`.lb-tb-pill`) shows lock + favicon + tab name when collapsed and expands in place into the editable URL when pressed (`tbExpanded` state, `.lb-tb-name` button in `ui/src/pages/Browser.tsx`). The pill owns the chrome (background/border/shape); the `.lb-url-input` inside it is bare text. Do not reintroduce the old separate `.lb-tb-page` + `.lb-tb-urlwrap` structure.
- URL field text color is explicitly pinned (color, -webkit-text-fill-color, caret-color, placeholder) because of past reports of invisible text. Keep the hardcoded fallbacks.

## Deployment

Render service `srv-daq17cmk1f9s73djhta0` (workspace `tea-da6k16hsrm7s73aeg0s0`). The Dockerfile builds the server (`cargo build --release -p lobster-server`) then the UI (`npm ci && npm run build` in `ui/`), so a Rust or TS type error fails the deploy. Builds take roughly 2–10 minutes.

Push to `main`, trigger a deploy, poll until `live` (or `build_failed`), and if it failed, pull the build logs (type `build`) and fix the actual compiler errors before redeploying.

## Conventions

- Server code: single `main.rs`. Rewriting functions thread `page_url`, `suffix` (engine option query string), and `prefix` (`"/r/"` or `"/lj/"`) through the call chain: `rewrite_html_doc` -> `rewrite_html` -> `rewrite_tag` -> `rewrite_url_attr` / `rewrite_srcset` / `rewrite_css`. If you add a rewriting pass, keep the prefix threading intact or LobsterJet pages will leak onto `/r/` and bypass the service worker cache.
- `b64url_encode` / `b64url_decode` are the base64url helpers for targets (UTF-8 safe).
- UI state is localStorage-only (`store.ts`); settings in `settings.ts` with `DEFAULT_SETTINGS` + migration-safe `loadSettings`.
- Incognito mode: no history recording, no session persistence. The toggle is an icon button (inline domino-mask SVG — `incognito` glyph missing from the font). Toggling ON suspends the whole normal session (stashed in a ref in App.tsx, never persisted) and opens one fresh empty incognito tab; toggling OFF closes the incognito tabs and restores the suspended session. The session-swap logic lives in `toggleIncognito` in `ui/src/App.tsx`.
- Privacy stance: the UI stores nothing server-side; the server proxy inherently sees proxied traffic. Be honest about that in user-facing text (the settings panel and tooltips already are).

## Roadmap: independence (planned, NOT yet)

The goal is that LobsterJet eventually fetches upstream pages on its own (client-side, e.g. via a WISP-style engine in the service worker or an edge function we control) instead of depending on the ScramJet server-side rewriter for every byte. Both engines stay; nothing gets renamed. UPDATE: the split is done. The new LobsterJet engine (formerly the `lobsterjet/` directory: the Rust/WASM rewriter crates, the Wisp-based engine app, the compat suite, engine docs and its CI) now lives in its own repository at lobsterbs/LobsterJet, where its CI runs; it consumes wisp-core and wisp-extensions from this repo via git dependencies. The legacy service worker `ui/public/lobsterjet.js` (page cache, Decentraleyes, prefetch wiring) stays HERE and the LobsterJet section above still describes it. Until that lands, every LobsterJet route still transits the axum server — do not claim client-side fetching, and keep the Settings description honest about the server seeing proxied traffic.
