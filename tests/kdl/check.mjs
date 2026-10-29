/* diagKdl (DevTools Diagnostics Copy logs, user request 2026-10-29):
   the KDL document must name the build that produced it (engine
   version line from the scoped snapshot, server build chip from
   /build) so a stale-engine capture is identifiable from its own
   export, and the existing header/stats/console/failure rows keep
   their shape. */
import assert from "node:assert/strict";
import { diagKdl, kdlStr } from "../../ui/src/kdl.ts";

const snapshot = {
  scope: { clientId: "page-a", source: "content" },
  generation: 10,
  engine: "3.0 Diamond",
  stats: {
    native: 3,
    fallback: 2,
    fallbacks: [{ ts: 1, url: "https://example.com/x.js", reason: "JS_LITERAL_REWRITE_REQUIRED" }],
  },
  events: [
    { seq: 1, ts: 1, category: "TRANSPORT", severity: "info", message: "request intercepted", stage: "REQUEST_INTERCEPTED" },
  ],
};

const doc = diagKdl(snapshot, [], [], "Diagnostics collected.", "e7a0f16 sw b489e3179d77798a");
assert(doc.includes('zeolite-diagnostics "this document" {'), "header row");
assert(doc.includes('engine "3.0 Diamond"'), "engine version row from the snapshot");
assert(doc.includes('build "e7a0f16 sw b489e3179d77798a"'), "server build chip row");
assert(doc.includes('source "content"'), "scope source row");
assert(doc.includes("generation 10"), "generation row");
assert(doc.includes('fallback "https://example.com/x.js" reason "JS_LITERAL_REWRITE_REQUIRED"'), "fallback rows");
assert(doc.includes('event "info" "TRANSPORT" "request intercepted" stage "REQUEST_INTERCEPTED"'), "event rows");

/* Older worker (no version) or failed /build: rows are omitted, never
   guessed. */
const noVersion = diagKdl({ ...snapshot, engine: undefined }, [], [], "Diagnostics collected.");
assert(!noVersion.includes("engine "), "no version, no engine row");
assert(!noVersion.includes("build "), "no chip, no build row");

/* A null snapshot (no engine identity yet) still exports the page
   console and resource failures. */
const nullSnap = diagKdl(
  null,
  [{ kind: "error", text: "boom", ts: 1 }],
  [{ kind: "script", url: "https://example.com/f.js", reason: "HTTP_ERROR", status: 404, ts: 2 }],
  "Awaiting this document engine identity.",
);
assert(nullSnap.includes("Awaiting this document engine identity."), "status line");
assert(nullSnap.includes('entry "error" "boom"'), "console entries ride a null snapshot");
assert(nullSnap.includes('fail "script" "https://example.com/f.js" reason "HTTP_ERROR" status 404'), "failure rows");

/* KDL string escaping, built from char codes so this file itself
   carries no escape-sequence landmines: quote, backslash, newline;
   controls dropped. */
const Q = String.fromCharCode(34);
const BS = String.fromCharCode(92);
assert.equal(kdlStr("a" + Q + "b" + BS + "c"), Q + "a" + BS + Q + "b" + BS + BS + "c" + Q, "quote and backslash escape");
assert.equal(kdlStr("x" + String.fromCharCode(10) + "y"), Q + "x" + BS + "ny" + Q, "newline escape");
assert.equal(kdlStr("drop" + String.fromCharCode(0) + "me"), Q + "dropme" + Q, "NUL dropped");

console.log("kdl export: engine/build stamp, console/failure rows and KDL escaping passed");
