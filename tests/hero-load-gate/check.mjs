import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* Hero backplate flash (2026-11-20 prompt item): on a reload after a
   site-data wipe the .lb-fx-bg layer painted the local lb-hero.jpg
   backplate for the whole fetch window of the remote wallpaper, so the
   OLD wallpaper visibly flashed before the current one landed on top.
   The contract now: the hero layer mounts only after the remote
   backdrop image has loaded (or errored, keeping the documented
   hotlink-blocked degrade). The URL stays in one place per file and
   the CSS copy must stay in sync. The follow-up (same day): the
   pre-warm starts at MODULE SCOPE and the gate state initializes from
   the settled flag, so a warm reload (browser-heuristic-cached image)
   can paint the hero layer in the very first commit instead of one
   cache round trip + decode behind the app - the "frosted glass takes
   its 100ms" symptom. */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const app = readFileSync(join(root, "ui", "src", "App.tsx"), "utf8");
const theme = readFileSync(join(root, "ui", "src", "theme.css"), "utf8");

/* 1. The remote backdrop is pre-warmed once per session and settles on
   BOTH load and error: a blocked image must not leave the page on a
   bare surface forever. Both paths also raise the settled flag. */
assert.ok(
  /const HERO_BACKDROP_URL =\s*\n?\s*"https:\/\/images4\.alphacoders\.com\/134\/thumb-1920-1341558\.png";/.test(app),
  "the remote hero backdrop URL is a named constant"
);
assert.ok(
  /heroBackdropWarm \?\?= new Promise<void>\(\(resolve\) => \{\s*\n\s*const img = new Image\(\);\s*\n\s*img\.onload = \(\) => \{\s*\n\s*heroBackdropSettled = true;\s*\n\s*resolve\(\);\s*\n\s*\};\s*\n\s*img\.onerror = \(\) => \{\s*\n\s*heroBackdropSettled = true;\s*\n\s*resolve\(\);\s*\n\s*\};\s*\n\s*img\.src = HERO_BACKDROP_URL;/.test(app),
  "the pre-warm settles on both load and error and raises the settled flag"
);
assert.ok(
  app.includes("let heroBackdropSettled = false;"),
  "the settled flag is a module-level boolean"
);

/* 2. The pre-warm starts at module scope (before the first render),
   not only from a mount effect: the fetch and decode must race the
   first paint, not follow it. Exactly one module-level call. */
assert.strictEqual(
  app.split("heroBackdropReady();").length - 1,
  1,
  "the pre-warm starts once, at module scope"
);

/* 3. The hero portal is gated on the backdrop being ready (the
   view gate from ui-wave92 stays intact). */
assert.ok(
  app.includes('{(view === "home" || view === "ai") && heroBgReady &&'),
  "the hero layer mounts only after the backdrop is ready"
);
assert.ok(
  /heroBackdropReady\(\)\.then\(\(\) => \{[\s\S]*?setHeroBgReady\(true\);/.test(app),
  "the gate flips from the pre-warmed promise"
);
assert.ok(
  app.includes("const [heroBgReady, setHeroBgReady] = useState(heroBackdropSettled);"),
  "the gate state initializes from the settled flag (warm reload = first commit)"
);
assert.ok(
  !app.includes("const [heroBgReady, setHeroBgReady] = useState(false);"),
  "the gate state never restarts at false on a settled pre-warm"
);

/* 4. The CSS and TS copies of the URL stay in sync: the .lb-fx-bg
   background stack still names the same remote image as its top
   layer, over the local backplate. */
assert.ok(
  theme.includes('url("https://images4.alphacoders.com/134/thumb-1920-1341558.png") center / cover no-repeat'),
  "theme.css .lb-fx-bg still paints the same remote backdrop (sync with App.tsx HERO_BACKDROP_URL)"
);

console.log("hero-load-gate: all checks passed");
