# LobsterBrowse Server (Rust)

Clean-room Wisp v2.1 implementation + hardening. MIT OR Apache-2.0.

## Crates

- wisp-core - wire framing (CONNECT/DATA/CONTINUE/CLOSE/INFO), little-endian,
  stream-id multiplexing, v2 INFO handshake with extension negotiation,
  password/key-auth/MOTD/stream-confirm/UDP extension metadata encoding.
  Dependency-light: bytes + thiserror only, no async runtime required.
- guard - destination policy (loopback/private/link-local/metadata blocked,
  close reason 0x48) and per-IP/per-connection rate limiting with
  CONNECT/CLOSE flood detection, modeled on the July 2026 Lucide Proxy attack.

## Spec attribution

Implemented from the Wisp v2.1 specification (CC BY 4.0) by ading2210 /
Mercury Workshop: https://github.com/MercuryWorkshop/wisp-protocol

## Building

    cd server
    cargo test
    cargo build --release

## Roadmap

- [x] wisp-core framing + handshake + extensions
- [x] guard destination policy + rate limiting
- [ ] wisp-extensions: full password/Ed25519 auth flows
- [ ] bin/server: tokio + axum WSS entrypoint, stream manager honoring CONTINUE windows
- [ ] adblock: uAssets network-filter matcher at CONNECT time
- [ ] localcdn, sessions, settings, rtc
