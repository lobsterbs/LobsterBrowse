# LobsterJet engine adapter (Phase 2 contract — IMPLEMENTED)

## How LobsterBrowse loads Scramjet today

LobsterBrowse embeds Scramjet as a full-page iframe: the tab points at
the engine service URL with `?url=<target>` (`scramjet/public/index.js`
hides its demo UI, registers the Scramjet SW, and opens the target in a
full-viewport frame). The engine owns its origin because its service
worker must control every proxied request. The UI never calls engine
APIs; it only swaps the iframe URL.

LobsterJet conforms to the same embed contract:

```
https://<lobsterjet-host>/?url=<encoded-target>
```

`app/src/main.ts` brings up the engine via the adapter, rehydrates
persisted per-site toggles, and navigates the frame to the encoded
route. No changes to LobsterBrowse are needed to present the choice:
both engines are just embed URLs.

## JS adapter

Implemented in `app/src/engine.ts` (class `LobsterJetEngine`). Field-for-field with the sketch:

```ts
export interface LobsterJetEngine {
  /** Register the SW on the engine origin, wait for control, push
   *  config (URL scheme rotation) to it. Idempotent. */
  init(config: EngineConfig): Promise<void>;
  /** Navigate to a destination (returns the engine-local route URL). */
  navigate(target: string): string;
  /** Enable/disable interception for one site (per-site toggle),
   *  acknowledged by the SW and persisted across SW restarts. */
  setSiteRoute(site: string, enabled: boolean): Promise<void>;
  /** Export session blob: per-profile cookie jar + scoped storage. */
  exportSession(): Blob;
  importSession(b: Blob): Promise<void>;
  /** Uninstall the SW, drop its caches, clear adapter state. Called
   *  when the user switches engines so nothing leaks. */
  teardown(): Promise<void>;
}

interface EngineConfig {
  wispUrl?: string;                       // default wss(s)://<origin>/wisp/
  pathScheme?: "b64u" | "mirror";        // codec rotation, default "b64u"
  pathPrefix?: string;                    // default "/j/"
  profile?: string;                       // cookie jar profile, default "default"
}
```

## Control plane (SW postMessage protocol)

Messages carry a `MessageChannel` reply port; every operation is
acknowledged, never fire-and-forget:

| message | payload | effect |
| --- | --- | --- |
| `lj:ping` | - | liveness probe |
| `lj:config` | `prefix`, `scheme` | rotate the URL shape at runtime |
| `lj:siteRoute` | `site`, `enabled` | per-site interception toggle (403 when disabled) |
| `lj:teardown` | - | drop all SW caches, `unregister()` |

## Isolation guarantees (Phase 2 acceptance)

- Storage: proxied site data is namespaced `lj:<sitehash>:` per site;
  engine-origin storage is never exposed to page code. The reverse
  origin index (`lj:origins`) is what session export enumerates.
- SW state: `teardown()` unregisters `/sw.js` and deletes every cache
  it owned, so switching engines leaves no interception active.
- Session blobs are tagged `format: "lobsterjet-session"`; a blob from
  any other engine is rejected on import.
- Per-site cookie jars: `EngineConfig.profile` selects the jar
  (`lj:jar:<profile>:<origin>`), enabling multiple accounts per site.
  The live jar syncs through the transport seam (`getCookies`/
  `setCookies` on the vendored transport) when available and is
  restored from storage otherwise.

## Keepalive / reconnect

`app/src/wisp.ts` sends a stream-0 CONTINUE heartbeat every 15 s so
idle sessions are not reclaimed; dropped sockets transparently reopen
on the next stream operation, and open streams receive `onClose` so
pages re-request rather than hang.

## Status

- Phase 2 adapter surface: implemented (engine.ts + sw.ts control plane
  + wisp.ts heartbeat/reconnect + codec rotation + session blobs).
- Pending before "done": runtime validation of the full switch path
  (Scramjet -> LobsterJet -> teardown -> Scramjet) on a real deployment,
  which also requires the Phase 1 transport vendoring to land first.
