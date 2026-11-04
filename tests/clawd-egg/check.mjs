/* node --experimental-strip-types tests/clawd-egg/check.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* The Clawd sleeping gif (user request 2026-11-04) is vendored as a
   local public asset: exactly the upstream bytes, GIF magic intact. */
const gif = readFileSync(join(root, 'ui', 'public', 'clawd-sleep.gif'));
assert.equal(gif.length, 22196, 'clawd-sleep.gif must be exactly 22196 bytes');
assert.equal(gif.subarray(0, 3).toString('latin1'), 'GIF', 'clawd-sleep.gif must be a GIF');

/* Settings.tsx renders it inside the About group, ABOVE the build
   version chips (the About card's version line). */
const src = readFileSync(join(root, 'ui', 'src', 'pages', 'Settings.tsx'), 'utf8');
const img = src.indexOf('lb-clawd');
assert.ok(img >= 0, 'Settings.tsx must reference the lb-clawd gif');
assert.ok(src.includes('src="/clawd-sleep.gif"'), 'the gif must load from the local public asset');
const about = src.indexOf('lb-about');
const build = src.indexOf('lb-build" title');
assert.ok(about >= 0 && img > about, 'the gif must live inside the About group');
assert.ok(build >= 0 && img < build, 'the gif must sit above the version line');

/* theme.css owns the pixel-art treatment. */
const css = readFileSync(join(root, 'ui', 'src', 'theme.css'), 'utf8');
assert.ok(css.includes('.lb-clawd'), 'theme.css must style .lb-clawd');
assert.ok(/\.lb-clawd\s*\{[^}]*image-rendering:\s*pixelated/.test(css), 'pixel art must scale nearest-neighbour');

console.log('clawd-egg: vendored gif bytes, About placement above the version line, pixelated styling passed');
