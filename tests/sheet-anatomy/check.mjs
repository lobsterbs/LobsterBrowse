/* Sheet geometry checks: on desktop widths the bottom sheets
   (DevTools, tab switcher) center on the CONTENT column instead of
   the full viewport (the 96px navigation rail shifts the shell right
   of the true center), and the tab switcher rows follow the spec
   sketch: a 48px M3E cookie shape with the favicon inside, the tab
   title taking the rest of the row, close X at the end, no
   supporting state line. */
import { readFileSync } from "node:fs";
const root = new URL("../../", import.meta.url);
const theme = readFileSync(new URL("ui/src/theme.css", root), "utf8");
const tabs = readFileSync(new URL("ui/src/browser/TabSwitcherCard.tsx", root), "utf8");
const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
let fails = 0;
const ok = (c, l) => { if (c) console.log("ok - " + l); else { fails++; console.log("FAIL - " + l); } };

/* Centering: only at rail widths (601px and up); on phones the rail
   collapses and the sheets stay viewport-centered. */
ok(theme.includes(".lb-dt-sheet, .lb-tabs-sheet { left: calc(50% + 48px); }"), "both sheets shift to the content column center");
const sh = theme.indexOf(".lb-dt-sheet, .lb-tabs-sheet { left:");
ok(sh >= 200 && theme.slice(sh - 200, sh).includes("@media (min-width: 601px)"), "the shift is gated at 601px (rail visible)");

/* Row anatomy per the spec sketch. */
ok(tabs.includes('name="4-sided-cookie"'), "the favicon rides an M3E cookie shape");
ok(tabs.includes('class: "lb-tab-shape"'), "the shape carries the tab-shape class");
ok(!tabs.includes("lb-tabs-sub"), "the supporting state line is gone");
const shapeIdx = theme.indexOf(".lb-tab-shape {");
ok(shapeIdx !== -1 && theme.slice(shapeIdx, shapeIdx + 260).includes("--m3e-shape-size: 48px;") && theme.slice(shapeIdx, shapeIdx + 260).includes("place-items: center;"), "the shape tile is 48px and centers the favicon");
const ti = theme.indexOf(".lb-tab-row .lb-tabs-title {");
const titleBlock = ti !== -1 ? theme.slice(ti, theme.indexOf("}", ti) + 1) : "";
ok(titleBlock.includes("flex: 1;") && titleBlock.includes("text-overflow: ellipsis;"), "the title flexes to the row end and ellipsizes");
ok(tabs.includes('aria-label={"Close " + tabLabel(t)}'), "each row keeps its close X");
ok(theme.includes(".lb-tab-row.active .lb-tab-shape {"), "the active row recolors its shape");

ok(ci.includes("tests/sheet-anatomy/check.mjs"), "CI runs the sheet anatomy check");
process.exit(fails ? 1 : 0);
