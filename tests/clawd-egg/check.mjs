/* node --experimental-strip-types tests/clawd-egg/check.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* The Clawd sleeping gif (user request 2026-11-04) is vendored as a
   local public asset: exactly the upstream bytes, GIF magic intact.
   #269 (user request 2026-11-12) removed the Settings About panel,
   so the gif is no longer rendered anywhere; the asset stays
   vendored and the removal is gated here. */
const gif = readFileSync(join(root, 'ui', 'public', 'clawd-sleep.gif'));
assert.equal(gif.length, 22196, 'clawd-sleep.gif must be exactly 22196 bytes');
assert.equal(gif.subarray(0, 3).toString('latin1'), 'GIF', 'clawd-sleep.gif must be a GIF');

/* #269: the About panel (and Clawd with it) is gone from Settings. */
const src = readFileSync(join(root, 'ui', 'src', 'pages', 'Settings.tsx'), 'utf8');
assert.ok(!src.includes('lb-clawd'), 'Settings.tsx no longer renders the Clawd gif');
assert.ok(!src.includes('id="p-about"'), 'the About expansion panel is removed');
assert.ok(!src.includes('lb-build'), 'the build version chips are removed');

/* theme.css no longer carries the treatment. */
const css = readFileSync(join(root, 'ui', 'src', 'theme.css'), 'utf8');
assert.ok(!css.includes('.lb-clawd'), 'theme.css no longer styles .lb-clawd');

console.log('clawd-egg: vendored gif bytes intact, About panel and Clawd removal (#269) passed');
