# Tier-0 transit checks (beta/zeolite-nativetransit)

fixture.mjs is a deterministic node:http fixture (HTML, CSS, JS, JSON,
redirect, POST echo, streaming, 2 MiB large body with real Range
support, cookie set/echo, SSE). check.mjs asserts every endpoint
byte-exactly.

With LB_ORIGIN set it also checks the server side of the beta:

    LB_ORIGIN=http://127.0.0.1:6001 node tests/transit/check.mjs

- /zl/<b64url> must answer with the honest "no worker controls this
  page" notice, never a server-side proxied or rewritten body.
- /r/<b64url> must still proxy the fixture end to end (the stable
  engine regression gate).

What this can never prove: the SW -> NativeTransit -> Wisp chain itself.
No browser runs in CI. That verification is a separate recorded step
against a live beta origin (see docs/BETA-ZEOLITE-NATIVETRANSIT.md,
"Tier 0 status").
