# AGENTS.md — LobsterBrowse

Guidance for AI agents and human contributors. Read this before changing the browser, proxy engine, UI, deployment configuration, or docs.

## Project identity
LobsterBrowse is an open-source proxy browser built around Rust/Axum, React + TypeScript, Material 3 Expressive, Wisp transport, structured DevTools diagnostics, and Zeolite integration.
Make sites work first, then improve browser-like compatibility. Do not add a headless browser or attempt to become a full Chromium/Firefox replacement.

## Repository map
- `server/` — Rust workspace.
- `server/bin/server/src/main.rs` — current Axum proxy implementation.
- `server/crates/adblock/` — network filtering.
- `ui/` — React + TypeScript + Vite.
- `ui/src/App.tsx` — application shell/global state.
- `ui/src/pages/Browser.tsx` — tabs, toolbar and frame integrations.
- `ui/src/settings.ts` — settings/defaults/migrations.
- `ui/src/store.ts` — local browser state.
- `ui/public/lobsterjet.js` — legacy /lj cache/prefetch worker retained here.
- `/zlsw/` — published Zeolite bundle.
- `/zl-ext/` and `/zl-cs/` — Zeolite extension resource routes.

## Current proxy paths
`/r/<base64url target>` and `/lj/<base64url target>` use the existing server-side rewriting path. It rewrites URL-bearing HTML/CSS/srcset surfaces and injects runtime handling for APIs such as fetch/XHR, URL-bearing element properties, history and window.open.
Redirects are followed and relative URLs are resolved against the final document URL. Non-rewritable content should stream.
Do not remove this path while NativeTransit is being developed.

## Zeolite
Zeolite is a separate reusable engine repository. LobsterBrowse consumes its published browser bundle and must not make Zeolite depend on the UI.
Always check Zeolite's actual compatibility implementation before claiming browser or extension API support.

## NativeTransit direction
NativeTransit is the long-term transport/interception architecture:

    LobsterBrowse -> Zeolite -> Transport
                              |-> NativeTransit
                              |-> RewriteFallback -> Wisp -> Network

NativeTransit should become the preferred path when the browser/runtime architecture permits it. Existing rewriting remains the compatibility escape hatch until real tests prove it can become optional.

Rules:
- Do not delete the rewriter.
- Do not duplicate Wisp/network/cookie infrastructure.
- Do not claim NativeTransit is implemented without code/tests.
- Do not add Gecko-specific implementation to NativeTransit.
- Do not turn NativeTransit into a second browser engine.
- Record native/fallback decisions and reasons.
- Preserve original URLs/content whenever possible.
- Put reusable engine fixes in Zeolite instead of LobsterBrowse-only hacks.

## Security and privacy
LobsterBrowse is a proxy, so the server necessarily sees traffic it proxies. Never describe it as server-blind.
Preserve SSRF and DNS-rebinding protection, URL/redirect validation, header safety, origin/cookie isolation, extension permissions and diagnostic redaction.
Never store authorization headers, bearer tokens, passwords, API keys or raw cookies in diagnostics.

## DevTools
DevTools is a real diagnostic surface. Events should identify trace/request ID, subsystem, severity, redacted URL, lifecycle event and concrete cause where known.
Distinguish navigation, upstream HTTP, transport, rewrite, resource, WebSocket, extension/runtime and browser/runtime failures. A normal WebSocket close is not an error.
When NativeTransit is active, the network view should show NativeTransit vs RewriteFallback and the fallback reason.

## UI rules
- No hamburger menu.
- Do not override M3E nav-rail width/overflow.
- Tabs shrink at existing thresholds instead of becoming horizontally scrollable.
- Preserve existing tab close/switch animations.
- Toolbar URL editing remains inside the center pill.
- Preserve explicit URL/caret/placeholder color fallbacks.
- Bookmarks and the old nav-rail badge are intentionally removed.
- Settings are localStorage-backed and migration-safe.
- Check `ui/src/m3e.d.ts` before adding M3E elements and follow existing custom-element ref/class patterns.

## Legacy /lj worker
`ui/public/lobsterjet.js` is the browser cache/prefetch layer retained in LobsterBrowse. It is not the standalone Zeolite engine. Do not confuse the two.

## Deployment
The application is deployed on Render. The Docker build must successfully build both the Rust server and strict TypeScript/Vite UI.
After deployment changes verify `/healthz`, UI, `/r/`, `/lj/`, `/zlsw/`, Wisp endpoints, and extension routes when relevant. Do not claim a deployment is healthy without checking it.

## Development workflow
Inspect the implementation and trace state/request flow first. Make the smallest coherent change, run applicable Rust/UI tests, inspect the diff, and update docs when behavior changes.
Test real website classes for engine changes: normal HTML, SPAs, fetch/XHR, WebSockets, modules, CSS/images, iframes, workers, redirects, authentication, MIME-sensitive resources and large responses.

## Documentation honesty
Use **Implemented**, **Partial**, **Experimental**, or **Planned**. Do not describe NativeTransit, full browser compatibility, client-side upstream fetching or extension coverage beyond what the code actually provides.

## Architecture goal
LobsterBrowse = host application + browser UI.
Zeolite = reusable interception/transport engine.
Wisp = transport foundation.
RewriteFallback = compatibility escape hatch.