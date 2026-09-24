# syntax=docker/dockerfile:1
# Multi-stage build for the LobsterBrowse Rust Wisp server.
# Builder tracks latest stable Rust: zeroize 1.9+ manifests need cargo >= 1.85.
FROM rust:1-slim AS builder
WORKDIR /build

COPY server/ ./
# TEMP: capture clippy warnings in build logs
RUN rustup component add clippy 2>/dev/null || true; cargo clippy --all-targets 2>&1 | tee /dev/stderr | grep -E "^(warning|error)" || true
RUN cargo build --release -p lobster-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/lobster-server /app/lobster-server
EXPOSE 6001
ENV PORT=6001 WISP_PATH=/wisp/
ENTRYPOINT ["/app/lobster-server"]