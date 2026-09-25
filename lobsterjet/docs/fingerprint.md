# Fingerprint hygiene (Phase 3, honest scope)

## What exists today

Nothing measurable. This document records the real architecture and
where impersonation has to live, so nobody burns time implementing it
in the wrong place.

## Where TLS actually terminates

The service worker cannot terminate TLS: a `fetch()` to the real
destination from the SW is cross-origin and blocked. All proxied HTTPS
therefore goes over wisp TCP streams, and TLS is terminated by the
libcurl wasm transport in the page context (the same BareMux-compatible
path Scramjet uses; see `app/src/libcurl-transport-vendored.ts`, which
ships as a throwing stub until the vendoring step lands).

Consequence: fingerprint impersonation is a property of that libcurl
build, not of the wisp server. The server only relays opaque TCP bytes.
"Server-side TLS impersonation via rquest/wreq" as originally sketched
would only apply in a future server-terminated HTTP proxy mode; that
mode does not exist and adding it is a new phase, not a patch.

## What impersonation would actually mean

- Cipher/ALPN/extension-order configuration of the vendored libcurl
  build (BoringSSL-style ClientHello shaping). This is done at
  build-time of the vendored transport, in the vendoring seam.
- HTTP/2 SETTINGS frame ordering and pseudo-header order in the curl
  build.
- Nothing on the Rust server changes: it stays a dumb TCP relay.

The intended upgrade path is swapping the vendored transport's
internal HTTP client for an rquest-style impersonating client compiled
to wasm. That dependency is not added yet: it is unverified against
wasm32, and the rule is that the compat suite must first show that
sites actually reject the current build's fingerprint. Measure first,
then impersonate.

## Done-when for this phase item

"fingerprint impersonation measurably reduces blocks" is not met and
cannot be met until the vendored transport exists and the suite reports
block rates to compare.
