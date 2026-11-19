/* Regression check for the W2-W4 UI wave:
   (1) the tabs sheet carries a two-step-confirm Close-all action
       and Browser closes every non-active tab through the same
       .closing animation as single closes;
   (2) non-modal bottom sheets keep their top-corner radius during
       the hide() slide (the minimized-shape token fixes the square
       exit the AI conversations and DevTools sheets showed);
   (3) the toolbar flashes a one-shot frost wave on tab switch;
   (4) suggestion rows enter staggered, capped after the third row;
   (5) a loading tab traces a thin wavy line under the omnibox pill;
   (6) the DevTools sheet body holds a steady 38vh floor so the
       fit-detent sheet stops resizing on every sub-tool switch;
   (7) Back is disabled at the bottom of the stack;
   (8) a cache clear or data wipe fires a fullscreen hero flare;
   (9) the active site's favicon hue tints the navigation rail
       frost through the document root.
   Every new animation has a prefers-reduced-motion kill.
   Run from the repo root:
   node --experimental-strip-types tests/ui-wave111/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const browser = read("../../ui/src/pages/Browser.tsx");
const tsc = read("../../ui/src/browser/TabSwitcherCard.tsx");
const settings = read("../../ui/src/pages/Settings.tsx");
const app = read("../../ui/src/App.tsx");
const theme = read("../../ui/src/theme.css");
const ci = read("../../.github/workflows/ci.yml");

const rule = (src, sel) => {
  const i = src.indexOf(sel);
  assert.ok(i !== -1, "selector exists: " + sel);
  return src.slice(i, src.indexOf("}", i) + 1);
};

/* 1. Close-all: the tab sheet header carries the trailing action,
   the confirm arm is transient and the sheet disarms on close. */
assert.ok(tsc.includes("onCloseAll?: () => void;"), "TabSwitcherCard accepts onCloseAll");
assert.ok(tsc.includes("closeAllArmed"), "Close-all carries a two-step confirm arm");
assert.ok(tsc.includes("window.setTimeout(() => setCloseAllArmed(false), 4000)"), "the arm disarms itself after 4s");
assert.ok(tsc.includes("if (!props.open) setCloseAllArmed(false);"), "closing the sheet disarms the button");
assert.ok(tsc.includes('slot="trailing"') && tsc.includes("lb-tabs-closeall"), "the action sits in the sheet bar trailing slot");
assert.ok(tsc.includes("Tap again to confirm"), "the armed label states the stakes");
assert.ok(tsc.includes("closableCount > 0"), "the action hides when nothing is closable");
assert.ok(browser.includes("onCloseAll="), "Browser wires the Close-all callback");
assert.ok(browser.includes("for (const t of tabs) if (t.id !== active.id) closeTabSmooth(t.id);"), "Close-all runs every non-active tab through the animated close");
assert.ok(rule(theme, ".lb-tabs-closeall.armed {").includes("var(--md-sys-color-error-container)"), "the armed state reads error-toned");

/* 2. Square-exit fix: the minimized shape token keeps the top
   corners round while the open attribute is already gone. */
assert.ok(
  rule(theme, "m3e-bottom-sheet {").includes("--m3e-bottom-sheet-minimized-container-shape: var(--md-sys-shape-corner-extra-large, 28px);"),
  "the minimized sheet shape keeps the open corners: no square exit"
);

/* 3. Frost flash on tab switch. */
assert.ok(browser.includes('el.classList.add("lb-flash");'), "the active-tab change adds the flash class");
assert.ok(browser.includes("flashPrimedRef"), "the flash skips the initial mount");
assert.ok(theme.includes("@keyframes lb-frost-flash"), "the flash keyframes exist");
assert.ok(rule(theme, ".lb-toolbar.lb-flash::after {").includes("animation: lb-frost-flash 240ms"), "the flash is one-shot 240ms");

/* 4. Suggestion stagger. */
assert.ok(theme.includes("@keyframes lb-ac-item-in"), "the suggestion entry keyframes exist");
assert.ok(rule(theme, ".lb-tb-ac-item:nth-child(2) {").includes("animation-delay: 25ms;"), "row two staggers by 25ms");
assert.ok(rule(theme, ".lb-tb-ac-item:nth-child(3) {").includes("animation-delay: 50ms;"), "row three staggers by 50ms");

/* 5. Omnibox load wave: pure inline SVG, seam-free loop. */
assert.ok(browser.includes("lb-tb-wave"), "the loading tab renders the wave element");
assert.ok(browser.includes("st.loading && ("), "the wave is bound to the tab loading state");
const waveRule = rule(theme, ".lb-tb-wave {");
assert.ok(waveRule.includes("height: 3px;") && waveRule.includes("bottom: 0;"), "the wave is a thin line at the pill edge");
assert.ok(rule(theme, ".lb-tb-wave svg {").includes("width: 200%;"), "the SVG is double-wide so the 50% slide tiles");
assert.ok(browser.includes('transform="translate(60)"'), "the second SVG copy shifts by one copy: the loop is seamless");

/* 6. DevTools steady sheet height. */
assert.ok(rule(theme, ".lb-dt-content {").includes("min-height: 38vh;"), "the DevTools body holds a steady floor");

/* 7. Back disabled at the bottom of the stack. */
assert.ok(browser.includes("disabled={active.idx > 0 ? undefined : true}"), "Back is disabled when the stack has nothing older");

/* 8. Hero flash after cache clear / data wipe. */
assert.ok(settings.includes('window.dispatchEvent(new CustomEvent("lb-flash-hero"));'), "Settings fires the hero flash event");
assert.ok((settings.match(/lb-flash-hero/g) || []).length === 2, "both clear cache and delete all fire it");
assert.ok(app.includes('"lb-flash-hero"'), "App listens for the hero flash event");
assert.ok(app.includes("lb-fx-flash"), "App renders the flash overlay");
assert.ok(rule(theme, ".lb-fx-flash {").includes("pointer-events: none;"), "the flash never blocks input");
assert.ok(theme.includes("@keyframes lb-hero-flash"), "the flash keyframes exist");

/* 9. Rail runtime tint from the active site. */
assert.ok(browser.includes('document.documentElement.classList.add("lb-site-tint-root");'), "the favicon hue reaches the document root");
assert.ok(browser.includes('document.documentElement.style.removeProperty("--lb-site-hue");'), "the root hue clears when no favicon exists");
assert.ok(rule(theme, ".lb-site-tint-root m3e-nav-rail {").includes("var(--lb-site-hue)"), "the rail frost mixes the site hue");

/* Reduced motion kills every new animation. */
const reduce = theme.slice(theme.indexOf("@media (prefers-reduced-motion: reduce)"));
assert.ok(reduce.includes(".lb-tb-ac-item { animation: none; }"), "the stagger stops under reduced motion");
assert.ok(reduce.includes(".lb-toolbar.lb-flash::after { animation: none;"), "the flash stops under reduced motion");
assert.ok(reduce.includes(".lb-tb-wave { display: none; }"), "the wave hides under reduced motion");
assert.ok(reduce.includes(".lb-fx-flash { display: none; }"), "the hero flash hides under reduced motion");

/* CI runs this check. */
assert.ok(ci.includes("../tests/ui-wave111/check.mjs"), "ci.yml runs the wave 111 check");

console.log("ui-wave111: all checks passed");
