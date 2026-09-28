# Tier-0 transit checks (beta/zeolite-nativetransit)

fixture.mjs is a deterministic node:http fixture (HTML, CSS, JS, JSON,
redirect, POST echo, streaming, 2 MiB large body with real Range
support, cookie set/echo, SSE). check.mjs asserts every endpoint
byte-exactly.

Tier-6 probes (added 2026-09-28): /worker.js + /module-worker.js
(scripts that fetch /data.json and postMessage the result),
/workers.html (page that spawns classic + module workers and probes
WebSocket behavior), /ws (minimal RFC6455 echo: handshake + one text
frame), /hdrs (echoes request headers as JSON), /set-cookie1 (single
Set-Cookie, to discriminate jar bugs from multi-cookie parsing).
check.mjs covers all of them at the HTTP level, including a raw
WebSocket handshake + echo.

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
