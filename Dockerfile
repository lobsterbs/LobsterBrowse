# syntax=docker/dockerfile:1
# Multi-stage build for the LobsterBrowse single-site service:
# the Rust Wisp server and the static M3E UI it serves from one origin.
# Builder tracks latest stable Rust: zeroize 1.9+ manifests need cargo >= 1.85.
# Reproducibility: same LobsterBrowse commit + same Dockerfile + pinned
# ZEOLITE_COMMIT below must give identical build inputs. Bump the pin
# by updating both the ARG and the zeolite-server rev in
# server/bin/server/Cargo.toml (and the committed server/Cargo.lock via
# the generate-rust-lockfile workflow), then clear the Render build cache.
FROM rust:1-slim AS builder
WORKDIR /build
COPY server/ ./
RUN cargo build --release --locked -p lobster-server

FROM node:22-slim AS ui-builder
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

# Zeolite engine bundle: an immutable Zeolite commit carries the green
# build of the engine service worker and its chunks (libcurl stripped
# there: the AGPL bundle is never committed to git). Vendored here at
# build time so the server can serve it same-origin at /zlsw/ and the
# UI can register the worker. Pinned to an exact revision instead of a
# moving branch so rebuilds are deterministic.
# Current pin: dist e893ee6 (Zeolite main da8c0c0, CI run 38056407768)
# 2026-10-07 (5). The engine week since 13ae7da8: wisp auth verified
# against client payloads, loopback bind + Origin guard + fail-closed
# auth config + security headers, JSON configs swapped for KDL, SW
# keepalive for streaming documents (#99), SipHash length-word mask
# for long-destination routes (#100), child-realm reemit + escape log
# (#101), 204/205 navigation error page (#102), iframe/embed/object
# destination classification (#103), popup activation guard (#106),
# 30s navigate first-byte deadline + post-redirect rewrite base
# (#107), child-realm storage/cookie isolation (#108), SWR refresh
# coalescing. 2026-10-07 (6): #109 - popup-class activations re-open
# through the original window.open while their user activation is
# live (the minted re-drive outlived the activation window, so e.g.
# Google's AI Mode pressed but never applied), and relative
# navigation-bound writes (anchor/area href, iframe src, form
# action) re-emit through the #101 marker instead of landing on
# the proxy origin. sw.js stays f90129af (SW bundle untouched),
# bootstrap.js 84c8ec97 -> 413a7bd7. Cargo-side pin stays 483aa0f
# (no crates changed since).
# 2026-10-07 (7): #110 - the SW re-establishes the client virtual
# context from the post-redirect destination once the hop chain
# resolves (google.com -> www.google.com left runtime-relative
# URLs resolving against the apex, whose 404 on /async/hpba meant
# Google's AI Mode panel never initialized and the button pressed
# with no effect). sw.js f90129af -> 9c5ead20; bootstrap.js
# unchanged (413a7bd7). Cargo-side pin stays 483aa0f (no crates
# changed).
# 2026-10-08 (8): #112 - directory-shaped JS literal destinations
# under the keyed codec keep the last path segment visible after the
# token (the sorry page's recaptcha enterprise loader appends "api2/"
# unless its api base ends with "enterprise/", and the opaque token
# broke every tail check, sending the anchor iframe to google's 404).
# sw.js and bootstrap.js unchanged (9c5ead20 / 413a7bd7): the fix
# rides in rewriter_wasm_bg.wasm, so the alarm pins cannot distinguish
# this bump from the previous pin - deploy with a cleared build cache.
# Cargo-side pin stays 483aa0f (no crates changed).
# 2026-10-08 (9): #112 follow-up - subresource requests from a navh-
# served document carry the navh route as referrer, which does not
# decode as an engine path, so forwardedHeaders omitted the Referer
# upstream; google's reCAPTCHA anchor validates the site key against
# that header and rendered "Invalid domain for site key" on /sorry.
# The SW now decodes the navh token and forwards its destination as
# the Referer. sw.js 9c5ead20 -> ae06e841; bootstrap.js unchanged
# (413a7bd7). Cargo-side pin stays 483aa0f (no crates changed).
# 2026-10-08 (10): #112 follow-up 2 - the Referer fix alone
# did not repair the widget: its JS computes co= from
# window.location.origin (LegacyUnforgeable), so upstream kept
# receiving the engine origin and the site-key domain check kept
# failing ("Invalid domain for site key"). A co= naming this
# deployment is now rewritten to the embedding page's virtual origin
# at the fetch seam. sw.js ae06e841 -> 247f8349; bootstrap.js
# unchanged (413a7bd7). Cargo-side pin stays 483aa0f (no crates
# changed).
# 2026-10-08 (11): #112 follow-up 3 - the sorry doc's page JS builds
# absolute URLs as real origin + location.pathname, and pathname is
# the opaque engine route token, so the engine fetched
# www.google.com/j/<token> upstream and google's 404 replaced the
# document (the captcha vanished behind a 404 error page). The SW
# now dereferences embedded self-route tokens in upstream
# destinations when the token decodes to the same origin
# (MAC-verified, fails closed). sw.js 247f8349 -> 9fa58b72;
# bootstrap.js unchanged (413a7bd7). Cargo-side pin stays 483aa0f
# (no crates changed).
# 2026-10-08 (12): #113 - a cold-start session can race the boot
# config: the first engine navigation is minted under the legacy
# /zl/ prefix before the SW route shape is configured, decodePath
# cannot see the tail, and the request escaped to the proxy origin
# (the server answers it with the misleading no-worker notice).
# The escape seam now recovers decodable legacy routes (configured
# prefix or the reserved zl segment; keyed tails refused, host
# routes never captured). sw.js 9fa58b72 -> b5f0f84c; bootstrap.js
# unchanged (413a7bd7). Cargo-side pin stays 483aa0f (no crates
# changed).
# 2026-10-08 (13): #99 - every wisp fetch now carries a 30s
# first-byte deadline in the transport seam (the vendored request
# promise resolves on headers, so a stalled subresource - a
# silently dropped wisp websocket - never settled and the page
# spinner ran forever). A stall is transport state like a
# connect-class error: singleton reset, re-init, single retry on
# a fresh connection, then honest failure. sw.js b5f0f84c ->
# bb61d441; bootstrap.js unchanged (413a7bd7). Cargo-side pin
# stays 483aa0f (no crates changed).
# 2026-10-09 (14): #113 follow-up - legacy /zl/ referrers (cold
# starts, pre-#113 dists) now decode in forwardedHeaders and
# referrerOrigin through the decodePath -> nav handle ->
# decodeLegacyRoute chain, so subresources from any route family
# carry a real upstream Referer again and the reCAPTCHA co= seam
# resolves the page origin deterministically. Regression tests
# pin the co= chain across keyed, navh and legacy referrers
# (Zeolite ed23eb46). sw.js bb61d441 -> edf104c0; bootstrap.js
# unchanged (413a7bd7). Cargo-side pin stays 483aa0f (no crates
# changed).
# 2026-10-09 (15): #115 - the page cache is conditional: stored
# entries keep the origin's ETag/Last-Modified, the stale refresh
# sends If-None-Match/If-Modified-Since and a wire 304 keeps the
# stored body and bumps the stored-at time instead of re-transferring
# it, and no-cache entries revalidate before use (RFC 9111) with a
# failed revalidation bypassing to the live path honestly.
# sw.js edf104c0 -> e4402f7d; bootstrap.js unchanged (413a7bd7).
# Cargo-side pin stays 483aa0f (no crates changed).
# 2026-10-09 (16): #116 - the child-document residuals: created
# shadow roots get their own MutationObserver through an
# attachShadow hook (parser-inserted frames inside them loaded
# browser-direct - the live /j/<token> google 404 class),
# contentWindow/contentDocument reads install the child realm
# guard synchronously (closing the same-task write race that
# beat the observer microtask), unquoted srcdoc attribute values
# rewrite too, and guarded children re-emit fetch/XHR through
# the #101 parent-relative marker. The shadow-root registry the
# first cut shipped was dead code; the trimmed hooks fit the
# 20 KiB bootstrap budget (20429 bytes). sw.js unchanged
# (e4402f7d): the ride is entirely in bootstrap.js,
# 413a7bd7 -> ee2c30cf, so the /build zlswSha cannot distinguish
# this bump - verify the served /zlsw/bootstrap.js hash instead.
# Cargo-side pin stays 483aa0f (no crates changed).
# 2026-10-09 (17): #122/#123 - regex-aware JS scanner in the wasm
# rewriter: quotes inside regex literals were parsed as string
# delimiters, so the engine-route rewrite of a URL embedded in a
# YouTube base.js messageRegExp injected slashes that terminated
# the pattern and the whole 10.9 MB script failed to parse (empty
# SPA body, video loads forever; Twitch the same class). Turnstile
# script srcs now stay provider-direct so api.js can self-locate
# its tag and the widget injects (#120 still owns the frames).
# Rust-only: sw.js stays a7bb36c3, bootstrap.js stays 30e040f1;
# the ride is in rewriter_wasm_bg.wasm, so the /build zlswSha
# cannot distinguish this bump - verify the served
# /zlsw/rewriter_wasm_bg.wasm hash instead.
# Cargo-side pin stays 3d170f7 (zeolite-server unchanged; the
# rewriter crate is not a server dependency).

