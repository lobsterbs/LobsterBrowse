/* node --experimental-strip-types tests/search-default/check.mjs */
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, ENGINES } from '../../ui/src/settings.ts';

/* The default search engine is Brave (user request 2026-11-04).
   DEFAULT_SETTINGS.engine is the single default knob: fresh profiles
   and invalid stored values fall back to it, so this line decides
   what a brand-new user searches with. */
assert.equal(DEFAULT_SETTINGS.engine, 'brave', 'DEFAULT_SETTINGS.engine must be brave');

/* The default must be a real engine with a {q} search URL. */
assert.ok('brave' in ENGINES, 'brave must exist in ENGINES');
assert.ok(ENGINES.brave.url.includes('{q}'), 'brave URL must carry the {q} placeholder');

/* Startpage stays selectable; only the default changed. */
assert.ok('startpage' in ENGINES, 'startpage must remain in ENGINES');

console.log('search-default: brave default, ENGINES membership, startpage still selectable passed');
