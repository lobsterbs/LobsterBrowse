# LobsterJet

Interception-based web proxy engine. Service worker on the engine origin
intercepts every request, a Rust/WASM streaming rewriter rewrites responses,
and all transport goes over Wisp v2.1.

Lives in LobsterBrowse as a sibling of `scramjet/`, but does not touch
LobsterBrowse source: like Scramjet, it deploys as its own service (the
service worker must own its origin) and is embedded via `?url=<target>`.

## Layout

```
lobsterjet/
  crates/
    rewriter/     Rust/WASM streaming HTML/CSS/JS-literal rewriter
    wisp-wasm/    wasm-bindgen wrapper over wisp-core (client framing)
    lj-server/    standalone wisp server + static host (small VPS, ARM OK)
  app/            static frontend: SW, runtime bootstrap, embed client
  suite/          compat probes -> JSON + Markdown scoreboard
  docs/           engine adapter contract (Phase 2)
```

## Non-negotiables

- ONE transport: Wisp v2.1. Reused from LobsterBrowse as a library:
  `path = "../../server/crates/wisp-core"` (and `wisp-extensions`).
  Never reimplemented here. Protocol version pinned at 2.1
  (`wisp-core::handshake` sends major 2 minor 1).
- Streaming always: the rewriter emits while it parses; nothing buffers a
  full document. Time-to-first-paint is the primary metric.
- Hybrid rewriting: static surface (HTML attributes, CSS url(), JS string
  literals) rewritten in emit; behavior (fetch/XHR/WebSocket/storage/
  history/Worker) patched at runtime by a bootstrap under 5 KB (minified).
- No headless browser anything. No Google login / Cloudflare interstitial
  bypass, ever. Out of scope by architecture.

## Phase gates (summary)

1. Engine core: rewriter + SW + bootstrap + wisp transport + compat suite.
   Done when YouTube + Reddit are interactive without console errors,
   first-paint within 2x direct, suite green in CI, single-config deploy works.
2. LobsterBrowse integration: documented adapter (see docs/engine-adapter.md,
   aligned to the Scramjet embed contract), teardown/SW lifecycle, URL
   scheme rotation, heartbeats, session export/import, per-site cookie jars.
3. Power features: injection hooks API, upstream TLS/HTTP2 fingerprint
   impersonation on the wisp server, ad/tracker stripping in the rewriter,
   oxc AST JS rewriting only if the suite proves the literal pass insufficient.
4. Ecosystem: plugin/middleware API, network inspector (priority) then a
   CDP-subset DOM inspector, public compat scoreboard vs Scramjet.

## HTTP over Wisp (Phase 1 decision)

TLS cannot terminate in the service worker itself, so proxied HTTP(S) goes
through the same proven path Scramjet uses: a libcurl wasm transport
(BareMux-compatible) speaking to the wisp server, loaded by `app/src/http.ts`.
This is a transport choice, not a compat layer; it keeps the SW small and the
single-transport rule intact. WebSocket upgrade traffic does not need TLS in
the SW: the runtime bootstrap implements the WebSocket API over a raw wisp
TCP stream.

## Dev

```
# rewriter + wisp wasm (requires wasm32-unknown-unknown target)
cargo build -p lobsterjet-rewriter -p lobsterjet-wisp --target wasm32-unknown-unknown --release
wasm-bindgen glue via app build (npm run build in app/)

# standalone server (also serves the built app statically)
cargo run -p lj-server -- --port 6002 --static ../app/dist

# compat suite against a running engine
node suite/probe.mjs --base http://localhost:6002
```
