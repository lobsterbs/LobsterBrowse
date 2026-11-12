/* Wave 90 UI regression checks: the four reported visual items.
   - Tab sheet (#240): the slotted favicon is constrained inside the
     frosted avatar instead of covering the whole 40px base, so the
     glass ring stays visible (the avatar's internal ::slotted(img)
     rule paints 100%/100% cover; a document rule outranks it).
   - AdBlock sheet (#241): the hero column and its text are
     horizontally centered instead of left-aligned.
   - Extensions sheet (#242): a failed icon load falls back to the
     initials avatar and triggers one list refresh per mount; the
     failed marks clear whenever the list identity changes, so a
     fresh token retries the real icon. No broken-image glyph.
   - DevTools (#243): the Console/Network/Diagnostics cards keep the
     rounded host frost halo but paint no container tint of their
     own (transparent over the sheet frost). */
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
const extPanel = read("src/browser/ExtensionsPanel.tsx");

/* 1. Tab sheet favicon (#240). */
const avaImg = block(theme, ".lb-tab-avatar img {");
ok(avaImg.includes("width: 20px;") && avaImg.includes("height: 20px;"), "slotted favicon is constrained to 20px");
ok(avaImg.includes("object-fit: contain;"), "favicon keeps its aspect inside the frost ring");

/* 2. AdBlock hero (#241). */
const adHero = block(theme, ".lb-ad-hero {");
ok(adHero.includes("align-items: center;"), "ad hero column is horizontally centered");
const adTxt = block(theme, ".lb-ad-hero-txt {");
ok(adTxt.includes("align-items: center;") && adTxt.includes("text-align: center;"), "ad hero text is centered");

/* 3. Extensions icon fallback (#242). */
ok(extPanel.includes("const [badIcons, setBadIcons]"), "failed icon ids are tracked");
ok(extPanel.includes("!badIcons[e.id]"), "a failed icon is not re-rendered as an img");
ok(extPanel.includes("onError={"), "the icon img handles load failure");
ok(extPanel.includes("iconRefreshedRef.current = true;"), "the error path refreshes the list once per mount");
ok(/useEffect\(\(\) => \{\s*setBadIcons\(\{\}\);\s*\}, \[props\.list\]\);/.test(extPanel), "a fresh list clears the failed marks");

/* 4. DevTools card glass (#243; wave 91 moved the contract from a
   fully transparent container, which was invisible as glass over the
   uniform sheet frost, to the light glass lift token). */
const dt91 = theme.indexOf("Wave 91 (issue #243, reopened)");
const dtWin = dt91 >= 0 ? theme.slice(dt91, dt91 + 900) : "";
ok(dtWin.includes(".lb-dt-card {") && dtWin.includes("--m3e-card-container-color: var(--lb-glass-lift);"), "DevTools cards paint the light glass lift");
ok(dtWin.includes("border-radius: 20px;") && dtWin.includes("backdrop-filter: var(--lb-glass-blur);"), "the DevTools card host keeps the halo and the blur");

if (fails > 0) {
  console.log(fails + " failing check(s)");
  process.exit(1);
}
console.log("wave 90 checks passed");
