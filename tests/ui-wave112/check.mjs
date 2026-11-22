/* Regression check for the wave-112 settings + toolbar redesign:
   (1) the settings search filter is GONE (user request under wave
       113): no SETTING_INDEX, no filter field, no hit list, none of
       their CSS; the result anchors themselves stay;
   (2) the theme controls live in an always-open hero card at the top
       of Appearance;
   (3) under 720px the section card rail swaps for an M3eSelect
       dropdown;
   (4) the browser toolbar reads three zones (lead / omnibox pill /
       trail) and Back + Forward form a tonal pair.
   Run from the repo root:
   node --experimental-strip-types tests/ui-wave112/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const settings = read("../../ui/src/pages/Settings.tsx");
const browser = read("../../ui/src/pages/Browser.tsx");
const theme = read("../../ui/src/theme.css");
const ci = read("../../.github/workflows/ci.yml");

const rule = (src, sel) => {
  const i = src.indexOf(sel);
  assert.ok(i !== -1, "selector exists: " + sel);
  return src.slice(i, src.indexOf("}", i) + 1);
};

/* 1. No settings search: the wave-112 filter is retired. */
assert.ok(!settings.includes("SETTING_INDEX"), "the settings search index is gone");
assert.ok(!settings.includes("SettingHit"), "the hit type is gone");
assert.ok(!settings.includes("Search settings"), "the filter field is gone");
assert.ok(!settings.includes("lb-set-hits"), "the hits list is gone");
assert.ok(!settings.includes("lb-set-hit"), "the hit buttons are gone");
assert.ok(!settings.includes("jumpTo"), "the jump machinery is gone");
assert.ok(!settings.includes("jumpTick"), "the jump counter is gone");
assert.ok(settings.includes('anchorId="'), "the result anchors themselves stay");
assert.ok(!theme.includes(".lb-set-search"), "the search field CSS is gone");
assert.ok(!theme.includes(".lb-set-hit"), "the hit CSS is gone");

/* 2. Theme hero: plain div, anchor kept, panel id gone. */
assert.ok(settings.includes('className="lb-set-hero"'), "hero card rendered");
assert.ok(!settings.includes('id="p-theme-color"'), "the old p-theme-color panel id is gone");
assert.ok(settings.includes('<div className="lb-set-anchor" id="set-theme-color" tabIndex={-1} />'), "the set-theme-color anchor kept");
const heroStart = settings.indexOf("<div className=\"lb-set-hero\">");
const heroEnd = settings.indexOf("</div>", settings.indexOf("lb-seed-row", heroStart));
assert.ok(heroStart !== -1 && heroEnd !== -1 && heroEnd > heroStart, "hero wraps the seed row");
assert.ok(settings.slice(heroStart, heroEnd).includes("lb-seed-row"), "seed chips live inside the hero");
assert.ok(settings.slice(heroStart, heroEnd).includes('aria-label="Theme color"'), "color input lives inside the hero");

/* 3. The hero is styled in the glass family. */
const hero = rule(theme, ".lb-set-hero {");
assert.ok(hero.includes("var(--lb-glass") || hero.includes("surface-container"), "hero uses the app surface family");

/* 4. Narrow screens: card rail out, dropdown in. */
assert.ok(settings.includes('className="lb-set-nav-drop"'), "dropdown rendered in the page");
const m720 = theme.indexOf("@media (max-width: 720px)");
assert.ok(m720 !== -1, "720px block exists");
const m720Body = theme.slice(m720, theme.indexOf("}", theme.indexOf(".lb-set-nav-drop", m720)) + 1);
assert.ok(m720Body.includes(".lb-set-nav { display: none; }"), "the card rail hides under 720px");
assert.ok(m720Body.includes(".lb-set-nav-drop { display: block; grid-column: 1 / -1; }"), "the dropdown swaps in under 720px");
assert.ok(theme.includes(".lb-set-nav-drop { display: none; }"), "the dropdown hides on wide screens");
assert.ok(!theme.includes(".lb-set-nav-sub { display: none; }"), "the old nav-sub hiding rule is gone");

/* 5. Toolbar zones: lead + trail spans, tonal nav pair. */
assert.ok(browser.includes('<span className="lb-tb-zone lb-tb-lead">'), "lead zone opens after the toolbar open tag");
assert.ok(browser.includes('<span className="lb-tb-zone lb-tb-trail">'), "trail zone opens after the omnibox pill");
const toolbarStart = browser.indexOf("<m3e-toolbar");
const toolbarEnd = browser.indexOf("</m3e-toolbar>", toolbarStart);
const toolbarBody = browser.slice(toolbarStart, toolbarEnd);
const opens = toolbarBody.split("<span").length - 1;
const closes = toolbarBody.split("</span>").length - 1;
/* Self-closing spans (<span ... />) need no close tag; strip them. */
const selfclosing = (toolbarBody.match(/<span[^>]*\/>/g) || []).length;
assert.ok(opens - selfclosing === closes, "toolbar spans balance (opens " + opens + ", self-closing " + selfclosing + ", closes " + closes + ")");
assert.ok(toolbarBody.indexOf("lb-tb-lead") < toolbarBody.indexOf('className={"lb-tb-pill"'), "lead zone precedes the omnibox pill");
assert.ok(toolbarBody.indexOf("lb-tb-trail") > toolbarBody.indexOf('className={"lb-tb-pill"'), "trail zone follows the omnibox pill");
assert.ok(toolbarBody.indexOf('<span className="lb-tb-nav">') < toolbarBody.indexOf('id="lb-back-btn"'), "the nav pair wraps Back");
assert.ok(toolbarBody.indexOf("</span>") > toolbarBody.indexOf('for="lb-forward-btn"'), "the nav pair closes after Forward");

const zone = rule(theme, ".lb-tb-zone");
assert.ok(zone.includes("display: flex;") && zone.includes("gap: var(--md-sys-measurement-space100, 8px);"), "zone groups with the toolbar gap");
const nav = rule(theme, ".lb-tb-nav");
assert.ok(nav.includes("display: flex;"), "nav pair is a flex row");
const navBtn = rule(theme, ".lb-tb-nav m3e-icon-button");
assert.ok(navBtn.includes("--m3e-icon-button-container-color: var(--md-sys-color-secondary-container);"), "Back and Forward carry the tonal container");

/* 6. The zone wrappers add no motion. */
assert.ok(!zone.includes("transition") && !zone.includes("animation"), "zone wrappers add no motion");

/* 7. CI wiring: the wave gate runs on every push. */
assert.ok(
  ci.includes("node --experimental-strip-types ../tests/ui-wave112/check.mjs"),
  "ci runs the wave-112 gate",
);

console.log("ui-wave112: all checks passed");
