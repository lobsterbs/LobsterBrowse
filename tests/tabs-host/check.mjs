/* Regression check for Zeolite #701: an extension's tabs.create() must
   reach the LB tab model instead of dead-ending with the engine's 30s
   "no tab host acknowledgement" timeout. The host parsing/mapping is a
   pure leaf module (ui/src/browser/tabsHost.ts) so bare node can
   evaluate it; the App.tsx wiring is source-contract checked.

   Run from the repo root:

     node --experimental-strip-types tests/tabs-host/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTabsCreateOp, toTabsUi } from "../../ui/src/browser/tabsHost.ts";

/* The exact Tampermonkey shape observed live on the beta origin: the
   "Get some scripts..." click sends newTab and the engine dispatches
   this create op to its UI clients. */
const op = parseTabsCreateOp({
  type: "zl:tabsOp",
  op: { op: "create", nonce: "zl-c1", props: { url: "https://www.tampermonkey.net/scripts.php" } },
});
assert.deepEqual(op, { nonce: "zl-c1", url: "https://www.tampermonkey.net/scripts.php" });

/* Shape and trust-boundary rejections. */
assert.equal(parseTabsCreateOp({ type: "zl:downloadOp" }), null);
assert.equal(parseTabsCreateOp(null), null);
assert.equal(parseTabsCreateOp(undefined), null);
assert.equal(
  parseTabsCreateOp({ type: "zl:tabsOp", op: { op: "update", nonce: "zl-c2", props: {} } }),
  null,
);
assert.equal(
  parseTabsCreateOp({ type: "zl:tabsOp", op: { op: "create", nonce: "", props: { url: "https://x.example/" } } }),
  null,
);
assert.equal(
  parseTabsCreateOp({ type: "zl:tabsOp", op: { op: "create", nonce: "zl-c3", props: { url: "javascript:alert(1)" } } }),
  null,
);
assert.equal(parseTabsCreateOp({ type: "zl:tabsOp", op: { op: "create", nonce: "zl-c4", props: {} } }), null);

/* Rooted engine-extension pages are granted navigations; off-origin
   forgeries of the zlExt/zlPageTok shape are not. */
assert.equal(
  parseTabsCreateOp({
    type: "zl:tabsOp",
    op: { op: "create", nonce: "zl-c5", props: { url: "/options.html?zlExt=abc&zlPageTok=tok-1" } },
  })?.nonce,
  "zl-c5",
);
assert.equal(
  parseTabsCreateOp({
    type: "zl:tabsOp",
    op: { op: "create", nonce: "zl-c6", props: { url: "//evil.example/options.html?zlExt=abc&zlPageTok=t" } },
  }),
  null,
);
assert.equal(
  parseTabsCreateOp({
    type: "zl:tabsOp",
    op: { op: "create", nonce: "zl-c6b", props: { url: "/\\evil.example/options.html?zlExt=abc&zlPageTok=t" } },
  }),
  null,
);

/* The sync list maps tab order and the active flag, and the nonce rides
   only on the newly created tab (Zeolite tabs.ts resolves pendingCreate
   on exactly this marker and then strips it). */
const ui = toTabsUi(
  [
    { id: 1, url: "https://a.example/", title: "A" },
    { id: 2, url: "https://www.tampermonkey.net/scripts.php", title: "" },
  ],
  2,
  (id) => (id === 2 ? "zl-c7" : undefined),
);
assert.deepEqual(ui, [
  { id: 1, index: 0, url: "https://a.example/", title: "A", active: false },
  { id: 2, index: 1, url: "https://www.tampermonkey.net/scripts.php", title: "", active: true, nonce: "zl-c7" },
]);
assert.equal("nonce" in ui[0], false);

/* Source contract: App consumes the zl:tabsOp broadcast and syncs zl:tabs
   back, so extension tabs can never dead-end on LB again. */
const app = readFileSync(new URL("../../ui/src/App.tsx", import.meta.url), "utf8");
assert.ok(app.includes("parseTabsCreateOp(ev.data)"), "App.tsx must consume zl:tabsOp (#701)");
assert.ok(app.includes('"zl:tabs"'), "App.tsx must sync the tab list back over zl:tabs (#701)");

console.log("tabs-host: ok");
