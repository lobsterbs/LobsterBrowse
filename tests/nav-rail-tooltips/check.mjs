import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* Nav rail tooltip placement (#262 follow-up, reported 2026-11-20):
   hovering a rail button showed its tooltip UNDER the button, over the
   next button. Root cause: m3e-tooltip accepts exactly above / below /
   before / after and silently resets any other position value to
   "below" (@m3e/web 2.8.2 dist/tooltip.js, isTooltipPosition + the
   changedProperties reset), so the old position="right" meant "below".
   The rail owns the side placement with position="after" (inline
   after = right in LTR), which puts the tooltip beside the rail, over
   no rail button, covering nothing behind it. */

const ui = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "src");

const app = readFileSync(join(ui, "App.tsx"), "utf8");

/* 1. All four rail tooltips sit at the After side, attached to the four rail items. */
for (const [id, label] of [
  ["nav-home", "Home"],
  ["nav-browse", "Browse"],
  ["nav-ai", "AI"],
  ["nav-settings", "Settings"],
]) {
  const re = new RegExp(`<m3e-tooltip for="${id}" position="after">${label}</m3e-tooltip>`);
  assert.ok(re.test(app), `rail tooltip ${id} is positioned after (the rail side)`);
}

/* 2. No tooltip anywhere may carry a position outside the component
   enum: an invalid value silently means "below" (the reported bug). */
const VALID = ["above", "below", "before", "after"];
const files = readdirSync(ui, { recursive: true }).filter((f) => /\.[t]sx$/.test(f));
let seen = 0;
for (const f of files) {
  const src = readFileSync(join(ui, String(f)), "utf8");
  for (const m of src.matchAll(/<m3e-tooltip\b[^>]*>/g)) {
    const tag = m[0];
    const pos = /position="([^"]*)"/.exec(tag);
    assert.ok(pos, `${f}: tooltip tag carries a position (${tag})`);
    assert.ok(
      VALID.includes(pos[1]),
      `${f}: tooltip position "${pos[1]}" is not in the m3e enum ${VALID.join("/")} (a bad value silently renders below)`
    );
    seen++;
  }
}
assert.ok(seen >= 10, `scanned a real tooltip population (${seen} tags)`);

/* 3. The rail tooltip fix travels with its anchor contract: the four
   tooltips reference items that exist as rail buttons. */
for (const id of ["nav-home", "nav-browse", "nav-ai", "nav-settings"]) {
  assert.ok(app.includes(`id="${id}"`), `rail item ${id} exists`);
}

console.log("nav-rail-tooltips: all checks passed");
