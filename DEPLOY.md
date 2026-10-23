# Deploying LobsterBrowse

## Render services (workspace migrated 2026-10-23)

The 2026-10-20 workspace and its onrender.com domains are gone (suspended
account). Current free-tier services, region frankfurt, autoDeploy off:

- lobsterbrowse (main branch): https://lobsterbrowse-yiy9.onrender.com
- lobsterbrowse-beta (beta/zeolite-nativetransit):
  https://lobsterbrowse-beta-cts6.onrender.com
- lobsterbrowse-content (the #107 split content origin: same Docker
  image, branch main; both app services announce it through
  ZL_CONTENT_ORIGIN):
  https://lobsterbrowse-content-ocbg.onrender.com
- lobsterbrowse-fixture (node, "node tests/transit/fixture.mjs",
  PORT=10000, FIXTURE_HOST=0.0.0.0):
  https://lobsterbrowse-fixture-rtus.onrender.com - the FIXTURE_ORIGIN
  of the transit-live CI job.

The standalone ScramJet wisp backend (Dockerfile.wisp) was retired with
the suspended workspace and is not recreated: Zeolite is the only engine
and /build reported sjWisp empty on both services already.

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
`server/bin/server/Cargo.toml`. The two must move together: bump both,
let the generate-rust-lockfile workflow commit the new `server/Cargo.lock`,
then let the push-triggered Render autoDeploy run (see the reliability
checklist below). Note that the
lockfile workflow's own commit does not run CI; the next push or a
manual re-run is what proves the pair green. A pin commit is also
red in CI by construction: the rust job's cargo --locked fails
while server/Cargo.lock still holds the old revs. That red run is
expected, not a regression. The verdict that matters is the green
Generate server lockfile run on the same SHA, which runs the same
fmt/build/test/clippy gates as the CI rust job before it lands
the lock.

## UI (Render static site)

- Build: `cd ui && npm ci && npm run build`
- Publish: `ui/dist`

## Database (Neon)

The 2026-10-23 workspace recreation did not carry a DATABASE_URL over;
re-provision the Neon project (or reuse it) and set `DATABASE_URL` on
the app services when the sessions crate lands. Free tier,
autosuspended when idle.

Current pin: Zeolite dist bdbce2d7 (pin 115: always-on Injector -
queryRoutes defaults to true at module eval (Zeolite
swstate.ts), so query-shape committed routes are the default
route shape and a host zl:config remains the runtime opt-out;
the prel nav 302 clean form and the vloc query arm ride the
same always-on default, and this server reports zlQueryRoutes
true unless ZL_QUERY_ROUTES opts out; Zeolite main 8882da6,
CI run 39947197172 all 5 jobs green, suite 1470/1470),
zlswSha 559dd986814b1a53 -> 378e4396918d9393 (630107
bytes), bootstrapSha 66d387dbf16ee2c3 unchanged (35288
bytes).
This matches the Dockerfile ZEOLITE_COMMIT; the zeolite-server
git rev stays a385fa9 because the wave does not touch
zeolite-server, and server/Cargo.lock is consistent with the
pin.
## Build/deploy reliability checklist (0.3 Titanium)

- A pin move is ONE commit: the Dockerfile ARG, the zeolite-server
  rev in server/bin/server/Cargo.toml, the regenerated
  server/Cargo.lock, this file's pin note and AGENTS.md's pin line
  move together. Never land half a pin.
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
