/* Persisted settings. Stored on-device in localStorage — nothing is ever
   sent to the server except the proxy query parameters the user's
   settings genuinely control. */

export type EngineId = "duckduckgo" | "brave" | "startpage" | "google" | "bing" | "mojeek";

export const ENGINES: Record<EngineId, { name: string; url: string }> = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q={q}" },
  brave: { name: "Brave", url: "https://search.brave.com/search?q={q}" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query={q}" },
  google: { name: "Google", url: "https://www.google.com/search?q={q}" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q={q}" },
  mojeek: { name: "Mojeek", url: "https://www.mojeek.com/search?q={q}" },
};

/* Proxy engine:
   - "scramjet": full rewriting proxy (Scramjet). The tab renders the
     Scramjet client (separate origin, required by its service worker),
     which rewrites all in-page traffic. Real sites work, including
     JS-heavy ones. In-page DevTools are not available cross-origin.
   - "document": server-side document fetch proxy (/p). Same-origin blob
     iframe, injected hook, in-page DevTools (console eval, network log),
     but no URL rewriting — JS-heavy sites break. */
export type ProxyEngine = "document" | "scramjet";

/* Default Scramjet instance. The service worker that rewrites traffic
   must own the origin it intercepts, so Scramjet cannot run on the same
   origin as this UI. */
export const DEFAULT_SCRAMJET_URL = "https://lobsterbrowse-scramjet.onrender.com";

/* User-Agent presets. The chosen UA string is sent to /p as the "ua"
   query parameter and applied by the server for every proxied request.
   Scramjet requests use the browser's own UA — the rewrite happens
   client-side. */
export type UaPresetId =
  | "server-default"
  | "chrome-win"
  | "firefox-linux"
  | "safari-mac"
  | "edge-win"
  | "chrome-android"
  | "safari-ios"
  | "custom";

export const UA_PRESETS: Record<Exclude<UaPresetId, "custom">, { name: string; ua: string }> = {
  "server-default": { name: "Server default", ua: "" },
  "chrome-win": {
    name: "Chrome (Windows)",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  },
  "firefox-linux": {
    name: "Firefox (Linux)",
    ua: "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0",
  },
  "safari-mac": {
    name: "Safari (macOS)",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  },
  "edge-win": {
    name: "Edge (Windows)",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  },
  "chrome-android": {
    name: "Chrome (Android)",
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  },
  "safari-ios": {
    name: "Safari (iPhone)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Mobile/15E148 Safari/604.1",
  },
};

/* Per-site rules. A rule only overrides the global setting for the
   fields it explicitly configures; the UI passes the effective values
   to /p on every navigation, so these genuinely change proxy behavior.
   Rules only apply in "document" engine mode. */
export type SiteRule = {
  domain: string;
  uaPreset?: UaPresetId;
  adblock?: boolean;
  trackers?: boolean;
};

export type Settings = {
  seed: string;
  engine: EngineId;
  /* Route searches/URLs through a proxy. */
  proxySearch: boolean;
  /* Which proxy engine renders tabs. */
  proxyEngine: ProxyEngine;
  /* Scramjet instance base URL (engine mode "scramjet"). */
  scramjetUrl: string;
  /* Strip known ad hosts from proxied documents (server-side, /p). */
  adblock: boolean;
  /* Strip known tracker hosts from proxied documents (server-side, /p). */
  trackers: boolean;
  /* Reject plain-http targets (server-side, /p). */
  httpsOnly: boolean;
  uaPreset: UaPresetId;
  uaCustom: string;
  /* Panic button: shortcut + destination. */
  panicEnabled: boolean;
  panicKeys: string;
  panicUrl: string;
  /* Auto cloak: swap the visible page when the tab is hidden. */
  cloakEnabled: boolean;
  cloakUrl: string;
  cloakTitle: string;
};

export const DEFAULT_SETTINGS: Settings = {
  seed: "#E8552F",
  engine: "duckduckgo",
  proxySearch: true,
  proxyEngine: "scramjet",
  scramjetUrl: DEFAULT_SCRAMJET_URL,
  adblock: true,
  trackers: true,
  httpsOnly: true,
  uaPreset: "chrome-win",
  uaCustom: "",
  panicEnabled: false,
  panicKeys: "Ctrl+Shift+X",
  panicUrl: "https://www.wikipedia.org/",
  cloakEnabled: false,
  cloakUrl: "https://www.wikipedia.org/",
  cloakTitle: "Wikipedia",
};

const KEY = "lobsterbrowse-settings";
const RULES_KEY = "lobsterbrowse-site-rules";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      engine: ENGINES[parsed.engine as EngineId] ? (parsed.engine as EngineId) : DEFAULT_SETTINGS.engine,
      proxyEngine:
        parsed.proxyEngine === "document" || parsed.proxyEngine === "scramjet"
          ? parsed.proxyEngine
          : DEFAULT_SETTINGS.proxyEngine,
    };
    if (!merged.scramjetUrl) merged.scramjetUrl = DEFAULT_SCRAMJET_URL;
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode) — settings stay for this session only */
  }
}

