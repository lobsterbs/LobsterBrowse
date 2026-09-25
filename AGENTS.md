# AGENTS.md — LobsterBrowse

Guidance for AI agents (and humans) working on this repository. Read this before changing anything.

## What this is

LobsterBrowse is a web proxy browser. A Rust axum server fetches and rewrites upstream pages (URL-bearing attributes, CSS url(), srcset, inline styles) so every navigation and subresource flows through same-origin routes, then re-injects a JS shim that routes runtime fetch/XHR and element assignments. A React + TypeScript + M3E (Material 3 Expressive) web component UI manages tabs, bookmarks, DevTools capture, and settings.

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
- `lb_hdrs=<base64url of "Name: value" lines>` — custom outbound headers

The server also sends `Sec-GPC: 1` and `DNT: 1` on every upstream request, decodes the engine route in the `Referer` back to the real page URL, follows redirects and rewrites against the final URL, de-AMPs AMP pages to their canonical URL, and skips shim injection on challenge/CAPTCHA hosts (integrity-sensitive widgets break otherwise). Non-rewritable content types stream through without buffering.

### LobsterJet (service worker)

`ui/public/lobsterjet.js`. Intercepts GET requests to same-origin `/lj/` paths only:

- cache-first, 10-minute freshness (stored Responses carry an `lb-cached-at` header),
- stale entries are revalidated from the network,
- network failure falls back to the stale copy, then a 504.

App registers it in `ui/src/App.tsx`. `routeUrl()` in `ui/src/settings.ts` builds `/lj/` routes when `settings.proxyEngine === "lobsterjet"` (the default); the shim inside proxied pages derives its own route prefix from `location.pathname`. Without the worker installed, everything still works — the server answers `/lj/` identically.

Known gaps (good next tasks): no cache size cap / LRU eviction, no link prefetching, no stale-while-revalidate mode.

### Search suggestions

`GET /suggest?engine=<id>&q=<query>` — server-side proxy for open suggestion (osjson) APIs to dodge CORS:

- google -> `suggestqueries.google.com/complete/search?client=firefox&q=`
- bing -> `api.bing.com/osjson.aspx?q=`
- everything else (duckduckgo, brave, startpage, mojeek) -> `ac.duckduckgo.com/ac/?type=list&q=`

Brave, Startpage and Mojeek have no open suggestion API; they fall back to DuckDuckGo. Do not claim otherwise.

The UI consumes this via `fetchSuggestions()` in `ui/src/settings.ts`, debounced 160ms, in both the Home search field and the toolbar URL field.

### UI notes that have bitten us before

- `m3e-icon` uses ligatures against a self-hosted Material Symbols font. Some glyphs (e.g. `lock`, `incognito`) are missing and render as raw text or nothing. The toolbar lock uses inline SVG via Vite `?raw` imports from `@material-symbols/svg-400` (`outlined/lock.svg`, `outlined/no_encryption.svg`); the incognito indicator is a text pill for the same reason. `vite-env.d.ts` references `vite/client` so `?raw` typechecks.
- The `m3e-icon-button` custom element has no `title` prop (build failure if you add one).
- `tsc` is strict: custom-element props in JSX must exist in `m3e.d.ts`.
- Hooks must not appear after early returns in components (conditional hook = crash).
- The tab strip is `overflow-x: hidden` on purpose: tabs shrink (compact tier at >=6 tabs, tight/favicon-only at >=10) instead of scrolling. Do not reintroduce `overflow-x: auto`.
- The bottom dock and tab strip share the `dockTucked` idle-tuck state; transforms must be applied to plain wrapper divs (`.lb-dock-pill`), not the m3e-toolbar host — Lit host display makes transforms silently do nothing.
- URL field text color is explicitly pinned (color, -webkit-text-fill-color, caret-color, placeholder) because of past reports of invisible text. Keep the hardcoded fallbacks.

## Deployment

Render service `srv-daq17cmk1f9s73djhta0` (workspace `tea-da6k16hsrm7s73aeg0s0`). The Dockerfile builds the server (`cargo build --release -p lobster-server`) then the UI (`npm ci && npm run build` in `ui/`), so a Rust or TS type error fails the deploy. Builds take roughly 2–10 minutes.

Push to `main`, trigger a deploy, poll until `live` (or `build_failed`), and if it failed, pull the build logs (type `build`) and fix the actual compiler errors before redeploying.

## Conventions

- Server code: single `main.rs`. Rewriting functions thread `page_url`, `suffix` (engine option query string), and `prefix` (`"/r/"` or `"/lj/"`) through the call chain: `rewrite_html_doc` -> `rewrite_html` -> `rewrite_tag` -> `rewrite_url_attr` / `rewrite_srcset` / `rewrite_css`. If you add a rewriting pass, keep the prefix threading intact or LobsterJet pages will leak onto `/r/` and bypass the service worker cache.
- `b64url_encode` / `b64url_decode` are the base64url helpers for targets (UTF-8 safe).
- UI state is localStorage-only (`store.ts`); settings in `settings.ts` with `DEFAULT_SETTINGS` + migration-safe `loadSettings`.
- Incognito mode: no history recording, no session persistence. The incognito pill is intentionally a labeled text pill — keep it that way.
- Privacy stance: the UI stores nothing server-side; the server proxy inherently sees proxied traffic. Be honest about that in user-facing text (the settings panel and tooltips already are).
