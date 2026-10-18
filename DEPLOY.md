# Deploying LobsterBrowse

## Server (Render web service, Docker)

- Runtime: Docker, Dockerfile at repo root (builds the Rust workspace).
- Env vars:
  - `PORT` (set by Render automatically; the server reads it).
  - `WISP_PATH` — Wisp endpoint path, defaults to `/wisp/`. Randomize per deployment.
  - `WISP_PASSWORD` / `WISP_USERNAME` — optional password auth (extension 0x02).
  - `DATABASE_URL` — Neon Postgres connection string (used by the upcoming sessions crate).
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

Current pin: Zeolite dist 7e29d525 (pin 88: two engine waves - the
control-plane lifecycle wave #250/#252/#253: the zl: messageListener
holds the event with waitUntil across the whole handler and answers
failed dispatches with a structured error reply, engine init()
resolves only on an explicit worker ack, route persistence waits for
the ack, post() settles exactly once, and docCookiePorts cap at 16
per client with eviction; and the #266/#261 wave: object-style
storage listeners are isolated and removable like function
listeners, and the cooldown relay branch carries its own first-byte
deadline so a silent embedder aborts with zl:relayCancel
(WispStallError) instead of hanging; Zeolite ce9eb6b + 1a70811, CI
runs 39132519199 and 39133625103 all 5 jobs green, suites 1288 and
1291 incl. 13 new tests), zlswSha 49896d2b07867e9f and bootstrapSha
d00b5e4270b011f1 (both changed; verify the served file hashes). This
matches the Dockerfile ZEOLITE_COMMIT; the zeolite-server git rev
stays b0296f8 because both waves are SW-only, and
server/Cargo.lock is consistent with the pin.

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