# 2026-10-09 (18): #124 - the script-serve import-specifier pass was
# a raw regex and could bridge two string literals, swallowing the
# code between them as a "specifier" and replacing it with an engine
# route (Twitch player-core: "No matches from ".concat(w," payloads")
# became a syntax error and the whole 387KB chunk failed to parse;
# ChunkLoadError, the player never booted). The matcher is now a
# quote-parity-aware scanner with the wasm literal pass context rules
# (strings, comments, regex discrimination); template bodies are
# opaque and property-name heads are skipped. sw.js a7bb36c3 ->
# 888f6c84; bootstrap.js stays 30e040f1; the wasm is untouched
# (78dd3ce206ab7f27, verify the served file). Cargo-side pin stays
# 3d170f7 (no crates changed).

# 2026-10-09 (19): #125 + #126 - zeolite-server upstream DNS is
# DoH by default now: the pinned Quad9 (default) or Cloudflare IPs
# answer over HTTPS/443 with the resolver certificate validated
# against its DNS name (dns.quad9.net / cloudflare-dns.com, Mozilla
# webpki roots), and there is deliberately no plaintext port-53
# fallback - a host that blocks the DoH handshake fails closed. This
# is the LB server's own outbound resolution too (main.rs PolicyDns
# delegates to zeolite_server::dns). Cargo-side pin 3d170f7 ->
# deccb43 (zeolite-server changed). #126: the wasm rewriter routes
# inline module import specifiers (bare package names stay bare;
# already-routed specifiers unwrap to one route). sw.js stays
# 888f6c84, bootstrap.js stays 30e040f1; the ride is in
# rewriter_wasm_bg.wasm, 78dd3ce206ab7f27 -> c5fe41724b40bae0 -
# the /build zlswSha cannot distinguish this bump, verify the served
# wasm hash instead.
# 2026-10-09 (20): #127 - google.com (origin-only Referrer-Policy)
# sent Referer: <engine-origin>/ for every subresource, decodePath
# could not recover a page URL from it, the Referer was dropped, and
# the /sorry reCAPTCHA anchor rejected the site key ("Invalid
# domain for site key"). The worker now restores the upstream
# Referer from the per-client virtual initiator origin
# (virtualRefererFallback) before giving up. App-side only:
# sw.js 888f6c84 -> 12ac9193; bootstrap.js stays 30e040f1; wasm
# untouched (c5fe41724b40bae0, verify the served file). Cargo-side
# pin stays deccb43 (no crates changed).

