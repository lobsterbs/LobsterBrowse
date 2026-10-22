# Deploying LobsterBrowse

## Render services (workspace migrated 2026-10-20)

The previous workspace and its onrender.com domains are gone (suspended
account). Current free-tier services, region frankfurt, autoDeploy off:

- lobsterbrowse (main branch): https://lobsterbrowse-plud.onrender.com
- lobsterbrowse-beta (beta/zeolite-nativetransit):
  https://lobsterbrowse-beta-gq13.onrender.com
- lobsterbeta-scramjet-wisp (Dockerfile.wisp, the wisp-js backend):
  https://lobsterbeta-scramjet-wisp-90su.onrender.com - set
  SCRAMJET_WISP_URL=wss://lobsterbeta-scramjet-wisp-90su.onrender.com/
  on the app services (surfaced by /build as sjWisp).
- lobsterbrowse-fixture (node, "node tests/transit/fixture.mjs",
  PORT=10000, FIXTURE_HOST=0.0.0.0):
  https://lobsterbrowse-fixture-oy53.onrender.com - the FIXTURE_ORIGIN
  of the transit-live CI job.

## Server (Render web service, Docker)

- Runtime: Docker, Dockerfile at repo root (builds the Rust workspace).
- Env vars:
  - `PORT` (set by Render automatically; the server reads it).
  - `WISP_PATH` - Wisp endpoint path, defaults to `/wisp/`. Randomize per deployment.
  - `WISP_PASSWORD` / `WISP_USERNAME` - optional password auth (extension 0x02).
  - `DATABASE_URL` - Neon Postgres connection string (used by the upcoming sessions crate).
  - `LB_TRUSTED_PROXY_CIDRS` - optional comma-separated trusted-proxy CIDR list. When the TCP peer sits inside one of these ranges, the relay rate limit keys on the rightmost `x-forwarded-for` hop outside the trusted set instead of the shared peer address (#163). Unset by default: the peer IP stays the key and a client-controlled `x-forwarded-for` is never honored. A malformed entry is a startup error.
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

A Neon Postgres project is provisioned; its connection string is injected into the
server as `DATABASE_URL`. Free tier, autosuspended when idle.

Current pin: Zeolite dist a7e663ae (pin 108: the idle-restart
family, Zeolite #389/#390/#391 - undecodable legacy-shaped routes
answer an engine 404 instead of the origin 503, the transport
engine choice persists in the Cache API across idle worker
restarts, and the worker broadcasts zl:relayLost at every cold
start so the relay re-arms in seconds instead of the 30s backoff
cycle; Zeolite main 88cbc94a, CI run 39753906400 all 5 jobs green,
suite 1436/1436), zlswSha 71d0bd6f016437e7 -> af5fd80829884d7b
(627231 bytes), bootstrapSha 7dfd6645656bab22 unchanged (34628
bytes). This matches the Dockerfile ZEOLITE_COMMIT; the
zeolite-server git rev stays a385fa9 because the wave does not
touch zeolite-server, and server/Cargo.lock is consistent with
the pin.
Beta additionally ships LB #181 (the #122 back/forward port: the
idx travels inside load(); Back/Forward now move the history index).

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
