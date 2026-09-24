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
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/lobster-server /app/lobster-server
COPY --from=ui-builder /ui/dist /app/ui
EXPOSE 6001
ENV PORT=6001 WISP_PATH=/wisp/
ENTRYPOINT ["/app/lobster-server"]