export function loadSiteRules(): SiteRule[] {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SiteRule[]) : [];
  } catch {
    return [];
  }
}

export function saveSiteRules(rules: SiteRule[]) {
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  } catch {
    /* ignore */
  }
}

/* Effective UA string for a domain (honoring per-site rules), or null
   when the server default should be used. */
export function resolveUa(s: Settings, rules: SiteRule[], domain: string): string | null {
  const rule = rules.find((r) => r.domain === domain);
  const preset = rule?.uaPreset ?? s.uaPreset;
  if (preset === "custom") {
    const custom = s.uaCustom.trim();
    return custom || null;
  }
  const ua = UA_PRESETS[preset as Exclude<UaPresetId, "custom">]?.ua ?? "";
  return ua || null;
}

/* Build the /p query string for a target URL, applying global settings
   and per-site rules. */
export function proxyParams(s: Settings, rules: SiteRule[], target: string): string {
  let domain = "";
  try {
    domain = new URL(target).hostname;
  } catch {
    domain = "";
  }
  const rule = rules.find((r) => r.domain === domain);
  const parts: string[] = [];
  if (s.adblock && rule?.adblock !== false) parts.push("ab=1");
  if (s.trackers && rule?.trackers !== false) parts.push("trk=1");
  if (s.httpsOnly) parts.push("https=1");
  const ua = resolveUa(s, rules, domain);
  if (ua) parts.push("ua=" + encodeURIComponent(ua));
  return parts.join("&");
}

export function proxyUrl(s: Settings, rules: SiteRule[], target: string): string {
  const params = proxyParams(s, rules, target);
  return "/p?url=" + encodeURIComponent(target) + (params ? "&" + params : "");
}

/* Scramjet client URL that auto-navigates to a target (LobsterBrowse
   embedding patch on the Scramjet-App client). */
export function scramjetUrl(s: Settings, target: string): string {
  const base = (s.scramjetUrl || DEFAULT_SCRAMJET_URL).replace(/\/+$/, "");
  return base + "/?url=" + encodeURIComponent(target);
}

/* Build the engine search URL for a query. */
export function searchUrl(s: Settings, query: string): string {
  const engine = ENGINES[s.engine];
  return engine.url.replace("{q}", encodeURIComponent(query));
}

/* Normalize a bare domain into a full URL. */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (input.includes("://")) return s;
  return "https://" + s;
}

/* Heuristic: a URL has a scheme, or looks like a bare domain/host
   (contains a dot, no spaces). Everything else is a search query. */
export function looksLikeUrl(s: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s)) return true;
  return /^[^\s]+\.[^\s]{2,}$/.test(s) && !s.includes(" ");
}
