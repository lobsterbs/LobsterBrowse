/* Wave-80 UI regression checks (user request 2026-11-07): static gates
   for the beta UI redesign - the DevTools and tab-switcher bottom
   sheets, the Settings expansion-panel redesign (no option lost), the
   Downloads overflow-menu removal, the scroll-tuck toolbar, the
   hero background (home, AI and Settings since wave 96), and the
   single-provider (@m3e/web) consolidation. Plain fs checks; no app imports, so it runs anywhere
   node runs. */
import { readFileSync, existsSync, readdirSync } from "node:fs";

const ui = new URL("../../ui/", import.meta.url);
const read = (p) => readFileSync(new URL(p, ui), "utf8");
let failures = 0;
const ok = (name, cond) => {
  if (cond) console.log("PASS " + name);
  else {
    failures++;
    console.error("FAIL " + name);
  }
};

/* --- Settings: every option the pre-redesign page exposed still
   surfaces in the redesigned page (the honest no-loss oracle: the
   fields the old page referenced, verified field by field against
   the wave-80 rewrite). --- */
{
  const page = read("src/pages/Settings.tsx");
  const fields = [
    "seed",
    "engine",
    "proxyEngine",
    "adblock",
    "httpsUpgrade",
    "transport",
    "cloakEnabled",
    "cloakUrl",
    "cloakTitle",
    "suggestQueries",
    "fancyBackground",
  ];
  for (const f of fields) ok("settings: option " + f + " kept", page.includes("settings." + f));

  ok("settings: ScramJet greyout present", page.includes('proxyEngine === "scramjet"'));
  ok("settings: guard wrapper present", page.includes("lb-zl-guard"));
  ok("settings: disabled rows present", page.includes("disabled={zlOff"));
  ok("settings: content pane host", page.includes("m3e-content-pane"));
  ok("settings: expansion panels", page.includes("m3e-expansion-panel"));
  ok("settings: result card uses class spread not className", !page.includes('className="lb-set-result"'));
}

/* --- Browser: Downloads leaves the overflow menu (the toolbar badge
   and the downloads card stay), and the scroll tuck/reveal hook is
   wired into both frame paths. --- */
{
  const b = read("src/pages/Browser.tsx");
  ok("browser: Downloads overflow item removed", !b.includes("disabled={downloads.length === 0"));
  ok("browser: downloads card still mounted", b.includes("<DownloadsCard"));
  ok("browser: scroll hook wired (helper + both frame paths)", b.split("hookFrameScroll").length - 1 >= 3);
  ok("browser: dock reveal on very top", b.includes("y <= 1 && dockTucked"));
}

/* --- Tab switcher: modal m3e-bottom-sheet with one card per tab. --- */
{
  const t = read("src/browser/TabSwitcherCard.tsx");
  ok("tabs: modal bottom sheet", t.includes("<m3e-bottom-sheet") && t.includes('modal=""'));
  /* #85 (user directive): the card grid and the live preview window are
     gone; one row per tab now: favicon in a frosted m3e-avatar, then the
     title, then the close button. */
  ok("tabs: one row per tab", t.includes("m3e-avatar") && t.includes("lb-tab-row"));
  ok("tabs: preview window removed", !t.includes("lb-tab-preview"));
}

/* --- DevTools: bottom-sheet host, connected button-group picker,
   section cards; the legacy file is kept in-repo but imported
   nowhere. --- */
{
  const d = read("src/pages/DevTools.tsx");
  ok("devtools: bottom sheet host", d.includes("m3e-bottom-sheet"));
  /* #239 (wave 84): the connected button group was replaced by the tonal pill row. */
  ok("devtools: sub-tool picker is the tonal pill row", d.includes("lb-dt-nav") && d.includes('variant={on ? "tonal" : "text"}'));
  ok("devtools: section cards", d.includes("m3e-card"));
  ok("devtools: legacy copy kept", existsSync(new URL("src/pages/DevToolsLegacy.tsx", ui)));
  const walk = (dir) => {
    let out = [];
    for (const e of readdirSync(new URL(dir, ui), { withFileTypes: true })) {
      if (e.isDirectory()) out = out.concat(walk(dir + e.name + "/"));
      else if (/\.(tsx?|mjs)$/.test(e.name)) out.push(dir + e.name);
    }
    return out;
  };
  let stray = 0;
  for (const p of walk("src/")) {
    if (p === "src/pages/DevToolsLegacy.tsx") continue;
    if (/from\s+"[^"]*DevToolsLegacy"/.test(read(p))) stray++;
  }
  ok("devtools: legacy copy imported nowhere", stray === 0);
}

/* --- App: the hero background renders on home, AI and Settings
     (user request 2026-11-09; wave 96 superseded the 2026-11-07
     home-only shape). --- */
{
  const a = read("src/App.tsx");
  ok("app: fx background on home and AI (#261)", a.includes('settings.fancyBackground && (view === "home" || view === "ai")'));
}

