/* Regression check for the LB#260 boot/diagnostics wave:
   (1) zlWaitActive skips the register() byte-check when a worker
       already controls the page (a 13.4 s register() stalled the
       first pane navigation on a slow origin while the warm worker
       answered mints in ~100 ms);
   (2) the engine nav log line recognizes BOTH keyed mint shapes
       ("/__zl_navh__/<token>" and the ZL_QUERY_ROUTES "/?zlNavh="
       form) instead of mislabeling every query mint as "legacy";
   (3) the content-origin zl:config no-ack warn only fires on a
       deployment that actually provisioned a content origin;
   (4) the Diagnostics panel keeps a merged history across pane
       navigations and renders EVERY event, not only
       errors/warnings. Run from the repo root:
   node --experimental-strip-types tests/ui-wave110/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zlHandleRoute } from "../../ui/src/zeolite.ts";
import { mergeDiagHistory } from "../../ui/src/browser/diagnosticsScope.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const z = read("../../ui/src/zeolite.ts");
const b = read("../../ui/src/pages/Browser.tsx");
const a = read("../../ui/src/App.tsx");
const d = read("../../ui/src/pages/DevTools.tsx");
const ci = read("../../.github/workflows/ci.yml");

/* (1) The controller fast path: register() only inside the
   no-controller branch. */
const waitFn = z.slice(z.indexOf("export function zlWaitActive")).slice(0, 1600);
assert.ok(waitFn.includes("if (!navigator.serviceWorker.controller) {"), "zlWaitActive gates register on a missing controller");
assert.ok(
  waitFn.indexOf("if (!navigator.serviceWorker.controller) {") < waitFn.indexOf('await navigator.serviceWorker.register("/zlsw/sw.js"'),
  "the register call sits inside the no-controller branch",
);

/* (2) Both keyed shapes are the handle form; the legacy b64u route
   and a plain path are not. */
assert.equal(zlHandleRoute("/__zl_navh__/KEYED"), true, "the path form is a handle route");
assert.equal(zlHandleRoute("/?zlNavh=KEYED"), true, "the ZL_QUERY_ROUTES query form is a handle route (the wave's mislabel)");
assert.equal(zlHandleRoute("/common/oauth2/v2.0/authorize?probe=x&zlNavh=KEYED"), true, "the query token matches mid-search");
assert.equal(zlHandleRoute("/zl/aHR0cHM6Ly9leGFtcGxlLmNvbS8"), false, "the legacy b64u route is not a handle");
assert.equal(zlHandleRoute("/"), false, "a bare app path is not a handle");
assert.ok(b.includes('const form = zlHandleRoute(href) ? "handle"'), "Browser.tsx labels routes through zlHandleRoute");

/* (3) The no-ack warn only runs when a content origin exists. */
assert.ok(
  a.includes("if (zlContentOrigin()) {\n            void zlContentConfig(mkMsg())"),
  "App.tsx gates the content-origin parity push and warn on a provisioned origin",
);

/* (4) The history merger: dedup by (clientId, seq), cross-navigation
   merge, cap, and a null snapshot passing through untouched. */
const mk = (clientId, seqs) => ({
  scope: { clientId, source: "app" },
  generation: 1,
  stats: { native: 0, fallback: 0, fallbacks: [] },
  events: seqs.map((seq) => ({ seq, ts: seq, category: "SW", severity: "info", message: "m" + seq })),
});
const nav1 = mk("client-1", [1, 2, 3]);
const nav2 = mk("client-2", [1, 2]);
let h = mergeDiagHistory([], nav1);
assert.equal(h.length, 3, "the first navigation seeds the history");
h = mergeDiagHistory(h, nav1);
assert.equal(h.length, 3, "re-polling the same snapshot deduplicates");
h = mergeDiagHistory(h, nav2);
assert.equal(h.length, 5, "the next navigation's events merge in");
assert.deepEqual(
  h.map((e) => e.clientId + ":" + e.seq),
  ["client-1:1", "client-1:2", "client-1:3", "client-2:1", "client-2:2"],
  "the history stays chronological across the navigation boundary",
);
assert.equal(mergeDiagHistory(h, null), h, "a null snapshot leaves the history untouched");
const big = mk("client-3", Array.from({ length: 1200 }, (_, i) => i + 1));
const capped = mergeDiagHistory([], big, 1000);
assert.equal(capped.length, 1000, "the history caps");

/* (4b) The panel renders every event with merged history, not the
   old error/warning-only slice. */
assert.ok(d.includes("mergeDiagHistory(historyRef.current, next)"), "the poll callback merges into the mount history");
assert.ok(!d.includes("zlNotable"), "the error/warning-only filter is gone");
assert.ok(!d.includes("slice(-25)"), "the 25-event render cap is gone");
assert.ok(d.includes("previous navigation"), "a navigation boundary divider renders");
assert.ok(d.includes("const rows = [...history].reverse();"), "every event renders newest first");

/* The ci ui job runs this check. */
assert.ok(ci.includes("../tests/ui-wave110/check.mjs"), "ci.yml runs the wave 110 check");

console.log("ui-wave110: all checks passed");
