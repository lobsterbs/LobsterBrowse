/* Engine configuration. Overridable at build time via Vite defines so a
   deployment is single-config: set LJ_WISP_URL and rebuild. */

declare const process: { env: Record<string, string | undefined> };

/** Wisp server WebSocket endpoint for this deployment. */
export const LJ_WISP_URL: string =
  (globalThis as Record<string, unknown>).LJ_WISP_URL as string ??
  ((globalThis as { location?: Location }).location?.protocol === "https:" ? "wss://" : "ws://") +
    ((globalThis as { location?: Location }).location?.host ?? "localhost:6002") +
    "/wisp/";
