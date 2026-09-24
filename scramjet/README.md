# Scramjet instance for LobsterBrowse

This directory builds a standalone [Scramjet](https://github.com/MercuryWorkshop/Scramjet-App)
proxy service (AGPL) that LobsterBrowse embeds as its full-rewriting
proxy engine.

- `Dockerfile`: clones upstream Scramjet-App, overlays one patched
  file, installs with pnpm, runs `node src/index.js` on $PORT.
- `public/index.js`: upstream file plus a LobsterBrowse patch. Loading
  the client with `?url=<target>` hides the demo form and auto-navigates
  to the target inside a Scramjet frame, so the LobsterBrowse tab UI
  can embed the client in an iframe.

The service worker that performs the rewriting must own its origin, so
Scramjet cannot be served from the same origin as the LobsterBrowse UI
server; it deploys as its own Render web service.
