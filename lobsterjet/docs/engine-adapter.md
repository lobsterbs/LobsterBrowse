# LobsterJet engine adapter (Phase 2 contract)

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

`app/src/main.ts` registers the LobsterJet SW (`/sw.js`, scope `/`) and
navigates the frame to `/j/<b64url of target>`. No changes to
LobsterBrowse are needed to present the choice: both engines are just
embed URLs.

## JS adapter (for when LobsterBrowse wants programmatic control)

Aligned field-for-field with the task's sketch. Names match the embed
contract above; nothing assumes LobsterBrowse internals.

```ts
export interface LobsterJetEngine {
  /** Register the SW on the engine origin and warm the wisp socket.
   *  config.wispUrl defaults to wss://<engine-origin>/wisp/. */
  init(config: EngineConfig): Promise<void>;
  /** Navigate to a destination (returns the /j/ route URL). */
  navigate(target: string): string;
  /** Enable/disable interception for one site (per-site toggle). */
  setSiteRoute(site: string, enabled: boolean): void;
  /** Export session blob: cookies + scoped storage for this engine. */
  exportSession(): Blob;
  importSession(b: Blob): Promise<void>;
  /** Uninstall the SW and clear engine-origin state. Called when the
   *  user switches engines so nothing leaks between Scramjet and
   *  LobsterJet. */
  teardown(): Promise<void>;
}

interface EngineConfig {
  wispUrl?: string;
  /** URL path scheme (codec rotation): "b64u" (default) | "mirror". */
  pathScheme?: string;
  pathPrefix?: string; // default "/j/"
}
```

## Isolation guarantees (Phase 2 acceptance)

- Storage: proxied site data is namespaced per site (bootstrap scoping),
  engine-origin storage is never used by page code.
- SW state: teardown unregisters `/sw.js` and clears its caches, so
  switching engines leaves no interception active.
- Session blobs are engine-tagged so a Scramjet blob can never be
  imported into LobsterJet.

Status: Phase 2. The embed URL contract above already works today.
