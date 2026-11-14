/* Wave 85 UI regression checks: real frosted glass on every
   overlay surface (sheets, menus, palette, floating cards, suggestors),
   the tab switcher row redesign (frosted avatar favicon, title, close
   X, preview windows gone), basic m3e-app-bar top bars everywhere,
   Settings card uniformity, and typescale-token typography. Static
   source asserts; live visual verification rides the deploy check. */
import { readFileSync } from "node:fs";

const ui = new URL("../../ui/", import.meta.url);
const read = (p) => readFileSync(new URL(p, ui), "utf8");
let fails = 0;
const ok = (cond, label) => {
  if (cond) console.log("ok - " + label);
  else {
    fails++;
    console.log("FAIL - " + label);
  }
};

const theme = read("src/theme.css");

/* Frost: every overlay family rides a translucent container color plus
   a backdrop filter, unscoped (not only under Enhanced UI). */
ok(theme.includes("m3e-bottom-sheet {"), "sheet frost rule exists");
ok(theme.includes("--m3e-bottom-sheet-container-color: var(--lb-glass-sheet-tint);"), "sheet container color is translucent");
ok(theme.includes("m3e-menu {"), "menu frost rule exists");
ok(theme.includes(".lb-cmdk {") && theme.includes("background: color-mix(in srgb, var(--md-sys-color-surface-container-high, #2b2b2f) 74%, transparent);"), "command palette is frosted");
ok(theme.includes(".lb-dl-card,\n.lb-fv-card {"), "floating elevated cards are frosted");
ok(!theme.includes("body.lb-fancy .lb-ac {"), "home suggestor frost is unscoped");
ok(!theme.includes("body.lb-fancy .lb-tb-ac {"), "toolbar suggestor frost is unscoped");
ok(!theme.includes("body.lb-fancy .lb-ai-bar"), "AI chat bar frost is unscoped");
ok(theme.includes("backdrop-filter: blur(24px) saturate(1.4);"), "backdrop blur present");

/* Top bars: one shared basic app-bar class, the old custom header
   rules are gone. */
ok(theme.includes(".lb-sheet-bar {"), "shared app-bar class exists");
for (const gone of [".lb-site-head", ".lb-site-ctitle", ".lb-dt-sheet-head", ".lb-dt-head-actions", ".lb-ad-head", ".lb-ai-hist-head"]) {
  ok(!theme.includes(gone), "old header rule removed: " + gone);
}

/* Tabs sheet: rows, not tiles; avatar favicon; no preview windows. */
ok(theme.includes(".lb-tab-row {"), "tab row rule exists");
ok(theme.includes(".lb-tab-row.active {"), "active row pill exists");
ok(theme.includes(".lb-tab-avatar {"), "frosted avatar rule exists");
ok(theme.includes("--m3e-avatar-size: 40px;"), "avatar size token set");
ok(!theme.includes("lb-tabs-tile"), "tile rules gone");
ok(!theme.includes("lb-tab-preview"), "preview rules gone");
ok(theme.includes(".lb-tab-row, .lb-dock-pill { transition: none; }"), "reduced-motion covers rows");

/* Typography: no off-scale raw sizes remain in the stylesheet. */
/* Wave 88: the only raw 13px/15px sizes are the narrow-screen steps
   inside the Wave 88 glass section (the user settings-card spec). */
const w88 = theme.indexOf("Narrow screens: tighter sub-card padding");
ok(w88 !== -1, "narrow glass block exists");
ok(!theme.slice(0, w88).includes("font-size: 13px;") && theme.slice(w88).indexOf("font-size: 13px;") === theme.slice(w88).lastIndexOf("font-size: 13px;"), "raw 13px only in the narrow glass block");
ok(!theme.slice(0, w88).includes("font-size: 15px;") && theme.slice(w88).indexOf("font-size: 15px;") === theme.slice(w88).lastIndexOf("font-size: 15px;"), "raw 15px only in the narrow glass block");
ok(!theme.includes("font-size: 40px;"), "no raw 40px left");
ok(!theme.includes("font-size: 0.95rem;"), "no raw 0.95rem left");
ok(theme.includes(".lb-muted { opacity: 0.65; font-size: var(--md-sys-typescale-body-small-font-size, 12px); }"), "muted text uses body-small token");

