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

Tier-7 probes (2026-09-30): redirect-chain semantics and method
replay. /redir-chain/a (relative 302 + per-hop Set-Cookie) ->
/redir-chain/b (absolute 302 + per-hop Set-Cookie) -> /redir-chain/c
(JSON, echoes the request Cookie header); /redir-303 and /redir-307
hop into /echo to gate method+body replay (303 -> GET with the body
dropped, 307 -> POST with the body preserved); /etag gates conditional
GET (304 on a matching If-None-Match); /nocontent is a bare 204;
/font.woff2, /media.mp4, /icon.svg and /manifest.webmanifest gate
MIME-typed resources (magic bytes asserted, sprite href in the SVG);
/cookie-scope + /scoped/cookie gate cookie Path scoping; /spa.html is
the deterministic SPA page (pushState/replaceState, popstate,
location.hash, window.open, relative + absolute links) for the
deferred browser pass. With LB_ORIGIN set, check.mjs additionally
gates the /r/ engine's server-side hop following for the chain and
both method replays.

With LB_ORIGIN set it also checks the server side of the beta:

    LB_ORIGIN=http://127.0.0.1:6001 node tests/transit/check.mjs

- /zl/<b64url> must answer with the honest "no worker controls this
  page" notice, never a server-side proxied or rewritten body.
- /r/<b64url> must still proxy the fixture end to end (the stable
  engine regression gate).

Deployed-pair mode: FIXTURE_ORIGIN=<public fixture> with
LB_ORIGIN=<deployed beta> checks a live deployment end to end
(no local spawn; the raw-socket WS probe is skipped there):

    FIXTURE_ORIGIN=https://lobsterbrowse-fixture.onrender.com \
    LB_ORIGIN=https://lobsterbrowse-beta.onrender.com \
    node tests/transit/check.mjs

What this can never prove: the SW -> NativeTransit -> Wisp chain itself.
No browser runs in CI. That verification is a separate recorded step
against a live beta origin (see docs/BETA-ZEOLITE-NATIVETRANSIT.md,
"Tier 0 status").
