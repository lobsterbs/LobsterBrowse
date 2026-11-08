/* Wave 91 UI regression checks: the glass lift sub-cards and the
   animation audit fixes.
   - Cards (#243, reopened): in-sheet sub-cards (DevTools cards,
     extension tiles, ad rows) lift lighter than the sheet surface
     with the new --lb-glass-lift token; a transparent or same-tint
     card over the uniform sheet frost read as a flat grey panel.
     Settings search results keep their 62% tint, and the opaque
     fallbacks (no backdrop-filter support, reduced transparency)
     define the lift as the solid surface.
   - Animation audit (#244): the AI typewriter caps text emits at
     ~30 per second instead of a setShown (full Markdown parse +
     sanitize) every animation frame, and the extension detail pop
     has a prefers-reduced-motion kill like the other families. */
import { readFileSync } from "node:fs";
const ui = new URL("../../ui/", import.meta.url);
const read = (p) => readFileSync(new URL(p, ui), "utf8");
let fails = 0;
const ok = (cond, label) => {
  if (cond) console.log("ok - " + label);
  else { fails++; console.log("FAIL - " + label); }
};
const block = (src, sel) => {
  const i = src.indexOf(sel);
  if (i < 0) return "";
  return src.slice(i, src.indexOf("}", i) + 1);
};
const theme = read("src/theme.css");
const ai = read("src/pages/Ai.tsx");
const extCss = read("src/extensions.css");

/* 1. The lift token exists and both opaque fallbacks define it. */
ok(theme.includes("--lb-glass-lift: color-mix(in srgb, #ffffff 7%, transparent);"), "the glass lift token is a 7% white fill");
ok(theme.split("--lb-glass-lift: var(--md-sys-color-surface-container-high, #2b2b2f);").length - 1 === 2, "both opaque fallbacks define the lift token");

/* 2. In-sheet sub-cards lift; the settings results keep their tint. */
const dt91 = theme.indexOf("Wave 91 (issue #243, reopened)");
const dtWin = dt91 >= 0 ? theme.slice(dt91, dt91 + 600) : "";
ok(dtWin.includes(".lb-dt-card {") && dtWin.includes("--m3e-card-container-color: var(--lb-glass-lift);"), "DevTools cards paint the lift");
ok(dtWin.includes("box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.06);"), "DevTools card host carries the inset top highlight");
const tile = block(theme, ".lb-ext-tile {");
ok(tile.includes("--m3e-card-container-color: var(--lb-glass-lift);"), "extension tiles paint the lift");
const adRow = block(theme, ".lb-ad-row {");
ok(adRow.includes("background: var(--lb-glass-lift);"), "the ad row paints the lift");
const frostShared = block(theme, ".lb-dt-card,");
ok(frostShared.includes("--m3e-card-container-color: var(--lb-glass-tint);") && frostShared.indexOf(".lb-set-result") >= 0, "settings search results keep their tint in the shared frost rule");

/* 3. Typewriter 30fps cap (#244). */
ok(ai.includes("const lastEmitRef = useRef(0);"), "the typewriter tracks its last emit time");
ok(ai.includes("if (now - lastEmitRef.current >= 32) {"), "text emits are gated to ~30 per second");
ok(ai.split("setShown(t.slice(0, posRef.current));").length - 1 === 1, "setShown runs only inside the throttle gate");

/* 4. Extension detail reduced-motion (#244). */
const rm = extCss.slice(extCss.indexOf("@media (prefers-reduced-motion: reduce)"));
ok(rm.includes(".lb-ext-detail { animation: none; }"), "the extension detail pop is disabled under reduced motion");

if (fails > 0) {
  console.log(fails + " failing check(s)");
  process.exit(1);
}
console.log("wave 91 checks passed");

