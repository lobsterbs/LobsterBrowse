/* Gate: animated icon presses (2026-11-23 report).
   The same icon buttons, given a short press flourish: the host keeps
   its scale press; the glyph itself dips and tilts briefly
   (composite-only transform, 160 ms) on every :active re-match. Has a
   reduced-motion kill. Nothing layout-affecting, nothing loops.
   Run: node --experimental-strip-types ../tests/icon-press/check.mjs */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const theme = read("../../ui/src/theme.css");
const ci = read("../../.github/workflows/ci.yml");

/* 1. The press flourish. */
assert.ok(theme.includes("m3e-icon-button:active > m3e-icon { animation: lb-icon-press 160ms"), "the glyph animates on press over a short duration");
assert.ok(theme.includes("@keyframes lb-icon-press {"), "the keyframes exist");
assert.ok(theme.includes("transform: scale(0.82) rotate(-4deg);"), "the press dips to .82 with a -4deg tilt");
assert.ok(theme.includes("m3e-icon-button:active { transform: scale(0.88); }"), "the host keeps its squish press");

/* 2. Composite-only: the keyframes touch transform alone. */
const kfStart = theme.indexOf("@keyframes lb-icon-press {");
const kfEnd = theme.indexOf("100% { transform: scale(1) rotate(0deg); }", kfStart);
assert.ok(kfStart !== -1 && kfEnd !== -1, "the keyframe steps exist");
const kf = theme.slice(kfStart, kfEnd);
for (const bad of ["width", "height", "margin", "top:", "left:"])
  assert.ok(!kf.includes(bad), "the keyframes must not animate layout: " + bad);

/* 3. Reduced motion. */
assert.ok(theme.includes("m3e-icon-button:active > m3e-icon { animation: none; }"), "reduced motion kills the press flourish");

/* 4. CI wiring. */
assert.ok(ci.includes("../tests/icon-press/check.mjs"), "ci runs the icon-press gate");
console.log("icon-press: all checks passed");
