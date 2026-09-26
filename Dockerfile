# syntax=docker/dockerfile:1
# Multi-stage build for the LobsterBrowse single-site service:
# the Rust Wisp server and the static M3E UI it serves from one origin.
# Builder tracks latest stable Rust: zeroize 1.9+ manifests need cargo >= 1.85.
FROM rust:1-slim AS builder
WORKDIR /build
COPY server/ ./
RUN cargo build --release -p lobster-server

FROM node:22-slim AS ui-builder
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm install --no-audit --no-fund
COPY ui/ ./
RUN npm run build

# Zeolite engine bundle: the dist branch of the Zeolite repo carries
# the newest green build of the engine service worker and its chunks
# (libcurl stripped there: the AGPL bundle is never committed to git).
# Vendored here at build time so the server can serve it same-origin
# at /zlsw/ and the UI can register the worker.
FROM debian:bookworm-slim AS zl-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates npm \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /bundle
RUN curl -fsSL https://github.com/lobsterbs/Zeolite/archive/refs/heads/dist.tar.gz \
      | tar xz --strip-components=1
# The libcurl transport (TLS termination for the wisp hop): pulled
# from npm at build time, same pinned version the Zeolite CI vendors.
RUN mkdir -p /bundle/libcurl \
    && npm install --prefix /zlvendor --no-audit --no-fund @mercuryworkshop/libcurl-transport@2.0.5 \
    && cp -r /zlvendor/node_modules/@mercuryworkshop/libcurl-transport/dist/. /bundle/libcurl/

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/lobster-server /app/lobster-server
COPY --from=ui-builder /ui/dist /app/ui
COPY --from=zl-builder /bundle /app/zlsw
EXPOSE 6001
ENV PORT=6001 WISP_PATH=/wisp/
ENTRYPOINT ["/app/lobster-server"]
