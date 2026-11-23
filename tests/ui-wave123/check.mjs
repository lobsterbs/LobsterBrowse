/* Regression check for wave 123 (devtools declutter + glass + ad hero).
 * (1) the console page carries no Filter search bar, no level filter
 *     chips, and no filter text state;
 * (2) the devtools diag/network rows (.lb-net-row) are glass sub-cards,
 *     not opaque surface boxes;
 * (3) the ad-block shield centers inside its hero shape with the
 *     absolute inset-0 margin-auto pattern (wave-116 favicon pattern);
 * (4) CI runs this gate. */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const d = read('../../ui/src/pages/DevTools.tsx');
const theme = read('../../ui/src/theme.css');
const ci = read('../../.github/workflows/ci.yml');

/* 1. Console declutter. */
if (d.includes('m3e-filter-chip')) throw new Error('console still has filter chips');
const consoleRegion = d.split('lb-dt-page" hidden={dt.page !== "console"}')[1]?.split('lb-dt-page"')[0] ?? '';
if (!consoleRegion) throw new Error('console page region not found');
if (consoleRegion.includes('m3e-search-bar') || consoleRegion.includes('lb-dt-search')) throw new Error('console still has a filter search bar');
if (d.includes('consoleFilter')) throw new Error('console filter state survived');
if (d.includes('No matching entries.')) throw new Error('filtered-empty copy survived with no filter');
if (!d.includes('Clear console') || !d.includes('Copy console output')) throw new Error('clear/copy actions lost');
if (!d.includes('Console output will appear here.')) throw new Error('quiet empty state lost');

/* Network page keeps its URL filter bar layout. */
if (!theme.includes('.lb-dt-search { flex: 1 1 200px; min-width: 0; }')) throw new Error('network filter bar lost its layout rule');

/* 2. Glass diag rows. */
if (!theme.includes('.lb-net-row {\n  border-bottom: 0;\n  --m3e-expansion-panel-container-color: var(--lb-glass-lift);')) throw new Error('net rows lost the glass lift');
if (!theme.includes('.lb-net-row {') || theme.split('.lb-net-row {').length - 1 !== 2) throw new Error('net row rule count changed');
if (!/\.lb-net-row \{[^}]*border-radius: var\(\--md-sys-shape-corner-large-increased, 20px\)[^}]*\}/.test(theme)) throw new Error("net rows lost the rounded host");

/* 3. Ad hero centering. */
if (!theme.includes('.lb-ad-hero-shape {\n  --m3e-shape-size: 56px;\n  --m3e-shape-container-color: var(--md-sys-color-secondary-container, #4a4458);\n  /* The shape paints as an absolute-fill SVG while slotted content\n     sits in normal flow at the top left, so the shield centers with\n     the wave-116 tab-favicon pattern: fixed-size icon, inset 0\n     margin auto. */\n  position: relative;')) throw new Error('hero shape lost relative positioning');
if (!theme.includes('.lb-ad-hero-shape > m3e-icon {\n  position: absolute;\n  inset: 0;\n  margin: auto;\n  width: 24px;\n  height: 24px;')) throw new Error('hero icon lost the center pattern');

/* 4. CI wiring. */
if (!ci.includes('../tests/ui-wave123/check.mjs')) throw new Error('ci runs the wave-123 gate');

console.log('ui-wave123: all checks passed');
