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

Current pin: Zeolite main f96eef59 (page-cache-hit rewrite fix,
Zeolite#22), dist bundle 88116094. This matches the Dockerfile
ZEOLITE_COMMIT and the zeolite-server git rev in
server/bin/server/Cargo.toml; server/Cargo.lock is consistent with
the pin.
