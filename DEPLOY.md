# Deploying LobsterBrowse

## Server (Render web service, Docker)

- Runtime: Docker, Dockerfile at repo root (builds the Rust workspace).
- Env vars:
  - `PORT` (set by Render automatically; the server reads it).
  - `WISP_PATH` — Wisp endpoint path, defaults to `/wisp/`. Randomize per deployment.
  - `WISP_PASSWORD` / `WISP_USERNAME` — optional password auth (extension 0x02).
  - `FILTER_LIST_PATH` — optional path to a full EasyList/uAssets download.
  - `DATABASE_URL` — Neon Postgres connection string (used by the upcoming sessions crate).
- Health check: `GET /healthz`.

## Zeolite engine pin

The engine bundle served at `/zlsw/` comes from the `dist` branch of
lobsterbs/Zeolite at the `ZEOLITE_COMMIT` pinned in the Dockerfile; the
Rust wisp handler comes from the zeolite-server git rev pinned in
`server/bin/server/Cargo.toml`. The two must move together: bump both,
let the generate-rust-lockfile workflow commit the new `server/Cargo.lock`,
then trigger a Render deploy with a cleared build cache. Note that the
lockfile workflow's own commit does not run CI; the next push or a
manual re-run is what proves the pair green.

## UI (Render static site)

- Build: `cd ui && npm ci && npm run build`
- Publish: `ui/dist`

## Database (Neon)

A Neon Postgres project is provisioned; its connection string is injected into the
server as `DATABASE_URL`. Free tier, autosuspended when idle.

Current pin: Zeolite rev 1d818fc0 (virtual Origin/Sec-Fetch-Site
synthesis (#23), HTML entity decoding in rewritten attributes (#24),
navguard + WebRTC gate (#28), zl:find (#29), netLog passthrough rows
(#30), per-client virtual-context routing (#33), opaque page identity
and mirror scheme removal (#32), cross-origin subresource routing
(#34)), dist bundle a01f5990. This matches the Dockerfile
ZEOLITE_COMMIT and the zeolite-server git rev in
server/bin/server/Cargo.toml; server/Cargo.lock is consistent with
the pin.
## Build/deploy reliability checklist

- A pin move is ONE push: the Dockerfile ARG, the zeolite-server
  rev in server/bin/server/Cargo.toml, and the pin notes in
  DEPLOY.md and AGENTS.md move together; the generate-rust-lockfile
  workflow then commits the regenerated server/Cargo.lock. Never
  land half a pin.
- Let the push-triggered Render autoDeploy do deploys. An API-triggered
  deploy once built from a stale git ref (2026-09-30: deploy metadata
  named the new commit, the image served the old one; /build proved it).
  The webhook autoDeploy carries the exact SHA and has not done this.
- After every deploy, verify /build: buildShort must equal the pushed
  SHA, and zlswSha must change when the Zeolite pin moved. /healthz
  must answer ok. A "live" deploy status alone proves nothing.
- Always cache-bust /build and /healthz queries (?cb=<now>) when
  fetching through external readers; they serve stale JSON otherwise.
- The generate-rust-lockfile workflow's own commit does not run CI;
  the next push (or a retrigger commit) proves the lock/pin pair
  green before the deploy is trusted.
