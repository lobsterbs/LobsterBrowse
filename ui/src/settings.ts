/* Persisted settings. Stored on-device in localStorage (a small
   browser-local file) — nothing is ever sent to the server. */

export type EngineId = "duckduckgo" | "brave" | "startpage" | "google" | "bing" | "mojeek";

export const ENGINES: Record<EngineId, { name: string; url: string; safe: string }> = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q={q}", safe: "&kp=1" },
  brave: { name: "Brave", url: "https://search.brave.com/search?q={q}", safe: "&safety=strict" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query={q}", safe: "" },
  google: { name: "Google", url: "https://www.google.com/search?q={q}", safe: "&safe=active" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q={q}", safe: "&adlt=strict" },
  mojeek: { name: "Mojeek", url: "https://www.mojeek.com/search?q={q}", safe: "&safe=1" },
};

export type Settings = {
  seed: string;
  adblock: boolean;
  trackers: boolean;
  spoofUa: boolean;
  stripReferrer: boolean;
  udp: boolean;
  httpsOnly: boolean;
  webrtc: "direct" | "relay" | "disabled";
  engine: EngineId;
  openSearchNewTab: boolean;
  /* Route searches/URLs through the server-side fetch proxy (/p). */
  proxySearch: boolean;
  /* Open entered URLs (not searches) in a new tab. */
  urlNewTab: boolean;
  /* Request the engine's safe-search mode. */
  safeSearch: boolean;
  /* Show the feature chips on the home page. */
  showFeatureChips: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  seed: "#E8552F",
  adblock: true,
  trackers: true,
  spoofUa: true,
  stripReferrer: true,
  udp: false,
  httpsOnly: true,
  webrtc: "relay",
  engine: "duckduckgo",
  openSearchNewTab: true,
  proxySearch: true,
  urlNewTab: true,
  safeSearch: false,
  showFeatureChips: true,
};

const KEY = "lobsterbrowse-settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      seed: parsed.seed || DEFAULT_SETTINGS.seed,
      engine: ENGINES[parsed.engine as EngineId] ? parsed.engine as EngineId : DEFAULT_SETTINGS.engine,
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

/* Build the engine search URL for a query, honoring the safe-search setting. */
export function searchUrl(s: Settings, query: string): string {
  const engine = ENGINES[s.engine];
  let url = engine.url.replace("{q}", encodeURIComponent(query));
  if (s.safeSearch && engine.safe) url += engine.safe;
  return url;
}

/* Normalize a bare domain into a full URL. */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (input.includes("://")) return s;
  return "https://" + s;
}
