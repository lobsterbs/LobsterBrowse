/* Persisted settings. Stored on-device in localStorage (a small
   browser-local file) — nothing is ever sent to the server. */

export type EngineId = "duckduckgo" | "brave" | "startpage" | "google" | "bing" | "mojeek";

export const ENGINES: Record<EngineId, { name: string; url: string }> = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q={q}" },
  brave: { name: "Brave", url: "https://search.brave.com/search?q={q}" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query={q}" },
  google: { name: "Google", url: "https://www.google.com/search?q={q}" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q={q}" },
  mojeek: { name: "Mojeek", url: "https://www.mojeek.com/search?q={q}" },
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
