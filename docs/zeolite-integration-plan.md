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
2. Incognito jar in engine mode: IMPLEMENTED (2026-09-30, Zeolite
   engine commit cf2d0400, LB side on this branch). A zl:jarProfile
   control message switches the engine cookie jar between the durable
   default profile and a throwaway session profile: App.tsx pushes the
   incognito sid while incognito is on (null otherwise) on boot, on the
   toggle, and on controllerchange. Session-profile cookies are
   in-memory only (never IndexedDB) and die on the switch back - the
   same semantics as the /r/ lb_inc jar. The original plan sketch
   (thread the sid through zl:wsOpen / the wisp transport) turned out
   unnecessary: the engine jar lives in the service worker, not the
   server, so no transport change is needed. Known limits, documented
   in the Zeolite docs/cookies.md: a SW restart mid-incognito briefly
   admits cookies into the default jar until the re-push lands, the
   engine page cache is shared across profiles (cookies never are),
   and the profile is global SW state, so two app windows in different
   incognito states cannot hold different profiles (last push wins).
3. js_antiframe parity: RESOLVED, not a gap (corrected per LB#24; the
   earlier claim that the Zeolite wasm rewriter had no counterpart
   pass was stale). The port exists and is wired in:
   crates/rewriter/src/js/antiframe.rs, applied by the html rewriter
   at BOTH call sites - served script bodies (after js::rewrite_script)
   and inline event handlers (wrapping js::rewrite_inline) - verified
   at Zeolite e0835e18. Remaining optional work: a behavioral test of
   the engine antiframe pass on a frame-busting page (the ScramJet
   parity side is gone since the 2026-10-01 removal; the pass now has
   to stand on its own).
   A deterministic fixture lives at ui/public/antiframe-fixture.html
   (served live at /antiframe-fixture.html): both idioms (top.location
   assignment and top.location.href assignment) must be sunk by the
   engine pass, so the page stays framed and flips its status text
   to "script ran".
4. Engine-mode WebSocket virtual origins: IMPLEMENTED (2026-09-30,
   Zeolite engine commit e3f1a171, CI-green after the tsc fix for the
   message-event type). The zl:wsOpen upgrade handshake now
   carries the per-origin identity instead of the single bridge
   identity every proxied site used to share: the initiator's Origin,
   the jar's cookies for the target (cookie-authenticated upgrades
   behave like native ones) and the per-site UA from zl:rules, with an
   active fingerprint profile still winning and pinning accept-language
   (Telluride). The initiator origin is the message field when the
   sender supplies it, else recovered from the controlling client's
   route - the same initiator recovery the fetch path uses, so
   worker-relayed sockets get it too and the bootstrap needed zero new
   bytes (its 5 KB CI budget stays intact). Headers are engine-built
   only: a page can never smuggle handshake headers onto the
   transport. Unit-gated in the engine (ws-identity.test.ts,
   wsbridge.test.ts).

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
