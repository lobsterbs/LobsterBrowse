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
   the CSS copy must stay in sync. */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const app = readFileSync(join(root, "ui", "src", "App.tsx"), "utf8");
const theme = readFileSync(join(root, "ui", "src", "theme.css"), "utf8");

/* 1. The remote backdrop is pre-warmed once per session and settles on
   BOTH load and error: a blocked image must not leave the page on a
   bare surface forever. */
assert.ok(
  /const HERO_BACKDROP_URL =\s*\n?\s*"https:\/\/images4\.alphacoders\.com\/134\/thumb-1920-1341558\.png";/.test(app),
  "the remote hero backdrop URL is a named constant"
);
assert.ok(
  /heroBackdropWarm \?\?= new Promise<void>\(\(resolve\) => \{[\s\S]*?img\.onload = \(\) => resolve\(\);[\s\S]*?img\.onerror = \(\) => resolve\(\);[\s\S]*?img\.src = HERO_BACKDROP_URL;/.test(app),
  "the pre-warm settles on both load and error"
);

/* 2. The hero portal is gated on the backdrop being ready (the
   view gate from ui-wave92 stays intact). */
assert.ok(
  app.includes('{(view === "home" || view === "ai") && heroBgReady &&'),
  "the hero layer mounts only after the backdrop is ready"
);
assert.ok(
  /heroBackdropReady\(\)\.then\(\(\) => \{[\s\S]*?setHeroBgReady\(true\);/.test(app),
  "the gate flips from the pre-warmed promise"
);

/* 3. The CSS and TS copies of the URL stay in sync: the .lb-fx-bg
   background stack still names the same remote image as its top
   layer, over the local backplate. */
assert.ok(
  theme.includes('url("https://images4.alphacoders.com/134/thumb-1920-1341558.png") center / cover no-repeat'),
  "theme.css .lb-fx-bg still paints the same remote backdrop (sync with App.tsx HERO_BACKDROP_URL)"
);

console.log("hero-load-gate: all checks passed");
