# LobsterBrowse

Fully open-source, 100% free Rust Wisp server with a Material 3 Expressive
in-app browser: proxied tabs, real DevTools, server-side ad/tracker
blocking, per-site rules, panic button, auto cloak and resumable sessions.

## Architecture

- server/ - Rust workspace (clean-room Wisp v2.1 implementation, MIT OR Apache-2.0)
  - wisp-core - protocol framing: CONNECT / DATA / CONTINUE / CLOSE / INFO + v2 handshake
  - wisp-extensions - password auth, Ed25519 key auth, MOTD, UDP, stream confirmation
  - guard - SSRF hardening, rate limiting, flood detection, destination policy
  - adblock - uAssets/EasyList network-filter engine (hostname matching at CONNECT time)
  - bin/server - tokio + axum HTTP/WSS entrypoint. Also serves:
    - /r/<base64url target> - the native rewriting engine (see below)
    - /logs - server-side engine log ring buffer
    - /healthz - liveness probe
    - the built UI (ui/) from the same origin
- ui/ - Material 3 Expressive shell (community M3E web components, dynamic color)

## The native engine (/r)

Every navigation goes to /r/<base64url of the target URL> plus engine
options (ab, trk, https, ua) as query parameters. The server fetches the
target with a shared cookie jar and rewrites the response so the page
keeps working same-origin inside the app's sandboxed iframe:

- HTML: URL-bearing attributes (href/src/action/poster/srcset/style) and
  inline CSS url()/@import references are rewritten to other /r routes.
  Blocked ad/tracker tags are stripped, CSP/XFO meta tags removed, base
  tags and SRI integrity attributes dropped.
- CSS: url() and @import references are rewritten against the final
  (post-redirect) document URL.
- A runtime shim is injected after <head>: fetch/XHR, element src/href
  setters, setAttribute, history.pushState/replaceState and window.open
  are routed through the engine, and console/network activity is
  reported to the in-app DevTools via postMessage.
- Everything else (images, fonts, scripts, downloads) streams through
  untouched. Redirects are followed server-side and relative URLs are
  resolved against the final URL.

Known limits of same-origin rewriting, stated honestly:

- JS document.cookie writes land on our origin, not the target's, so
  sites that lean on client-side cookies misbehave.
- WebSockets are not proxied through /r; sites that need them partially fail.
- Service workers are not supported.
- No rewriter catches everything; heavy SPA sites can still break.

The Wisp endpoint (/wisp/, configurable via WISP_PATH) is a TCP/UDP
tunnel for a future native Wisp client and is independent of /r.

## Fonts and privacy

Typography (Roboto Flex variable) and Material Symbols are self-hosted via
npm at build time. The app makes zero requests to Google CDNs. All
settings, history, bookmarks and sessions live in localStorage on the
user's device.

## Building

    cd server
    cargo test && cargo build --release

    cd ui
    npm install && npm run build
