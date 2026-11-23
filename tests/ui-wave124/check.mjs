/* Wave 124 regression check: the tabs bottom sheet is NON-modal and
 * anchored ABOVE the dock (operator pick: the sheet should appear
 * from a better place instead of over the toolbar; the toolbar
 * stays visible and interactive). Contracts:
 * (1) TabSwitcherCard: no modal attribute, own Escape close,
 *     detents fit + handle + hideable still ride m3eAttrs;
 * (2) Browser: the sheet JSX sits OUTSIDE the dock div (fixed non-modal
 *     positioning must not ride the dock tuck transform), and the dock
 *     never slid away for tabs-open anymore
 *     (no inert from tabsOpen, no tabs-open class);
 * (3) theme: the .lb-dock.tabs-open slide rule is GONE, and the
 *     sheet rides 86px above the viewport bottom on desktop
 *     (18 dock offset + 56 pill + 12 gap), 150px on compact
 *     (18 + 64 nav + 56 + 12);
 * (4) CI runs this gate. */
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const tsc = read('../../ui/src/browser/TabSwitcherCard.tsx');
const browser = read('../../ui/src/pages/Browser.tsx');
const theme = read('../../ui/src/theme.css');
const attrs = read('../../ui/src/browser/browserShared.ts');
const sheetAttrs = read('../../tests/ui-sheet-attrs/check.mjs');
const ci = read('../../.github/workflows/ci.yml');
if (tsc.includes('modal: ' + String.fromCharCode(34,34))) throw new Error('tabs sheet went modal again');
if (!tsc.includes('m3eAttrs(sheetRef.current, {')) throw new Error('attribute helper lost');
if (!tsc.includes('detents: ' + String.fromCharCode(34) + 'fit' + String.fromCharCode(34) + ',')) throw new Error('fit detent lost');
if (!tsc.includes('handle: ' + String.fromCharCode(34,34) + ',') || !tsc.includes('hideable: ' + String.fromCharCode(34,34) + ',')) throw new Error('handle/hideable lost');
if (!tsc.includes('k.key === ' + String.fromCharCode(34) + 'Escape' + String.fromCharCode(34)) || !tsc.includes('live.current.onClose();')) throw new Error('non-modal Escape close lost');
if (browser.includes('tabs-open')) throw new Error('tabs-open class survived');
if (browser.includes('dockTucked || tabsOpen')) throw new Error('dock still goes inert for the tabs sheet');
const bi = browser.indexOf('<TabSwitcherCard');
const bd = browser.indexOf('className={' + String.fromCharCode(34) + 'lb-dock' + String.fromCharCode(34));
if (!(bi > -1 && bd > bi)) throw new Error('tabs sheet renders inside the dock again (non-modal fixed rides the tuck transform)');
if (theme.includes('.lb-dock.tabs-open')) throw new Error('dock slide-away rule survived');
const desktop = '.lb-tabs-sheet { top: calc(100dvh - var(--_bottom-sheet-height) - 86px - env(safe-area-inset-bottom, 0px)); }';
if (!theme.includes(desktop)) throw new Error('desktop lift rule lost');
const compact = '.lb-tabs-sheet { top: calc(100dvh - var(--_bottom-sheet-height) - 150px); }';
if (!theme.includes(compact)) throw new Error('compact lift rule lost');
const di = theme.indexOf(compact);
if (!theme.slice(Math.max(0, di - 700), di).includes('@media (max-width: 600px)')) throw new Error('compact lift is not in the 600px block');
if (!sheetAttrs.includes('modal: false, handle: true, hideable: true }, ' + String.fromCharCode(47,42) + ' wave 124')) throw new Error('sheet-attrs gate still pins modal');
if (!ci.includes('../tests/ui-wave124/check.mjs')) throw new Error('ci runs the wave-124 gate');
console.log('ui-wave124: all checks passed');