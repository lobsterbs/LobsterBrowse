# LobsterBrowse

Fully open-source, 100% free Rust Wisp server + hardened Scramjet fork, with a
Material 3 Expressive UI, built-in uBlock Origin / Decentraleyes-style filtering,
browser spoofing, WebRTC and UDP proxying with per-user toggles, and resumable sessions.

## Architecture

- server/ - Rust workspace (clean-room Wisp v2.1 implementation, MIT OR Apache-2.0)
  - wisp-core - protocol framing: CONNECT / DATA / CONTINUE / CLOSE / INFO + v2 handshake
  - wisp-extensions - password auth, Ed25519 key auth, MOTD, UDP, stream confirmation
  - guard - SSRF hardening, rate limiting, flood detection, destination policy
  - adblock - uAssets/EasyList network-filter engine (hostname matching at CONNECT time)
  - localcdn - Decentraleyes-style local CDN bundle serving
  - sessions - client-side-encrypted session vault (Neon Postgres backing, opt-in)
  - settings - user settings API + filter-list configuration
  - rtc - TURN-style WebRTC relay with per-session HMAC credentials
  - bin/server - tokio + axum HTTP/WSS entrypoint
- frontend/ - Scramjet fork (keeps upstream GPL license)
- ui/ - Material 3 Expressive shell (community M3E web components, dynamic color)

## Status

Phase 1 in progress: wisp-core protocol implementation + guard hardening layer.

## License

Rust server: MIT OR Apache-2.0 (clean-room from the Wisp v2.1 spec, CC BY 4.0).
Scramjet fork: upstream GPL-family license retained.
See LICENSE files per directory.
