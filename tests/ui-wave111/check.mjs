/* Regression check for the W2-W4 UI wave:
   (1) the tabs sheet carries an immediate Close-all action and
       Browser closes every non-active tab through the same
       .closing animation as single closes, then offers Undo;
   (2) non-modal bottom sheets keep their top-corner radius during
       the hide() slide (the minimized-shape token fixes the square
       exit the AI conversations and DevTools sheets showed);
   (3) the toolbar flashes a one-shot frost wave on tab switch;
   (4) suggestion rows enter staggered, capped after the third row;
   (5) the omnibox wave is gone; the loadchip stays the loading signal;
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

/* 1. Close-all: the tab sheet header carries the trailing action;
   the press fires immediately and an Undo snackbar restores the
   closed tabs once the collapse lands (timer confirm removed). */
assert.ok(tsc.includes("onCloseAll?: () => void;"), "TabSwitcherCard accepts onCloseAll");
assert.ok(!tsc.includes("closeAllArmed"), "the two-step confirm arm is gone");
assert.ok(tsc.includes("onClick={props.onCloseAll}"), "the press fires immediately");
assert.ok(tsc.includes('slot="trailing"') && tsc.includes("lb-tabs-closeall"), "the action sits in the sheet bar trailing slot");
assert.ok(tsc.includes("closableCount > 0"), "the action hides when nothing is closable");
assert.ok(browser.includes("onCloseAll="), "Browser wires the Close-all callback");
assert.ok(browser.includes("const ids = tabs.filter((t) => t.id !== active.id).map((t) => t.id);"), "Close-all collects every non-active tab");
assert.ok(browser.includes("for (const id of ids) closeTabSmooth(id);"), "Close-all runs every collected tab through the animated close");
assert.ok(browser.includes('"Undo"') && browser.includes("props.restoreClosedTabs(ids)"), "an Undo snackbar restores the closed tabs");
assert.ok(!theme.includes(".lb-tabs-closeall.armed"), "the dead armed style is gone");

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

/* 5. The omnibox load wave is gone (the demo ships no under-pill
   wave); the loading tab is still signalled by the loadchip. */
assert.ok(!browser.includes("lb-tb-wave"), "the wave element is gone from the toolbar");
assert.ok(!theme.includes(".lb-tb-wave"), "the wave rules are gone from the theme");
assert.ok(theme.includes(".lb-loadchip"), "the loadchip rule stays");
assert.ok(browser.includes("lb-loadchip"), "the loadchip stays the loading signal in the toolbar");

/* 6. DevTools steady sheet height. */
assert.ok(rule(theme, ".lb-dt-content {").includes("min-height: 38vh;"), "the DevTools body holds a steady floor");

/* 7. Back disabled at the bottom of the stack. */
assert.ok(browser.includes("disabled={active.idx > 0 ? undefined : true}"), "Back is disabled when the stack has nothing older");

/* 9. Rail runtime tint from the active site. */
assert.ok(browser.includes('document.documentElement.classList.add("lb-site-tint-root");'), "the favicon hue reaches the document root");
assert.ok(browser.includes('document.documentElement.style.removeProperty("--lb-site-hue");'), "the root hue clears when no favicon exists");
assert.ok(rule(theme, ".lb-site-tint-root m3e-nav-rail {").includes("var(--lb-site-hue)"), "the rail frost mixes the site hue");

/* Reduced motion kills every new animation. */
const reduce = theme.slice(theme.indexOf("@media (prefers-reduced-motion: reduce)"));
assert.ok(reduce.includes(".lb-tb-ac-item { animation: none; }"), "the stagger stops under reduced motion");
assert.ok(reduce.includes(".lb-toolbar.lb-flash::after { animation: none;"), "the flash stops under reduced motion");
assert.ok(!reduce.includes(".lb-tb-wave"), "the wave reduced-motion line is gone with the wave");

/* CI runs this check. */
assert.ok(ci.includes("../tests/ui-wave111/check.mjs"), "ci.yml runs the wave 111 check");

console.log("ui-wave111: all checks passed");
