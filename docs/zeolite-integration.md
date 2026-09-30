# Zeolite deep integration - beta branch plan

Status: prep document, 2026-09-29. Migrated from the retired "unstable"
line to beta/zeolite-nativetransit at the owner's direction on
2026-09-29: the beta branch is the one and only integration line.
This branch is where Zeolite integration work lands before promotion
to main. Main stays on tagged, dist-verified Zeolite releases; beta
may track Zeolite main. The active execution plan is
docs/zeolite-integration-plan.md; this file records the verified
integration surface and the backlog detail behind it.

## Current integration surface (verified)

LobsterBrowse consumes Zeolite in exactly three places today:

1. `zeolite-server` crate: git dependency in
   `server/bin/server/Cargo.toml` (rev pinned). LB uses
   `zeolite_server::policy::DestinationPolicy` for the SSRF policy,
   now both on the /wisp/ relay and, since 806cd0bf, on every /r/
   fetch via the PolicyDns resolver and per-hop validation.
2. The engine dist bundle: served at the origin root (the zlsw
   service worker). Pinned via the Dockerfile ARG ZEOLITE_COMMIT plus
   the dist sha; /build reports lb/zeolite/zlswSha/build.
3. The UI runtime: the service worker owns /zl/ interception,
   in-worker rewriting and native wisp transport; the UI pushes
   zl:config at boot and talks to it via postMessage (zl:ping,
   zl:downloads, zl:exportSession, ...).

Pin invariant: the Dockerfile ARG, the Cargo.toml zeolite-server rev
and the dist sha must be bumped together, or /build reports a stale
pin and the engine/UI disagree about what is deployed.

## Deep integration backlog (proposed order)

1. One policy module for everything: /r/, /wisp/ and the future /ws
   bridge all judge destinations through the same DestinationPolicy
   version that ships with the pinned zeolite-server rev. Done for
   /r/ and /wisp/; the /ws bridge (#3) must be born with it.
2. Per-sid jars everywhere: the #1 session jars must also key the
   wisp relay clients, so engine and wisp traffic share one cookie
   jar per sid. The /ws bridge joins the same map when it lands.
3. Compat suite in LB CI: run the Zeolite compat suite against the
   pinned dist in LB CI on this branch, so a pin bump that breaks
   LB-known sites fails before promote. Beta bumps may point at
   Zeolite main; CI is the gate.
4. Diagnostics unification: surface Zeolite diagnostics (netLog,
   compat probes) in LB DevTools next to the LB log ring, keyed by
   the same lb_sid, so one session view covers both layers.
5. Rewriter convergence: evaluate swapping LB's server-side HTML
   rewriting for the Zeolite rewriter on this branch only. No
   commitment; benchmark first, decide on numbers.

## Promotion rule

beta promotes to main when: CI green (fmt, clippy, tsc, lockfile
verify), compat suite green against the pinned dist, /healthz and
/build verified on the Render preview, and a fresh-context browser
pass confirms /zl/ routes on first install (the LB#15 scenario). No
single-green-CI promotions.
