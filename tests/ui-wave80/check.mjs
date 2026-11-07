/* Wave-80 UI regression checks (user request 2026-11-07): static gates
   for the beta UI redesign - the DevTools and tab-switcher bottom
   sheets, the Settings expansion-panel redesign (no option lost), the
   Downloads overflow-menu removal, the scroll-tuck toolbar, the
   home-only animated background, and the single-provider (@m3e/web)
   consolidation. Plain fs checks; no app imports, so it runs anywhere
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
  ok("tabs: one card per tab", t.includes("m3e-card") && t.includes("lb-tabs-tile"));
  ok("tabs: live preview kept", t.includes("lb-tab-preview"));
}

/* --- DevTools: bottom-sheet host, connected button-group picker,
   section cards; the legacy file is kept in-repo but imported
   nowhere. --- */
{
  const d = read("src/pages/DevTools.tsx");
  ok("devtools: bottom sheet host", d.includes("m3e-bottom-sheet"));
  ok("devtools: connected button group picker", d.includes("m3e-button-group") && d.includes('variant="connected"'));
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

/* --- App: the animated background renders on the home view only. --- */
{
  const a = read("src/App.tsx");
  ok("app: fx background home-only", a.includes('settings.fancyBackground && view === "home"'));
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
   no outline ring on the edge facing the content; the DevTools
   Diagnostics page puts both actions at the very top, above the
   log cards. --- */
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
  const failCard = d.indexOf('aria-label="Resource failures"', dpos);
  const topBtn = d.indexOf("void copyLogs()", dpos);
  ok("devtools: diagnostics actions above the log cards", topBtn !== -1 && topBtn < failCard);
  ok("devtools: page tools card folded into the actions row", !d.includes('aria-label="Page tools"'));
  ok("devtools: eruda renders once", d.split("<ZeoliteEngineTools").length - 1 === 1);
}

if (failures > 0) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ui-wave80: all checks passed");
