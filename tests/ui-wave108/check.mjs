/* Wave 108 UI regression checks (settings redesign, user request
   2026-11-17): the Settings page is a sticky frosted side navigation
   with one section visible at a time. No capability lost: every
   #198 search target id stays and the About card stays. */
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
ok(page.split('section === "').length - 1 >= 7, "all sections gate on the active section state");
ok(page.includes('className="lb-set-section"'), "the active section renders in its own column");
ok(!page.includes("m3e-accordion"), "the accordion is gone");
ok(!page.includes('Panel id="panel-'), "the accordion panels are gone");
/* Every #198 search target must still exist as an id. */
for (const a of ["set-search-engine", "set-search-suggest", "set-adblock", "set-https",
  "set-manage-ext", "set-amo", "set-import", "set-theme-color", "set-fancy", "set-site-tint",
  "set-cloak-enabled", "set-cloak-url", "set-aboutblank", "set-proxy", "set-transport",
  "set-data", "set-logs"]) {
  ok(page.includes('id="' + a + '"'), "search target " + a + " kept");
}
ok(page.includes("SETTING_INDEX"), "the #198 settings search index stays");
ok(page.includes("lb-set-results"), "search results still render");
ok(page.includes("<ExtManage />"), "the extensions management UI stays");
ok(page.includes("lb-about-hero"), "the About hero card stays");
ok(page.includes("lb-setting-group lb-about"), "the About build card stays");
ok(page.includes("lb-build-chip"), "the build pills stay");
ok(page.includes("exportSessionData"), "session export stays");

const theme = read("src/theme.css");
ok(theme.includes(".lb-set-nav { position: sticky;"), "the nav rail is sticky");
ok(theme.includes("backdrop-filter: blur(24px) saturate(1.4);"), "the nav rail is frosted");
ok(theme.includes(".lb-set-nav-item.active {"), "the active nav item carries its pill");
ok(theme.includes(".lb-set-page { display: grid;"), "the page is the sidenav grid");
ok(theme.includes("@media (max-width: 720px)"), "narrow screens collapse the rail");
ok(theme.includes("lb-set-section-in"), "section switches animate in");
ok(theme.includes(".lb-set-nav-item { transition:"), "the nav pill crossfades its container colors");
ok(theme.includes(".lb-set-section > * { animation: none; }"), "reduced motion collapses the section entrance");

const ciwf = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
ok(ciwf.includes("ui-wave108"), "ci.yml runs the wave 108 check");

console.log(fails === 0 ? "ALL OK" : fails + " FAILURES");
process.exit(fails ? 1 : 0);
