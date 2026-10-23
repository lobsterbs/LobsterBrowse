# syntax=docker/dockerfile:1
# Multi-stage build for the LobsterBrowse single-site service:
# the Rust Wisp server and the static M3E UI it serves from one origin.
# Builder tracks latest stable Rust: zeroize 1.9+ manifests need cargo >= 1.85.
# Reproducibility: same LobsterBrowse commit + same Dockerfile + pinned
# ZEOLITE_COMMIT below must give identical build inputs. Bump the pin
# by updating both the ARG and the zeolite-server rev in
# server/bin/server/Cargo.toml (and the committed server/Cargo.lock via
# the generate-rust-lockfile workflow), then clear the Render build cache.
# Builder base is pinned to bookworm: the runtime stage is
# debian:bookworm-slim (glibc 2.36) and the rolling rust:1-slim tag
# moved to a newer Debian, producing a binary that needs GLIBC_2.38
# and dies at instance start ("version GLIBC_2.38 not found").
FROM rust:1-slim-bookworm AS builder
# wreq links BoringSSL (btls-sys): cmake + g++ + perl build it and
# bindgen needs libclang at build time (the runtime feature loads the
# system libclang, it is not linked into the binary).
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake perl pkg-config libclang-dev git \
 && rm -rf /var/lib/apt/lists/*
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

# 2026-10-10 (35): #134 - cache-hit serve re-ran the streaming
# rewriter for HTML and CSS but served JS bodies verbatim (the
# netlog row already claimed rewritten: js). Entries stored by
# older dists hold raw upstream bodies, so a module-relative
# import() in such a copy resolved against the engine route and
# the escaped-path recovery answered the document root instead of
# the module directory: play2048.co's lazy chunk loaded the site's
# own SPA shell as JavaScript (200 text/html, MIME rejection, the
# game never booted; github.com's CSS chunk the same class). The
# browser flattens a dot-relative specifier to a root-relative
# engine path, so the recovery cannot fix the class - the fix is
# serve parity. The cache-hit JS branch runs the same two passes
# the fresh path runs (specifier fold + literal pass, both
# idempotent on composed copies) and writes the repaired copy back
# only when a pass changed the body, so a stale raw entry heals
# once. Worker destinations keep the raw serve (their cached
# copies are composed by the fresh path). sw.js 9dcd3c18 ->
# aea44290 (198656 bytes); bootstrap.js unchanged 03cd3476; wasm
# unchanged f5ad1126. Cargo-side pin stays deccb43.

# 2026-10-10 (36): Zeolite #134 + #133. The SW specifier pass
# (fresh-serve import rewriting) desynced on real module bodies
# with nested template substitutions: a backtick inside a
# template expression closed the outer template early, and the
# scanner then read a // inside template text as a line comment,
# swallowing the rest of the chunk including the import
# specifier - play2048.co's 364KB entry chunk served with a raw
# import despite the (35) serve-parity fix. The pass now tracks
# template/substitution nesting recursively (brace depth, nested
# strings, comments and templates), so specifiers inside
# template-heavy chunks fold correctly. #133: a wisp stream
# beyond the server's max-stream ceiling wedges the transport
# (instant error 7 afterwards, the WebSocket never fires close,
# the #74 watcher is blind to it); errors 7/35 join the connect
# class and reset() busts the vendored bundle's connection-cache
# key with a wisp URL generation, so the reset+retry rides a
# fresh WispTransport. sw.js aea44290 -> f8c69962 (199579 bytes);
# bootstrap.js unchanged 03cd3476; wasm unchanged f5ad1126.
# Cargo-side pin stays deccb43 (app-only change, no crates).

# 2026-10-10 (37): Zeolite #134 residual, global fix. React
# apps (github.com) construct module.css asset names at RUNTIME
# (flat names like xy4.86babbfb1b89d634.module.css), so no
# serve-time pass can fold them: the flat specifier resolved
# against the document base, escaped-path recovery answered the
# page origin root, and the origin 404 (text/plain) was refused
# as a stylesheet. New assetbases.ts records the CDN asset
# directories of every successful cross-origin script/style load
# per virtual page origin; a failed (>=400) flat-named script or
# style request retries against those observed bases with minimal
# safe headers (user-agent/accept/accept-language only; never
# cookies/origin/referer). No per-site table: the heuristic is
# global and fails closed. sw.js f8c69962 -> 1785f26f (201195
# bytes); bootstrap.js unchanged 03cd3476; wasm unchanged
# f5ad1126. Cargo-side pin stays deccb43 (app-only change).

# 2026-10-10 (38): two engine fixes. (1) The Anubis
# pass-challenge repair accepts the redir shape anubis >= 1.26
# actually emits: window.location.href of the rewritten challenge
# page, an ABSOLUTE engine-origin URL. The old code only decoded
# bare route paths, isEnginePath failed on the absolute string,
# the redir went upstream untouched and the deployment rejected
# the cross-origin redirect target (startpage: the proof of work
# completes, verification then fails 500). Absolute redirs are
# accepted only from the engine origin. (2) The flat asset
# recovery now also covers runtime-built BINARY names (image,
# video, audio, font, bare fetch): the github homepage mints
# glb/mp4 names at runtime that 404 at the page origin. Element
# dests require their MIME family (or octet-stream), a bare
# fetch must carry an extension so beacon-shaped misses do not
# mint CDN retries, and HTML/plain-text candidates are refused.
# sw.js 1785f26f -> 25dea7e1 (201702 bytes); bootstrap.js
# unchanged 03cd3476; wasm unchanged f5ad1126. Cargo-side pin
# stays deccb43 (app-only changes).

# 2026-10-10 (39): lazy-images opt-in rewriter pass (loading="lazy" on
# img tags without one, additive only) + the zl:config imageLazy and
# httpsUpgrade host toggles (Zeolite main 7dc5d8a, ci gate fix 0704011).
# sw.js 25dea7e1 -> 21dc6e6c (201932 bytes); bootstrap.js unchanged
# 03cd3476; rewriter wasm f5ad1126 -> d86f746e. Cargo-side pin stays
# deccb43 (the LB server consumes no rewriter change; lazy images and
# the https toggle ride the service worker).

# 2026-10-10 (40): the declarative compatibility policy engine
# (Zeolite #135/#136): /policy.kdl rules upgrade narrowly scoped
# requests (host/path/types) from native transport onto the rewrite
# path, with a stable reason + ruleId in the fallback ring and the
# TRANSPORT_FALLBACK trace; route "rewrite" is the only settable
# route (native is already the default, required rewrites cannot be
# demoted), and a rejected file keeps the defaults with a TRANSPORT
# diag. The shipped policy.kdl is intentionally empty; LB serves it
# from the vendored dist at the origin root. sw.js 21dc6e6c ->
# 5b2df445 (205055 bytes); bootstrap.js unchanged 03cd3476; wasm
# unchanged d86f746e. Cargo-side pin stays deccb43 (app-only change).
# 2026-10-10 (41): engine error pages now attribute engine bugs
# (the error card names a Zeolite engine bug and asks for a report
# with the Trace ID; upstream failures stay neutral), and the
# zl:loadState control API reports in-flight upstream requests per
# destination host plus live rewrite streams so the LB tab spinner
# tracks engine work, not just frame resource timing. sw.js
# 5b2df445 -> 8edc1a9b (205898 bytes); bootstrap.js unchanged
# 03cd3476; wasm unchanged d86f746e. Cargo-side pin stays deccb43
# (app-only change).


# 2026-10-10 (42): the Anubis pass-challenge repair now decodes
# navh handle redirs. The embedder's initial navigations ride navh
# handles, so the redir anubis 1.26.4 echoes back is the absolute
# handle URL, isEnginePath rejected it and the repair never fired
# (startpage: the proof of work completes, the verification 500s
# Something went wrong). The handle decodes with its own keyed
# decoder (tag + TTL), engine-side only, so the redir upstream
# carries the real destination. sw.js unchanged 8edc1a9b (205898
# bytes); bootstrap.js unchanged 03cd3476; wasm unchanged d86f746e;
# the fix rides codec.js (88437eb5 -> c29f5a19, verify the served
# file). Cargo-side pin stays deccb43 (app-only change).

# 2026-10-11 (43): the embedder fetch relay and settle guarantees.
# Hosts that fingerprint-block the wasm TLS ClientHello (duckduckgo:
# libcurl error 35) route onto the embedder network stack (the LB
# /zlrelay endpoint, native TLS, the same SSRF resolver); policy
# route "relay" drives it, route "native" (#138) demotes the JS
# literal pass for proven hosts. Subresource bodies settle on idle
# stalls (#140) and github repo pages boot again (#143: runtime
# flat module.css names recover against the CDN bases). The stall
# wrap and relayed responses carry rawHeaders, so upstream
# set-cookie still lands in the jar. sw.js 8edc1a9b -> 60ce0fde
# (211106 bytes); bootstrap.js unchanged 03cd3476; wasm unchanged
# d86f746e; codec.js unchanged c29f5a19. Cargo-side pin stays
# deccb43 (app-only change).

# 2026-10-11 (44): the opaque-route relative recovery (#143
# follow-up). github repo pages boot the React app but their
# widget fetches arrive as /__zl_navh__/<token>/<suffix> and
# 404 with a bad-handle strand: the page cannot read its real
# path (LegacyUnforgeable location), so runtime URL building
# appends to location.pathname. navhTailDest resolves
# token-bearing tails with page-path-append semantics (the
# token destination first, the client virtual context as the
# fallback for expired tokens on long-lived pages) and
# parser-resolved relative tails with ordinary URL semantics;
# navigations keep the honest 404. sw.js 60ce0fde -> c4181cb7
# (211757 bytes); bootstrap.js unchanged 03cd3476; wasm
# unchanged d86f746e; codec.js unchanged c29f5a19. Cargo-side
# pin stays deccb43 (app-only change).
# 2026-10-11 (45): cookie jar RFC 6265 audit (Zeolite main 1e573d3,
# CI run 541 green, dist 2757a66) - an empty Domain attribute no
# longer demotes a host-only cookie to a bare-host domain cookie
# (5.2.3), document.cookie reads path-match the document URL the
# same way request cookies do (5.4), and persisted (jarLoad) plus
# imported (jarReplace) jar records are shape-checked before
# admission so corrupted storage or a hostile import cannot throw
# mid-request. sw.js c4181cb7 -> e2c5ea7a (212157 bytes);
# bootstrap.js unchanged 03cd3476; wasm unchanged d86f746e;
# codec.js unchanged c29f5a19. Cargo-side pin stays deccb43
# (app-only change).
# 2026-10-11 (46): cookie jar follow-ups (Zeolite main b1b96b3, CI
# green, dist f8135f2) - RFC 6265 5.3.11: re-admitting a cookie keeps
# the original creation-time (send-order tie-break), and jarMerge
# filters imported records with the stored-cookie shape gate so a
# record missing secure/httpOnly/expires/created cannot be admitted.
# sw.js e2c5ea7a -> 38b66986 (212039 bytes); bootstrap.js unchanged
# 03cd3476; wasm unchanged d86f746e; codec.js unchanged c29f5a19.
# Cargo-side pin stays deccb43 (app-only change).
# 2026-10-11 (47): #144 navh suffix navigation recovery, HTTPS-only
# default with proceed-anyway (loopback never upgraded),
# zl:extUninstall, optional API module detach/reattach,
# cookies.onChanged, RFC 6265 cookie-date parser, wisp stall-storm
# relay-first cooldown (Zeolite main 72351d4, CI green, dist
# 0767b56). sw.js 38b66986 -> f0c7b17f (215739 bytes);
# bootstrap.js unchanged 03cd3476; wasm unchanged d86f746e;
# codec.js unchanged c29f5a19. Cargo-side pin stays deccb43
# (app-only change).
# 2026-10-11 (48): PSL site boundary for the cookie jar via tldts
# (registrable domain, private-section suffixes included) plus the
# RFC 6265 5.3 step 5 public-suffix admission gate; tough-cookie and
# whatwg-url adopted as test oracles (Zeolite main cbe510a, CI
# green, dist e6f9c7a). sw.js f0c7b17f -> 19ff69a3f5572ce9 (342614 bytes;
# +127KB is the public-suffix trie). bootstrap.js unchanged
# 03cd3476; wasm unchanged d86f746e; codec.js unchanged c29f5a19.
# 2026-10-11 (49): document.cookie read ordering (RFC 6265 5.4):
# longer paths first then creation order, matching the Cookie
# header and every browser; tough-cookie oracle pins it
# (Zeolite main 25e28e7, CI green, dist e01015a). sw.js
# 19ff69a3f5572ce9 -> a5e47b8e3a265fd8 (342643 bytes).
# bootstrap.js unchanged 03cd3476; wasm unchanged d86f746e;
# codec.js unchanged c29f5a19. Cargo-side pin stays deccb43
# (app-only change).
# 2026-10-11 (50): Zeolite bug-scout wave (main 1e9b7d1, CI run
# 38154209990, dist d2315df): the extension package reader now caps
# zip inflation DURING decompression (a decompression bomb could
# previously expand gigabytes in the worker before the declared-size
# check ever ran), and codec tailBytes is anchored, so a same-origin
# path merely containing the scheme prefix mid-way no longer decodes
# as a destination; hostile-tail recovery stays in recoverPath
# behind its keyed gates. First tests for the package reader. sw.js
# a5e47b8e3a265fd8 -> 230932f95cdef730 (342885 bytes); bootstrap.js
# unchanged 03cd3476; wasm unchanged d86f746e; codec.js
# c29f5a19 -> 950319bc59af25c9 (codec.ts changed; not startup-
# pinned). Cargo-side pin stays deccb43 (app-only change).
# 2026-10-11 (51): Zeolite docs wave (main 1022268, CI run
# 38169358836, dist 1021d30): security doc retitled as an internal
# self-review with methodology stated, session-blob iter bounds
# documented at the check, stale Phase 3 AST comment in literals.rs
# corrected (issue #146). sw.js 230932f95cdef730 (342885 bytes),
# bootstrap.js 03cd3476, codec.js 950319bc59af25c9 all unchanged
# (comment-only source changes); wasm d86f746e -> 68264b205eb4e64d
# (byte-level shift from the literals.rs comment, functionally
# identical). Cargo-side pin stays deccb43.
# 2026-10-11 (52): Zeolite relay abort wave (main c4fca0c, CI run
# 38170947855, dist d255688): relayFetch propagates AbortSignal with
# a zl:relayCancel frame (issue #145) so an aborted page fetch drops
# the embedder-side /zlrelay connection instead of streaming to
# completion; the transport cooldown passes the signal through and
# request.ts threads e.request.signal into upstreamFetch. LB ui
# zeolite.ts aborts its /zlrelay fetch on the cancel frame. sw.js
# 230932f95cdef730 -> acec9296b7e68c10 (343391 bytes); bootstrap.js
# 03cd3476, codec.js 950319bc59af25c9, wasm 68264b205eb4e64d all
# unchanged. Cargo-side pin stays deccb43.
# 2026-10-12 (53): Zeolite navh split-identity wave (#144)
# (main 9772360, CI run 38212107143, dist 296078c): zl:navHandle
# now carries only the origin in the keyed token with the real
# path and query plaintext on the route, so SPA URL bars show a
# real pathname while the destination stays hidden from the page.
# decodeNavHandlePath in codec/request.ts resolves token+tail;
# legacy full-dest tokens decode unchanged and age out at 120s.
# sw.js acec9296b7e68c10 -> 66d337316585ca15 (343611 bytes),
# codec.js 950319bc59af25c9 -> 8dbcd20fd3c8e9ff; bootstrap.js
# 03cd3476 unchanged; wasm 68264b205eb4e64d -> 19575746805d5da0.
# Cargo-side pin stays deccb43.
# 2026-10-12 (54): epoxy wisp-mux death is connect-class (Zeolite
# #147; main 7548235, CI run 38215205394, dist e6ea8c6). A dead
# epoxy wisp socket failed the pending hyper connect with
# Wisp(MuxTaskEnded) ("Multiplexor task ended"), which matched no
# connect-class pattern, so the #74 reset+retry never fired and
# the navigation answered a terminal 502 error page (live trace
# zl-tmv4vzlk7-8). CONNECT_CLASS_RE now also matches the epoxy
# dead-transport surface (muxtaskended, multiplexor task ended,
# wisp transport already closed, failed to send/receive
# multiplexor message, websocket implementation error: websocket
# closed); mid-body hyper errors stay unmatched and fail honestly.
# sw.js 66d337316585ca15 -> 1c67b54c12821a2b (343773 bytes);
# bootstrap.js 03cd3476, codec.js 8dbcd20fd3c8e9ff, wasm
# 19575746805d5da0 all unchanged (only sw.js rides). Cargo-side
# pin stays deccb43 (app-only change).
# Zeolite dist cbd3908 (main 6782532): content scripts actually
# execute (bridge use-strict newline, #150); NAVH pages decode as
# control-plane destinations and are refused host-only control
# (#151); extension onMessage reply values and promises honored
# (#152). sw.js 1c67b54c12821a2b (343773) -> 96d70fb9d7b90b14
# (343953); codec.js 8dbcd20fd3c8e9ff -> 8e94f6a717dc11e8;
# bootstrap.js 03cd3476 unchanged. Cargo-side pin stays deccb43
# (app-only change).
FROM debian:bookworm-slim AS zl-builder
# Pin 57: Zeolite dist f5b7327 ships the policy.kdl catch-all relay
# (wisp-auth deployments: the wasm client cannot authenticate, so
# every fetch rides the embedder relay). sw.js unchanged
# (96d70fb9d7b90b14); Cargo-side pin stays deccb43 (data-only change).
# Pin 58: Zeolite dist 8f51d86 ships the #121 refresh-spam fix (the
# bootstrap never auto-reloads proxied pages when a new engine
# activates; it now logs a console note and re-dispatches a
# zl:engineUpdate window CustomEvent for a manual reload affordance).
# sw.js 96d70fb9d7b90b14 -> 473408e5d1abe91a; bootstrap.js
# 03cd3476 -> b0624c71; Cargo-side pin stays deccb43 (app-only change).
# Pin 60: Zeolite dist 8e74ce7 ships the #157 top-level re-emit anchoring
# (root-relative fetch/XHR/beacon inputs on NAVH-served pages re-emit
# through <route>/__zl_prel__ instead of escaping to the proxy origin
# root; NAVP parents resolve under all three route shapes; the
# navRel/relRoute exclusion list dedupes into navExcluded). sw.js
# 473408e5d1abe91a -> 2b92b02d0deddd5e; bootstrap.js 3c148a51 ->
# 89314e254ca65dcd; Cargo-side pin stays deccb43 (app-only change).
# Pin 61: Zeolite dist 8c54bd1 ships the #157/#159 own-origin
# re-anchor (absolute engine-origin inputs re-anchor to their
# path and re-emit through the parent route, both at the emit
# seam and at the shared decode; script and worker destinations
# get a JS-typed body on upstream error statuses instead of an
# HTML error page; tokenShaped and the rel-route factory dedupe
# into navguard). sw.js 2b92b02d0deddd5e -> 2a70658ddf60e57a;
# bootstrap.js 89314e254ca65dcd -> 423b16b806b7f4cc; Cargo-side
# pin stays deccb43 (app-only change).
# Pin 62: Zeolite dist d981283 extends pin 61 with the content-type
# honesty guard: a script or worker destination never receives an
# HTML or CSS body, whatever the upstream status (SPA catch-alls
# answer missing module paths with a 200 HTML document, claude
# answers a mangled specifier with CSS; both the fresh path and
# the cache hit serve a JS-typed comment instead, so module
# graphs fail cleanly). sw.js 2a70658ddf60e57a -> f006bbd75da0a643;
# bootstrap.js 423b16b806b7f4cc unchanged; Cargo-side pin stays
# deccb43 (app-only change).
# Pin 64: Zeolite dist ad2e571 ships two engine fixes. First,
# the POST stream-body fix (#155/#159/#164/#166 class): every
# request body is buffered once at the upstreamFetch choke point
# (32MiB cap, honest overflow), so POSTs ride the embedder relay
# and survive the wisp connect-class retry instead of dying as a
# disturbed ReadableStream - the "shell renders, API 502" pattern
# on youtube innertube, chatgpt, deepseek, twitch Apollo,
# sketchfab and three.js. Second, the wasm rewriter never mints
# routes for www.w3.org namespace-identity URI literals (#153):
# createElementNS keeps the identity namespace, so the excalidraw
# provider cascade and delta setAttributeNS NamespaceError go
# away; the wasm is rebuilt with the guard. sw.js
# f006bbd75da0a643 -> 6fc87be1664e3954; bootstrap.js
# 423b16b806b7f4cc unchanged. Cargo-side pin stays deccb43
# (app + wasm-side rewriter changes, no server crate change).
# Pin 65: Zeolite dist a9fb63e. Server crate moves to Zeolite
# d8d6bed: wisp CONNECT now races allowed addresses (250ms stagger,
# first success wins) instead of starving later IPs behind a
# blackholed first address; DoH fallback (Quad9 NXDOMAIN/SERVFAIL
# retried once through Cloudflare) so filtered domains no longer
# look dead; wisp caps raised (streams/conn 24 -> 256, connections
# 64 -> 256, per-IP fairness behind a trusted proxy) and the 1h
# connection deadline drains live streams (60s grace) instead of
# hard-killing them. App-side sw.js ships built Sec-Fetch /
# Sec-CH-UA headers for first navigations (the #160 class),
# conditional body replay (buffer only when a retry or relay can
# actually happen), and mask accounting for #158/#159-class
# rewritten script responses. sw.js 6fc87be1664e3954 ->
# 4405ed7132900953; bootstrap.js 423b16b806b7f4cc unchanged;
# Cargo-side pin deccb43 -> 47b8f5b (zeolite-server changed; 47b8f5b
# additionally gives dns::LookupError the std::error::Error impl the
# server-side reqwest DNS resolver needs, caught by the first pin-65
# deploy build).
# Pin 66: Zeolite dist a78c6c8. The SW never forwards proxy-injected
# hop headers upstream anymore: the reverse proxy in front of the SW
# origin adds x-forwarded-for/-proto/-host/-port to every inbound
# engine request and the generic header copy sent them along - a
# proxy tell no real browser sends, and the plausible trigger behind
# Cloudflare edge 403 "Bad request" rejections of the relayed
# document on strict WAF zones (Zeolite #160, live echo evidence:
# postman-echo through the engine showed x-forwarded-proto riding
# the upstream request). The LB relay allowlist also denies them
# server-side now. sw.js 4405ed7132900953 -> c364479519b6e1ab;
# bootstrap.js 423b16b806b7f4cc unchanged; Cargo-side pin stays
# 47b8f5b (app-only change; 037e0d1 additionally makes the
# connect-race test DNS override parallel-safe).
# Pin 67: Zeolite dist 350cb06. Three engine fixes: the GREASE brand
# and the brand-list order of Sec-CH-UA now derive from the Chromium
# major (a fixed "Not_A Brand";v="8" in a fixed order is a list no real
# Chrome of that major ever sends; verified against chromium
# user_agent_utils.cc), chPlatform maps iPhone/iPad UAs to iOS instead
# of macOS, and routed <script src> values keep their destination's
# filename as a fragment so CMPs that locate their stub tag by substring
# on the original src (OneTrust script[src*=...] class, #161) find it
# again; the fetch target is unchanged (fragments strip before the
# request). sw.js c364479519b6e1ab -> 9c99fc3a2fef7157; bootstrap.js
# 423b16b806b7f4cc unchanged; Cargo-side pin stays 47b8f5b (the dns.rs
# change is test-only). Deployed together with the relay's wreq swap:
# reqwest/rustls -> wreq/boringssl with Chrome124 TLS/h2 emulation, the
# Zeolite #149/#160 fingerprint class.
# Pin 68: Zeolite dist 2947881. Typed navigations now carry the exact
# header set a real Chrome sends instead of the physical iframe's
# facts: sec-fetch-dest document with site none and sec-fetch-user ?1
# (dest iframe + site none + user ?1 is a combo no real Chrome emits,
# a #160-class WAF tell), initiated frame navs keep their dest but
# drop sec-fetch-user, the navigation Accept matches the claimed UA
# major (Chrome 124 does not advertise image/jxl, which arrived with
# Chrome 155's JPEG XL ship; the forwarded accept did), Accept-Language
# gains Chrome's q-value shape (en-US,en;q=0.9, not a bare join), and
# Sec-Fetch-Storage-Access (a Chrome 133+ header, after the persona's
# major) is neither synthesized nor forwarded. sw.js
# 9c99fc3a2fef7157 -> f3dfdb76467266c2; bootstrap.js 423b16b806b7f4cc
# unchanged; Cargo-side pin stays 47b8f5b.
# Pin 69: Zeolite dist e26dc50. 307/308 redirect hops buffer the
# request body once (cap 32 MiB) and replay it instead of surfacing
# the redirect to the page (only an announced Content-Length over the
# cap still surfaces), cross-origin hops drop Authorization per the
# fetch spec, the navigation TTFB deadline aborts the upstream fetch
# instead of only rejecting its promise, and the default persona is
# Chrome 149 with Sec-Fetch-Storage-Access synthesized on cross-site
# credentialed requests (a Chrome 133+ header, so the 124 persona
# could never carry it honestly). sw.js
# f3dfdb76467266c2 -> e575b078e13e2193; bootstrap.js 423b16b806b7f4cc;
# Cargo-side pin moves 47b8f5b -> 63b4f23.
# Pin 70: Zeolite dist ced0c3f. Per-host policy route "wisp"
# (#168): hosts the policy file routes to "wisp" (shipped rule:
# search.brave.com, whose PoW interstitial accepts the
# libcurl-wasm ClientHello through the public unauthenticated
# wisp-js backend but 429s the relay transport class) ride a
# secondary wisp client the UI announces via zl:wispRegister
# from /build sjWisp (beta: the standalone ScramJet wisp-js
# service; main: unset, so the route falls back to relay there).
# The relay stays the default for everything else. sw.js
# e575b078e13e2193 -> 2c036ac7ea643f7b; bootstrap.js
# 423b16b806b7f4cc unchanged; Cargo-side pin stays 63b4f23.
# Pin 76 (main release bump; pins 71-75 were beta-only and
# their fixes ride this bundle): Zeolite dist 7cdf6fc.
# Engine-side fixes since pin 70: control-plane sender gates
# fail closed, worker/blob storage scoping, tab reply binding
# (#169, #170, #171, #185); page cache session/auth scope,
# credentials handling, redirect-final URL keys and a body
# size cap (#179, #184, #195); mid-body transport errors
# surface as stream errors, not a clean EOF (#180); redirect
# hops re-enter the full gate chain and injected headers stay
# same-origin (#186, #194); NAVH pages recover their virtual
# origin (#193); cookie __Host-/__Secure- prefixes (#191);
# download partial-buffer cap with honest resume errors
# (#192); css url() fragments survive engine-route unwrap
# (#199); DevTools keyboard access (#220); fingerprint tz/
# canvas consistency (#223-#226); svg paint tail, b64decode
# len%4 rejection, bounded mint memo (#227-#229); plus the
# wave 18-20 fixes beta rode at pins 71-73 (#200-#204,
# #205-#208). sw.js 2c036ac7ea643f7b -> 88e39dd016c4ad30;
# bootstrap.js 423b16b806b7f4cc -> cf8b76ad53488959.
# Cargo-side pin moves 63b4f23 -> b0296f8: ships the
# zeolite-server hardening wave (#181, #182, #183, #189,
# #196, #198) and the deferred server wave (#197, #209-#213).
# Pin 77: Zeolite dist db17179. Engine-side fix since pin 76: the
# route search replaces a token-encoded destination query instead of
# concatenating onto it (a query-only relative navigation "?x" has
# browser replace semantics; JS-literal mints and legacy full-dest
# tokens encode their query inside the token, and the glued-on outer
# search produced "?a=1?b=2" upstream - Brave Ask on search.brave.com
# sent the new question as a mangled double-q URL and the AI answer
# never streamed). The same replace semantics apply at the cache-key,
# refresh, cache-bypass and forwarded Referer seams, and a NAVH
# full-dest token no longer drops the route search. sw.js
# 88e39dd016c4ad30 -> 4102766dcac60856; bootstrap.js cf8b76ad53488959
# unchanged; Cargo-side pin stays b0296f8 (app-only change).
# Pin 78: Zeolite dist 54f2c098. SPA pathname routing: an oxc AST
# pass in the wasm rewriter renames location reads (bare location and
# <window|self|globalThis|document|top|parent>.location member reads)
# to the __zl virtual location (#235), scope-aware so shadowed locals,
# writes, delete targets and shorthand keys stay untouched, with a
# parse-failure fallback that keeps the input unchanged and counts the
# failure in diagnostics; the bootstrap gains applyVloc (#236): a
# location-like view over the virtual path/query/hash (initScript
# vpath; the host stays opaque), pushState/replaceState re-anchoring
# through /__zl_prel__/ engine routes, popstate/hashchange sync, and
# assign/replace/reload/toString parity. Pathname-routed SPAs (Brave
# Ask's SvelteKit router) match their routes in-app instead of throwing
# Not found on the opaque engine pathname. sw.js 4102766dcac60856 ->
# 4e6e7a32ae284b67; bootstrap.js cf8b76ad53488959 -> 29bfb41d3b8e83ce
# (bootstrap budget raised 25600 -> 27648 in the Zeolite CI gate,
# measured 27117); rewriter_wasm_bg.wasm grows 114438 -> 663252 bytes
# (the oxc parser rides the wasm; scripts without a location token
# skip the pass - measured ~0.15 ms per 2 MB fast path, ~24 ms per 1
# MB parsed and renamed). Cargo-side pin stays b0296f8 (rewriter crate
# only; it is not a server dependency).
# Pin 79: Zeolite dist d934d4a. #236 regression fix: the virtual
# location anchored every re-anchored pushState/assign on the full
# native pathname captured at bootstrap, so a document loaded at a
# re-anchored <entry>/__zl_prel__/<encoded> URL nested the previous
# tail inside every new encoded tail and each SPA fallback reload
# doubled it (Brave Ask: 429 retry loops, then 414 Request-URI-Too-
# Long). entry strips its prel tail, the NAVH native-parse decodes a
# prel tail as the newer virtual state instead of reading it as site
# path, and decoded tails cut at an embedded marker so legacy
# history entries cannot re-seed the loop (Zeolite 385e55ef, CI run
# 620 green, 4 regression tests). sw.js 4e6e7a32ae284b67 unchanged;
# bootstrap.js 29bfb41d3b8e83ce -> 90af15190531c5df (27441 bytes,
# under the 27648 gate); Cargo-side pin stays b0296f8 (bootstrap-
# only change, so the /build zlswSha cannot distinguish this bump -
# verify the served /zlsw/bootstrap.js hash instead).
# Pin 80: Zeolite dist 47f0ab3. Bug-scout fix wave (Zeolite 8569bc71,
# CI run 623 green, vitest 1215): #239 vloc cross-origin slip -
# protocol-relative and whitespace-prefixed absolute URLs were
# re-anchored as own virtual paths instead of passing through
# natively; #240 the globals write-target peek now skips comments
# between the member and the assignment operator (a misrenamed
# write threw in strict mode); #241 inline event-handler
# attributes run the same #235 globals pass as script bodies;
# #242 a preceding ".delete" property tail no longer suppresses
# the rename. sw.js 4e6e7a32ae284b67 unchanged; bootstrap.js
# 90af15190531c5df -> 20dee634ae9c98c9 (27517 bytes, under the
# 27648 gate); rewriter_wasm_bg.wasm moves 663252 -> 1a5c2582
# (globals.rs + handler seam). Cargo-side pin stays b0296f8
# (rewriter crate is not a server dependency); sw.js is unchanged,
# so verify the served /zlsw/bootstrap.js hash instead.
# Pin 81: Zeolite dist a84c43f. #238: the Brave SERP reload
# storm. SvelteKit client start() compares document.URL with
# location.href and self-assigns location.href to resync (kit
# PR 11179, a basic-auth drop); the #235 pass renamed
# location.href reads to the virtual __zl.href but left
# document.URL native, so against the opaque navh route the
# compare never passed and start() re-navigated on every
# load (43 identical document loads in ~30s live, then Brave
# 429 + PoW interstitial). The globals pass now rewrites
# scope-resolved document.URL and document.documentURI reads
# (receiver 'document' only; window.URL is the URL
# constructor) to __zl.href, so both sides of the compare see
# the virtual URL and the check never fires (Zeolite 7c3f6c21,
# CI run 626 green, 144 rewriter tests incl. 2 new). sw.js
# 4e6e7a32ae284b67 unchanged; bootstrap.js 20dee634ae9c98c9
# unchanged; rewriter_wasm_bg.wasm moves 1a5c2582 ->
# 7acc3b508f693a5a (664473 bytes) - the ride is in the wasm,
# so the /build alarm pins cannot distinguish this bump;
# verify the served /zlsw/rewriter_wasm_bg.wasm hash instead.
# Cargo-side pin stays b0296f8 (rewriter crate is not a server
# dependency).
# Pin 82: Zeolite dist 9b6f7f8. Two engine waves since pin 81.
# #248 (google.com/ai reCAPTCHA solve loop): the post-solve
# re-navigation minted a prel-of-prel URL and decodeNavHandlePath
# leaked engine markers into the upstream path (Google's own 404),
# so Google re-challenged forever; the prel tail now peels to the
# deepest level (bounded 4) and vloc toVirtual decodes route-shaped
# inputs instead of re-wrapping them (Zeolite 1dd647a, bootstrap
# budget 27648 -> 28672 for the 27678-byte result).
# #243-#247: new app/src/lifecycle.ts draws the host/proxied client
# boundary structurally (host-only zl:tabsOp/zl:downloadOp/zl:notifyOp;
# tabs.sendMessage and zl:scripting only reach the client whose
# decoded destination matches, unmatched scripting is dropped),
# install holds the rewriter prewarm in waitUntil, the extension
# boot phases fail independently with EXTENSION diagnostics, and
# startUpdateChecks runs once per worker evaluation (Zeolite 530d9ab,
# CI run 630 all 5 jobs green, suite 1232). sw.js 4e6e7a32ae284b67
# -> d693a74c593bb725 (359381 bytes); bootstrap.js 20dee634ae9c98c9
# -> eced033e919dfb38; rewriter_wasm_bg.wasm unchanged
# 7acc3b508f693a5a. Cargo-side pin stays b0296f8 (SW-only fixes).
# Pin 83: Zeolite dist d63dd86. One engine wave since pin 82.
# #249 (UI loads but every engine request wedges to embedder
# timeout): the boot gates awaited unbounded promises, so a hung
# Cache Storage or IndexedDB open stalled routeReady/engineReady
# forever and no proxied request ever settled. lifecycle.ts now
# races every boot step with a 10s deadline (routeReady, the
# fetch-handler engine gate, the extension-route gate, the
# control-plane gate, the install prewarm, the extension boot
# phases), emits a SERVICE_WORKER "boot step wedged; continuing
# degraded" diag on expiry, and still propagates rejections
# (Zeolite a99f021, CI run 632 all 5 jobs green, suite 1236
# incl. 4 new bounded-boot tests). sw.js d693a74c593bb725 ->
# c19ce11c78efd751 (359826 bytes); bootstrap.js eced033e919dfb38
# unchanged; rewriter_wasm_bg.wasm unchanged 7acc3b508f693a5a.
# Cargo-side pin stays b0296f8 (SW-only fix).
# Pin 84: Zeolite dist d5a2a66. Two engine waves since pin 83.
# #258 (startpage.com fails its verification pass): the
# pass-challenge redirect repair rebuilt bare engine-origin
# Locations verbatim, so the Anubis PoW redirect left the
# frame virtual home and hit the SPA 404; the fix rebuilds
# such redirects against the frame virtual home origin and
# route path (Zeolite 20d2b85, CI run 633 all green, suite
# 1240 incl. 4 new challenge-redir tests).
# #259 (search.brave.com homepage logo 404): dotted-hash
# SvelteKit asset finals are now recoverable and the flat
# asset recovery tries 4 bases, so the page-minted
# virtual-origin asset recovers from the cdn.search.brave.com
# immutable base (Zeolite 1fbac2dc, CI run 634 all 5 jobs
# green, suite 1242 incl. 2 new assetbase tests). sw.js
# c19ce11c78efd751 -> 42dda133cb8d9a70 (359976 bytes);
# bootstrap.js eced033e919dfb38 unchanged. Cargo-side pin
# stays b0296f8 (SW-only fixes).
# Pin 85: Zeolite dist 65bdf61. One engine wave since pin 84, the
# 2026-10-18 small-issue wave (Zeolite 7fca90e on top of the #290
# deref fix, CI run 39117282705 all green, suite 1249):
# #291 mapRefreshHeader ends a quoted url= at its closing quote and
# an unquoted one at the next semicolon, #292 downloadFilename
# decodes RFC 6266 filename* ext-values with a plain-filename
# fallback, #293 the WS shims count pre-handshake queued sends in
# bufferedAmount (page + worker realms), #294 the page-realm mint
# memo is capped at 256 entries with LRU re-insert and eviction,
# #295 rewrite rules bind to the from-host boundary. sw.js
# 42dda133cb8d9a70 -> d29b017afeef63eb (360334 bytes);
# bootstrap.js eced033e919dfb38 -> e890e6083be75719. Cargo-side
# pin stays b0296f8 (SW-only fixes).
# Pin 86: Zeolite dist bee555f. One engine wave since pin 85, the
# 2026-10-18 fix-wave completion (Zeolite a43aeb10 on top of the
# agent commits 514471f8, 79b3377a, 4aeb5e3e and the d8126d64
# tabs.ts splice repair, CI run 39124338300 all 5 jobs green,
# suite 1273): #270 32-bit fnv1a site hash with jar origin
# migration, #289 durable-jar-only origins records, #262/#263/
# #264 honest IndexedDB/cmp/caches.match shims, #265 siteconfig
# key normalization, #272 webRequest listener detail copies,
# #282 live webRequest permission views, #271 tabs.onUpdated
# changeInfo gating (an empty gated changeInfo is not delivered),
# #278 host-visible filtered tab queries, #283 tab op deadlines
# with closed-tab rejection, #286 query title globs, #281
# cookies.onChanged scoping with revoke-on-delivery, #285
# content-script asset validation, #276 credentials-gated
# cookie jar, #288 permission-correct webRequest URLs. sw.js
# d29b017afeef63eb -> 3a6e775447488fe4 (362658 bytes);
# bootstrap.js e890e6083be75719 -> 1e55ec0f04f848b9 (27962
# bytes). Cargo-side pin stays b0296f8 (SW-only fixes; the
# rewriter crate is not a server dep).
# Pin 87: Zeolite dist 13d9b85. One engine wave since pin 86:
# #297 (extensions appeared installed but never ran in the
# host-embedded browsing pane): every proxied document arrives
# with sec-fetch-dest iframe and csInjectUrls treated any
# iframe/object destination as a genuine subframe, so
# resolveContentScripts dropped every non-all_frames content
# script - and with content scripts dead, MV3 backgrounds
# never boot on demand, so extension service workers never
# initialized. A frame whose parent referrer is a host page
# (neither a NAVH nor an engine route) is now the pane main
# surface for content-script matching; genuine subframes of
# proxied documents keep subframe semantics; absent, about:,
# or unparseable parents fail closed (Zeolite 9d33b44 on
# 1ae6cdc, CI run 39129225053 all 5 jobs green, suite 1278
# incl. 5 new cs-inject tests). sw.js 3a6e775447488fe4 ->
# 8ef1ef7239120397 (362825 bytes); bootstrap.js
# 1e55ec0f04f848b9 unchanged. Cargo-side pin stays b0296f8
# (SW-only fix).
# Pin 88: Zeolite dist 7e29d525. Two engine waves since pin 87.
# #250 the control-plane messageListener (control.ts/sw.ts) keeps
# the message event alive for the whole handler (waitUntil) and a
# failed dispatch answers a structured {ok:false,error:"control
# handler failed"} reply with a RUNTIME diag instead of an unhandled
# rejection; #252 engine init() resolves only on ack.ok===true,
# setSiteRoute persists only after the worker acks, post() settles
# exactly once (settled flag, timeout cleared, port closed);
# #253 docCookiePorts are capped at 16 per client with shift+close
# eviction (Zeolite ce9eb6b, CI runs 39132519199 + 39133625103 all
# 5 jobs green, suite 1288 incl. +10 tests).
# #266 the storage-event isolation filter recognizes object-style
# listeners ({handleEvent}) too, keyed by the raw listener so
# removeEventListener finds both shapes; #261 the cooldown relay
# branch carries its own first-byte deadline: an embedder that never
# answers aborts with zl:relayCancel (WispStallError) instead of
# hanging, and caller aborts stay honest AbortErrors (Zeolite
# 1a70811, suite 1291 incl. +3 tests). sw.js 8ef1ef7239120397 ->
# 49896d2b07867e9f (363469 bytes); bootstrap.js 1e55ec0f04f848b9 ->
# d00b5e4270b011f1 (28080 bytes). Cargo-side pin stays b0296f8
# (SW-only fixes).
# Pin 89: Zeolite dist 9eee560. One engine wave since pin 88, the
# bootstrap compat wave (Zeolite a3406c0 on main 6cd18b6, CI run
# 39137417144 all 5 jobs green, suite 1297 incl. 6 new tests):
# #268 the vorigin relabel/remove pass recognizes object-style
# (EventListener {handleEvent}) listeners, not just functions;
# #269 ScopedChannel subclasses the real BroadcastChannel
# constructor with its own name getter; #273 the scoped storage
# store is a Proxy over the backing store (named-property
# forwarding, key(i) strips the site prefix); #274 EventSource
# registrations dedupe with native-bound removeEventListener,
# once-drop and AbortSignal support; #275 ZlWorker/ZlSharedWorker
# constructors enforce new-only semantics; #284 relay listeners
# filter object-style listeners through a wrapper registry so
# removeEventListener finds the real listener shape.
# bootstrap.js d00b5e4270b011f1 -> 8c7520cbfad8035d (29383 of
# the 29696 budget, raised 28672 -> 29696 in the Zeolite CI gate);
# sw.js unchanged 49896d2b07867e9f (bootstrap-only wave, so the
# /build zlswSha cannot distinguish this bump - verify the served
# /zlsw/bootstrap.js hash instead). Cargo-side pin stays b0296f8
# (bootstrap-only change).
# Pin 90: Zeolite dist 3826f41. Two engine waves since pin 89, the
# 2026-10-18 bug-hunt fix wave.
# #314 (range serving OOM): a single Range request against a cached
# entry buffered the whole body with arrayBuffer() before deciding
# the range lay outside it, so a byte-range probe on a huge cached
# document could balloon the worker. The range path now prechecks
# the cached content-length against ZL_RANGE_MAX and refuses the
# range before buffering (Zeolite 54053ce, CI run 39139691546 all
# 5 jobs green, suite 1300 incl. 3 new range tests). sw.js
# 49896d2b07867e9f -> e20a18398c4d25a8 (363561 bytes);
# bootstrap.js unchanged 8c7520cbfad8035d.
# #322 (blocked-element swallow unbounded): drop_raw swallowed raw
# text until the close tag, so a blocked script with no close tag
# buffered the rest of the document without bound. The swallow
# buffer is capped at 256 KiB and keeps only the longest suffix
# that is a prefix of the close marker, so no close tag can be
# missed (Zeolite 0213393, CI run 39141278968, cargo suite incl. 2
# new bounded-drop_raw tests). Rust-only: sw.js and bootstrap.js
# unchanged (e20a18398c4d25a8 / 8c7520cbfad8035d); the ride is in
# rewriter_wasm_bg.wasm (7908d03c7920f8a7), so the alarm pins
# cannot distinguish this bump - verify the served
# /zlsw/rewriter_wasm_bg.wasm hash instead. Cargo-side pin stays
# b0296f8 (the rewriter crate is not a server dep).
# Pin 101: Zeolite dist 15a049461aca31f1862e3f791990cfc5f18d72eb
# (from CI build 39574090321, Zeolite main 45ed5449, all 5 jobs
# green, app suite 1404 tests). Pin 101 carries the 2026-10-21
# Zeolite fix wave: #385 expired navigation handles re-mint on
# GET navigations (Zeolite 22c0755); #383 prel parents always
# reach the handle form (a non-NAVH parent now mints a fresh
# NAVH handle for the decoded destination too, instead of
# parking the document on the opaque prel pathname); #382 the
# 60s relay header deadline breach resolves null and emits a
# TRANSPORT DIAG row so the caller falls back instead of
# wedging (undeclared long-polls beyond 60s stay an honest
# residual); #381 Ghostery list fetches ride the full
# upstreamFetch transport decision (relay routing works on
# relay-only deployments) and load failures emit TRANSPORT
# DIAG rows (no longer silent). sw.js 4326069120ccb9dc ->
# c7cb3102e12f9e57 (625725 bytes); bootstrap.js e15f38fb1b1557e2
# unchanged (30381 bytes); rewriter_wasm_bg.wasm unchanged.
# Cargo-side pin stays a385fa9.
# Pin 112: Zeolite dist b7c924e5a6bb658d92922a541fbcb03a3870d534
# (from CI build 39847696942, Zeolite main c981e19a, all 5 jobs
# green, app suite 1459 tests). Pin 112 ships the Injector
# phase 2 follow-up: the in-page NAVH mint (navhCleanFromPrel,
# the prel-navigation clean 302) honors queryRoutes - with the
# toggle on, the redirected handle rides the query shape
# (<real path>?<real query>&zlNavh=<token>), so a reloaded
# document owns a natively readable location.pathname; engine-
# internal path collisions and missing route keys fall back to
# the NAVH path form (#383 fail-closed intact). sw.js
# 3b94ab518397c471 -> c6debef338723924 (629684 bytes);
# bootstrap.js unchanged c7300fa9981e71b4. Cargo-side pin
# stays a385fa9 (SW-only change).
# Pin 111: Zeolite dist 98e24bc4ec1e13562b876ab7f852507f130686a7
# (from CI build 39812893153, Zeolite main e293ecc5, all 5 jobs
# green, app suite 1456 tests). Pin 111 ships the split-origin
# URL-bar strand: decodeLegacyRoute validates the whole legacy
# /zl/<b64u> shape (two segments, the configured prefix or the
# reserved zl segment, a strict-UTF-8 http(s) b64u payload,
# never a keyed tail) and wins at the escape seam ahead of the
# settled-context recovery, so a URL-bar navigation to a legacy
# route minted under the other origin decodes to its real
# destination instead of a guaranteed upstream 404 resolved
# against the previous page's virtual origin; genuine escaped
# relative paths and undecodable tails keep the ordinary
# recovery order. Cargo-side pin stays a385fa9.
# Pin 110: Zeolite dist 35f36ab14aeeef3dc8720bdeb6a30748e9ee1ff8
# (from CI build 39788565776, Zeolite main f9881a4f, all 5 jobs
# green, app suite 1454 tests). Pin 110 ships Injector phase 2:
# query-shape committed routes behind the queryRoutes opt-in
# (default OFF, no live traffic change). zl:navHandle mints
# <real path>?<real query>&zlNavh=<token> when the host opts in
# via zl:config, so the committed pathname IS the real
# destination path and native location.pathname reads work
# without a shim; decodeClientUrl decodes the shape at the
# shared client seam, handleFetch serves live tokens, re-mints
# expired GET navigations (#385 mirror) and fails garbage
# closed; the sender gate classifies query-shape senders as
# proxied (never host, even at "/" or "/index.html"); vloc
# parses the native form and re-commits real paths natively
# keeping the token (history virtualization). Engine-internal
# path collisions refuse the mint and fall back to the NAVH
# form. sw.js 32303e296200b7db -> 8390cea8526d542a (629360
# bytes); bootstrap.js 7dfd6645656bab22 -> c7300fa9981e71b4
# (35113 bytes). Cargo-side pin stays a385fa9.
# Pin 109: Zeolite dist 429b185188404f5373c500be906a2fe5d8fd3f5e
# (from CI build 39770557101, Zeolite main d778ba0e, all 5 jobs
# green, app suite 1441 tests). Pin 109 ships the 2026-10-22 scout
# wave, Zeolite #392-#400: the antiframe sink scan emits a verbatim
# method call instead of a bare ?.reload?. reference (#392),
# comparison folding refuses member-chain operands (#396), a quote
# inside a regex literal no longer opens a fake string (#398), an
# uppercase </SCRIPT> ends the script block (#397), an expired NAVH
# parent still resolves its prel tail (#393), an expired token head
# resolves its tail against the context origin instead of doubling
# the page path (#395), a storage failure answers null instead of []
# so route keys never strand (#399), a relay stall feeds the storm
# detector (#400), and the jar profile state persists in the Cache
# API across idle worker restarts (#394). sw.js af5fd80829884d7b ->
# 32303e296200b7db (628200 bytes); bootstrap.js 7dfd6645656bab22
# unchanged (34628 bytes). Cargo-side pin stays a385fa9.
# Pin 108: Zeolite dist a7e663ae132c89dca2d04324307fc14b87404d31
# (from CI build 39753906400, Zeolite main 88cbc94a, all 5 jobs
# green, app suite 1436 tests). Pin 108 ships the idle-restart
# family, Zeolite #389/#390/#391: undecodable legacy-shaped routes
# answer an engine 404 instead of the origin 503 (#389), the
# transport engine choice persists in the Cache API across idle
# worker restarts so the UI and the worker agree again (#390), and
# the worker broadcasts zl:relayLost at every cold start so the
# relay re-arms in seconds instead of the 30s backoff cycle (#391;
# live pre-fix recovery was 33.9s). sw.js 71d0bd6f016437e7 ->
# af5fd80829884d7b (627231 bytes); bootstrap.js 7dfd6645656bab22
# unchanged (34628 bytes). Cargo-side pin stays a385fa9.
# Pin 107: Zeolite dist 3263e6e423b7cfabb811b3e86a2a00ec15aaa565
# (from CI build 39738165242, Zeolite main d58131c3, all 5 jobs
# green, app suite 1427 tests). Pin 107 ships the location
# member-write fix, LB #182: the rewriter renames the object
# of member writes (location.hash = x becomes __zl.hash = x),
# but the vloc view exposed getters with no setters, so
# hash-routed SPA writes were silently lost (sloppy) or
# threw (strict). The view now carries setters: hash mirrors
# natively plus a synchronous cur update, search/pathname
# rebuild the virtual URL preserving the other components
# and navigate.
# sw.js 71d0bd6f016437e7 unchanged (626483 bytes);
# bootstrap.js 20589f579aa89383 -> 7dfd6645656bab22
# (34628 bytes; the CI bootstrap size budget rose
# 34304 -> 34816). Cargo-side pin stays a385fa9.
# Pin 106: Zeolite dist ce1e64c606f4dd9e9a707b9b4b1270cdb16faaef
# (from CI build 39732131533, Zeolite main 4c73252e, all 5 jobs
# green, app suite 1423 tests). Pin 106 fixes the two audit
# findings on the pin-105 anchor shim, Zeolite #387/#388: the
# scan collected only the first 2*64 route values from the
# document head on every pass and never paged, so deep anchors
# on large pages kept native route reads (collection now skips
# memoized and inflight values, and a capped decode reply
# schedules the next scan, converging across many-anchor pages),
# and SVG anchors expose href as an SVGAnimatedString whose
# baseVal read bypassed the navguard property seam
# (SVGAElement.prototype.href now wraps with a virtual view on
# a memo hit, writes forward natively; the AREA half of #388 was
# wrong, the navguard swap row already covers HTMLAreaElement).
# sw.js 71d0bd6f016437e7 unchanged (626483 bytes); bootstrap.js
# 509c8042d96c8ba7 -> 20589f579aa89383 (34294 bytes; the CI
# bootstrap size budget rose 33792 -> 34304).
# Cargo-side pin stays a385fa9.
# Pin 105: Zeolite dist 17c5165fa30b1d05e7fac5f1035093434c527b6f
# (from CI build 39677692896, Zeolite main 34737bc0, all 5 jobs
# green, app suite 1420 tests). Pin 105 ships Injector phase 1,
# the anchor read virtualization fixing LB #180: parser-inserted
# anchors read back as engine route URLs, and Startpage derives
# its SERP breadcrumb from the anchor href, so the opaque
# content-origin /j/<token> route leaked into the visible display
# text. The new bootstrap/anchorshim.ts memoizes route ->
# virtual destination and serves the nav guard's swap-row
# property getter plus an Element.getAttribute wrap, asking the
# worker to decode the page's own markup routes over the new
# zl:decodeRoutes control message (PAGE_MESSAGES admission like
# zl:mint, bounded 64 routes per message; garbage and foreign
# tokens decode to null). Honest limits: the first read before
# the decode reply lands returns the native route value;
# detached anchors never join a scan. sw.js 96b27c209b7f596e ->
# 71d0bd6f016437e7 (626483 bytes); bootstrap.js
# 37460e146d217cb7 -> 509c8042d96c8ba7 (33782 bytes; the CI
# bootstrap size budget rose 31744 -> 33792 for the shim).
# Cargo-side pin stays a385fa9.
# Pin 104: Zeolite dist 397bce562c0f18ec0a916b00c7a149548a99f6e6
# (from CI build 39656714434, Zeolite main fb845658, all 5 jobs
# green, app suite 1415 tests). Pin 104 fixes LB #154: the
# Google gapi loader sanity-validates generated module URLs
# against an apis.google.com literal and threw before any fetch
# because the JS literal pass rewrites the "https://apis.google.com"
# literal into an opaque route token. The shipped gapi-native
# policy rule (route "native", types script, host apis.google.com)
# demotes the literal pass for that host, and the new
# transportMatch() composes behavior rules with transport rules
# so the load still rides the embedder relay (default-relay)
# instead of falling through to the dead wisp transport; engine
# issue #34 keeps every cross-origin fetch from controlled pages
# inside the engine, so nothing leaks direct. sw.js
# ce02ad5c6c73bd90 -> 96b27c209b7f596e (626218 bytes);
# bootstrap.js unchanged 37460e146d217cb7. Cargo-side pin
# stays a385fa9.
# Pin 103: Zeolite dist ec7fd8fe27d7b10ffd7349e5a238cb1fd72bebc9
# (from CI build 39636675089, Zeolite main 2b1633b, all 5 jobs
# green, app suite 1411 tests). Pin 103 fixes the two roots of
# the #107 phase 2 live gap: the fail-closed host gate (#170)
# classified the /zlsw-register boot page as a proxied sender
# and silently refused its host-only zl:relayRegister /
# zl:wispRegister / zl:embedderOrigin registrations, so the
# content-origin relay never opened and content loads rode the
# wisp transport instead; decodeClientUrl now falls back to
# decodeLegacyRoute so /zl/<b64u> clients decode on a
# prefix-less (default /j/) worker. sw.js
# 628614de5754a91f -> ce02ad5c6c73bd90 (626093 bytes);
# bootstrap.js unchanged 37460e146d217cb7 (31406 bytes).
# Cargo-side pin stays a385fa9.
# Pin 102: Zeolite dist dc16a50c8e95cdc59a0460fd4ba5431861fb7bcc
# (from CI build 39628337530, Zeolite main 0c809c2, all 5 jobs
# green, app suite 1410 tests). Pin 102 carries the #107 phase 2
# embedder URL/title sync: zl:getEmbedder (page-facing, in
# PAGE_MESSAGES) answers an embedded frame with the registered
# embedder origin plus THIS client's own SW-decoded virtual URL;
# zl:embedderOrigin (host-only, the boot page's zlRegAsk
# handshake) registers the embedder origin; the bootstrap gained
# the embedsync module (posts {lb:"nav",url,title} to the parent
# on load, vloc moves and title mutations) and the vloc
# onVlocChange hook at its real-path choke points; the bootstrap
# size gate rose 30400 -> 31744 for it. sw.js
# c7cb3102e12f9e57 -> 628614de5754a91f (626076 bytes);
# bootstrap.js e15f38fb1b1557e2 -> 37460e146d217cb7 (31406
# bytes). Cargo-side pin stays a385fa9.
# Pin 100 (re-pointed to carry ALL fixes): Zeolite dist 12d9f83c
# (from CI build 39487725296, Zeolite main fb6f8fa0, all 5 jobs
# green; bootstrap budget 30381/30400). Pin 100 first shipped
# ARG 812cfd7 (Zeolite 15f8364: the fetch handler pre-deadline
# browser-API awaits - clients.get in the jar root recovery and
# the foreign/initiator lookups, caches.delete in the legacy
# page cache discard, caches.open/match in pageCacheMatch - ride
# raceBoot bounded at 1.5s; a never-settling call wedged the
# navigation and parked the tab on an empty grey root, LB #167;
# regression boot-wedge.test.ts). After the three open Zeolite
# PRs merged, pin 100 was re-pointed so it is the one with all
# fixes: PR #367 (5xx retry memoization for policy.ts/rules.ts
# loads, 60s relay header deadline in relayfetch.ts, cookieStore
# delete isolation; bootstrap.js 9d1cb1fba82b9ba8 ->
# e15f38fb1b1557e2, 30381 bytes), PR #380 (runtime primary WISP
# endpoint zl:wispPrimary + CORE_CONTROL_TYPES registry label;
# the engine half of LB #165), PR #363 (Ghostery network filter
# engine: ghostery.ts matcher, rules.ts GhosteryRedirect
# redirect support, request.ts redirect wiring, sw.ts transport
# config; @ghostery/adblocker-web 2.20.1, MPL-2.0; list fetches
# ride the raw wisp transport by design, so on relay-only
# deployments remote filter lists never load and local rules
# stay active). sw.js 828ad258ba730e20 -> 4326069120ccb9dc
# (624690 bytes, the Ghostery engine rides in sw.js);
# rewriter_wasm_bg.wasm 38adf0597150389a unchanged. Cargo-side
# pin stays a385fa9.
# Pin 99: Zeolite dist c3a1d78 (from CI build 39460354394,
# Zeolite main 2b8c802, all 5 jobs green, app suite 1389 tests).
# Correction and completion of pin 98: the pin-98 ARG pinned
# 7d855ef, which is not a commit on the Zeolite dist branch
# (the Render build 404ed on the tarball fetch; no service ever
# went live on it). Pin 99 carries both engine fixes: (1) the
# pin-98 payload, script src split routes (Zeolite 1297742:
# script src/href under the keyed codec mints a path-preserving
# route so loaders validating their own script URL PATH pass,
# the YouTube ytembeds "writeEmbed is not defined" class);
# (2) prel navigation redirect (Zeolite 2b8c802: a GET
# navigation arriving on a __zl_prel__ tail under a NAVH parent
# answers one same-origin 302 to the visible handle form,
# token + real path + real query, so the reloaded document owns
# a readable location.search - the Google SERP/AI-overview sei
# reload parked on the opaque prel pathname and re-triggered,
# the #290 class). sw.js 63f678ad6fb2b335 -> cae2519a33479628
# (376066 bytes); bootstrap.js 9d1cb1fba82b9ba8 unchanged;
# rewriter_wasm_bg.wasm 51a9435ac25eac23 -> 38adf0597150389a
# (the split-route rewriter ride). Cargo-side pin stays a385fa9.
# Pin 98: Zeolite dist 7d855ef (from CI build 39424088091,
# Zeolite main 1297742, all 5 jobs green, app suite 1383 tests).
# Script src split routes: script src/href attributes under the
# keyed codec mint a path-preserving route (origin + /zl/ +
# keyed origin-only token + the real path), decoded at the SW
# fetch seams with the existing recoverPath, so loaders that
# validate their own script URL PATH pass again (YouTube
# ytembeds Oe wants "/_/js/" + "/k=": the opaque token broke
# it, "writeEmbed is not defined" and Error: O on every
# YouTube embed; the #296 src-surgery class). Long tails
# (capped 2000 chars), query-only and bare-origin srcs keep
# the opaque route. sw.js 63f678ad6fb2b335 -> 81253c4706ca2dae
# (373551 bytes); bootstrap.js 9d1cb1fba82b9ba8 unchanged.
# Cargo-side pin stays a385fa9 (rewriter + SW-side only).
# Pin 97: Zeolite dist d78bb5a (from CI build 39413168260,
# Zeolite main 1074e6d, all 5 jobs green, app suite 1382 tests).
# Recovery-transport wave: flag-surgery and flat-asset recovery
# candidates ride the full upstreamFetch transport decision (the
# raw wispTransport.fetch lambda died on relay-only embedders with
# a wisp error-7 fan-out, the 2026-10-20 sorry-page report),
# rejected candidate bodies are cancelled before the next base is
# tried, and a flag-surgery recovery miss emits a per-bail reason
# DIAG warning (#290 residual, #347 class, #296 visibility).
# sw.js 5a88a06a57303672 -> 63f678ad6fb2b335 (373499 bytes);
# bootstrap.js 9d1cb1fba82b9ba8 unchanged. Cargo-side pin stays
# a385fa9 (SW-only wave; Zeolite #379 closed as honest upstream:
# products/index.rss is a real upstream 404, and async/hpba is a
# sync XHR Chrome never routes through the SW).
# Pin 96: Zeolite dist 81b3474 (from CI build 39392562420,
# Zeolite main b2c21c3, all 5 jobs green, app suite 1377
# tests). The 2026-10-20 scout wave: rewriter-side #368
# comment-aware frame-buster folding, #369 non-executable
# script bodies pass through, #370 chained cross-frame
# sinks (riding rewriter_wasm_bg.wasm; verify the served
# wasm hash for those three), and the bootstrap/SW series
# #364 ws:// shim SyntaxError, #371 srcdoc script bodies,
# #372 window.open noopener mint, #373 backslash-form
# URLs, #374 EventSource stringify, #375 postMessage
# transfer list, #376 cache refresh redirect hop gates,
# #377 page-cache clear on fingerprint/UA change
# (bootstrap budget 30400). sw.js 6975a139819b198b ->
# 5a88a06a57303672 (372972 bytes); bootstrap.js
# eb91c2a989aa89f0 -> 9d1cb1fba82b9ba8 (30349 bytes).
# Cargo-side pin stays a385fa9 (the wave does not touch
# zeolite-server).
# Pin 95: Zeolite dist de70643 (from CI build 39377475538,
# Zeolite main 7e95110, all 5 jobs green, app suite 1359
# tests). One engine-side change since pin 94, SW-side: the
# #256 build-time static plugin registry (7e95110: the
# registry generates plugins-static.mjs at build time so the
# service worker resolves plugin modules from a static
# origin-local map instead of dynamic import; inert until a
# plugin is requested; e2e plugin suite 5/5 on the local
# toolchain). sw.js 9b924b1e1e5a4d42 -> 6975a139819b198b
# (372152 bytes); bootstrap.js unchanged eb91c2a989aa89f0
# (29649 bytes). Cargo-side pin stays a385fa9 (no
# zeolite-server changes since pin 92).
# Pin 94: Zeolite dist ac68e9c (from CI build 39316637933,
# Zeolite main 525e4de, all 5 jobs green, app suite 1354+
# tests). Four engine-side changes since pin 93, all SW-side
# or rewriter-side: the #331 rewriter location renames for
# computed member reads and optional chains (Zeolite 76354a1;
# the ride is in rewriter_wasm_bg.wasm), the #290 keyed-route
# diagnostics fix (21bca01: request.ts diag entries name the
# requesting page and url), the #359 bound script recovery
# with honest unavailable-plugin reporting (PR #360,
# ded2ef2; partial for #256, the static plugin loader stays
# open), and the #361 client-lineage cookie jar binding
# (PR #362, 525e4de: jar profiles key on the host-window
# lineage so incognito and normal windows stop clobbering
# each other's profiles - the Zeolite half of LB #109; the
# LB two-window regression still needs a live deploy).
# sw.js 7db69875af0b35a8 -> 9b924b1e1e5a4d42 (371639
# bytes); bootstrap.js 790c52c7c4beb41c -> eb91c2a989aa89f0
# (29649 bytes). Cargo-side pin stays a385fa9 (no
# zeolite-server changes since pin 92).
# Pin 93: Zeolite dist 6727cba (from CI build 39166714671,
# Zeolite main a6d37ed, all 5 jobs green, suite 1318 incl. 5 new
# tests). Three engine-side changes since pin 92: the Vary
# honor fix #346 (Zeolite PR #355, conservative form: any
# non-empty Vary makes a response non-storable, so the URL-only
# cache key can never serve a variant; the roadmap docs #353
# ride along, docs-only), the relay re-registration fix #354
# (Zeolite 7292e71: a relay-routed fetch that finds no channel
# broadcasts zl:relayLost to window clients and waits once,
# bounded 3s with a 30s backoff; the LB App.tsx listener
# re-registers at once - fixes the fast.com/chatgpt.com SSL
# error 35 class after an idle SW restart, LB #156), and the
# SharedWorker identity scoping fix #260 (Zeolite a6d37ed: the
# ctor folds the opaque site token into the worker name, both
# arg forms, so two virtual sites on the one engine origin
# never share a worker context). sw.js 248fc6aea789e2f2 ->
# 7db69875af0b35a8 (366753 bytes); bootstrap.js
# 8c7520cbfad8035d -> 790c52c7c4beb41c (29462 bytes).
# Cargo-side pin stays a385fa9 (all fixes SW-side).
# Pin 92: Zeolite dist 7b9593f (from CI build 39162909529). Two
# waves plus a fix since pin 91: the 2026-10-18 rewriter wave
# (Zeolite e4f997f on main: #345/#342/#339; the ride is in
# rewriter_wasm_bg.wasm 7908d03c7920f8a7 -> fc58b70eee7ab936b,
# so the alarm pins cannot distinguish it - verify the served
# wasm hash instead), the 2026-10-18 server wave (Zeolite
# a515b17 on main: #343/#350/#351/#352/#340; server-side only,
# not in the dist bundle - it ships via the Cargo-side rev bump
# below), and the app fix #296 flag-surgery script URL recovery
# (Zeolite a385fa9 on main, CI run 39162909529 all 5 jobs green,
# suite 1313 incl. 4 new tests; fixes the Google
# /sorry/httpd=1/... script 404 class that broke search results
# and the AI overview). sw.js 54e173c073e5de4b ->
# 248fc6aea789e2f2 (366108 bytes); bootstrap.js unchanged
# 8c7520cbfad8035d. Cargo-side pin b0296f8 -> a385fa9 (first
# server-dep bump since pin 76; ships the 2026-10-18 server wave
# a515b17 with the regenerated server/Cargo.lock).
# Pin 91: Zeolite dist 9927bd7. One engine wave since pin 90, the
# 2026-10-18 app security wave (Zeolite 60b9404a on main, CI run
# 39142882453 all 5 jobs green, suite 1309 incl. 9 new tests):
# #337 document.cookie cannot overwrite or delete an HttpOnly
# cookie, #338 the x-zl-cached-at / x-zl-final-url internal view
# headers are stripped from served cache copies, #341 an If-Range
# validator mismatch serves the full body instead of a range
# slice, #344 WEBNAV.domContentLoaded fires from the
# sender-derived dest, #349 cookie names and values reject
# control characters at jar admission, #336 the compat doc
# discloses the zl:ext one-world limit (the page-visible bridge
# cfg URL makes per-token scoping impossible). sw.js
# e20a18398c4d25a8 -> 54e173c073e5de4b (364388 bytes);
# bootstrap.js unchanged 8c7520cbfad8035d; wasm unchanged
# 7908d03c7920f8a7. Cargo-side pin stays b0296f8 (SW-only
# fixes).
# Pin 113: Zeolite dist 07bb4ce0a48650b7e72c8043557efc1fd5af48fd
# (from CI build 39856666415, Zeolite main f8ea0553, all 5 jobs
# green, app suite 1464 tests). Pin 113 ships COEP embedder
# parity: the engine worker rebuilds every default/cors Response
# with cross-origin-resource-policy: cross-origin at the
# respondWith seam (app/src/corp.ts withCorp; status, headers
# and body preserved, opaque and error responses pass through
# untouched), so a COEP require-corp embedder (Quartz and any
# crossOriginIsolation shell) can embed the /zlsw-register boot
# page and /zl/ content instead of ERR_BLOCKED_BY_RESPONSE. The
# server half ships in the same wave (main.rs with_corp layer).
# sw.js c6debef338723924 -> 0a62d321a5b09828 (630095 bytes);
# bootstrap.js unchanged c7300fa9981e71b4 (35113 bytes); wasm
# unchanged. Cargo-side pin stays a385fa9.
# Pin 114: Zeolite dist 0497c201beadb7ccbb0dc5bc984eecc6b2eb165c
# (from CI build 39919675076, Zeolite main 0b72b3f8, all 5 jobs
# green, app suite 1469 tests). Pin 114 ships the query-handle
# slash contract + vloc query-arm route-shape gate, Zeolite
# #410/#411: buildQueryHandleUrl percent-escapes a surplus
# leading-slash run in the committed query-shape path (a
# handle opening // resolves protocol-relative on host
# assignment) with decodeQueryHandle and the expired-handle
# re-mint restoring it (#202 parity with the NAVH form); the
# vloc presence-only query arm never wins on a route-shaped
# pathname, so a NAVH page whose real destination query
# carries a zlNavh impostor reads the real path instead of
# the opaque handle (#180 leak class), and the query-mode
# re-commit keeps the escaped form. sw.js 0a62d321a5b09828 ->
# 559dd986814b1a53 (630107 bytes); bootstrap.js c7300fa9981e71b4
# -> 66d387dbf16ee2c3 (35288 bytes, CI ceiling 35328). Cargo-side
# pin stays a385fa9 (SW-only change).
# Pin 115: Zeolite dist bdbce2d77c15651424ef64648ce6664e6af4125c (from CI build
# 39947197172, Zeolite main 8882da6, all 5 jobs green, app
# suite 1470 tests). Pin 115 ships the always-on Injector:
# queryRoutes defaults to true at module eval (swstate.ts), so
# query-shape committed routes are the default route shape; a
# host zl:config remains the runtime opt-out. sw.js
# 559dd986814b1a53 -> 378e4396918d9393 (630107 bytes);
# bootstrap.js unchanged 66d387dbf16ee2c3. Cargo-side pin
# stays a385fa9 (SW-only change).
# Pin 116: Zeolite dist 75b2196efbcbd37c7284971fdd8be5380afb23a9 (from CI build
# 39988823338, Zeolite main 7b957af3, all 5 jobs green, app
# suite 1471 tests). Pin 116 ships Zeolite #412/#413: a
# window.open popup opens the key-free marker route
# /__zl_nav__/<b64u> directly (no minted keyed token: a fresh
# tab with no installed worker can still decode the
# destination instead of the engine-offline notice), and lazy
# images default to true at module eval, so the
# loading="lazy" rewrite pass survives worker restarts (a
# host zl:config stays the runtime opt-out). sw.js
# 378e4396918d9393 -> 9d7a233a5f2a00c6 (630107 bytes);
# bootstrap.js 66d387dbf16ee2c3 -> 9a2224f65bff6141 (35111
# bytes, CI ceiling 35328). Cargo-side pin stays a385fa9
# (SW-only change).
# Pin 117: Zeolite dist 7b1a4eed52b4d31cdc054486acb8207826a54c3a (from CI
# build 40007080132, Zeolite main 5e6b87d8, all 5 jobs green, app suite
# 1473 tests). Pin 117 ships the Google /zl/ 404 fix: a query-shape
# route whose pathname is engine-route-shaped (a keyed zlNavh token
# copied by page JS) is no longer decoded as a control-plane
# destination (queryHandlePathShaped gates decodeQueryHandle and the
# expired re-mint arm), and the zl:ping reply echoes imageLazy so the
# debug menu readout matches the worker state. sw.js
# 9d7a233a5f2a00c6 -> c3e4e7f4c1e41e0c (630146 bytes); bootstrap.js
# unchanged 9a2224f65bff6141 (35111 bytes). Cargo-side pin stays
# a385fa9 (SW-only change).
# Pin 118: Zeolite dist 535d045d612f1d46f82c738caac45c5382ea91c6 (from CI
# build 40027192164, Zeolite main 6b2f7ac, all 5 jobs green; the app
# suite gained the ogs-origin regression file). Pin 118 ships Zeolite
# #420: the Google apps widget (ogs.google.com /widget/) embeds the
# engine origin in its percent-encoded origin= query param, so the
# widget frame never matched the page and the 9-dot products menu
# stayed empty; the fetch seam now virtualizes that origin= to the
# page origin at the same seam as the #112 reCAPTCHA co= fix
# (fail-closed without a usable referrer). sw.js
# c3e4e7f4c1e41e0c -> 13b00d3970710c96 (630808 bytes); bootstrap.js
# unchanged 9a2224f65bff6141 (35111 bytes). Cargo-side pin stays
# a385fa9 (SW-only change).
ARG ZEOLITE_COMMIT=535d045d612f1d46f82c738caac45c5382ea91c6
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

# ScramJet engine bundle (upstream MercuryWorkshop, the newest
# published build), vendored with the same never-committed rule as
# the Zeolite bundle and served same-origin at /sj/. Pin:
# scramjet 2.0.67-alpha.2 + controller 0.0.14 + utils 0.0.3 +
# libcurl-transport 2.0.5 (the same libcurl pin the zl-builder
# vendors). The controller worker scope is /sj/ (default from the
# script path), so it never competes with the Zeolite root worker.
# Bump these pins together with SCRAMJET_VERSION in the final stage.
FROM node:22-slim AS sj-builder
RUN npm install --prefix /sjvendor --no-audit --no-fund \
      @mercuryworkshop/scramjet@2.0.67-alpha.2 \
      @mercuryworkshop/scramjet-controller@0.0.14 \
      @mercuryworkshop/scramjet-utils@0.0.3 \
      @mercuryworkshop/libcurl-transport@2.0.5 \
 && mkdir -p /sj \
 && cp /sjvendor/node_modules/@mercuryworkshop/scramjet/dist/scramjet.js /sj/scramjet.js \
 && cp /sjvendor/node_modules/@mercuryworkshop/scramjet/dist/scramjet.wasm /sj/scramjet.wasm \
 && cp /sjvendor/node_modules/@mercuryworkshop/scramjet-controller/dist/controller.api.js /sj/controller.api.js \
 && cp /sjvendor/node_modules/@mercuryworkshop/scramjet-controller/dist/controller.inject.js /sj/controller.inject.js \
 && cp /sjvendor/node_modules/@mercuryworkshop/scramjet-controller/dist/controller.sw.js /sj/controller.sw.js \
 && cp /sjvendor/node_modules/@mercuryworkshop/scramjet-utils/dist/scramjet-utils.js /sj/scramjet-utils.js \
 && cp /sjvendor/node_modules/@mercuryworkshop/libcurl-transport/dist/index.js /sj/libcurl-client.js 

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/lobster-server /app/lobster-server
COPY --from=ui-builder /ui/dist /app/ui
COPY --from=zl-builder /bundle /app/zlsw
COPY --from=sj-builder /sj /app/sj
# Bundle-stale alarm pins: sha256-8 prefixes of the dist artifacts at
# ZEOLITE_COMMIT above (sw.js, bootstrap.js). The server compares them
# at startup and flags /build stale when the zl-builder layer cache
# serves an older tarball.
ENV PORT=6001 WISP_PATH=/wisp/ ZEOLITE_SW_SHA=13b00d3970710c96 ZEOLITE_BOOTSTRAP_SHA=9a2224f65bff6141 SCRAMJET_VERSION=2.0.67-alpha.2
# #129/#143: verify the SERVED artifacts against the pins at build
# time: a mismatch (poisoned or stale cached tarball) fails the
# Docker build itself instead of shipping silently. Stronger than
# hashing the tarball: this proves what /zlsw/ actually serves.
RUN set -e; \
    sw_sha=$(sha256sum /app/zlsw/sw.js | cut -c1-16); \
    boot_sha=$(sha256sum /app/zlsw/bootstrap.js | cut -c1-16); \
    if [ "$sw_sha" != "$ZEOLITE_SW_SHA" ] || [ "$boot_sha" != "$ZEOLITE_BOOTSTRAP_SHA" ]; then \
      echo "FATAL: zlsw bundle sha mismatch (sw $sw_sha, bootstrap $boot_sha)" >&2; \
      exit 1; \
    fi
EXPOSE 6001
# #132: drop root - the server needs no privilege to read /app.
RUN useradd --system --uid 10001 --no-create-home appuser \
 && chown -R appuser:appuser /app
USER appuser
ENTRYPOINT ["/app/lobster-server"]

