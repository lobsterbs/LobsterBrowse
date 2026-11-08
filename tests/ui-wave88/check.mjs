/* Wave 88 UI regression checks: frosted glass everywhere.
   - The Home suggestor popover paints nothing itself: the .lb-ac
     glass card is the suggestion surface (no grey panel under it),
     and the keyboard hint row is gone.
   - Bottom sheets follow the user settings-card spec: 560px max
     width, min(76dvh, 780px) max height, 52% sheet tint behind
     blur(28px) saturate(180%) brightness(.66).
   - In-sheet cards and every remaining opaque surface (settings
     panels, inline cards, search results, DevTools cards, extension
     tiles, tab rows, AI history rows, ad sheet blocks, new-tab
     suggestor, command palette input, XPI card, extension notes,
     site card, log list, snackbar) read as frosted glass via the
     shared --lb-glass-tint token.
   - Opaque Material fallbacks for no-backdrop-filter support and
     prefers-reduced-transparency.
   No setting, option or behavior was removed: the only deleted UI
   is the suggestor keyboard hint (user request 2026-11-08). */
import { readFileSync } from "node:fs";
const ui = new URL("../../ui/", import.meta.url);
const read = (p) => readFileSync(new URL(p, ui), "utf8");
let fails = 0;
const ok = (cond, label) => {
  if (cond) console.log("ok - " + label);
  else { fails++; console.log("FAIL - " + label); }
};
const NL = String.fromCharCode(10);
const theme = read("src/theme.css");
const home = read("src/pages/Home.tsx");
/* Suggestor: no hint row, the popover paints nothing. */
ok(!home.includes("lb-ac-hint") && !home.includes("Enter to open"), "suggestor keyboard hint removed");
ok(home.includes("lb-ac-item"), "suggestor rows still render");
ok(!theme.includes(".lb-ac-hint"), "hint style rule removed");
ok(theme.includes("--m3e-search-view-container-color: transparent;"), "popover container paints nothing");
ok(theme.includes("--m3e-search-view-contained-container-color: transparent;"), "contained results panel paints nothing");
ok(theme.includes("--m3e-search-view-docked-scrim-color: transparent;"), "docked scrim paints nothing");
ok(!theme.includes("--m3e-search-view-contained-container-color: color-mix"), "no tinted contained panel remains");
/* Glass no longer depends on the Enhanced UI setting. */
ok(!theme.includes("body.lb-fancy .lb-home"), "home frost is unconditional");
ok(theme.includes(".lb-home m3e-search-bar {"), "bar frost rule unscoped");
ok(theme.includes(".lb-home pre.lb-ascii {"), "wordmark frost rule unscoped");
/* Sheet spec. */
ok(theme.includes("--m3e-bottom-sheet-container-color: var(--lb-glass-sheet-tint);"), "sheet rides the glass tint token");
ok(theme.includes("--lb-glass-sheet-tint: color-mix(in srgb, var(--md-sys-color-surface-container-high, #2b2b2f) 52%, transparent);"), "sheet tint is the spec 52%");
ok(theme.includes("--m3e-bottom-sheet-max-width: 560px;"), "sheet max width is the spec 560px");
ok(theme.includes("max-height: min(76dvh, 780px);"), "sheet max height is the spec min(76dvh, 780px)");
ok(theme.includes("backdrop-filter: blur(28px) saturate(180%) brightness(.66);"), "sheet blur is the spec chain");
ok(!theme.includes("--m3e-bottom-sheet-max-width: 720px;") && !theme.includes("--m3e-bottom-sheet-max-width: 480px;"), "per-sheet width overrides are gone");
/* Sheet fit: the JS max clamp equals the CSS max height, and every
   app sheet opens at the fit detent so the post-open recompute
   corrects the pre-popover NaN pin (the library measures the
   content while the popover is still display: none). */
