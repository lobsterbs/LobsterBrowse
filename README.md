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
    - /p - document fetch proxy used by the in-app browser (cookie jar,
      UA override, ad/tracker script stripping, devtools hook injection)
    - /logs - server-side proxy log ring buffer
    - the built UI (ui/dist) from the same origin
- ui/ - Material 3 Expressive shell (community M3E web components, dynamic color)

## The web proxy, honestly

The Wisp server is a TCP/UDP tunnel for a future Wisp client. For in-app
browsing, LobsterBrowse uses a server-side document fetch proxy (/p):
the server fetches the target page (keeping cookies in a server-side jar)
and renders it in a same-origin iframe inside the app. This hides the
visitor's IP from the target site's main document and enables the real
DevTools (console execution, network capture via the injected hook).

It is NOT a rewriting proxy like Scramjet/Ultraviolet. Subresources with
absolute URLs load directly from the target, and SPA/WebSocket/service-worker
heavy sites will not behave as they do in a normal browser. A rewriting
engine would be the required next step for full compatibility.

## Fonts and privacy

Typography (Roboto Flex variable) and Material Symbols are self-hosted via
npm at build time. The app makes zero requests to Google CDNs.

## Building

    cd server
    cargo test && cargo build --release

    cd ui
    npm install && npm run build
