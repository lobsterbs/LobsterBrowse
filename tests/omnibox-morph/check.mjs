/* The omnibox edit morph (demo fc() parity): the pill widens on the
   demo's slow expressive curve, the whole toolbar collapses on one
   shared 500ms spring (no single-frame trail blink), and reduced
   motion freezes the morph. Gates must read only strings that exist
   because the CSS is authored to the demo's exact curve values. */
import { readFileSync } from "node:fs";
const root = new URL("../../", import.meta.url);
const theme = readFileSync(new URL("ui/src/theme.css", root), "utf8");
const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
let fails = 0;
const ok = (c, l) => { if (c) console.log("ok - " + l); else { fails++; console.log("FAIL - " + l); } };

ok(theme.includes("width 550ms cubic-bezier(.39, 1.29, .35, .98)"), "pill width rides the demo's slow expressive curve");
ok(theme.includes("border-radius 500ms cubic-bezier(.34, .8, .34, 1)"), "pill radius eases on a monotonic curve (an overshoot squared the corners mid-morph)");
ok(theme.includes("background-color 500ms cubic-bezier(.34, .8, .34, 1)"), "pill tint eases on the demo's effects curve");
ok(theme.includes("transform 350ms cubic-bezier(.42, 1.67, .21, .9)"), "pill press bounce uses the demo's fast spatial spring");
const btnRule = theme.slice(theme.indexOf(".lb-toolbar m3e-icon-button"), theme.indexOf(".lb-toolbar.editing"));
ok(btnRule.includes("flex: none; max-width: 64px;"), "buttons are gated at the demo's 64px so the squeeze is uniform (wave 121: the rule may carry the 2.13.6 container-color pins before the layout props)");
ok(theme.includes("max-width 500ms cubic-bezier(.38, 1.21, .22, 1)"), "the button squeeze rides the shared spatial spring");
ok(theme.includes("opacity 200ms cubic-bezier(.34, .8, .34, 1)"), "the button fade rides the effects spring");
ok(!theme.includes(".lb-toolbar.editing .lb-tb-trail {"), "the trail no longer blinks away (no display rule on the whole zone)");
ok(theme.includes(".lb-toolbar.editing .lb-tb-trail m3e-menu { display: none; }"), "the closed overflow menu stays display-locked while editing");
ok(theme.includes(".lb-tb-zone { transition: gap 500ms"), "zone gaps ride the same spring");
ok(theme.includes(".lb-tb-pill, .lb-tb-zone { transition: none; }"), "reduced motion freezes pill and zones");
/* 2026-11-23 frame lock: the pill morphs INSIDE the resting toolbar
   (its edit width is pegged by the Browser effect through
   --lb-tb-edit-w), the buttons slide out of the pill on their own
   side instead of squashing in place, and nothing widens past the
   resting chrome. */
ok(theme.includes("width: var(--lb-tb-edit-w, min(92vw, 440px));"), "the edit morph rides the frame-locked width var");
ok(theme.includes(".lb-toolbar.editing .lb-tb-pill { width: var(--lb-tb-edit-w"), "the editing rule owns the var");
ok(theme.includes("transform: translateX(-56px);"), "the lead buttons slide out left");
ok(theme.includes(".lb-toolbar.editing .lb-tb-trail m3e-icon-button { transform: translateX(56px); }"), "the trail buttons slide out right");
ok(!theme.includes("transform: scale(.4);"), "the squash press is retired");
ok(theme.includes(".lb-toolbar.editing .lb-tb-pill.expanded { max-width: none; }"), "the trim cap cannot clip the frame-locked width");
ok(ci.includes("tests/omnibox-morph/check.mjs"), "CI runs the omnibox morph check");
process.exit(fails ? 1 : 0);

