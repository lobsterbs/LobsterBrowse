# Deep Zeolite integration plan (beta branch)

Working branch for deep integration of the Zeolite engine into
LobsterBrowse: beta/zeolite-nativetransit, per the owner's direction
on 2026-09-29 (migrated from the retired "unstable" line; beta is the
only integration branch). Everything lands here first, gets deployed
and live-tested from this branch, and only moves to main once stable
via PR #12. main stays deployable at all times.

## Why a separate branch

The integration touches the request path (engine_proxy), the service
worker transport (/zlsw), and the per-site settings surface at the same
time. Each change can break proxied sites in ways CI cannot catch (CI
compiles; it does not browse). The beta branch isolates that risk.

## Current state (honest gaps to close)

1. Per-site rules into the engine: IMPLEMENTED (2026-09-30, Zeolite
   engine commit f3268eff, LB side on this branch). A zl:rules control
   message (not zl:config; the message carries a rule list plus a
   global default UA, so it got its own type) pushes the per-site rule
   set (host, adblock, ua) into the engine request pipeline: App.tsx
   sends it on boot and on every settings/rules change, alongside the
   existing zl:adblock toggle. The engine (rules.ts + sw.ts) evaluates
   per target host with the same semantics as the /r/ chain: the
   adblock override can only disable per site (the global toggle
   wins), and the UA override is applied to the outgoing wisp request
   headers the SW builds itself (an active engine fingerprint profile
   still wins). Overrides are ephemeral: the SW resets them on restart
   and LB re-sends. Verified by engine unit tests (rules.test.ts);
   live behavioral verification rides the beta deploy of the pin
   bump.
2. Incognito jar gap in engine mode. Incognito sessions swap the
   server-side cookie jar via session tokens on /r/ routes. The engine
   path does not carry a jar identity, so incognito isolation is
   weaker there. Plan: thread the session token through zl:wsOpen /
   the wisp transport and give the engine per-session jar state, same
   semantics as /r/.
3. js_antiframe parity: RESOLVED, not a gap (corrected per LB#24; the
   earlier claim that the Zeolite wasm rewriter had no counterpart
   pass was stale). The port exists and is wired in:
   crates/rewriter/src/js/antiframe.rs, applied by the html rewriter
   at BOTH call sites - served script bodies (after js::rewrite_script)
   and inline event handlers (wrapping js::rewrite_inline) - verified
   at Zeolite e0835e18. Remaining optional work: a behavioral parity
   test between /r/ ScramJet and /lj/ Zeolite on a frame-busting page.
4. Engine-mode WebSocket virtual origins. The engine bridges page
   WebSockets end to end (zl:wsOpen). Documented follow-up: per-origin
   virtual WS identities so a page cannot fingerprint the single
   bridge origin.

## Ground rules for this branch

- AGENTS.md remains the architecture authority; update it with every
  behavior change, not at the end.
- Every step keeps the honest-behavior rule: nothing may pretend a
  capability succeeded when it did not. Failed capability = immediate,
  loud, visible.
- One integration item per commit series, deployed and live-tested
  (lobsterbrowse-server.onrender.com) before the next starts.
- When all items above are green in production for a few days, merge
  beta -> main in one reviewed merge (PR #12), not by cherry-picking.

## Verification per step

- GitHub CI green (tsc -b, vite build, cargo fmt + build) on every push.
- Render deploy from this branch, /build must show the branch head SHA.
- Live checks: /healthz, /build, a proxied page load in engine mode,
  the specific UI surface the step changed (rules chip, incognito
  swap, find bar).
