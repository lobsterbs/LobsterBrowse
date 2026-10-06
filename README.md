# LobsterBrowse

```text
    __          __         __            ____
   / /   ____  / /_  _____/ /____  _____/ __ )_________ _      __________
  / /   / __ \/ __ \/ ___/ __/ _ \/ ___/ __  / ___/ __ \ | /| / / ___/ _ \
 / /___/ /_/ / /_/ (__  ) /_/  __/ /  / /_/ / /  / /_/ / |/ |/ (__  )  __/
/_____/\____/_.___/____/\__/\___/_/  /_____/_/   \____/|__/|__/____/\___/
```

**Open-source browser-style proxy · Rust + React + Material 3 Expressive**

LobsterBrowse is a browser-style proxy application built around **Rust/Axum**, **React + TypeScript**, **Material 3 Expressive**, **Wisp transport**, structured diagnostics, and **Zeolite** integration.

## Status

LobsterBrowse is actively developed and is **not a Chromium or Firefox replacement**. The project prioritizes working browser behavior, compatibility, and a clean LobsterBrowse/Zeolite boundary over feature count.

The current workspace version is **0.2.0**. The next roadmap milestone is **0.3 — Titanium**.

## What it includes

- Tabbed browser UI with Material 3 Expressive styling
- Rust/Axum proxy server
- Wisp transport
- Zeolite engine integration
- Incognito sessions
- DevTools and privacy-safe diagnostics
- Extension controls and WebExtension compatibility work
- Search suggestions and link prefetching
- Network filtering and proxy options
- Health and deployment endpoints

## Architecture

The intended architecture keeps the browser application separate from the reusable interception and transport engine:

```text
LobsterBrowse
    |
    v
 Zeolite
    |
    +-- interception
    +-- rewriting
    +-- transport decisions
    +-- browser-state primitives
    |
    v
 Network / Wisp / native transport
```

**LobsterBrowse** owns the browser/application experience.

**Zeolite** owns reusable interception and transport functionality so it can be used by other host applications.

**Wisp** remains a transport foundation.

NativeTransit is the direction for native transport/interception. The project is moving away from treating server-side rewriting as the primary architecture, but compatibility paths must not be removed until real compatibility testing shows they are no longer needed.

## Server

The server lives under `server/` and uses Tokio + Axum.

Important routes include:

| Route | Purpose |
| --- | --- |
| `/wisp/` | Wisp endpoint |
| `/healthz` | Liveness/health check |
| `/zlsw/` | Published Zeolite bundle |
| `/zl-ext/` | Extension-related route |
| `/zl-cs/` | Content-script-related route |
| `/suggest` | Search suggestion proxy |

Compatibility routing and rewriting are implementation details that are still being actively evolved. Do not assume an older `/r/` or `/lj/` architecture is the long-term design.

## UI

The UI lives under `ui/` and uses:

- React
- TypeScript
- Vite
- Material 3 Expressive
- Google Sans Flex
- Material Symbols

The browser UI includes tabs, settings, incognito sessions, DevTools, site information, extension controls, search suggestions, and browser-state handling.

## Zeolite integration

Zeolite is maintained in its own repository and roadmap. LobsterBrowse consumes a published Zeolite bundle without making Zeolite depend on LobsterBrowse's UI.

Keep reusable engine fixes in Zeolite rather than adding LobsterBrowse-only workarounds.

See [Zeolite](https://github.com/lobsterbs/Zeolite) for the engine itself.

## Proxy options

| Option | Purpose |
| --- | --- |
| `lb_ab=1` | Ad filtering |
| `lb_trk=1` | Tracker filtering |
| `lb_https=1` | Reject plain HTTP |
| `lb_img=1` | JPEG re-encoding |
| `lb_ua=` | User-agent override |

## DevTools and diagnostics

DevTools is a real diagnostic surface, not just a UI log viewer.

Diagnostics should expose useful context such as:

- trace/request IDs
- redacted URLs
- subsystem
- severity
- lifecycle stage
- concrete failure causes
- transport/interception decisions

Diagnostics must remain privacy-safe. Passwords, bearer tokens, API keys, authorization headers, raw cookies, and equivalent secrets must never be exposed or persisted.

A normal WebSocket close is not automatically an error.

## Privacy

LobsterBrowse is a proxy, so the server necessarily sees traffic that it proxies. It should **not** be described as server-blind.

Browser UI state is stored locally where applicable. Diagnostic output must redact credentials, cookies, authorization data, and other secrets.

## Building

### Server

```bash
cd server
cargo test
cargo build --release
```

### UI

```bash
cd ui
npm install
npm run build
```

For development, the UI also provides the standard Vite development command:

```bash
cd ui
npm run dev
```

## Deployment

LobsterBrowse is deployed on **Render**.

After deployment changes, verify the deployed UI and relevant server functionality, especially:

- `/healthz`
- browser navigation
- Zeolite bundle loading
- Wisp
- extension routes
- compatibility behavior

The deployed Zeolite revision should remain pinned and verifiable rather than silently following moving engine code.

## Roadmap

The authoritative roadmap is [ROADMAP.md](./ROADMAP.md).

Current roadmap direction:

1. **0.3 — Titanium:** architecture and foundation
2. **0.4 — Vanadium:** navigation and compatibility foundation
3. **0.5 — Cobalt:** difficult modern websites
4. **0.6 — Nickel:** diagnostics and DevTools
5. **0.7 — Zirconium:** browser state and persistence
6. **0.8 — Tungsten:** extensions
7. **0.9 — Iridium:** stabilization and compatibility freeze
8. **1.0 — Osmium:** stable LobsterBrowse

Roadmap details are intentionally kept in `ROADMAP.md` rather than duplicated here.

## Contributing

Before changing code:

1. Inspect the existing implementation and request/state flow.
2. Identify the correct repository boundary.
3. Make the smallest coherent change.
4. Run the relevant tests and builds.
5. Inspect the final diff.
6. Update documentation when behavior changes.

If a fix belongs in Zeolite, fix it in Zeolite instead of creating a LobsterBrowse-specific workaround.

## Project boundaries

```text
LobsterBrowse = browser/application + host integration
Zeolite       = reusable interception + transport engine
Wisp          = transport foundation
```

The goal is a modular browser application with real compatibility, not a second browser engine.
