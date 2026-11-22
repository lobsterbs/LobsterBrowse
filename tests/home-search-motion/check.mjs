/* Home search motion checks: the wordmark sheet and the shape decos
   stay shrunk while a query is typed (not only while the input holds
   focus, a focus flicker resets it), and on commit the search view
   fades with the shape wipe instead of staying lit above it. */
import { readFileSync } from "node:fs";
const root = new URL("../../", import.meta.url);
const theme = readFileSync(new URL("ui/src/theme.css", root), "utf8");
const home = readFileSync(new URL("ui/src/pages/Home.tsx", root), "utf8");
const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
let fails = 0;
const ok = (c, l) => { if (c) console.log("ok - " + l); else { fails++; console.log("FAIL - " + l); } };

/* Typed queries hold the shrink: each rule also fires on a non-empty
   input value, so a suggest-panel focus flicker cannot pop the
   wordmark back mid-typing. */
for (const tail of [".lb-home-sheet", ".lb-home-hl1 m3e-shape", ".lb-home-hl2"]) {
  ok(theme.includes(".lb-home:has(.lb-ac-wrap input:not(:placeholder-shown)) " + tail), "typed value keeps the shrink: " + tail);
}
ok(home.includes("placeholder="), "the shrink selector needs a real placeholder attr");

/* Commit fades the bar with the wipe: the wipe overlay is a sibling
   div, so the bar must dim itself. */
ok(theme.includes(".lb-home .lb-ac-wrap { transition: opacity 180ms cubic-bezier(.34, .8, .34, 1); }"), "bar fade transition exists");
ok(theme.includes(".lb-home .lb-ac-wrap.lb-away { opacity: 0; }"), "lb-away dims the bar");
ok(theme.includes(".lb-home-sheet, .lb-home-hl, .lb-home-hl m3e-shape, .lb-ac-wrap { transition: none; }"), "reduced motion freezes the bar fade");
ok(home.includes('const [wiping, setWiping] = useState(false);'), "wiping state exists");
ok(home.includes("setWiping(true);"), "commit arms the fade");
ok(home.includes('"lb-ac-wrap" + (wiping ? " lb-away" : "")'), "the wrap gains lb-away on wipe");

ok(ci.includes("tests/home-search-motion/check.mjs"), "CI runs the home search motion check");
process.exit(fails ? 1 : 0);
