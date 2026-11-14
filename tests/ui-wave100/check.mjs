/* Regression check for wave 100: DevTools sheet declutter and the
   Settings hero engine badge (user request 2026-11-13).
   - Console and Network render bare like Diagnostics: the filled
     cards are gone, content sits directly in the sheet.
   - The console log-level filter chips are removed (text filter only).
   - All three pages stay mounted; the sub-tool switch toggles
     [hidden], so flipping sub-tools does not unmount and remount.
   - The engine surfaces poll only while their page is open.
   - Settings: the About hero carries the engine badge again. */
import { readFileSync } from "node:fs";
const ui = new URL("../../ui/", import.meta.url);
const read = (p) => readFileSync(new URL(p, ui), "utf8");
let fails = 0;
const ok = (cond, label) => {
  if (cond) console.log("ok - " + label);
  else { fails++; console.log("FAIL - " + label); }
};

const dt = read("src/pages/DevTools.tsx");
ok(!dt.includes("lb-dt-chips"), "console filter chips removed");
ok(!dt.includes("levelFilter"), "the level filter state is gone");
ok(!dt.includes('aria-label="Console output"'), "console renders bare, no output card");
ok(!dt.includes('aria-label="Network requests"'), "network renders bare, no card");
ok(!dt.includes("not a network tap"), "network explainer paragraph removed");
ok(dt.split('className="lb-dt-page"').length - 1 === 3, "all three pages stay mounted, [hidden]-toggled");
ok(dt.includes('active={dt.page === "network"}'), "the download registry polls only while Network is open");
ok(dt.includes("active: boolean"), "engine surfaces gate polling on the visible page");
ok(dt.includes("m3e-card"), "the download registry card remains");

const settings = read("src/pages/Settings.tsx");
ok(settings.includes("lb-hero-engine"), "the About hero carries the engine badge");
ok(settings.includes('"ScramJet" : "Zeolite"'), "the badge names the running proxy engine");

const theme = read("src/theme.css");
ok(theme.includes(".lb-dt-page { display: flex; flex-direction: column; gap: 18px; }"), "page sections keep the sheet rhythm");
ok(theme.includes(".lb-dt-page[hidden] { display: none; }"), "hidden pages do not paint");
ok(theme.includes(".lb-hero-engine {"), "engine badge style restored");
ok(!theme.includes(".lb-dt-chips"), "chip css removed");
ok(theme.includes(".lb-setp-head { display: flex; flex-direction: column; gap: 2px; cursor: pointer; padding: var(--md-sys-measurement-space150) 0; }"), "panel headers gained breathing room");
ok(theme.includes("min-height: 56px;"), "inline rows grew with the panel headers");
ok(theme.includes(".lb-set-page { display: flex; flex-direction: column; gap: var(--md-sys-measurement-space300); }"), "settings cards get real separation (space300 page gap)");

const ciwf = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
ok(ciwf.includes("ui-wave100"), "ci.yml runs the wave 100 check");

console.log(fails === 0 ? "ALL OK" : fails + " FAILURES");
process.exit(fails ? 1 : 0);
