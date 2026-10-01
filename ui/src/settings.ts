/* Persisted settings. Stored on-device in localStorage; nothing is
   sent to the server through routes. Settings that shape engine
   behavior reach the engine through the zl:rules push. */

/* Cookie-session id (issue #1): the server keeps one cookie jar per
   lb_sid, so deployment users no longer share a single jar. Stable per
   browser profile for normal browsing (cookies survive reloads), fresh
   and in-memory for each incognito window (its jar dies with the sid). */
const SID_KEY = "lobsterbrowse-sid";
let incSid = "";
let memSid = "";
function freshSid(): string {
  return (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Math.random()).slice(2) + String(Date.now());
}
/* Called when a new incognito window opens: its jar starts empty. */
export function resetIncognitoSid(): void {
  incSid = "";
}
/* The current incognito session id (created lazily). Used as the
   Zeolite engine's throwaway jar profile while incognito is on. */
export function incognitoSid(): string {
  return cookieSid(true);
}
function cookieSid(incognito: boolean): string {
  if (incognito) {
    if (!incSid) incSid = freshSid();
    return incSid;
  }
  if (!memSid) {
    try {
      memSid = localStorage.getItem(SID_KEY) ?? "";
      if (memSid.length < 16 || memSid.length > 64) memSid = "";
      if (!memSid) {
        memSid = freshSid();
        localStorage.setItem(SID_KEY, memSid);
      }
    } catch {
      memSid = freshSid();
    }
  }
  return memSid;
}

export type EngineId = "duckduckgo" | "brave" | "startpage" | "google" | "bing" | "mojeek";

