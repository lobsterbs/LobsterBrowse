/* Regression check for #230: the toolbar extension card launches the
   extension UI directly; the configuration UI lives in Settings.

   The launch decision (ui/src/browser/extLaunch.ts) is a pure leaf
   module - no zeolite/store imports - so bare node can evaluate it.

   Run from the repo root:

     node --experimental-strip-types tests/ext-launch/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extLaunchPlan } from "../../ui/src/browser/extLaunch.ts";

/* An extension with an options page launches it. */
assert.deepEqual(extLaunchPlan({ optionsPath: "options.html" }), { launch: true, which: "options" });

/* No options page: no launch, and the reason must point the user at
   Settings (where the configuration UI lives now), not at the old
   toolbar detail card. */
const none = extLaunchPlan({ optionsPath: null });
assert.equal(none.launch, false);
assert.ok(String(none.reason).includes("Settings"), "the no-surface reason must point at Settings");

/* Empty-string optionsPath is treated as absent. */
assert.equal(extLaunchPlan({ optionsPath: "" }).launch, false);

/* Source contract: the toolbar card is a launcher (no config UI) and
   Settings mounts the management component. */
const panel = readFileSync(new URL("../../ui/src/browser/ExtensionsPanel.tsx", import.meta.url), "utf8");
assert.ok(panel.includes("onLaunch"), "toolbar card must launch extensions directly (#230)");
assert.ok(!panel.includes("onToggleEnabled"), "the enabled toggle moved out of the toolbar card");
assert.ok(!panel.includes("Open options page"), "the options-page button moved to Settings");
assert.ok(!panel.includes("onOpenDetail"), "the detail card moved out of the toolbar card");

const settings = readFileSync(new URL("../../ui/src/pages/Settings.tsx", import.meta.url), "utf8");
assert.ok(settings.includes("<ExtManage />"), "Settings must mount the extensions management UI");
assert.ok(settings.includes("set-manage-ext"), "the manage group needs a search-index target id");

console.log("ext-launch: ok");
