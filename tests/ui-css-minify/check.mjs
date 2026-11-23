/* Wave 120 regression: after the vite 8 sweep shipped, every frosted
   surface on live beta lost its blur. Root cause: vite 8 defaults to
   lightningcss css minification, which rewrote each authored pair
   "backdrop-filter: X; -webkit-backdrop-filter: X;" down to the
   -webkit-backdrop-filter alias alone; Chromium 125 does not paint that
   alias (computed backdrop-filter: none, live-proven). This gate pins
   the cssMinify: false override and the comment that explains it, so
   no future dep sweep or config golf silently restores the minifier. */
import { readFileSync } from "node:fs";

const ui = new URL("../../ui/", import.meta.url);
let fails = 0;
function ok(cond, label) {
  if (cond) console.log("OK " + label);
  else { console.error("FAIL " + label); fails++; }
}
const cfg = readFileSync(new URL("vite.config.ts", ui), "utf8");

ok(cfg.includes("cssMinify: false"), "vite.config.ts pins build.cssMinify: false");
ok(cfg.includes("lightningcss"), "config comment names the lightningcss culprit");
ok(!/cssMinify:\s*"(lightningcss|esbuild)"/.test(cfg), "no minifying cssMinify re-enabled (esbuild is not even installable on vite 8)");

process.exit(fails ? 1 : 0);
