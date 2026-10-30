/* On-device stores: browsing history, session tabs and a client-side
   technical log ring buffer. All persisted in localStorage under
   lobsterbrowse-* keys so "Delete all data" can wipe them. */

import { sanitizeText, sanitizeUrl } from "./sanitize.ts";
import { wipeAiData } from "./ai/aiStore.ts";

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
     restore - guest pages cannot read it (it lives in UI state, not
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
    /* #149: corrupted storage can hold any shape; when the
       caller expects an array (history, tabs, logs), a
       non-array value would throw in the first downstream
       .filter/.find during render. */
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
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

/* #93 Home recent sites: single-entry removal and full clear. */
export function removeHistory(url: string): string[] {
  const list = loadHistory().filter((u) => u !== url);
  writeJson(HISTORY_KEY, list);
  return list;
}

export function clearHistory(): string[] {
  writeJson(HISTORY_KEY, []);
  return [];
}

/* #99 undo: put one removed entry back at its old position. */
export function insertHistory(url: string, index: number): string[] {
  const list = loadHistory().filter((u) => u !== url);
  list.splice(Math.min(Math.max(index, 0), list.length), 0, url);
  const trimmed = list.slice(0, 200);
  writeJson(HISTORY_KEY, trimmed);
  return trimmed;
}

/* #99 undo: restore a cleared list, keeping anything visited since. */
export function restoreHistory(urls: string[]): string[] {
  const merged = Array.from(new Set([...loadHistory(), ...urls])).slice(0, 200);
  writeJson(HISTORY_KEY, merged);
  return merged;
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

/* ---- Session export/import (0.7 Zirconium) ----
   Settings (Data group) offers a local-file backup of the persisted
   session: browsing history plus the open tabs with their per-tab
   history stacks. Export follows the #111 redaction posture at this
   boundary; import never trusts the file: every URL and title is
   sanitized before it can reach storage or app state, and session
   tokens are minted fresh. */

export type SessionExport = {
  exportedAt: string;
  history: string[];
  tabs: Array<{ id: number; url: string; title: string; stack: string[]; idx: number }>;
};

export function exportSessionData(): SessionExport {
  const saved = readJson<SessionExport["tabs"]>(TABS_KEY, []);
  return {
    exportedAt: new Date().toISOString(),
    history: loadHistory().map(sanitizeUrl),
    tabs: (Array.isArray(saved) ? saved : []).map((t) => ({
      id: t.id,
      url: sanitizeUrl(t.url),
      title: sanitizeText(t.title),
      stack: (Array.isArray(t.stack) ? t.stack : [t.url]).map(sanitizeUrl),
      idx: t.idx,
    })),
  };
}

/* Returns the merged history and tabs ready to append (fresh sess,
   id 0 as a placeholder: the caller assigns fresh ids), or null when
   the decoded file is not a session export. */
export function importSessionData(raw: unknown): { history: string[]; tabs: Tab[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const hasHistory = Array.isArray(o.history);
  const hasTabs = Array.isArray(o.tabs);
  if (!hasHistory && !hasTabs) return null;
  const freshSess = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : String(Math.random()).slice(2) + String(Date.now());
  const history = hasHistory
    ? (o.history as unknown[]).filter((u): u is string => typeof u === "string").map(sanitizeUrl)
    : [];
  const tabs: Tab[] = [];
  if (hasTabs) {
    for (const t of o.tabs as unknown[]) {
      if (!t || typeof t !== "object") continue;
      const to = t as Record<string, unknown>;
      const url = typeof to.url === "string" ? sanitizeUrl(to.url) : "";
      if (!url) continue;
      const stack = Array.isArray(to.stack) && to.stack.every((u) => typeof u === "string")
        ? (to.stack as string[]).map(sanitizeUrl).filter(Boolean)
        : [url];
      const norm = stack.length > 0 ? stack : [url];
      const idx = typeof to.idx === "number" && to.idx >= 0 && to.idx < norm.length ? to.idx : norm.length - 1;
      tabs.push({
        id: 0,
        url,
        title: typeof to.title === "string" ? sanitizeText(to.title) : "",
        stack: norm,
        idx,
        sess: freshSess(),
      });
    }
  }
  /* A hostile file could carry thousands of tabs; a real export
     cannot (the browser never opens that many). Cap honestly. */
  return { history: hasHistory ? restoreHistory(history) : loadHistory(), tabs: tabs.slice(0, 100) };
}

/* ---- Client-side technical log ring ---- */

const LOGS_KEY = "lobsterbrowse-logs";
/* Incognito mode (#108): page diagnostics (console lines, resfail
   entries) reach pushLog while an incognito session is active. They
   go to a SEPARATE throwaway ring that is discarded the moment
   incognito ends - they can NEVER reach localStorage, not even after
   exit via a later normal-mode flush or a pagehide flush (those only
   ever write the normal ring). The old single shared ring leaked
   private entries into the persistent log exactly that way. */
let incognitoMode = false;
let incognitoRing: LogEntry[] = [];
export function setIncognitoLogging(on: boolean) {
  incognitoMode = on;
  /* Enter: the private ring starts empty. Exit: it is discarded -
     the entries die with the session, and nothing schedules a flush
     that could persist them (persistLogs writes logRing only). */
  incognitoRing = [];
  if (on && persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

/* The active ring: what DevTools shows and what clear/clearAll touch.
   Private entries live in the throwaway ring, normal entries in the
   persisted one; neither ever crosses into the other. */
const activeRing = () => (incognitoMode ? incognitoRing : logRing);
/* Restored from localStorage at startup: the old in-memory ring was
   wiped on every reload, which is why the Logs page showed "No client
   log entries yet" right after a hard refresh. */
let logRing: LogEntry[] = readJson<LogEntry[]>(LOGS_KEY, []).filter(
  (l) => l && typeof l.ts === "number" && typeof l.msg === "string"
);
const LOG_LIMIT = 300;

function persistLogs() {
  /* #108: only the normal ring is ever written. incognitoRing is
     unreachable here by construction: private entries go to it only
     while incognitoMode is on, and this never reads activeRing(). */
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
  /* #111: redaction is centralized at this boundary, so no call site
     can persist a raw destination URL: secret query values, URL
     user-info credentials and JWT-shaped values are stripped here
     (mirror of main.rs redact_secrets; see ui/src/sanitize.ts). */
  const safe = sanitizeText(sanitizeUrl(msg));
  const ring = activeRing();
  ring.push({ ts: Date.now(), level, msg: safe });
  if (ring.length > LOG_LIMIT) ring.shift();
  if (persistTimer === null && !incognitoMode) {
    persistTimer = window.setTimeout(flushLogs, 500);
  }
}

export function getLogs(): LogEntry[] {
  return [...activeRing()];
}

export function clearLogs() {
  activeRing().length = 0;
  /* In incognito this flushes the NORMAL ring, which the private
     session never touched - the discarded private entries can never
     be written by it. */
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
  incognitoRing = [];
  /* AI mode chats: the encrypted IndexedDB store is wiped too. */
  void wipeAiData();
}
