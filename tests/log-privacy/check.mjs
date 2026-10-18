/* Regression check for the client log ring's privacy invariants
   (#108 incognito separation, #111 centralized URL redaction).
   Run from the repo root:

     node --experimental-strip-types tests/log-privacy/check.mjs

   #108: incognito diagnostics live in a separate throwaway ring that
   is discarded on exit; no flush (debounce, pagehide, clear) can ever
   write them into the persistent lobsterbrowse-logs key.
   #111: pushLog is the redaction boundary - raw destination URLs
   (secret query values, user-info credentials, JWTs) never persist
   even when a caller forgets sanitizeUrl/sanitizeText. */

import assert from "node:assert/strict";

/* Minimal DOM stubs: store.ts reads localStorage at import time and
   uses window for the debounce timer and the pagehide flush. */
const backing = new Map();
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  key: (i) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
};
const pendingTimers = [];
globalThis.window = {
  setTimeout: (fn) => {
    pendingTimers.push(fn);
    return pendingTimers.length;
  },
  clearTimeout: () => {},
  addEventListener: () => {},
};
/* Run every scheduled debounce flush, like the 500ms elapsing (or a
   pagehide firing - both go through the same flushLogs). */
const flush = () => {
  for (const fn of pendingTimers.splice(0)) fn();
};

const store = await import("../../ui/src/store.ts");

/* Clean slate. */
store.clearLogs();

const readPersisted = () => {
  const raw = backing.get("lobsterbrowse-logs");
  return raw ? JSON.parse(raw) : [];
};

/* ---- #108: enter, log, exit, normal log, flush ---- */
store.pushLog("info", "normal before incognito");
flush();
store.setIncognitoLogging(true);
store.pushLog("info", "incognito visit https://private.example/session-page");
assert(
  store.getLogs().some((l) => l.msg.includes("private.example")),
  "incognito entries stay visible in the in-memory ring (DevTools)"
);
assert.equal(pendingTimers.length, 0, "incognito pushes schedule no flush");
store.setIncognitoLogging(false);
store.pushLog("info", "normal after incognito");
flush();
const persisted = readPersisted();
assert(
  persisted.some((l) => l.msg.includes("normal before incognito")),
  "pre-incognito entries persist"
);
assert(
  persisted.some((l) => l.msg.includes("normal after incognito")),
  "post-incognito entries persist"
);
assert(
  !persisted.some((l) => l.msg.includes("private.example")),
  "#108: incognito entries must never persist, even after exit + flush"
);
assert(
  !store.getLogs().some((l) => l.msg.includes("private.example")),
  "the discarded ring is gone from memory too"
);

/* A pagehide-equivalent flush during a NEW incognito session must
   also never write private entries (it only writes the normal ring). */
store.setIncognitoLogging(true);
store.pushLog("info", "incognito second secret");
flush();
store.setIncognitoLogging(false);
assert(
  !readPersisted().some((l) => l.msg.includes("second secret")),
  "pagehide/timeout flushes during incognito cannot persist either"
);

/* clear-logs in incognito touches only the private ring. */
store.setIncognitoLogging(true);
store.pushLog("info", "incognito transient");
store.clearLogs();
assert.equal(store.getLogs().length, 0, "clear wipes the active ring");
store.setIncognitoLogging(false);
assert(
  readPersisted().some((l) => l.msg.includes("normal after incognito")),
  "clear in incognito never wipes the persisted normal ring"
);

/* ---- #111: pushLog redacts at the boundary ---- */
store.pushLog(
  "info",
  "engine nav https://user:secretpw@example.com/reset?token=abc123DEF&ok=1 (NAV-0001, route mint 12 ms)"
);
const entry = store.getLogs().find((l) => l.msg.includes("example.com"));
assert(entry, "the nav entry was logged");
assert(
  entry.msg.includes("[redacted-userinfo]@"),
  "userinfo redacted: " + entry.msg
);
assert(!entry.msg.includes("secretpw"), "password must not persist: " + entry.msg);
assert(
  entry.msg.includes("example.com/reset"),
  "host/path context stays: " + entry.msg
);
assert(
  entry.msg.includes("token=[redacted]"),
  "secret query redacted: " + entry.msg
);
assert(!entry.msg.includes("abc123DEF"), "secret value must not persist: " + entry.msg);
assert(entry.msg.includes("ok=1"), "benign param stays: " + entry.msg);

const jwt =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV";
store.pushLog("error", "auth failed near " + jwt + " end");
const jwtEntry = store.getLogs().find((l) => l.msg.includes("redacted-jwt"));
assert(jwtEntry, "JWT-shaped values are not stored verbatim");
assert(
  !store.getLogs().some((l) => l.msg.includes("SflKxwRJS")),
  "no raw JWT segment persists"
);

console.log("log-privacy check: incognito separation + URL redaction ok");