# 2026-10-09 (21): #128 - engine-routed pages messaging their own
# same-site frame by the frame's virtual origin had the postMessage
# dropped by the browser (targetOrigin mismatch): reCAPTCHA
# enterprise on google search died with "reCAPTCHA Timeout" and
# "Failed to fetch". The bootstrap now delivers such payloads
# locally as a synthetic message event carrying the origin the
# caller intended; matching targets, * and / stay native, malformed
# origins keep the native SyntaxError, ev.source is null on the
# synthetic path. Frames stay engine-routed - provider-direct was
# ruled out because it leaks the user IP. Plus the minimal error
# page redesign (no cards, system type, compact facts list; the
# zl-error meta, redaction and determinism contract unchanged).
# sw.js 12ac9193 -> a3eff568; bootstrap.js 30e040f1 -> 9cfdbb8f
# (21491 of the 21504 budget); wasm unchanged (c5fe41724b40bae0,
# verify the served file). Cargo-side pin stays deccb43.

# 2026-10-09 (22): #129 - the #120 provider-direct 302 for
# challenge frames leaked the user IP (the frame committed at
# the real provider origin) and broke the reCAPTCHA messaging
# the #128 bootstrap fix had just repaired (cross-origin anchor,
# postMessage targetOrigin dropped by the browser). Challenge
# frames now stay engine-routed; the 302 is gone and a DIAG
# event records the routing verdict. Plus the error page
# redesign: Zeolite ASCII logo, category row back in the facts
# list, retry is a form button. sw.js a3eff568 -> b6221208;
# bootstrap.js stays 9cfdbb8f (21491 of the 21504 budget); wasm
# unchanged (c5fe41724b40bae0, verify the served file).
# Cargo-side pin stays deccb43.

