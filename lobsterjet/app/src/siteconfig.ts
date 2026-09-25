/* SiteConfig (Phase 3): per-site rules loaded from /siteconfig.json at
   engine origin. Every compat-suite failure becomes a rule here, never
   a hardcoded branch in the rewriter or SW.

   Shape (all fields optional):
   {
     "rules": {
       "youtube.com":  { "inject": ["/hooks/yt.js"],
                         "block":  ["ad.doubleclick.net"],
                         "plugins": ["strip-trackers"] }
     }
   }

   Matching: longest host-suffix wins (youtube.com matches
   www.youtube.com and music.youtube.com, but a more specific key
   like music.youtube.com wins over youtube.com). */

export interface SiteRule {
  /** Script paths (engine-origin) injected into <head> after the
      bootstrap, userscript-style. */
  inject?: string[];
  /** Hosts whose subresource tags are dropped at rewrite time. */
  block?: string[];
  /** Plugin module names: loaded from /plugins/<name>.js. */
  plugins?: string[];
}

export type SiteRules = Record<string, SiteRule>;

let cached: Promise<SiteRules> | null = null;

/** Fetch (and memoize for the SW lifetime) the site rules. A missing or
    malformed file means "no rules": the engine must still work. */
export function siteRules(): Promise<SiteRules> {
  if (!cached) {
    cached = (async () => {
      try {
        const resp = await fetch("/siteconfig.json", { cache: "no-cache" });
        if (!resp.ok) return {};
        const data = (await resp.json()) as { rules?: SiteRules };
        return data.rules ?? {};
      } catch {
        return {};
      }
    })();
  }
  return cached;
}

/** Host of a target URL, lowercase; null for unparseable input. */
function hostOf(target: string): string | null {
  try {
    return new URL(target).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Longest host-suffix match for a target URL. Empty rule when none. */
export function ruleFor(rules: SiteRules, target: string): SiteRule {
  const host = hostOf(target);
  if (!host) return {};
  let best: string | null = null;
  for (const key of Object.keys(rules)) {
    const k = key.toLowerCase();
    if (host === k || host.endsWith("." + k)) {
      if (best === null || k.length > best.length) best = k;
    }
  }
  return best ? rules[best] : {};
}
