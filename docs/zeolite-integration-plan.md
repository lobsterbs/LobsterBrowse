# Deep Zeolite integration plan (unstable branch)

Working branch for deep integration of the Zeolite engine into LobsterBrowse.
Everything lands here first, gets deployed and live-tested from this branch, and
only moves to main once stable. main stays deployable at all times.

## Why a separate branch

The integration touches the request path (engine_proxy), the service worker
transport (/zlsw), and the per-site settings surface at the same time. Each
change can break proxied sites in ways CI cannot catch (CI compiles; it does
not browse). The unstable branch isolates that risk.

## Current state (honest gaps to close)

1. Per-site rules do not reach the Zeolite engine. The rules editor
   (per-site ad-block switch, UA preset) builds lb_ query options that the
   /r/ rewriter honors. The /lj/ engine path ignores per-site overrides
   today; the UI states this honestly. Plan: a zl:config control message that
   pushes the per-site rule set (host, adblock, ua) into the engine request
   pipeline so the SW applies them per target host before the request leaves
   the browser.

2. Incognito jar gap in engine mode. Incognito sessions swap the server-side
   cookie jar via session tokens on /r/ routes. The engine path does not
   carry a jar identity, so incognito isolation is weaker there. Plan: thread
   the session token through zl:wsOpen / the wisp transport and give the
   engine per-session jar state, same semantics as /r/.

3. js_antiframe parity. The ScramJet path rewrites framebusting
   top.location writes (LB_antiframe). The Zeolite wasm rewriter has no
   equivalent pass, so framebusting pages behave differently between engines.
   Plan: port the js_antiframe scan/classify pass to the Zeolite rewriter so
   both paths produce the same runtime behavior.

4. Engine-mode WebSocket virtual origins. The engine bridges page
   WebSockets end to end (zl:wsOpen). Documented follow-up: per-origin
   virtual WS identities so a page cannot fingerprint the single bridge
   origin.

## Ground rules for this branch

- AGENTS.md remains the architecture authority; update it with every
  behavior change, not at the end.
- Every step keeps the honest-behavior rule: nothing may pretend a capability
  succeeded when it did not. Failed capability = immediate, loud, visible.
- One integration item per commit series, deployed and live-tested
  (lobsterbrowse-server.onrender.com) before the next starts.
- When all items above are green in production for a few days, merge
  unstable -> main in one reviewed merge, not by cherry-picking.

## Verification per step

- GitHub CI green (tsc -b, vite build, cargo fmt + build) on every push.
- Render deploy from this branch, /build must show the branch head SHA.
- Live checks: /healthz, /build, a proxied page load in engine mode, the
  specific UI surface the step changed (rules chip, incognito swap, find bar).