/* --- m3e.d.ts: the md-card intrinsic is gone and the live elements
   carry the widened prop surface. --- */
{
  const t = read("src/m3e.d.ts");
  ok("m3e: md-card intrinsic removed", !t.includes('"md-card"'));
  ok("m3e: card widened", t.includes('"m3e-card": M3eBase & { variant?: string; tabIndex?: number;'));
  ok("m3e: button widened", t.includes('"data-page"?: string'));
}

/* --- Single provider: @materialwebunofficial/md3e-web is gone from
   the dependency tree. --- */
{
  ok("package: md3e-web dependency removed", !read("package.json").includes("materialwebunofficial"));
  ok("lock: md3e-web entry removed", !read("package-lock.json").includes("materialwebunofficial"));
}

/* --- Wave-80 follow-up (user report 2026-11-07): the settings panels
   sat outside an m3e-accordion, so their surface tokens were empty
   and the page rendered as one flat sheet; the nav rail must carry
   no outline ring on the edge facing the content. #266 (user request
   2026-11-11) superseded the diagnostics-actions placement: the
   Resource failures card is gone entirely and both actions live in
   the sheet header app bar, reachable from every sub-page. --- */
{
  const theme = read("src/theme.css");
  const pIdx = theme.indexOf(".lb-set-page m3e-expansion-panel {");
  ok("settings: panel surface tokens defined", pIdx !== -1 && theme.slice(pIdx, pIdx + 300).includes("--m3e-expansion-panel-container-color"));
  ok("settings: rhythm wrapper rule", theme.includes(".lb-set-page { display: flex"));
  ok("settings: row labels evened inside panels", theme.includes(".lb-setp-body .lb-setting-label { margin: 0; }"));
  const rIdx = theme.indexOf("m3e-nav-rail {");
  ok("rail: outline ring removed", rIdx !== -1 && !theme.slice(rIdx, rIdx + 500).includes("0 0 0 1px"));
  const sPage = read("src/pages/Settings.tsx");
  ok("settings: page wrapper mounted", sPage.includes('className="lb-set-page"'));
  const d = read("src/pages/DevTools.tsx");
  const dpos = d.indexOf('dt.page === "diagnostics"');
  const hdr = d.indexOf('slot="header"');
  const copyBtn = d.indexOf('id="lb-dt-copy-btn"');
  const erudaBtn = d.indexOf('id="lb-dt-eruda-btn"');
  ok("devtools: copy logs lives in the sheet header", copyBtn !== -1 && copyBtn > hdr && copyBtn < dpos);
  ok("devtools: eruda lives in the sheet header", erudaBtn !== -1 && erudaBtn > hdr && erudaBtn < dpos);
  ok("devtools: resource failures card removed", !d.includes('aria-label="Resource failures"'));
  ok("devtools: resfail explainer removed", !d.includes("resfail reports"));
  ok("devtools: empty-fails message removed", !d.includes("No resource failures captured."));
  ok("devtools: diagnostics page card removed (user request 2026-11-11)", dpos !== -1 && !d.slice(dpos).includes('aria-label="Engine diagnostics"'));
  ok("devtools: page tools card folded into the actions row", !d.includes('aria-label="Page tools"'));
  ok("devtools: eruda renders once", d.split("<ZeoliteEngineTools").length - 1 === 1);
  ok("devtools: eruda gated on /eruda.js availability (user request 2026-11-11)", d.includes("erudaReady") && d.includes("disabled={erudaReady"));
}

/* --- Settings follow-up (user request 2026-11-07): a sub option
   whose entire payload is one control is an inline row card
   (SetInline), not an expansion panel - one switch behind a chevron
   is a wasted click. Multi-control or explanatory sub options keep
   their panels. Every search-index target must exist on the page:
   the redesign had dropped the panel anchor ids, so jumps to those
   entries opened a panel but never scrolled. --- */
{
  const page = read("src/pages/Settings.tsx");
  const inline = ["set-search-engine", "set-search-suggest", "set-adblock", "set-https", "set-cloak-enabled", "set-data", "set-logs"];
  for (const t of inline) ok("settings: " + t + " is an inline card", page.includes('anchorId="' + t + '"'));
  const gone = ["p-search-engine", "p-search-suggest", "p-adblock", "p-https", "p-cloak-enabled", "p-data", "p-logs"];
  for (const p of gone) ok("settings: panel " + p + " removed", !page.includes('id="' + p + '"'));
  const targets = [...page.matchAll(/target: "(set-[a-z-]+)"/g)].map((m) => m[1]);
  ok("settings: search index targets parsed", targets.length >= 16);
  for (const t of targets) {
    ok("settings: jump target " + t + " exists on the page", page.includes('anchorId="' + t + '"') || page.includes('id="' + t + '"'));
  }
  const theme = read("src/theme.css");
  ok("settings: inline card surface defined", theme.includes(".lb-set-inline {"));
  ok("settings: inline cards join the jump focus ring", theme.includes(".lb-set-inline:focus-visible"));
}

if (failures > 0) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ui-wave80: all checks passed");