/* Settings uniformity: panels and inline cards share one rhythm. */
ok(theme.includes("--m3e-expansion-header-padding-left: var(--md-sys-measurement-space150);"), "panel header padding harmonized");
ok(theme.includes("--m3e-expansion-panel-content-padding: var(--md-sys-measurement-space150) var(--md-sys-measurement-space200) var(--md-sys-measurement-space200);"), "panel content padding harmonized (#269), roomier (wave 104)");
ok(theme.includes(".lb-setp-head { display: flex; flex-direction: column; gap: 2px; cursor: pointer; padding: var(--md-sys-measurement-space200) 0; }"), "panel headers carry the roomier vertical rhythm (wave 104)");
ok(theme.includes("min-height: 56px;"), "inline card min-height grew with the panel headers (wave 100)");

const tabs = read("src/browser/TabSwitcherCard.tsx");
ok(tabs.includes("<m3e-avatar"), "tab rows use m3e-avatar");
ok(tabs.includes('class: "lb-tab-avatar"'), "avatar carries the frost class");
ok(tabs.includes("<m3e-app-bar"), "tabs sheet header is an app bar");
ok(tabs.includes('<span slot="title">Tabs'), "tabs sheet title in title slot");
ok(!tabs.includes("zlContentHref"), "preview route import gone");
ok(!tabs.includes("routeUrl"), "preview routeUrl import gone");
ok(!tabs.includes("everOpened"), "preview mount gate gone");
ok(!tabs.includes("<iframe"), "no preview iframes");

const ad = read("src/browser/AdBlockCard.tsx");
ok(ad.includes("<m3e-app-bar") && ad.includes('<span slot="title">Ad blocking</span>'), "ad sheet header is a basic app bar");
ok(!ad.includes("lb-ad-head"), "ad sheet old header gone");

const ext = read("src/browser/ExtensionsPanel.tsx");
ok(ext.includes("<m3e-app-bar") && ext.includes('<span slot="title">Extensions</span>'), "extensions sheet header is a basic app bar");
ok(!ext.includes("lb-ext-head"), "extensions old header gone");
ok(!ext.includes("Refresh extensions"), "extensions header refresh removed");

const dt = read("src/pages/DevTools.tsx");
ok(dt.includes("<m3e-app-bar") && dt.includes('<span slot="title">DevTools'), "DevTools sheet header is a basic app bar");
ok(!dt.includes("lb-dt-sheet-head") && !dt.includes("lb-dt-head-actions"), "DevTools old header gone");
ok(!dt.includes("View app logs"), "DevTools header logs shortcut removed");

const ai = read("src/pages/Ai.tsx");
ok(ai.includes('<span slot="title">Conversations</span>'), "AI history header is a basic app bar");
ok(!ai.includes("lb-ai-hist-head"), "AI history old header gone");

const dl = read("src/browser/DownloadsCard.tsx");
ok(dl.includes("<m3e-app-bar") && dl.includes('<span slot="title">Downloads'), "downloads card header is a basic app bar");
ok(!dl.includes("lb-site-head"), "downloads old header gone");

const fv = read("src/browser/FileViewer.tsx");
ok(fv.includes("<m3e-app-bar"), "file viewer header is a basic app bar");
ok(!fv.includes("lb-site-head"), "file viewer old header gone");

const logs = read("src/pages/Logs.tsx");
ok(logs.includes('<span slot="title">Logs</span>'), "logs page top bar is a basic app bar");
ok(!logs.includes("<m3e-heading variant=\"title\" size=\"medium\" level={2}>"), "logs old heading header gone");

const setp = read("src/pages/Settings.tsx");
ok(!setp.includes("fontSize: 12"), "settings inline raw font sizes gone");

const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
ok(ci.includes("ui-wave85"), "CI runs the wave 85 check");

console.log(fails === 0 ? "ALL OK" : fails + " FAILURES");
process.exit(fails ? 1 : 0);
