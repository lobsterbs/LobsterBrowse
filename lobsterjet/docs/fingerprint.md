# Fingerprint hygiene (Phase 3, honest scope)

## What exists today

The transport seam is real: `app/src/libcurl-transport-vendored.ts` is
a committed adapter that loads the vendored `@mercuryworkshop/libcurl-transport`
dist at runtime (`/libcurl/index.mjs`). The bundle itself is
AGPL-3.0-only (~2.1 MB), so it is never committed; the CI workflow
vendors a pinned version (2.0.5) into `app/public/libcurl` and the
build verifies it landed in `dist`. Without the vendor step the adapter
throws at runtime and the suite records transport-missing.
Impersonation itself: nothing measurable yet. The compat suite must
first report block rates for the stock build before any shaping is
justified. Measure first, then impersonate.

## Where TLS actually terminates

The service worker cannot terminate TLS: a `fetch()` to the real
destination from the SW is cross-origin and blocked. All proxied HTTPS
therefore goes over wisp TCP streams, and TLS is terminated by the
libcurl wasm transport in the page context (the same BareMux-compatible
path Scramjet uses; see `app/src/libcurl-transport-vendored.ts`).

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
sites actually reject the current build's fingerprint.

## AGPL note

`@mercuryworkshop/libcurl-transport` and `libcurl.js` are AGPL-3.0-only.
They are vendored at build time, never committed. Anyone serving a
built engine that includes these bundles must honor AGPL-3.0 for the
transport and, per AGPL, for the combined work it links against. There
is no non-libcurl fallback in the SW: without the vendored bundle,
proxied navigation throws transport-missing by design.

## Done-when for this phase item

"Fingerprint impersonation measurably reduces blocks" is not met and
cannot be met until the suite reports block rates to compare.
