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

Tier-8 probes (2026-09-30, 0.4 Vanadium): navigation surfaces and
authentication. /nav.html carries every navigation-adjacent resource
the rewriter must route (iframe doc /frame.html, module script
/mod.mjs, dynamic import /dyn.mjs, XHR to /data.json, relative +
absolute + external links); /auth/login + /auth/protected gate the
authentication-redirect flow (302 to login without the sid cookie,
JSON with it). With LB_ORIGIN, check.mjs asserts the /r/ engine
rewrites the nav page's iframe and module srcs onto /r/ routes, its
links onto /r/ routes, and follows the auth redirect chain to the
login page. Execution-level behavior (XHR, dynamic import, iframe
subresource routing, SPA navigation) needs a browser and rides the
deferred browser pass.

Tier-9 probes (2026-09-30, 0.4 Vanadium): import maps.
/importmap.html carries an inline <script type="importmap"> with
bare keys (im-bare), a path-like key (/im-path.mjs), an array value
mixing an /r/-routable URL with a data: URL, and a pure data: value,
plus a type=module script importing the bare specifier; the mapped
modules (/im-bare.mjs, /im-alt.mjs, /im-arr1.mjs) answer 200. With
LB_ORIGIN, check.mjs asserts the /r/ engine routes the map's URL
values onto /r/, rewrites the path-like key byte-identically to the
rewritten import specifier that will look it up, and leaves bare keys,
data: values, and the type="importmap" script tag verbatim. Scope keys
stay verbatim by design (a rewritten module referrer can never
prefix-match an unrewritten scope prefix; scopes fall back to the top
level).

With LB_ORIGIN set it also checks the server side of the beta:

    LB_ORIGIN=http://127.0.0.1:6001 node tests/transit/check.mjs

- /zl/<b64url> must answer with the honest "no worker controls this
  page" notice, never a server-side proxied or rewritten body. The
  notice is the engine_error_page cold-start card and answers HTTP
  502, like every engine failure card.
- /r/<b64url> must still proxy the fixture end to end (the stable
  engine regression gate).

The /r/ gates carry a fresh per-run lb_sid session jar. A bare /r/
hit with no lb_sid shares the deployment-wide DEFAULT cookie jar with
every other direct client (any earlier probe leaves cookies there and
the auth-redirect gate would be nondeterministic), so the check mints
its own session, exactly like the UI threads lb_sid on every engine
route.

Deployed-pair mode: FIXTURE_ORIGIN=<public fixture> with
LB_ORIGIN=<deployed beta> checks a live deployment end to end
(no local spawn; the raw-socket WS probe is skipped there):

    FIXTURE_ORIGIN=https://lobsterbrowse-fixture.onrender.com \
    LB_ORIGIN=https://lobsterbrowse-beta.onrender.com \
    node tests/transit/check.mjs

CI runs this deployed-pair mode automatically: the transit-live job
in .github/workflows/ci.yml fires on every beta-branch push and gates
the live pair end to end (it verifies the deployed service, which
can lag the pushed commit while Render rebuilds).

What this can never prove: the SW -> NativeTransit -> Wisp chain itself.
No browser runs in CI. That verification is a separate recorded step
against a live beta origin (see docs/BETA-ZEOLITE-NATIVETRANSIT.md,
"Tier 0 status").
