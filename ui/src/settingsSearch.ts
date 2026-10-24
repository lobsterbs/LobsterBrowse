/* Local Settings metadata targets existing controls, including controls in
   collapsed panels. Search never sends a query to a server. */
export type SettingsSearchEntry = {
  id: string;
  section: string;
  sectionTitle: string;
  label: string;
  description: string;
};

export const SETTINGS_SEARCH: readonly SettingsSearchEntry[] = [
  { id: "setting-engine", section: "search", sectionTitle: "Search & browse", label: "Search engine", description: "Choose the search provider used by the address bar." },
  { id: "setting-suggestions", section: "search", sectionTitle: "Search & browse", label: "Engine search suggestions", description: "Show suggested queries while typing." },
  { id: "setting-ua-preset", section: "ua", sectionTitle: "User-Agent", label: "User-Agent preset", description: "Choose a browser identity preset." },
  { id: "setting-ua-custom", section: "ua", sectionTitle: "User-Agent", label: "Custom User-Agent", description: "Enter, validate and save a manual User-Agent string." },
  { id: "setting-adblock", section: "privacy", sectionTitle: "Privacy", label: "Ad & tracker blocking", description: "Block advertisements and trackers with the ad blocker." },
  { id: "setting-https", section: "privacy", sectionTitle: "Privacy", label: "HTTPS upgrade", description: "Upgrade HTTP page links to encrypted HTTPS before fetching." },
  { id: "setting-extension-find", section: "extensions", sectionTitle: "Extensions", label: "Find and install add-ons", description: "Search Mozilla AMO for browser extensions." },
  { id: "setting-extension-import", section: "extensions", sectionTitle: "Extensions", label: "Import package", description: "Install a local extension from an XPI or ZIP file." },
  { id: "setting-theme", section: "appearance", sectionTitle: "Appearance", label: "Theme color", description: "Choose the accent color or a palette seed." },
  { id: "setting-background", section: "appearance", sectionTitle: "Appearance", label: "Enhanced UI (animated background)", description: "Enable the Home page starfield and pointer parallax." },
  { id: "setting-cloak-enabled", section: "cloak", sectionTitle: "Auto Cloak", label: "Cloak when the tab is hidden", description: "Hide the app when switching away from this browser tab." },
  { id: "lb-ti-cloak-destination", section: "cloak", sectionTitle: "Auto Cloak", label: "Cloak destination", description: "The harmless website staged while the app is hidden." },
  { id: "lb-ti-tab-title-while-cloaked", section: "cloak", sectionTitle: "Auto Cloak", label: "Tab title while cloaked", description: "The browser tab name shown while the app is hidden." },
  { id: "setting-about-blank", section: "cloak", sectionTitle: "Auto Cloak", label: "Open in about:blank", description: "Open the app in a new window with an about:blank address." },
  { id: "setting-proxy-engine", section: "advanced", sectionTitle: "Advanced", label: "Proxy engine", description: "Choose Zeolite or ScramJet for the next navigation." },
  { id: "setting-transport", section: "advanced", sectionTitle: "Advanced", label: "Transport engine", description: "Choose libcurl or experimental epoxy TLS transport." },
  { id: "setting-export", section: "advanced", sectionTitle: "Advanced", label: "Export session", description: "Back up persisted history and open tabs to a local JSON file." },
  { id: "setting-import", section: "advanced", sectionTitle: "Advanced", label: "Import session", description: "Restore history and open tabs from a saved JSON backup." },
  { id: "setting-data", section: "advanced", sectionTitle: "Advanced", label: "Manage data", description: "Clear the proxied page cache or delete all stored history, sessions and settings." },
  { id: "setting-logs", section: "advanced", sectionTitle: "Advanced", label: "Open Logs", description: "View diagnostic messages and errors." },
];

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function searchSettings(query: string): SettingsSearchEntry[] {
  const normalized = normalize(query);
  if (!normalized) return [];
  const terms = normalized.split(/\s+/);
  return SETTINGS_SEARCH.filter((entry) => {
    const text = normalize(entry.sectionTitle + " " + entry.label + " " + entry.description);
    return terms.every((term) => text.includes(term));
  }).sort((a, b) => {
    const score = (entry: SettingsSearchEntry) => {
      const label = normalize(entry.label);
      return label === normalized ? 2 : label.includes(normalized) ? 1 : 0;
    };
    return score(b) - score(a);
  });
}
