/* node --experimental-strip-types tests/command-palette-removed/check.mjs */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/* #278: the command palette is gone for good. Source scan over ui/src:
   any of these markers means palette code crept back in (component,
   shortcut state, overlay classes, palette bridge events, or the
   palette-only clear-cookies target). */
const root = join(import.meta.dirname, '..', '..', 'ui', 'src');
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(e)) files.push(p);
  }
};
walk(root);

const forbidden = [
  'CommandPalette',
  'paletteOpen',
  'lb-cmdk',
  'lb-open-extensions',
  'lb-focus-omnibox',
  'clearSiteUrl',
];

assert.ok(files.length > 10, 'source scan found suspiciously few files');
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const marker of forbidden) {
    assert.ok(!s.includes(marker), f + ' still references removed palette marker "' + marker + '"');
  }
}

console.log('command-palette-removed: no palette references remain in ui/src');
