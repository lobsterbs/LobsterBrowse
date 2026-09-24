/* On-device stores: browsing history, bookmarks, session tabs and a
   client-side technical log ring buffer. All persisted in localStorage
   under lobsterbrowse-* keys so "Delete all data" can wipe them. */

export type Bookmark = { url: string; title: string; ts: number };

export type Tab = {
  id: number;
  url: string;
  title: string;
  /* Navigation stack: stack[idx] is the current URL. */
  stack: string[];
  idx: number;
};

export type LogEntry = { ts: number; level: "info" | "warn" | "error"; msg: string };

const HISTORY_KEY = "lobsterbrowse-history";
const BOOKMARKS_KEY = "lobsterbrowse-bookmarks";
const TABS_KEY = "lobsterbrowse-tabs";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/* ---- History ---- */

export function loadHistory(): string[] {
  return readJson<string[]>(HISTORY_KEY, []);
}

export function addHistory(url: string): string[] {
  const list = loadHistory().filter((u) => u !== url);
  list.unshift(url);
  const trimmed = list.slice(0, 200);
  writeJson(HISTORY_KEY, trimmed);
  return trimmed;
}

/* ---- Bookmarks ---- */

export function loadBookmarks(): Bookmark[] {
  return readJson<Bookmark[]>(BOOKMARKS_KEY, []);
}

export function saveBookmarks(list: Bookmark[]) {
  writeJson(BOOKMARKS_KEY, list);
}

export function toggleBookmark(list: Bookmark[], url: string, title: string): Bookmark[] {
  if (list.some((b) => b.url === url)) {
    const next = list.filter((b) => b.url !== url);
    saveBookmarks(next);
    return next;
  }
  const next = [{ url, title, ts: Date.now() }, ...list];
  saveBookmarks(next);
  return next;
}

/* ---- Session tabs (restore on reload) ---- */

export function loadSessionTabs(): Tab[] {
  const tabs = readJson<Tab[]>(TABS_KEY, []);
  if (!Array.isArray(tabs) || tabs.length === 0) return [];
  return tabs.map((t) => ({ ...t, stack: [t.url], idx: 0 }));
}

export function saveSessionTabs(tabs: Tab[]) {
  writeJson(
    TABS_KEY,
    tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, stack: [t.url], idx: 0 }))
  );
}

/* ---- Client-side technical log ring ---- */

const logRing: LogEntry[] = [];
const LOG_LIMIT = 300;

export function pushLog(level: LogEntry["level"], msg: string) {
  logRing.push({ ts: Date.now(), level, msg });
  if (logRing.length > LOG_LIMIT) logRing.shift();
}

export function getLogs(): LogEntry[] {
  return [...logRing];
}

export function clearLogs() {
  logRing.length = 0;
}

/* ---- Wipe everything ---- */

export function clearAllData() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("lobsterbrowse-")) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
}

/* ---- Suggestions for the URL/search field ---- */

export function buildSuggestions(input: string, opts: { history: string[]; bookmarks: Bookmark[]; engineName: string }): string[] {
  const q = input.trim();
  if (!q) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    if (!seen.has(s) && out.length < 8) {
      seen.add(s);
      out.push(s);
    }
  };
  for (const b of opts.bookmarks) {
    if (b.title.toLowerCase().includes(q.toLowerCase()) || b.url.toLowerCase().includes(q.toLowerCase())) {
      push(b.url);
    }
  }
  for (const h of opts.history) {
    if (h.toLowerCase().includes(q.toLowerCase())) push(h);
  }
  push(q);
  return out;
}
