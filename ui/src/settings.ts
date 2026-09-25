/* Persisted settings. Stored on-device in localStorage — nothing is ever
   sent to the server except the route query parameters the user's
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

/* User-Agent presets. The chosen UA string is sent on the /r route as
   the "ua" query parameter and applied by the server for every proxied
   request. */
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
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  },
};

/* Per-site rules. A rule only overrides the global setting for the
   fields it explicitly configures; the UI passes the effective values
   on the /r route for every navigation, so these genuinely change
   engine behavior. */
export type SiteRule = {
  domain: string;
  uaPreset?: UaPresetId;
  adblock?: boolean;
  trackers?: boolean;
};

export type ProxyEngineId = "scramjet" | "lobsterjet";

export type Settings = {
  seed: string;
  engine: EngineId;
  /* Which proxy engine routes navigations: the built-in server-side
     rewriter (scramjet) or a deployed LobsterJet service. */
  proxyEngine: ProxyEngineId;
  /* Route searches/URLs through the native engine. */
  proxySearch: boolean;
  /* Strip known ad hosts from proxied documents (server-side). */
  adblock: boolean;
  /* Strip known tracker hosts from proxied documents (server-side). */
  trackers: boolean;
  /* Reject plain-http targets (server-side). */
  httpsOnly: boolean;
  uaPreset: UaPresetId;
  uaCustom: string;
  /* Re-encode JPEG images at lower quality (server-side). */
  compressImages: boolean;
  /* Custom outbound headers, one "Name: value" per line (server-side). */
  customHeaders: string;
  /* Auto cloak: swap the visible page when the tab is hidden. */
  cloakEnabled: boolean;
  cloakUrl: string;
  cloakTitle: string;
};

export const DEFAULT_SETTINGS: Settings = {
  seed: "#E8552F",
  engine: "duckduckgo",
  proxyEngine: "lobsterjet",
  proxySearch: true,
  adblock: true,
  trackers: true,
  httpsOnly: true,
  uaPreset: "chrome-win",
  uaCustom: "",
  compressImages: true,
  customHeaders: "",
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
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      engine: ENGINES[parsed.engine as EngineId] ? (parsed.engine as EngineId) : DEFAULT_SETTINGS.engine,
      proxyEngine:
        parsed.proxyEngine === "lobsterjet" || parsed.proxyEngine === "scramjet"
          ? parsed.proxyEngine
          : DEFAULT_SETTINGS.proxyEngine,
      compressImages: parsed.compressImages === undefined ? true : Boolean(parsed.compressImages),
      customHeaders: typeof parsed.customHeaders === "string" ? parsed.customHeaders : "",
    };
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

/* Build the engine option query string for a target URL, applying
   global settings and per-site rules. */
export function proxyParams(s: Settings, rules: SiteRule[], target: string): string {
  let domain = "";
  try {
    domain = new URL(target).hostname;
  } catch {
    domain = "";
  }
  const rule = rules.find((r) => r.domain === domain);
  const parts: string[] = [];
  /* Engine options carry the lb_ prefix so the target page can keep
     query keys of its own (like ?ua= or ?ab=) without the engine
     swallowing them. */
  if (s.adblock && rule?.adblock !== false) parts.push("lb_ab=1");
  if (s.trackers && rule?.trackers !== false) parts.push("lb_trk=1");
  if (s.httpsOnly) parts.push("lb_https=1");
  if (s.compressImages) parts.push("lb_img=1");
  const ua = resolveUa(s, rules, domain);
  if (ua) parts.push("lb_ua=" + encodeURIComponent(ua));
  const hdrs = s.customHeaders.trim();
  if (hdrs) parts.push("lb_hdrs=" + b64urlEncode(hdrs.slice(0, 600)));
  return parts.join("&");
}

/* base64url of a UTF-8 string (manual, no dependencies). */
export function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

/* Decode base64url back to a UTF-8 string. */
export function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, (4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* Build the navigation route for a target URL. Both engines route
   through the same-origin server for now: when the deployment
   provides a LobsterJet engine this is where its route shape plugs
   in. Until then the built-in rewriter serves every navigation. */
export function routeUrl(s: Settings, rules: SiteRule[], target: string): string {
  void s.proxyEngine;
  const params = proxyParams(s, rules, target);
  return "/r/" + b64urlEncode(target) + (params ? "?" + params : "");
}

/* Recover the real URL from a /r/<b64> pathname ("" when invalid). */
export function decodeRoute(pathname: string): string {
  if (!pathname.startsWith("/r/")) return "";
  const seg = pathname.slice(3).split("?")[0].split("#")[0];
  try {
    return b64urlDecode(seg);
  } catch {
    return "";
  }
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
