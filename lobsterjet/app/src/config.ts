/* Engine configuration. Overridable at build time via Vite defines so a
   deployment is single-config: set LJ_WISP_URL and rebuild. */

const g = globalThis as typeof globalThis & {
  LJ_WISP_URL?: string;
  location?: Location;
};

/** Wisp server WebSocket endpoint for this deployment. */
export const LJ_WISP_URL: string =
  g.LJ_WISP_URL ??
  ((g.location?.protocol === "https:" ? "wss://" : "ws://") +
    (g.location?.host ?? "localhost:6002") +
    "/wisp/");