# 2026-10-09 (23): #128 follow-up - with challenge frames
# engine-routed, reCAPTCHA's anchor protocol reached the
# messaging stage and died on the frame's bare two-argument port
# post: postMessage(msg, [port]) is the legacy WebKit overload
# (targetOrigin defaults to *). The #128 wrapper re-emitted every
# delegated call as (msg, targetOrigin, transfer), so the binding
# saw a phantom third undefined argument, picked the standard
# overload and threw "Invalid target origin '[object
# MessagePort]'". The wrapper now normalizes both call shapes
# and replays the caller's exact argument list at the native
# boundary; the synthetic delivery keeps transfer ports live
# (structuredClone with a transfer list neutered them into an
# unreachable clone). sw.js stays b6221208 (198072 bytes);
# bootstrap.js 9cfdbb8f -> 7f299840 (21551 of the 22528 budget,
# raised with the fix, rationale recorded in the Zeolite gate);
# wasm unchanged (c5fe41724b40bae0, verify the served file).
# Cargo-side pin stays deccb43.

# 2026-10-09 (24): #130 - the synthetic postMessage dispatch from
# #128 is gone. With challenge frames engine-routed, every frame
# message now stays inside the real engine origin, so postmsg.ts
# rewrites foreign/virtual targetOrigins to the real origin and
# delivers natively (both call shapes normalized, exact-argument
# replay, malformed keeps the honest SyntaxError; no synthetic
# dispatch, transfer lists stay native). vorigin.ts is new: the
# page asks the SW for its virtual origin (zl:getVirtualOrigin)
# and a bootstrap-side message-event filter re-exposes ev.origin
# as the sender virtual origin on same-origin-looking events. sw.js
# b6221208 -> 568fc624 (198147 bytes); bootstrap.js 7f299840 ->
# c5554b40 (22483 of the 23552 budget, raised with the rationale
# recorded in the Zeolite CI gate); wasm unchanged
# (c5fe41724b40bae0, verify the served file). Cargo-side pin
# stays deccb43.


