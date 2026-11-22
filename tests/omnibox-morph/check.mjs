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
ok(theme.includes(".lb-toolbar m3e-icon-button { flex: none; max-width: 64px;"), "buttons are gated at the demo's 64px so the squeeze is uniform");
ok(theme.includes("max-width 500ms cubic-bezier(.38, 1.21, .22, 1)"), "the button squeeze rides the shared spatial spring");
ok(theme.includes("opacity 200ms cubic-bezier(.34, .8, .34, 1)"), "the button fade rides the effects spring");
ok(!theme.includes(".lb-toolbar.editing .lb-tb-trail {"), "the trail no longer blinks away (no display rule on the whole zone)");
ok(theme.includes(".lb-toolbar.editing .lb-tb-trail m3e-menu { display: none; }"), "the closed overflow menu stays display-locked while editing");
ok(theme.includes(".lb-tb-zone { transition: gap 500ms"), "zone gaps ride the same spring");
ok(theme.includes(".lb-tb-pill, .lb-tb-zone { transition: none; }"), "reduced motion freezes pill and zones");
ok(ci.includes("tests/omnibox-morph/check.mjs"), "CI runs the omnibox morph check");
process.exit(fails ? 1 : 0);

