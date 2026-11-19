/* Regression check for the home hero (#245): the
   liquid-metal shader is fully removed and the photographic hero
   image replaces it. Run from the repo root:

     node --experimental-strip-types tests/ui-wave92/check.mjs */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/* The hero image is committed and is a real JPEG wallpaper. */
const heroPath = new URL("../../ui/public/lb-hero.jpg", import.meta.url);
assert.ok(existsSync(heroPath), "ui/public/lb-hero.jpg is committed");
const heroBytes = readFileSync(heroPath);
assert.ok(heroBytes.length > 500000, "the hero image is the full wallpaper (" + heroBytes.length + " bytes)");
assert.equal(heroBytes[0], 0xff, "hero magic byte 0 is ff");
assert.equal(heroBytes[1], 0xd8, "hero magic byte 1 is d8");
assert.equal(heroBytes[2], 0xff, "hero magic byte 2 is ff");

/* The shader is fully gone. */
assert.ok(!existsSync(new URL("../../ui/src/components/ui/shader-metal.tsx", import.meta.url)), "shader-metal.tsx is deleted");
const appSrc = read("../../ui/src/App.tsx");
assert.ok(!appSrc.includes("ShaderMetal"), "App no longer mounts the shader component");
assert.ok(appSrc.includes('(view === "home" || view === "ai") &&'), "the hero layer renders on Home and AI");
assert.ok(!appSrc.includes("fancyBackground"), "the hero layer is always on (wave 109 removed the Enhanced UI gate)");
assert.ok(appSrc.includes("lb-fx-bg"), "the fx background layer class is unchanged");

/* The CSS paints the image; no shader or aurora remnants. */
const themeSrc = read("../../ui/src/theme.css");
assert.ok(themeSrc.includes('url("/lb-hero.jpg")'), "the fx layer paints the hero image");
assert.ok(themeSrc.includes("center / cover no-repeat"), "the hero image covers the layer");
assert.ok(!themeSrc.includes("shader-metal"), "no shader-metal CSS remains");
assert.ok(!themeSrc.includes("lb-fx-bg::after"), "the aurora bloom overlay is gone with the shader");

/* Settings copy: the wave 109 work order removed the Enhanced UI
   option together with its panel, headline, toggle row and sub
   descriptions, so none of that copy may return. */
const settingsPageSrc = read("../../ui/src/pages/Settings.tsx");
assert.ok(!settingsPageSrc.includes("Enhanced UI"), "the Enhanced UI panel copy is gone");
assert.ok(!settingsPageSrc.includes("hero background image"), "the hero toggle row copy is gone");
assert.ok(!settingsPageSrc.includes("liquid-metal"), "no liquid-metal copy remains in Settings");
const settingsModelSrc = read("../../ui/src/settings.ts");
assert.ok(!settingsModelSrc.includes("fancyBackground"), "the settings model dropped the fancyBackground flag");
assert.ok(settingsModelSrc.includes("photographic hero background") || settingsModelSrc.includes("photographic hero"), "the settings comment still describes the always-on hero");

console.log("ui-wave92 check: all assertions passed");