ok(theme.includes("--m3e-bottom-sheet-compact-top-space: calc(100dvh - min(76dvh, 780px));"), "sheet JS clamp equals the CSS max height");
ok(theme.includes("--m3e-bottom-sheet-top-space: calc(100dvh - min(76dvh, 780px));"), "sheet short-viewport clamp matches");
for (const f of ["browser/AdBlockCard.tsx", "browser/ExtensionsPanel.tsx", "browser/TabSwitcherCard.tsx", "pages/Ai.tsx", "pages/DevTools.tsx"]) {
  ok(read("src/" + f).includes('detents="fit"'), "fit detent on " + f);
}
ok(!read("src/extensions.css").includes("--m3e-bottom-sheet-max-width: 480px;"), "extensions sheet follows the global 560px width");
/* Shared glass tokens and fallbacks. */
ok(theme.includes("--lb-glass-tint: color-mix(in srgb, var(--md-sys-color-surface-container-high, #2b2b2f) 62%, transparent);"), "card tint is the spec 62%");
ok(theme.includes("--lb-glass-blur: blur(18px) saturate(160%);"), "card blur is the spec chain");
ok(theme.includes("--lb-glass-ring: 1px solid rgb(255 255 255 / .08);"), "hairline ring token exists");
ok(theme.includes("@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))"), "opaque fallback for no backdrop-filter");
ok(theme.includes("@media (prefers-reduced-transparency: reduce)"), "opaque fallback for reduced transparency");
ok(theme.includes("--lb-glass-blur: none;"), "fallback kills the blur");
ok(theme.includes("inset 0 1px 0 rgb(255 255 255 / .05)"), "inset highlight present");
/* Sub-cards and remaining surfaces. */
ok(theme.includes("--m3e-expansion-panel-container-color: var(--lb-glass-tint);"), "settings panels are glass");
ok(theme.includes(".lb-set-inline .lb-setting-label"), "settings rows keep their typography");
ok(theme.includes("--m3e-card-container-color: var(--lb-glass-tint);"), "in-sheet m3e-cards ride the glass tint");
ok(theme.includes("--m3e-card-shape: 20px;"), "sub-cards use the spec 20px radius");
ok(theme.includes(".lb-ext-list { display: flex; flex-direction: column; gap: 18px; }"), "extension list is a glass card column");
ok(theme.includes("--m3e-snackbar-container-color: color-mix(in srgb, var(--md-sys-color-inverse-surface, #322f35) 78%, transparent);"), "snackbar is glass");
const tabIdx = theme.indexOf(".lb-tab-row {");
ok(tabIdx !== -1 && theme.slice(tabIdx, tabIdx + 700).includes("background: var(--lb-glass-tint);"), "tab rows are glass cards");
ok(tabIdx !== -1 && theme.slice(tabIdx, tabIdx + 700).includes("min-height: 64px;"), "tab rows use the spec row height");
const ntIdx = theme.indexOf(".lb-nt-ac {");
ok(ntIdx !== -1 && theme.slice(ntIdx, ntIdx + 700).includes("background: var(--lb-glass-tint);"), "new tab suggestor is glass");
const histIdx = theme.indexOf(".lb-ai-hist-row {");
ok(histIdx !== -1 && theme.slice(histIdx, histIdx + 700).includes("var(--lb-glass-tint)"), "AI history rows are glass");
const hostsIdx = theme.indexOf(".lb-ad-hosts {");
ok(hostsIdx !== -1 && theme.slice(hostsIdx, hostsIdx + 700).includes("background: var(--lb-glass-tint);"), "ad hosts block is glass");
ok(theme.includes(".lb-ad-row {") && theme.slice(theme.indexOf(".lb-ad-row {", theme.indexOf("Wave 88"))).includes("backdrop-filter"), "ad toggle row is a glass setting-row card");
ok(theme.includes("gap: 18px;"), "18px sub-card spacing present");
ok(theme.includes(".lb-xpi-card," + NL + ".lb-site-card {"), "xpi and site cards share the glass rule");
ok(theme.includes(".lb-ext-note {") && theme.slice(theme.indexOf(".lb-ext-note {")).includes("backdrop-filter: var(--lb-glass-blur);"), "extension notes are glass");
const logIdx = theme.indexOf(".lb-log-list {");
ok(logIdx !== -1 && theme.slice(logIdx, logIdx + 700).includes("background: var(--lb-glass-tint);"), "log list is glass");
const cmdkIdx = theme.indexOf(".lb-cmdk-input {");
ok(cmdkIdx !== -1 && theme.slice(cmdkIdx, cmdkIdx + 700).includes("background: var(--lb-glass-tint);"), "command palette input is glass");
/* Behavior preservation: the settings surface set is unchanged. */
const setp = read("src/pages/Settings.tsx");
ok(setp.includes("m3e-expansion-panel") && setp.includes("lb-set-inline"), "settings panels and inline cards still render");
/* The only raw 13px/15px are the narrow-screen steps. */
const narrow = theme.indexOf("Narrow screens: tighter sub-card padding");
ok(narrow !== -1, "narrow glass block exists");
ok(narrow !== -1 && !theme.slice(0, narrow).includes("font-size: 13px;") && !theme.slice(0, narrow).includes("font-size: 15px;"), "no raw 13px/15px outside the narrow block");
const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
ok(ci.includes("ui-wave88"), "CI runs the wave 88 check");
console.log(fails === 0 ? "ALL OK" : fails + " FAILURES");
process.exit(fails ? 1 : 0);
