/* node --experimental-strip-types tests/site-tint/check.mjs */
import assert from 'node:assert/strict';
import { dominantHue } from '../../ui/src/siteTint.ts';

/* Helper: RGBA buffer from [r,g,b,a] pixel tuples. */
const buf = (...px) => Uint8ClampedArray.from(px.flat());

/* Single hue: red icons vote red (near 0deg). */
const red = dominantHue(buf([255,0,0,255],[255,0,0,255],[200,10,10,255],[255,30,30,200]));
assert.ok(red, 'pure red must produce a hue');
assert.ok(red.hue < 10 || red.hue > 350, 'red hue must be near 0deg, got ' + red.hue);

/* Wrap-around: hues just below and above 0deg average near 0deg, not 180deg. */
const wrap = dominantHue(buf([255,20,30,255],[255,0,10,255],[230,0,20,255],[220,10,30,255]));
assert.ok(wrap && (wrap.hue > 340 || wrap.hue < 20), 'wrap-around reds must stay near 0deg, got ' + (wrap && wrap.hue));

/* Two hues with unequal weight: 3 red pixels outweigh 1 blue pixel. */
const mix = dominantHue(buf([255,0,0,255],[255,0,0,255],[255,0,0,255],[30,60,255,255]));
assert.ok(mix && (mix.hue < 15 || mix.hue > 345), 'unequal weights must pick the heavier hue, got ' + (mix && mix.hue));

/* Saturation weighting: a fully saturated minority beats a washed-out majority. */
const satWeight = dominantHue(buf([100,130,140,255],[100,130,140,255],[100,130,140,255],[0,200,0,255]));
assert.ok(satWeight && satWeight.hue > 80 && satWeight.hue < 160, 'saturated green must outweigh washed-out cyan, got ' + (satWeight && satWeight.hue));

/* Blue icons vote near 240deg. */
const blue = dominantHue(buf([30,60,255,255],[20,40,230,255],[40,80,255,255],[10,30,240,255]));
assert.ok(blue && blue.hue > 210 && blue.hue < 270, 'blue hue must be near 240deg, got ' + (blue && blue.hue));

/* Rejections: all transparent, gray, white, black -> null. */
assert.equal(dominantHue(buf([255,0,0,0],[255,0,0,0],[255,0,0,0],[255,0,0,0])), null);
assert.equal(dominantHue(buf([128,128,128,255],[128,128,128,255],[128,128,128,255],[128,128,128,255])), null);
assert.equal(dominantHue(buf([255,255,255,255],[255,255,255,255],[255,255,255,255],[255,255,255,255])), null);
assert.equal(dominantHue(buf([0,0,0,255],[0,0,0,255],[0,0,0,255],[0,0,0,255])), null);

/* Tiny icon: 2 colored pixels are too few -> null. */
assert.equal(dominantHue(buf([255,0,0,255],[0,200,0,255])), null);

console.log('site-tint: transparent/gray/white/black rejection, saturation weighting, wrap-around mean passed');
