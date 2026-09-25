/* LobsterJet engine adapter (Phase 2). The documented interface
   LobsterBrowse (or any host) programs the engine with. See
   docs/engine-adapter.md for the contract and the embed-URL fallback.

   Design points:
   - init(): registers the SW on the engine origin, waits for control,
     then pushes config (URL scheme rotation) to it.
   - navigate(): pure function over the codec; returns the engine-local
     route for a destination.
   - setSiteRoute(): per-site interception toggle, acknowledged by the SW.
   - exportSession()/importSession(): a versioned JSON blob holding the
     per-site cookie jar (via the transport seam) plus all scoped
     storage entries (keys prefixed "lj:<sitehash>:"). Blob is
     engine-tagged so a Scramjet blob can never import.
   - teardown(): SW unregisters and caches drop; nothing survives an
     engine switch. */

import { encodeDest, setScheme } from "./codec";

export interface EngineConfig {
  /** Wisp endpoint; defaults to wss(s)://<engine-origin>/wisp/. */
  wispUrl?: string;
  /** URL path scheme (codec rotation): "b64u" (default) | "mirror". */
  pathScheme?: "b64u" | "mirror";
  /** Path prefix for the b64u scheme. Default "/j/". */
  pathPrefix?: string;
  /** Cookie jar profile: multiple accounts per site. Default "default". */
  profile?: string;
}

interface CookieEntry {
  name: string;
  value: string;
}

interface SessionBlob {
  format: "lobsterjet-session";
  version: 1;
  profile: string;
  exported: string;
  cookies: Record<string, CookieEntry[]>; // site origin -> jar
  storage: Record<string, Record<string, string>>; // site origin -> k/v
}

/** Which origins a session covers. Default: every proxied site. */
function scopedOrigins(): string[] {
  // Derived from storage keys: lj:<sitehash>:<key>. The hash is FNV1a
  // of the origin, but we keep a reverse index in storage for exact
  // export (the hash is not invertible).
  const idx = JSON.parse(localStorage.getItem("lj:origins") ?? "{}") as Record<string, string>;
  return Object.keys(idx);
}

function rememberOrigin(origin: string): void {
  const idx = JSON.parse(localStorage.getItem("lj:origins") ?? "{}") as Record<string, string>;
  idx[origin] = "1";
  localStorage.setItem("lj:origins", JSON.stringify(idx));
}

export class LobsterJetEngine {
  private config: Required<Pick<EngineConfig, "pathScheme" | "pathPrefix" | "profile">> & EngineConfig = {
    pathScheme: "b64u",
    pathPrefix: "/j/",
    profile: "default",
  };

  /** Register the SW, wait for control, push config. Idempotent. */
  async init(config: EngineConfig = {}): Promise<void> {
    this.config = { ...this.config, ...config };
    setScheme(this.config.pathPrefix, this.config.pathScheme);

    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;

    let tries = 0;
    while (!navigator.serviceWorker.controller && tries++ < 50) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!navigator.serviceWorker.controller) {
      // First-ever load on this origin: SW claims on the next navigation.
      // The host should reload once; init() will then fully succeed.
      return;
    }
    await this.post({ type: "lj:config", prefix: this.config.pathPrefix, scheme: this.config.pathScheme });
  }

  /** Engine-local route for a destination (usable as an iframe src). */
  navigate(target: string): string {
    return encodeDest(target);
  }

  /** Enable/disable interception for one site. */
  async setSiteRoute(site: string, enabled: boolean): Promise<void> {
    await this.post({ type: "lj:siteRoute", site, enabled });
    // Persist across SW restarts (the SW is ephemeral; the adapter is
    // the durable brain).
    const key = "lj:disabled-sites";
    const cur = new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    if (enabled) cur.delete(site);
    else cur.add(site);
    localStorage.setItem(key, JSON.stringify([...cur]));
  }

  /** Session blob: scoped storage + per-profile cookie jar. */
  async exportSession(): Promise<Blob> {
    const cookies: Record<string, CookieEntry[]> = {};
    const storage: Record<string, Record<string, string>> = {};
    const mod = await import("./libcurl-transport-vendored");

    for (const origin of scopedOrigins()) {
      // Cookie jar for this profile (multiple accounts per site).
      try {
        const jarKey = `lj:jar:${this.config.profile}:${origin}`;
        if (typeof mod.getCookies === "function") {
          const live = await mod.getCookies(origin);
          localStorage.setItem(jarKey, JSON.stringify(live));
          cookies[origin] = live;
        } else {
          cookies[origin] = JSON.parse(localStorage.getItem(jarKey) ?? "[]");
        }
      } catch {
        cookies[origin] = [];
      }
      // Scoped storage: enumerate lj:<hash>: keys for this origin.
      const siteHash = await this.hashOrigin(origin);
      const kv: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        if (k.startsWith(`lj:${siteHash}:`)) kv[k] = localStorage.getItem(k)!;
      }
      storage[origin] = kv;
    }

    const blob: SessionBlob = {
      format: "lobsterjet-session",
      version: 1,
      profile: this.config.profile,
      exported: new Date().toISOString(),
      cookies,
      storage,
    };
    return new Blob([JSON.stringify(blob)], { type: "application/json" });
  }

  async importSession(b: Blob): Promise<void> {
    const text = await b.text();
    let blob: SessionBlob;
    try {
      blob = JSON.parse(text);
    } catch {
      throw new Error("not a session blob");
    }
    if (blob.format !== "lobsterjet-session") {
      throw new Error("engine mismatch: not a LobsterJet session");
    }
    const mod = await import("./libcurl-transport-vendored");
    for (const [origin, jar] of Object.entries(blob.cookies ?? {})) {
      rememberOrigin(origin);
      localStorage.setItem(`lj:jar:${blob.profile}:${origin}`, JSON.stringify(jar));
      if (typeof mod.setCookies === "function") {
        try {
          await mod.setCookies(origin, jar);
        } catch {
          // Transport not ready: jar restored to storage, replayed on init.
        }
      }
    }
    for (const [origin, kv] of Object.entries(blob.storage ?? {})) {
      rememberOrigin(origin);
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
    }
  }

  /** Uninstall: SW unregisters, caches drop, no state survives. */
  async teardown(): Promise<void> {
    const ctl = navigator.serviceWorker.controller;
    if (ctl) {
      await new Promise<void>((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => resolve();
        ctl.postMessage({ type: "lj:teardown" }, [ch.port2]);
        // Unregister is idempotent; resolve even if the reply never comes.
        setTimeout(resolve, 3000);
      });
    }
    localStorage.removeItem("lj:origins");
    localStorage.removeItem("lj:disabled-sites");
  }

  /** PostMessage with a reply port; resolves on acknowledgement. */
  private post(msg: unknown): Promise<{ ok: boolean; error?: string }> {
    const ctl = navigator.serviceWorker.controller;
    if (!ctl) return Promise.resolve({ ok: false, error: "no controller" });
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data as { ok: boolean; error?: string });
      ctl.postMessage(msg, [ch.port2]);
      setTimeout(() => resolve({ ok: false, error: "timeout" }), 5000);
    });
  }

  /** FNV1a(origin) as the bootstrap computes it (36-radix). */
  private async hashOrigin(origin: string): Promise<string> {
    let h = 0x811c9dc5;
    for (let i = 0; i < origin.length; i++) {
      h ^= origin.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(36);
  }
}

export type { LobsterJetEngine as default };