export const ENGINES: Record<EngineId, { name: string; url: string }> = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q={q}" },
  brave: { name: "Brave", url: "https://search.brave.com/search?q={q}" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query={q}" },
  google: { name: "Google", url: "https://www.google.com/search?q={q}" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q={q}" },
  mojeek: { name: "Mojeek", url: "https://www.mojeek.com/search?q={q}" },
};

/* User-Agent presets. The chosen UA string reaches the engine
   through the zl:rules push (global or per-site) and applies from
   the next navigation. */
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
   fields it explicitly configures; the UI pushes the effective values
   to the engine (zl:rules), so they genuinely change engine
   behavior. */
export type SiteRule = {
  domain: string;
  uaPreset?: UaPresetId;
  adblock?: boolean;
};

export type Settings = {
  seed: string;
  engine: EngineId;
  /* Strip known ad and tracker hosts from proxied documents
     (engine-side). */
  adblock: boolean;
  uaPreset: UaPresetId;
  uaCustom: string;
  /* Zeolite engine jar SameSite policy (#48): "approx" has the
     engine jar emit SameSite hints it cannot know natively. */
  sameSitePolicy: "off" | "approx";
  /* Zeolite document-surface spoofing on engine-routed pages (#48). */
  fingerprintSpoof: boolean;
  /* Auto cloak: swap the visible page when the tab is hidden. */
  cloakEnabled: boolean;
  cloakUrl: string;
  cloakTitle: string;
  /* Engine-queried completions in the search fields. */
  suggestQueries: boolean;
  /* Warm the engine cache when links are hovered. */
  prefetchLinks: boolean;
  /* Tuck the toolbar and tab strip when the app is idle. */
  autoHideChrome: boolean;
  /* Diagnostic mode: log every failed resource/console message
     verbosely in the app log, and surface expected proxy
     interventions (CSP/SRI stripping) as failure entries. */
  diagnostics: boolean;
  /* M3E density: normal or compact (tighter spacing UI-wide). */
  density: "normal" | "compact";
};

export const DEFAULT_SETTINGS: Settings = {
  seed: "#E8552F",
  engine: "startpage",
  adblock: true,
  uaPreset: "chrome-win",
  uaCustom: "",
  sameSitePolicy: "off",
  fingerprintSpoof: false,
  cloakEnabled: false,
  cloakUrl: "https://www.wikipedia.org/",
  cloakTitle: "Wikipedia",
  suggestQueries: true,
  prefetchLinks: true,
  autoHideChrome: true,
  diagnostics: true,
  density: "compact",
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
      suggestQueries: parsed.suggestQueries === undefined ? true : Boolean(parsed.suggestQueries),
      prefetchLinks: parsed.prefetchLinks === undefined ? true : Boolean(parsed.prefetchLinks),
      autoHideChrome: parsed.autoHideChrome === undefined ? true : Boolean(parsed.autoHideChrome),
      diagnostics: parsed.diagnostics === undefined ? false : Boolean(parsed.diagnostics),
      sameSitePolicy: parsed.sameSitePolicy === "approx" ? "approx" : "off",
      fingerprintSpoof: parsed.fingerprintSpoof === undefined ? false : Boolean(parsed.fingerprintSpoof),
      density: parsed.density === "compact" ? "compact" : "normal",
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

/* Route prefix of the Zeolite engine. This is the single place the
   engine route shape lives; everywhere else resolves through it. */
export function engineRoutePrefix(): string {
  return "/zl/";
}

/* Build the navigation route for a target URL. Zeolite is the only
   engine: its service worker owns /zl/ routes and forwards the
   route's query string to the target, so no option params ride on
   them (settings reach the engine through the zl:rules push). */
export function routeUrl(target: string): string {
  return engineRoutePrefix() + b64urlEncode(target);
}

/* Recover the real URL from an engine route pathname ("" when
   invalid). */
export function decodeRoute(pathname: string): string {
  /* Accepts /zl/ plus the legacy /r/ and /lj/ prefixes, which the
     server now 302s to /zl/ (old history entries may still hold
     them). */
  let seg = "";
  if (pathname.startsWith("/r/")) seg = pathname.slice(3);
  else if (pathname.startsWith("/lj/")) seg = pathname.slice(4);
  else if (pathname.startsWith("/zl/")) seg = pathname.slice(4);
  else return "";
  seg = seg.split("?")[0].split("#")[0];
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

/* Engine-queried search suggestions for one engine, fetched through
   the server's /suggest endpoint (server-side to avoid CORS). Never
   throws; an aborted signal rejects with the AbortError that the
   caller swallows. Public entry: fetchSuggestions, below. */
/* Suggestion round trip: the items plus the provider that actually
   answered (the server owns the fallback chain, so the asked-for
   engine is not necessarily the source). */
export type SuggestResult = { items: string[]; source: string };

export async function suggestFrom(engine: EngineId, q: string, signal?: AbortSignal, sess?: string): Promise<SuggestResult> {
  const query = q.trim();
  if (!query) return { items: [], source: "" };
  try {
    const r = await fetch("/suggest?engine=" + encodeURIComponent(engine) + "&q=" + encodeURIComponent(query) + (sess ? "&lb_sess=" + encodeURIComponent(sess) : ""), { signal });
    if (!r.ok) return { items: [], source: "" };
    const data = (await r.json()) as { suggestions?: unknown; source?: unknown };
    const src = typeof data.source === "string" ? data.source : "";
    return {
      items: Array.isArray(data.suggestions)
        ? data.suggestions.filter((x): x is string => typeof x === "string").slice(0, 8)
        : [],
      /* Engine display name when the provider id is a known one. */
      source: (ENGINES as Record<string, { name: string }>)[src]?.name ?? src,
    };
  } catch {
    return { items: [], source: "" };
  }
}

/* Suggestions for the search bars. The server's /suggest endpoint owns
   the fallback chain (a provider can be unreachable from the server's
   network — DuckDuckGo rate-limits the Render egress — so the server
   retries Brave then Bing before answering empty). One round trip per
   keystroke; the client no longer double-fetches. */
export async function fetchSuggestions(engine: EngineId, q: string, signal?: AbortSignal, sess?: string): Promise<SuggestResult> {
  return suggestFrom(engine, q, signal, sess);
}
