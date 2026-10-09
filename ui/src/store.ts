/* On-device stores: browsing history, session tabs and a client-side
   technical log ring buffer. All persisted in localStorage under
   lobsterbrowse-* keys so "Delete all data" can wipe them. */

export type Tab = {
  id: number;
  url: string;
  title: string;
  /* Navigation stack: stack[idx] is the current URL. */
  stack: string[];
  idx: number;
  /* Session token: /logs is scoped to it server-side, so diagnostics
     from one tab never leak into another session's view. Generated
     client-side (crypto.randomUUID), never persisted, regenerated on
     restore — guest pages cannot read it (it lives in UI state, not
     the page). */
  sess: string;
};

export type LogEntry = { ts: number; level: "info" | "warn" | "error"; msg: string };

const HISTORY_KEY = "lobsterbrowse-history";
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

/* ---- Session tabs (persisted so the browser view can restore on reload) ----
   The full per-tab history stack and index are preserved (P0 session
   restoration): flattening to the current URL used to destroy back/
   forward history on every reload. Old saves without a valid stack are
   normalized to a single-entry stack. */

export function loadSessionTabs(): Tab[] {
  const tabs = readJson<Tab[]>(TABS_KEY, []);
  if (!Array.isArray(tabs) || tabs.length === 0) return [];
  return tabs.map((t) => {
    const stack = Array.isArray(t.stack) && t.stack.length > 0 ? t.stack.filter((u) => typeof u === "string") : [t.url];
    const idx = typeof t.idx === "number" && t.idx >= 0 && t.idx < stack.length ? t.idx : stack.length - 1;
    // Fresh session token per restored tab: persisted saves never
    // contain it, so restored tabs never inherit (or collide with) a
    // previous run's server-side log ring.
    const sess = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2) + String(Date.now());
    return { id: t.id, url: t.url, title: t.title, stack, idx, sess };
  });
}

export function saveSessionTabs(tabs: Tab[]) {
  /* sess is deliberately omitted: the session token is per-run, never
     persisted, so a restored tab starts a fresh server-side ring. */
  writeJson(TABS_KEY, tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, stack: t.stack, idx: t.idx })));
}

/* ---- Client-side technical log ring ---- */

const LOGS_KEY = "lobsterbrowse-logs";
/* Incognito mode (P0 data-flow): page diagnostics (console lines,
   resfail entries) reach pushLog while an incognito session is
   active. They stay in the in-memory ring so DevTools/Logs work, but
   they are NEVER written to localStorage — the persisted log used to
   leak incognito browsing activity into the normal profile. */
let incognitoMode = false;
export function setIncognitoLogging(on: boolean) {
  incognitoMode = on;
  if (on && persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
/* Restored from localStorage at startup: the old in-memory ring was
   wiped on every reload, which is why the Logs page showed "No client
   log entries yet" right after a hard refresh. */
let logRing: LogEntry[] = readJson<LogEntry[]>(LOGS_KEY, []).filter(
  (l) => l && typeof l.ts === "number" && typeof l.msg === "string"
);
const LOG_LIMIT = 300;

function persistLogs() {
  if (incognitoMode) return;
  writeJson(LOGS_KEY, logRing);
}

/* Persistence debounce: a busy page can push dozens of log entries per
   second (diagnostic mode logs every console line); serializing the
   ring on every push is a synchronous main-thread JSON.stringify per
   event. Writes now coalesce into one write at most every 500ms, with
   an immediate flush on clear and a best-effort flush at pagehide so
   the tail is not lost. */
let persistTimer: number | null = null;
const flushLogs = () => {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistLogs();
};
try {
  window.addEventListener("pagehide", flushLogs);
} catch {
  /* no window; persist immediately instead */
}
export function pushLog(level: LogEntry["level"], msg: string) {
  logRing.push({ ts: Date.now(), level, msg });
  if (logRing.length > LOG_LIMIT) logRing.shift();
  if (persistTimer === null && !incognitoMode) {
    persistTimer = window.setTimeout(flushLogs, 500);
  }
}

export function getLogs(): LogEntry[] {
  return [...logRing];
}

export function clearLogs() {
  logRing.length = 0;
  flushLogs();
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
  logRing.length = 0;
}
