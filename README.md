# LobsterBrowse
```text
    __          __         __            __            ____                             
   / /   ____  / /_  _____/ /____  _____/ __ )_________ _      __________ 
  / /   / __ \/ __ \/ ___/ __/ _ \/ ___/ __  / ___/ __ \ | /| / / ___/ _ \
 / /___/ /_/ / /_/ (__  ) /_/  __/ /  / /_/ / /  / /_/ / |/ |/ (__  )  __/
/_____/\____/_.___/____/\__/\___/_/  /_____/_/   \____/|__/|__/____/\___/ 
```
**Open-source browser-style proxy · Rust + React + Material 3 Expressive**
LobsterBrowse is a browser-style proxy application built around Rust/Axum, React + TypeScript, Material 3 Expressive, Wisp transport, structured diagnostics and Zeolite integration.

## Status

This branch, `beta/zeolite-nativetransit`, is the experimental **Zeolite NativeTransit-first** line. Zeolite is the only engine on this branch; `/zl/` is the primary engine route, while `/r/` and `/lj/` are legacy redirects kept for compatibility.

This branch is experimental and should not be treated as the stable LobsterBrowse release.
## What it includes

- Browser-style UI with tabs, settings, incognito sessions, DevTools and extension controls
- Rust/Axum application server
- Zeolite service-worker engine integration
- NativeTransit-first transport/interception architecture
- Wisp transport
- Search suggestions and link prefetching
- Structured, privacy-safe diagnostics

## Roadmap

The authoritative project roadmap is [ROADMAP.md](./ROADMAP.md). It uses chemical element codenames for LobsterBrowse releases, distinct from Zeolite's compound/material naming system.

## Architecture
    LobsterBrowse UI
          |
        Zeolite
       engine SW
          |
        Wisp
          |
       upstream
## Server
- server/bin/server — Tokio + Axum HTTP/WSS entrypoint.
- server/crates/adblock — network filtering (workspace member).
- /zl/<base64url target> — Zeolite engine route (worker-owned; the server answers only with the honest no-worker notice).
- /r/, /lj/ — legacy prefixes, 302 to /zl/.
- /wisp/ — Wisp endpoint.
- /logs — bounded diagnostics.
- /healthz — liveness.
- /zlsw/ — published Zeolite bundle.
- /zl-ext/ and /zl-cs/ — extension routes.
- /suggest — search suggestion proxy.
## UI
React + TypeScript + Vite with Material 3 Expressive components. Includes tabs, settings, incognito sessions, DevTools, site information, extension controls, search suggestions and link prefetch.
## Zeolite integration
Zeolite is maintained separately so other host applications can reuse it. LobsterBrowse consumes its published bundle under /zlsw/ without making Zeolite depend on LobsterBrowse UI code. On the beta branch, Zeolite is the only engine: browsing routes over /zl/ (worker-owned, NativeTransit-first); see docs/BETA-ZEOLITE-NATIVETRANSIT.md.
## NativeTransit direction
NativeTransit is the next transport/interception architecture:
    LobsterBrowse -> Zeolite -> Transport
                              |-> NativeTransit
                              |-> RewriteFallback -> Wisp -> Network
> Do not rewrite website content unless the engine needs to.
This is a design direction, not a claim that NativeTransit has already replaced rewriting.
When implemented, DevTools should show transport path, NativeTransit vs RewriteFallback, fallback reason, and whether a failure is upstream, transport, browser/runtime, policy or rewriting related.
## Current rewriting behavior
The Zeolite service worker owns every proxied navigation and subresource: in-worker rewriting handles URL-bearing HTML attributes and CSS, runtime fetch/XHR and element properties, history and window.open, with transport over Wisp. Redirects are followed and relative URLs resolved against the final URL.
Known limitations include client-side cookie differences, challenge-protected sites (Anubis), limited service-worker behavior, WebSocket-heavy application gaps and complex SPA compatibility gaps.
## Proxy options
Settings reach the engine through the zl:rules control-plane push (adblock, per-site adblock and User-Agent overrides), not through route query parameters; the route path carries only the base64url target.
## DevTools
DevTools is a real diagnostic surface. Events should identify trace/request ID, redacted URL, subsystem, severity, lifecycle stage and concrete cause where known. A normal WebSocket close is not an error. NativeTransit diagnostics should expose native-vs-fallback behavior.
## UI rules
No hamburger menu. The compact nav rail owns its sizing/overflow. Tabs shrink rather than horizontally scrolling. Toolbar URL editing remains inside the center pill. Bookmarks and the old nav-rail badge are intentionally removed. Settings are localStorage-backed and migration-safe.
## Privacy
LobsterBrowse is a proxy, so the engine transport necessarily carries the traffic it proxies. Do not describe it as server-blind. Browser UI state is stored locally. Diagnostics/logs must redact credentials, cookies, authorization data and other secrets.
## Building

### Server

```bash
cd server
cargo test
cargo build --release
```

### UI

```bash
cd ui
npm install
npm run build
```

For development:

```bash
cd ui
npm run dev
```
## Deployment

The application is deployed on Render. This beta branch should be verified against the actually served Zeolite revision after deployment; do not assume every branch push automatically updates the running instance. After deployment changes verify /healthz, UI, /zl/ (and the /r/, /lj/ redirects), /zlsw/, Wisp and extension routes when relevant.
## Contributing
Inspect the implementation, trace the request/state flow, identify the correct repository boundary, make the smallest coherent change, run tests/builds, inspect the diff and update docs. If a fix belongs in Zeolite, fix it there instead of adding a LobsterBrowse-only workaround.
## Architecture goal
LobsterBrowse = host application + browser UI
Zeolite = reusable interception/transport engine
Wisp = transport foundation
RewriteFallback = compatibility escape hatch