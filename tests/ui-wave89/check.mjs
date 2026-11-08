/* Wave 89 UI regression checks: the seven reported visual bugs.
   - Tab sheet: the row list carries no inline padding of its own (the
     sheet body already pads 16px inline; the rows ran 16px past the
     sheet's right edge), the favicon avatar's frost halo is circular,
     and the sheet title carries no open-tab count.
   - DevTools: the sub-tool picker (Console / Network / Diagnostics)
     is centered, and the in-sheet cards' frost halo is rounded to the
     card shape - a square host halo read as a grey outline behind the
     console and the other tabs.
   - Settings: expansion panels carry the rounded host halo too, and
     each theme seed chip shows a colored swatch in its icon slot.
   - Home wordmark: the ASCII banner follows the exact sheet frost
     spec (52% tint, blur(28px) saturate(180%) brightness(.66)).
   - Ad sheet: the shield circle sits above the count and the body
     drops its extra inline padding, so the hero text aligns with the
     hosts card.
   - Overflow menu: plain items indent to the checkbox items' start
     line via --m3e-menu-item-padding-start.
   - Extensions: tiles carry the rounded host halo and render the
     engine-reported iconPath with an initials fallback. */
import { readFileSync } from "node:fs";
const ui = new URL("../../ui/", import.meta.url);
const read = (p) => readFileSync(new URL(p, ui), "utf8");
let fails = 0;
const ok = (cond, label) => {
  if (cond) console.log("ok - " + label);
  else { fails++; console.log("FAIL - " + label); }
};
/* Rule-scoped read: the text from the start of the selector to its
   closing brace, so a check cannot pass on a different rule. */
const block = (src, sel) => {
  const i = src.indexOf(sel);
  if (i < 0) return "";
  return src.slice(i, src.indexOf("}", i) + 1);
};
const theme = read("src/theme.css");
const extCss = read("src/extensions.css");
const tabs = read("src/browser/TabSwitcherCard.tsx");
const extPanel = read("src/browser/ExtensionsPanel.tsx");
const settings = read("src/pages/Settings.tsx");

/* 1. Tab sheet. */
const tabsRow = block(theme, ".lb-tabs-row {");
ok(tabsRow.includes("box-sizing: border-box;"), "tab rows size inside the sheet");
ok(tabsRow.includes("padding: var(--md-sys-measurement-space50) 0 16px;"), "tab rows carry no inline padding");
ok(block(theme, ".lb-tab-avatar {").includes("border-radius: 9999px;"), "tab avatar frost halo is circular");
ok(tabs.includes('<span slot="title">Tabs</span>'), "tab sheet title is plain Tabs");
ok(!tabs.includes("Tabs ({"), "count marker removed from the title");

/* 2. DevTools. */
ok(block(theme, ".lb-dt-nav {").includes("justify-content: center;"), "DevTools sub-tool picker is centered");
ok(block(theme, ".lb-dt-card,").includes("border-radius: 20px;"), "DevTools card frost halo is rounded");
const frostCards = block(theme, ".lb-dt-card,");
ok(frostCards.includes(".lb-set-result") && frostCards.includes("border-radius: 20px;"), "settings search result halo is rounded");

/* 3. Settings. */
ok(block(theme, ".lb-set-page m3e-expansion-panel {").includes("border-radius: 20px;"), "settings panel frost halo is rounded");
ok(settings.includes('slot="icon"') && settings.includes("lb-seed-dot"), "seed chips carry colored swatches in the icon slot");
ok(block(theme, ".lb-seed-dot {").includes("border-radius: 50%;"), "seed swatch is a circle");

/* 4. Home wordmark. */
const ascii = block(theme, ".lb-home pre.lb-ascii {");
ok(ascii.includes("background: var(--lb-glass-sheet-tint);"), "wordmark uses the sheet tint");
ok(ascii.includes("blur(28px) saturate(180%) brightness(.66)"), "wordmark uses the sheet frost");
ok(ascii.includes("border: var(--lb-glass-ring);"), "wordmark uses the glass ring");
ok(ascii.includes("border-radius: 20px;"), "wordmark is rounded like the sheet cards");

/* 5. Ad sheet. */
ok(block(theme, ".lb-ad-body {").includes("padding: 0 0 var(--md-sys-measurement-space150);"), "ad body carries no inline padding");
const adHero = block(theme, ".lb-ad-hero {");
ok(adHero.includes("flex-direction: column;") && adHero.includes("align-items: flex-start;"), "shield circle sits above the count");

/* 6. Overflow menu. */
ok(block(theme, "#lb-overflow-menu m3e-menu-item {").includes("--m3e-menu-item-padding-start:"), "plain overflow items indent to the checkbox start line");

/* 7. Extensions. */
ok(block(theme, ".lb-ext-tile {").includes("border-radius: 20px;"), "extension tile frost halo is rounded");
ok(extPanel.includes("iconPath?: string | null;"), "ExtInfo carries the engine icon route");
ok(extPanel.includes("{e.iconPath ? ("), "tile renders the real icon with a fallback");
ok(extPanel.includes("lb-ext-ava-img"), "tile icon image is classed for sizing");
ok(block(extCss, ".lb-ext-ava-img {").includes("border-radius: 50%;"), "tile icon is circle-cropped");

if (fails > 0) {
  console.error(fails + " wave 89 check(s) failed");
  process.exit(1);
}
console.log("ALL OK");
