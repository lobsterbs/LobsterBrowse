# syntax=docker/dockerfile:1
# Multi-stage build for the LobsterBrowse Rust Wisp server.
FROM rust:1.83-slim AS builder
WORKDIR /build

# Cache workspace manifest first.
COPY server/Cargo.toml ./Cargo.toml
COPY server/Cargo.lock* ./
COPY server/crates ./crates
COPY server/bin ./bin
RUN mkdir -p .cargo && cargo build --release -p lobster-server 2>&1 | tee /tmp/build.log; \
    test -x target/release/lobster-server || (cargo build --release -p lobster-server && true)

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/lobster-server /app/lobster-server
EXPOSE 6001
ENV PORT=6001 WISP_PATH=/wisp/
ENTRYPOINT ["/app/lobster-server"]