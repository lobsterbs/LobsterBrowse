/* Regression check for the wave-112 settings + toolbar redesign:
   (1) the settings pane header carries a search field over a
       SETTING_INDEX of every anchored setting; a hit jumps to the
       section and focuses the anchor;
   (2) the theme controls moved from a collapsed panel (p-theme-color)
       to an always-open hero card at the top of Appearance;
   (3) under 720px the section card rail swaps for an M3eSelect
       dropdown;
   (4) the browser toolbar reads three zones (lead / omnibox pill /
       trail) and Back + Forward form a tonal pair.
   The one new motion (the hit-button press scale) has a
   prefers-reduced-motion kill.
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

/* 1. Settings search: the index lists one entry per anchored
   setting and the header field filters it. */
const idxStart = settings.indexOf("const SETTING_INDEX");
assert.ok(idxStart !== -1, "SETTING_INDEX exists");
const idxEnd = settings.indexOf("];", idxStart);
const idxBody = settings.slice(idxStart, idxEnd);
const entries = idxBody.split("anchorId:").length - 1;
assert.ok(entries === 12, `SETTING_INDEX has 12 entries (found ${entries})`);
assert.ok(settings.includes('type SettingHit = { section: SectionId; label: string; anchorId: string };'), "SettingHit type is anchored");
assert.ok(settings.includes('className="lb-set-search-input"'), "search input rendered");
assert.ok(settings.includes('placeholder="Search settings"'), "search input carries its placeholder");
assert.ok(settings.includes('aria-label="Search settings"'), "search input labelled");
assert.ok(settings.includes("lb-set-hits"), "hits list rendered");
assert.ok(settings.includes('className="lb-set-hit"'), "hit buttons rendered");
assert.ok(settings.includes("No setting matches."), "empty-hits message exists");

/* Every index entry resolves to a real anchor in the page. */
for (const m of idxBody.matchAll(/anchorId: "([^"]+)"/g)) {
  const id = m[1];
  assert.ok(
    settings.includes(`anchorId="${id}"`) || settings.includes(`id="${id}"`),
    "index anchor renders: " + id,
  );
}

/* Jump behavior: section switch + scroll-to-anchor + focus. */
assert.ok(settings.includes("const jumpTo = (h: SettingHit) => {"), "jumpTo defined");
assert.ok(settings.includes("setSection(h.section);"), "a hit switches the section");
assert.ok(settings.includes("anchor.scrollIntoView({ block: \"center\", behavior: reduce ? \"auto\" : \"smooth\" });"), "a hit scrolls the anchor into view");
assert.ok(settings.includes("anchor.focus();"), "a hit focuses the anchor");
assert.ok(settings.includes("jumpTick"), "a jump counter re-fires inside the open section");

/* 2. Theme hero: plain div, anchor kept, panel id gone. */
assert.ok(settings.includes('className="lb-set-hero"'), "hero card rendered");
assert.ok(!settings.includes('id="p-theme-color"'), "the old p-theme-color panel id is gone");
assert.ok(settings.includes('<div className="lb-set-anchor" id="set-theme-color" tabIndex={-1} />'), "the set-theme-color anchor kept");
const heroStart = settings.indexOf("<div className=\"lb-set-hero\">");
const heroEnd = settings.indexOf("</div>", settings.indexOf("lb-seed-row", heroStart));
assert.ok(heroStart !== -1 && heroEnd !== -1 && heroEnd > heroStart, "hero wraps the seed row");
assert.ok(settings.slice(heroStart, heroEnd).includes("lb-seed-row"), "seed chips live inside the hero");
assert.ok(settings.slice(heroStart, heroEnd).includes('aria-label="Theme color"'), "color input lives inside the hero");

/* 3. The hero and search surfaces are styled in the glass family. */
const hero = rule(theme, ".lb-set-hero {");
assert.ok(hero.includes("var(--lb-glass") || hero.includes("surface-container"), "hero uses the app surface family");
const search = rule(theme, ".lb-set-search {");
assert.ok(search.length > "{".length, "search field has a rule");

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
assert.ok(opens - selfclosing === closes, `toolbar spans balance (opens ${opens}, self-closing ${selfclosing}, closes ${closes})`);
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

/* 6. Motion: one press scale on the hit buttons, killed for
   reduced-motion users; the zone wrappers add no motion. */
assert.ok(theme.includes(".lb-set-hit:active { scale: 0.98; transition-duration: 90ms; }"), "hit buttons carry press feedback");
const rm = theme.indexOf("@media (prefers-reduced-motion: reduce)");
const rmBody = theme.slice(rm, theme.indexOf("}", theme.indexOf(".lb-set-hit", rm)) + 1);
assert.ok(rmBody.includes(".lb-set-hit { transition: none; }"), "reduced motion kills the hit press");
assert.ok(!zone.includes("transition") && !zone.includes("animation"), "zone wrappers add no motion");

/* 7. CI wiring: the wave gate runs on every push. */
assert.ok(
  ci.includes("node --experimental-strip-types ../tests/ui-wave112/check.mjs"),
  "ci runs the wave-112 gate",
);

console.log("ui-wave112: all checks passed");
