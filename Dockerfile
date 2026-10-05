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
# Current pin: dist 8ffc313 (Zeolite main 0691b19, CI run 37356572148), 2026-10-05.
# Cargo-side pin untouched: Zeolite 0691b19 changed app/src only, the
# wisp/rewriter crates are identical to the pinned rev.
FROM debian:bookworm-slim AS zl-builder
ARG ZEOLITE_COMMIT=8ffc3133aae512a871f0a201b1288edd64bd68ac
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
ENV PORT=6001 WISP_PATH=/wisp/ ZEOLITE_SW_SHA=718a868b6d37d357 ZEOLITE_BOOTSTRAP_SHA=8f4cc3bdf3f3bd20
ENTRYPOINT ["/app/lobster-server"]