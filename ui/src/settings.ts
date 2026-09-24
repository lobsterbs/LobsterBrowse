/* Persisted settings. Stored on-device in localStorage (a small
   browser-local file) — nothing is ever sent to the server. */
export type Settings = {
  seed: string;
  adblock: boolean;
  trackers: boolean;
  spoofUa: boolean;
  stripReferrer: boolean;
  udp: boolean;
  httpsOnly: boolean;
  webrtc: "direct" | "relay" | "disabled";
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
};

const KEY = "lobsterbrowse-settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed, seed: parsed.seed || DEFAULT_SETTINGS.seed };
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
