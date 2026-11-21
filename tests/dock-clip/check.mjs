import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* The dock toolbar reported as a square box housing the rounded
   pill (2026-11-21 report): the frosted host paints
   backdrop-filter blur, and on GPU-composited paths the blur can
   rasterize as the whole host rectangle, so a square frost read
   behind the rounded bar. The fix has two halves: a rounded
   clip-path on the toolbar host clips the composited blur to the
   pill shape, and the elevation shadow moves to the plain
   .lb-dock-pill wrapper because the clip-path would eat the
   host's own box-shadow. This check pins both halves plus the
   untouched dock contract: nothing around the dock ever paints a
   frost box. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const theme = readFileSync(join(root, "ui", "src", "theme.css"), "utf8");
const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");

const rule = (sel) => {
  const i = theme.indexOf(sel);
  assert.ok(i !== -1, "selector exists: " + sel);
  return theme.slice(i, theme.indexOf("}", i) + 1);
};

const tb = rule(".lb-toolbar {");
assert.ok(
  tb.includes("clip-path: inset(0 round 999px);"),
  "the toolbar host is pill-clipped: the frost cannot paint a square"
);
assert.ok(tb.includes("backdrop-filter: blur(24px)"), "the frost itself stays on the host");
assert.ok(!tb.includes("box-shadow"), "the host's own shadow is gone (the clip would eat it)");

const pill = rule(".lb-dock-pill {");
assert.ok(
  pill.includes("box-shadow: var(--md-sys-elevation-level5, 0 10px 36px rgba(0, 0, 0, 0.28));"),
  "the elevation token moved to the wrapper, pill-hugging"
);
assert.ok(!pill.includes("backdrop-filter"), "the wrapper never fogs a box behind the pill");
assert.ok(!rule(".lb-dock {").includes("backdrop-filter"), "the dock never paints a frost box either");
assert.ok(theme.includes(".lb-dock.tucked .lb-dock-pill {"), "the tuck contract is untouched");
assert.ok(ci.includes("../tests/dock-clip/check.mjs"), "ci.yml runs the dock-clip check");
console.log("dock-clip: all checks passed");
