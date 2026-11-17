/* Wave 108 UI regression checks (settings redesign, user request
   2026-11-17): the Settings page is a sticky frosted side navigation
   with one section visible at a time. No capability was lost: the
   wave-80 anchor set still renders and the expansion-panel component
   language stays. */
import { readFileSync } from "node:fs";

const ui = new URL("../../ui/", import.meta.url);
const read = (p) => readFileSync(new URL(p, ui), "utf8");
let fails = 0;
const ok = (cond, label) => {
  if (cond) console.log("ok - " + label);
  else { fails++; console.log("FAIL - " + label); }
};

const page = read("src/pages/Settings.tsx");
ok(page.includes('className="lb-set-nav"'), "the settings side navigation renders");
ok(page.includes('aria-label="Settings sections"'), "the nav carries its access label");
ok(page.includes("lb-set-nav-item"), "nav items render");
ok(page.split('section === "').length - 1 >= 5, "sections gate on the active section state");
ok(page.includes('className="lb-set-section"'), "the active section renders in its own column");
for (const a of ["set-search-engine", "set-search-suggest", "set-adblock", "set-data", "set-logs"]) {
  ok(page.includes('anchorId="' + a + '"') || page.includes('id="' + a + '"'), "anchor " + a + " kept");
}
ok(page.includes("m3e-content-pane"), "the content pane host stays");
ok(page.includes("m3e-expansion-panel"), "expansion panels stay");
ok(page.includes("lb-set-inline"), "inline row cards stay");

const theme = read("src/theme.css");
ok(theme.includes(".lb-set-nav { position: sticky;"), "the nav rail is sticky");
ok(theme.includes("backdrop-filter: blur(24px) saturate(1.4);"), "the nav rail is frosted");
ok(theme.includes(".lb-set-nav-item.active {"), "the active nav item carries its pill");
ok(theme.includes(".lb-set-page { display: grid;"), "the page is the sidenav grid");
ok(theme.includes("@media (max-width: 720px)"), "narrow screens collapse the rail");
ok(theme.includes("lb-set-section-in"), "section switches animate in");
ok(theme.includes(".lb-set-nav-item { transition:"), "the nav pill crossfades its container colors");
ok(theme.includes(".lb-set-section > * { animation: none; }"), "reduced motion collapses the section entrance");

const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
ok(ci.includes("ui-wave108"), "CI runs the wave 108 check");

console.log(fails === 0 ? "ALL OK" : fails + " FAILURES");
process.exit(fails ? 1 : 0);