# 2026-10-10 (27): #130 finish + #131. The reCAPTCHA widget's last
# break was sender-side: senderVirtualOrigin decoded only
# standalone route tails, so a #112 directory-shaped anchor route
# (<token>/api2/anchor) answered zl:getVirtualOrigin with null; the
# page's vorigin filter never rewrote the anchor's message events
# and grecaptcha dropped them all as foreign-origin messages
# (reCAPTCHA Timeout, anchor retry loop). The origin decode now
# retries with the request engine's MAC-verified recoverPath and
# peels nested routes with unwrapDest. #131: Vite's __vite__mapDeps
# dot-relative asset strings ("../chunks/x.js") now route through the
# rewriter's module-base encoder instead of resolving to
# engine-origin 404s (Brave Search: dead UI, no favicons, Ask AI
# refresh loop). sw.js 568fc624 -> 9dcd3c18 (198177 bytes);
# bootstrap.js unchanged (c5554b40); wasm c5fe4172 -> f5ad1126
# (99153 bytes, verify the served file). Cargo-side pin stays
# deccb43.


# 2026-10-10 (28): #130 residual, third widget break. The
# page's grecaptcha sends the anchor setup as a legacy
# two-arg postMessage("recaptcha-setup", [MessagePort]) with no
# targetOrigin. The #130 exact-argument replay delivered it
# verbatim, but Chromium drops the transfer list when the
# legacy postMessage overload delivers same-origin, so the
# anchor never received its private MessagePort and the
# widget protocol died (reCAPTCHA Timeout, anchor recreation
# loop, no bframe). bootstrap.js now re-emits legacy two-arg
# port calls in standard order (message, explicit origin,
# ports) so the ports survive delivery. sw.js unchanged
# 9dcd3c18 (198177 bytes); bootstrap.js c5554b40 -> bc001db
# (22544 bytes); wasm unchanged f5ad1126. Cargo-side pin
# stays deccb43.



# 2026-10-10 (29): fourth widget break, the last measured seam.
# The #130 wrapper re-emits from its own realm, so the anchor's
# parent.postMessage landed on the page's wrapper and the
# re-emission executed in the PAGE realm: ev.source was stamped
# with the page window (from=self), the page's grecaptcha dropped
# the anchor's setup, and the widget spun (reCAPTCHA Timeout,
# anchor recreation loop, no bframe). bootstrap.js now stashes
# each realm's native postMessage (__zlNativePM) and every child
# realm shadows its configurable window.parent (top is
# LegacyUnforgeable) with a Proxy that executes the parent's
# stashed native from the CHILD realm, so the browser stamps the
# genuine caller and the ports survive delivery; navguard's
# guarded inline child realms get the same shim. The Zeolite
# commit title mislabels the issue as #131; the widget work is
# tracked in #130 and its follow-up. sw.js unchanged 9dcd3c18
# (198177 bytes); bootstrap.js bc001db -> d6f6abba (23388
# bytes); wasm unchanged f5ad1126. Cargo-side pin stays
# deccb43.
# 2026-10-10 (30). #132 closes the frame-protocol duplex: the
# contentWindow sender half (a parent messaging its child through
# the element delivers with the genuine sender window; before, the
# anchor heard the page's setup as ev.source = itself) + the
# virtual-origin parity drop (a targetOrigin the recipient's marker
# does not match is dropped, the unproxied behavior). sw.js
# unchanged 9dcd3c18 (198177 bytes); bootstrap.js d6f6abba ->
# a9aca861 (24172 bytes); wasm unchanged f5ad1126. Cargo-side pin
# stays deccb43.

