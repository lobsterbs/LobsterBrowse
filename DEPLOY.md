# Deploying LobsterBrowse

## Render services (workspace migrated 2026-10-28)

The 2026-10-23 workspace and its onrender.com domains are gone (suspended
account). Current free-tier services, region frankfurt, autoDeploy off:

- lobsterbrowse (main branch): https://lobsterbrowse-g0bs.onrender.com
- lobsterbrowse-beta (beta/zeolite-nativetransit):
  https://lobsterbrowse-beta-9bct.onrender.com
- lobsterbrowse-content (the #107 split content origin: same Docker
  image, branch main; both app services announce it through
  ZL_CONTENT_ORIGIN):
  https://lobsterbrowse-content-2djv.onrender.com
- lobsterbrowse-fixture (node, "node tests/transit/fixture.mjs",
  PORT=10000, FIXTURE_HOST=0.0.0.0):
  https://lobsterbrowse-fixture-okp6.onrender.com - the FIXTURE_ORIGIN
  of the transit-live CI job.

The standalone Wisp backend was restored on 2026-10-25 for the Zeolite
`brave-wisp` policy route (#209), using the existing `Dockerfile.wisp`:

- lobsterbrowse-wisp: https://lobsterbrowse-wisp-8ec1.onrender.com
- Service `srv-dbgtoinlk1mc739f8tf0`, branch main, Frankfurt, free,
  autoDeploy off; WebSocket endpoint `wss://lobsterbrowse-wisp-8ec1.onrender.com/`.
- Set `SCRAMJET_WISP_URL` to that WebSocket endpoint on main, beta **and
  content**, then deploy each. The content worker owns split-origin page
  traffic, so configuring only the app services does not restore Brave.
- `/build` exposes `sjWisp` only to same-origin fetches. For an operator
  check, send `Sec-Fetch-Site: same-origin`; an ordinary command-line
  request deliberately reports an empty value (#128).

The service uses unmodified upstream wisp-js with its private/loopback
destination restrictions. It is a public transport endpoint; keeping the
password on LobsterBrowse's separate `/wisp/` route is intentional.
A live deployment and a nonempty `sjWisp` establish wiring only: verify a
Brave homepage and search navigation through the content worker before
claiming that site works. The policy falls back to the relay when the
alternate endpoint is absent, which caused the original 20-second stalls.
Verification on 2026-10-25: a fresh Chromium 153 profile, using the real
UI and content worker, received Brave's HTTP 429 challenge document and
rendered its slider prompt without page JavaScript errors. The original
no-first-byte hang was absent. This confirms transport recovery, not a
completed challenge or a successful search-results page.

## Server (Render web service, Docker)

- Runtime: Docker, Dockerfile at repo root (builds the Rust workspace).
- Env vars:
  - `PORT` (set by Render automatically; the server reads it).
  - `WISP_PATH` - Wisp endpoint path, defaults to `/wisp/`. Randomize per deployment.
  - `WISP_PASSWORD` / `WISP_USERNAME` - optional password auth (extension 0x02).
  - `DATABASE_URL` - Neon Postgres connection string (used by the upcoming sessions crate).
  - `LB_TRUSTED_PROXY_CIDRS` - optional comma-separated trusted-proxy CIDR list. When the TCP peer sits inside one of these ranges, the relay rate limit keys on the rightmost `x-forwarded-for` hop outside the trusted set instead of the shared peer address (#163). Unset by default: the peer IP stays the key and a client-controlled `x-forwarded-for` is never honored. A malformed entry is a startup error.
  - `ZL_QUERY_ROUTES` - Injector phase 2 opt-OUT (query-shape committed routes, the LegacyUnforgeable pathname fix). On by default: /build reports `zlQueryRoutes: true` and the UI pushes `queryRoutes` in `zl:config` to both origin workers (the app origin and the provisioned content origin). Set `0`/`false`/`no` to opt out: the opaque NAVH handle shape stays committed.
- Health check: `GET /healthz`.

## Zeolite engine pin

The engine bundle served at `/zlsw/` comes from the `dist` branch of
lobsterbs/Zeolite at the `ZEOLITE_COMMIT` pinned in the Dockerfile; the
Rust wisp handler comes from the zeolite-server git rev pinned in
`server/bin/server/Cargo.toml`. Update that rev and regenerate
`server/Cargo.lock` only when the release changes server code. Browser-only
bundle changes update the Dockerfile ARG and expected hashes without
changing the Rust dependency. All services currently have autoDeploy off;
trigger deployment explicitly with `clearCache: true`, then verify the
served hashes through `/build`.

## UI (Render static site)

- Build: `cd ui && npm ci && npm run build`
- Publish: `ui/dist`

## Database (Neon)

The 2026-10-23 workspace recreation did not carry a DATABASE_URL over;
re-provision the Neon project (or reuse it) and set `DATABASE_URL` on
the app services when the sessions crate lands. Free tier,
autosuspended when idle.

Current pin: Zeolite dist `146c2a972d6f678a50d49601c929cf26b333fbb0`
(pin 127, CI build 40207272135), zlswSha `d4423f428f4e1279`,
bootstrapSha `d4a04eb5947837ef`. This includes the service-worker,
relay, popup, diagnostics, fingerprint, runtime-fragment and authorization
route fixes. Pin 127 additionally fixes script escape boundaries and exact MIME attributes
(Zeolite #447/#448); only the rewriter WASM changes. See `docs/pin-126.md`
for the preceding route-search change.
The independent Docker epoxy-tls vendor is pinned to `2.1.20-1`, matching
the engine CI vendor. The Rust zeolite-server dependency is unchanged.

## Build/deploy reliability checklist (0.3 Titanium)

- A bundle pin move updates the Dockerfile ARG, expected SW/bootstrap
  hashes, this pin note and AGENTS.md together. A server dependency change
  additionally updates its Cargo.toml rev and regenerated Cargo.lock.
- Deploys are API-triggered: autoDeploy is off on both services.
  Trigger with clearCache: true after every pin bump, then verify
  /build: buildShort must equal the pushed SHA and zlswSha must equal
  the Dockerfile ENV pin. A 2026-09-30 deploy once built from a
  stale git ref (deploy metadata named the new commit, the image
  served the old one; /build proved it); the /build check after
  every deploy is the guard.
- After every deploy, verify /build: buildShort must equal the pushed
  SHA, and zlswSha must change when the Zeolite pin moved. /healthz
  must answer ok. A "live" deploy status alone proves nothing.
- Always cache-bust /build and /healthz queries (?cb=<now>) when
  fetching through external readers; they serve stale JSON otherwise.
- The generate-rust-lockfile workflow's own commit does not run CI;
  the next push (or a retrigger commit) proves the lock/pin pair
  green before the deploy is trusted.
