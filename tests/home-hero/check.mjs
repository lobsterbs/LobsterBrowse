/* Home hero regression check (black home page).

   Runs in CI with node --experimental-strip-types. Exit 1 on fail.

   Root cause chain (live-proven on beta build 50db9ac): the fx
   background layer is portaled to <body> (#245), which sits OUTSIDE
   <m3e-theme>; every --md-sys-color-* token inherits only from that
   element's subtree, so --md-sys-color-surface reads empty on the
   portal. var() without a fallback inside the multi-layer background
   shorthand makes the entire declaration invalid at computed-value
   time, so EVERY layer drops (computed background-image "none") and
   the page paints bare black even though /lb-hero.jpg serves 200.
   The check pins: the layer order, the local hero, and the
   color-surface call carrying its own fallback. */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../ui/src/theme.css", import.meta.url), "utf8");

let fails = 0;
const ok = (name, cond) => {
  if (!cond) {
    console.error("FAIL: " + name);
    fails++;
  }
};

const start = css.indexOf(".lb-fx-bg {");
ok(".lb-fx-bg rule exists", start !== -1);
if (start !== -1) {
  const end = css.indexOf("}", start);
  ok(".lb-fx-bg rule closes", end !== -1);
  const block = css.slice(start, end === -1 ? undefined : end);

  ok("scrim layer present", block.includes("linear-gradient(rgba(0, 0, 0, 0.35), rgba(0, 0, 0, 0.35))"));
  ok("remote wallpaper layer present", block.includes("images4.alphacoders.com"));
  ok("local /lb-hero.jpg layer present", block.includes('url("/lb-hero.jpg")'));
  /* The one-line fix: the base color must carry a fallback so an
     unsubstituted token can never poison the whole shorthand. */
  ok("surface color carries fallback", block.includes("var(--md-sys-color-surface,"));
  ok("no bare surface token in fx shorthand", !block.includes("var(--md-sys-color-surface);"));
}

/* Document why the fallback is mandatory: if someone deletes the
   comment, the mechanism knowledge is gone. */
ok("portal-inheritance comment retained", css.includes("which sits OUTSIDE <m3e-theme>"));

if (fails > 0) {
  console.error("home-hero: " + fails + " check(s) failed");
  process.exit(1);
}
console.log("home-hero: all checks passed");