# 2026-10-10 (31): #132 follow-up, the measured widget seam. The
# #130 vorigin origin relabel (ev.origin -> the sender's __zlVO)
# broke the widget: gstatic's channel establishers derive the
# origin they expect from the rewritten src/co= URLs, which point
# at the ENGINE, so every origin check failed, the setup port was
# never taken, the click notification was lost, the bframe was
# never created and the widget timed out on every anchor rebuild
# (live probes rc45-rc53: identity, source and port checks all
# passed, only the origin comparison failed). ev.origin now
# deliberately stays the native engine origin; the ev.source
# identity relabel and the __zlVO marker (postmsg sender-side
# parity checks) stay. sw.js unchanged 9dcd3c18 (198177 bytes);
# bootstrap.js 0b6b80e9 -> db25100b (24433 bytes, under the
# 25088 budget); wasm unchanged f5ad1126. Cargo-side pin stays
# deccb43.

# 2026-10-10 (32): #132 follow-up 2, the window.name seam. The #37
# isolation wrapper scoped window.name through the site-scoped
# sessionStorage but initialized it EMPTY, dropping the browsing
# context's real name; gstatic's bframe resolves its anchor channel
# as parent.frames[its own name transformed to the anchor's name]
# (recaptcha__en.js Y.o2), so the named lookup returned undefined,
# the bframe's postMessage target was dead, and the anchor's 15s
# establisher rejected (reCAPTCHA Timeout, challenge never opened,
# live probes rc59/rc60: name correct at t=0, cleared by the
# wrapper by t=200ms). A fresh scoped context now seeds its name
# from its frameElement's name attribute; top-level windows still
# start empty, so the #37 anti-bleed goal is preserved. sw.js
# unchanged 9dcd3c18 (198177 bytes); bootstrap.js db25100b ->
# 03cd3476 (24521 bytes, under the 25088 budget); wasm unchanged
# f5ad1126. Cargo-side pin stays deccb43.

FROM debian:bookworm-slim AS zl-builder
ARG ZEOLITE_COMMIT=e893ee6dd6d1a3dd7870d1f14f8f8fb01c4f925a
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates npm \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /bundle
RUN curl -fsSL "https://github.com/lobsterbs/Zeolite/archive/${ZEOLITE_COMMIT}.tar.gz" \
 | tar xz --strip-components=1
# The libcurl transport (TLS termination for the wisp hop): pulled
# from npm at build time, same pinned version the Zeolite CI vendors.
RUN mkdir -p /bundle/libcurl \
 && npm install --prefix /zlvendor --no-audit --no-fund @mercuryworkshop/libcurl-transport@2.0.5 \
 && npm install --prefix /zlvendor --no-audit --no-fund @mercuryworkshop/epoxy-tls@2.1.18-1 \
 && cp -r /zlvendor/node_modules/@mercuryworkshop/libcurl-transport/dist/. /bundle/libcurl/
# The epoxy transport (selectable second engine, Zeolite #64):
# same pinned-version, never-committed vendoring rule as libcurl.
# Full variant: the WebSocket bridge + gzip/brotli + HTTP/2 sit
# behind the package "full" build. The SW resolves it at the origin
# root (/epoxy/epoxy.js + epoxy.wasm); the server serves /epoxy from
# this bundle directory.
RUN mkdir -p /bundle/epoxy \
 && cp /zlvendor/node_modules/@mercuryworkshop/epoxy-tls/full/epoxy.js /bundle/epoxy/epoxy.js \
 && cp /zlvendor/node_modules/@mercuryworkshop/epoxy-tls/full/epoxy.wasm /bundle/epoxy/epoxy.wasm

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/lobster-server /app/lobster-server
COPY --from=ui-builder /ui/dist /app/ui
COPY --from=zl-builder /bundle /app/zlsw
EXPOSE 6001
# Bundle-stale alarm pins: sha256-8 prefixes of the dist artifacts at
# ZEOLITE_COMMIT above (sw.js, bootstrap.js). The server compares them
# at startup and flags /build stale when the zl-builder layer cache
# serves an older tarball.
ENV PORT=6001 WISP_PATH=/wisp/ ZEOLITE_SW_SHA=9dcd3c18f44b9426 ZEOLITE_BOOTSTRAP_SHA=03cd3476b4117997
ENTRYPOINT ["/app/lobster-server"]
