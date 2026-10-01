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
deferred browser pass.

Tier-8 probes (2026-09-30, 0.4 Vanadium): navigation surfaces and
authentication. /nav.html carries every navigation-adjacent resource
the rewriter must route (iframe doc /frame.html, module script
/mod.mjs, dynamic import /dyn.mjs, XHR to /data.json, relative +
absolute + external links); /auth/login + /auth/protected gate the
authentication-redirect flow (302 to login without the sid cookie,
JSON with it). Execution-level behavior (XHR, dynamic import, iframe
subresource routing, SPA navigation) needs a browser and rides the
deferred browser pass.

Tier-9 probes (2026-09-30, 0.4 Vanadium): import maps.
/importmap.html carries an inline <script type="importmap"> with
bare keys (im-bare), a path-like key (/im-path.mjs), an array value
mixing an /r/-routable URL with a data: URL, and a pure data: value,
plus a type=module script importing the bare specifier; the mapped
modules (/im-bare.mjs, /im-alt.mjs, /im-arr1.mjs) answer 200. Scope
keys stay verbatim by design (a rewritten module referrer can never
prefix-match an unrewritten scope prefix; scopes fall back to the top
level).

Tier-10 probes (2026-09-30, 0.4 Vanadium): CSS rewrite surface,
srcset, page query, session jar, conditional GET. /css-probes.css
carries every url() shape the CSS rewriter must handle (a bare
url(), a single-quoted url() with a query string, an @import in
url() form, and a data: URL that must stay verbatim); /nav.html's
img grows a srcset with two candidates so srcset routing keeps its
descriptors; /query echoes the raw request target (path + query)
byte-exactly. Tier-10 went live on
the deployed pair 2026-09-30: fixture and beta both serve the new
surfaces, and the deployed-pair CI mode runs every Tier-10 gate
against them.

With LB_ORIGIN set it also checks the server side of the beta:

    LB_ORIGIN=http://127.0.0.1:6001 node tests/transit/check.mjs

- /zl/<b64url> must answer with the honest "no worker controls this
  page" notice, never a server-side proxied or rewritten body. The
  notice is the engine_error_page cold-start card and answers HTTP
  502, like every engine failure card.
- the legacy /r/<b64url> and /lj/<b64url> prefixes must 302 to
  /zl/<b64url> with the target and query preserved (ScramJet is gone
  from this branch; stale bookmarks and history entries keep working).
- /rewriter_wasm_bg.wasm must answer 200 with application/wasm and
  the \0asm magic (the origin-root alias of the vendored engine
  rewriter wasm, same pattern as /bootstrap.js).

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
