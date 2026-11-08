/* Wave 84 UI regression checks: #235 AI attachment peek floats
   above the bar and image-only sends work, #236 the ad-blocking card
   is a bottom sheet, #237 the search-engine picker is a select,
   #239 the DevTools sub-tool picker is a tonal pill row. Static
   asserts over the sources; the full gates are tsc and the vite
   build in CI. */
import { readFileSync } from "node:fs";

const ui = new URL("../../ui/", import.meta.url);
let fails = 0;
function ok(cond, label) {
  if (cond) console.log("OK " + label);
  else { console.error("FAIL " + label); fails++; }
}
const src = (p) => readFileSync(new URL(p, ui), "utf8");

const ai = src("src/pages/Ai.tsx");
ok(ai.includes("if ((!text && files.length === 0) || busy) return;"), "#235 send guard allows attachment-only turns");
ok(!ai.includes("if (!text || busy) return;"), "#235 old send guard retired");
ok(ai.includes('? [{ type: "text", text: withFiles }]'), "#235 parts array is conditional");

const theme = src("src/theme.css");
ok(theme.includes(".lb-ai-att-peek"), "#235 peek style present");
ok(!/\.lb-ai-att-peek[^}]*inset:\s*0/.test(theme), "#235 peek no longer overlays the input");
ok(theme.includes("bottom: calc(100% + var(--md-sys-measurement-space50, 4px))"), "#235 peek floats above the bar");
ok(!theme.includes(".lb-ad-card"), "#236 ad card css retired");
ok(theme.includes(".lb-ad-body"), "#236 sheet body css present (the sheet surface is the global wave-88 sheet rule)");
ok(theme.includes(".lb-ad-hero"), "#236 hero row css present");
ok(theme.includes(".lb-ad-foot { width: 100%; }"), "#236 footer css present");
ok(!theme.includes(".lb-dt-bgroup"), "#239 button-group css retired");
ok(theme.includes(".lb-dt-nav {"), "#239 nav row css present");
ok(!/^\.lb-set-search \{ margin:/m.test(theme), "#238 dead unscoped set-search margin removed");

const ad = src("src/browser/AdBlockCard.tsx");
ok(ad.includes("<m3e-bottom-sheet"), "#236 ad blocking is a bottom sheet");
ok(ad.includes("open: boolean"), "#236 open prop present");
ok(!ad.includes("closing?:"), "#236 closing prop retired");
ok(ad.includes("lb-ad-hero"), "#236 hero row markup present");
ok(ad.includes('variant="tonal"'), "#236 tonal footer button");
ok(ad.includes("if (!props.open) return;"), "#236 poll gated on open");

const browser = src("src/pages/Browser.tsx");
ok(browser.includes("<AdBlockCard") && browser.includes("open={adOpen}"), "#236 sheet mounted with open prop");
ok(!browser.includes("adMounted"), "#236 mount-stay state retired");

const settings = src("src/pages/Settings.tsx");
ok(settings.includes('import M3eSelect from "../M3eSelect";'), "#237 engine select import");
ok(settings.includes("<M3eSelect") && settings.includes('label="Search engine"'), "#237 engine select used");
ok(!settings.includes('aria-label="Search engine"'), "#237 engine segmented button retired");
ok(settings.includes("m3e-button-segment"), "#237 proxy/transport segmented rows intact");

const dt = src("src/pages/DevTools.tsx");
ok(dt.includes("lb-dt-nav"), "#239 nav row markup present");
ok(dt.includes('variant={on ? "tonal" : "text"}'), "#239 active sub-tool is a tonal pill");
ok(dt.includes('aria-current={on ? "true" : undefined}'), "#239 aria-current on the active sub-tool");
ok(!dt.includes("bgroupRef"), "#239 reconcile effect retired");

const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
ok(ci.includes("ui-wave84"), "ci wave 84 step present");

if (fails > 0) { console.error(fails + " wave-84 check(s) failed"); process.exit(1); }
console.log("wave-84 checks passed");
