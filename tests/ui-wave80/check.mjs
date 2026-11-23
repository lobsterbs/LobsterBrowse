/* UI regression checks: static gates for the beta UI redesign -
   the DevTools and tab-switcher bottom sheets, the Settings
   expansion-panel redesign (no option lost), the Downloads
   overflow-menu removal, the scroll-tuck toolbar, the hero
   background (home and AI), and the single-provider (@m3e/web)
   consolidation. Plain fs checks; no app imports, so it runs
   anywhere node runs. */
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
   the rewrite). --- */
{
  const page = read("src/pages/Settings.tsx");
  const fields = [
    "seed",
    "engine",
    "proxyEngine",
    "adblock",
    "transport",
    "suggestQueries",
  ];
  for (const f of fields) ok("settings: option " + f + " kept", page.includes("settings." + f));

  /* Wave 109: the Enhanced UI option is gone by user order; the
     hero background is always on, so the option must not survive
     anywhere in the settings page or the settings model. */
  ok("settings: enhanced UI option removed", !page.includes("fancyBackground") && !read("src/settings.ts").includes("fancyBackground"));

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
  ok("browser: downloads card removed", !b.includes("<DownloadsCard"));
  ok("browser: downloads toolbar button removed", !b.includes("lb-dl-btn"));
  ok("browser: scroll hook wired (helper + both frame paths)", b.split("hookFrameScroll").length - 1 >= 3);
  ok("browser: dock reveal on very top", b.includes("y <= 1 && dockTucked"));
}

/* --- Tab switcher: modal m3e-bottom-sheet with one card per tab. --- */
{
  const t = read("src/browser/TabSwitcherCard.tsx");
  ok("tabs: modal bottom sheet", t.includes("<m3e-bottom-sheet") && t.includes('modal: ""'));
  /* #85: the card grid and the live preview window are gone; one row
     per tab now: leading favicon tile, then the title with its
     supporting state line, then the close button. */
  ok("tabs: one row per tab", t.includes("lb-tab-favicon") && t.includes("lb-tab-row"));
  ok("tabs: avatar tile gone", !t.includes("m3e-avatar"));
  ok("tabs: preview window removed", !t.includes("lb-tab-preview"));
}

/* --- DevTools: bottom-sheet host, connected button-group picker,
   section cards; the legacy file is kept in-repo but imported
   nowhere. --- */
{
  const d = read("src/pages/DevTools.tsx");
  ok("devtools: bottom sheet host", d.includes("m3e-bottom-sheet"));
  /* 2026-11-23: the connected button group became a real m3e-tabs
     bar (the change event mirrors into state); the toggle-attribute
     helper contract left with the segments. */
  ok("devtools: sub-tool picker is an m3e-tabs bar", d.includes("lb-dt-nav") && d.includes("lb-dt-nav-tabs") && d.includes("<m3e-tabs") && !d.includes('variant="connected"') && !d.includes('m3eAttrs(el, { toggle: "" })'));
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

/* --- Home background: the App-level fx background is gone with the
   2026-11-23 hero-wallpaper removal; Home owns its backdrop
   (HomeBg, the Aurora/Shapes random pick, ea6ab0d). Wave 109
   invariant kept: no settings toggle covers any background. --- */
{
  const a = read("src/App.tsx");
  const h = read("src/pages/Home.tsx");
  ok("app: hero background option stays removed (wave 109)", !a.includes("fancyBackground"));
  ok("home: HomeBg backdrop always on (aurora/shapes)", h.includes("<HomeBg />") && !h.includes("fancyBackground"));
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

/* --- Settings follow-up: the settings panels sat outside an
   m3e-accordion, so their surface tokens were empty and the page
   rendered as one flat sheet; the nav rail must carry no outline
   ring on the edge facing the content. #266 superseded the
   diagnostics-actions placement: the Resource failures card is gone
   entirely and both actions live in the sheet header app bar,
   reachable from every sub-page. --- */
{
  const theme = read("src/theme.css");
  /* Wave 115: the sub-panel surface moved from the (retired)
     m3e-expansion-panel onto the lb-setp disclosure card host. */
  const pIdx = theme.indexOf(".lb-setp {");
  ok("settings: panel surface tokens defined", pIdx !== -1 && theme.slice(pIdx, pIdx + 300).includes("background: var(--lb-glass-tint);"));
  ok("settings: sidenav grid wrapper rule (wave 108)", theme.includes(".lb-set-page { display: grid"));
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
  /* 2026-11-23: the eruda button lives in the ZeoliteEngineTools
     wrapper; its single call site in the sheet header is the truth
     the textual check pins (the id sits inside the wrapper's
     definition, before the header in file order). */
  const zet = d.indexOf("<ZeoliteEngineTools");
  ok("devtools: eruda lives in the sheet header", zet !== -1 && zet > hdr && zet < dpos && erudaBtn !== -1);
  ok("devtools: resource failures card removed", !d.includes('aria-label="Resource failures"'));
  ok("devtools: resfail explainer removed", !d.includes("resfail reports"));
  ok("devtools: empty-fails message removed", !d.includes("No resource failures captured."));
  ok("devtools: diagnostics page card removed", dpos !== -1 && !d.slice(dpos).includes('aria-label="Engine diagnostics"'));
  ok("devtools: page tools card folded into the actions row", !d.includes('aria-label="Page tools"'));
  ok("devtools: eruda renders once", d.split("<ZeoliteEngineTools").length - 1 === 1);
  ok("devtools: eruda gated on /eruda.js availability", d.includes("erudaReady") && d.includes("disabled={erudaReady"));
}

/* --- Settings follow-up: a sub option
   whose entire payload is one control is an inline row card
   (SetInline), not an expansion panel - one switch behind a chevron
   is a wasted click. Multi-control or explanatory sub options keep
   their panels. Every search-index target must exist on the page:
   the redesign had dropped the panel anchor ids, so jumps to those
   entries opened a panel but never scrolled. --- */
{
  const page = read("src/pages/Settings.tsx");
  const inline = ["set-search-engine", "set-search-suggest", "set-adblock", "set-data", "set-logs"];
  for (const t of inline) ok("settings: " + t + " is an inline card", page.includes('anchorId="' + t + '"'));
  const gone = ["p-search-engine", "p-search-suggest", "p-adblock", "p-https", "p-cloak-enabled", "p-data", "p-logs"];
  for (const p of gone) ok("settings: panel " + p + " removed", !page.includes('id="' + p + '"'));
  /* #269: the #198 search index left with the search bar. Wave 112
     brings back a search index deliberately (SETTING_INDEX lives
     again in Settings.tsx); the #198 jump pattern (target: "set-"
     props) stays gone. */
  ok("settings: old #198 target-jump pattern removed", !page.includes('target: "set-'));
  const theme = read("src/theme.css");
  ok("settings: inline card surface defined", theme.includes(".lb-set-inline {"));
  ok("settings: inline cards join the jump focus ring", theme.includes(".lb-set-inline:focus-visible"));
}

/* --- Expressive type + shapes: the full
   Google Sans Flex axis set loads, the weight ramp and the M3E
   typescale are tokenized, no rule hardcodes a weight outside the
   ramp, and the decorative shapes are aria-hidden with the morph
   frozen under reduced motion. --- */
{
  const mainTs = read("src/main.tsx");
  ok("type: full variable font axis set loaded", mainTs.includes("@fontsource-variable/google-sans-flex/full.css"));
  ok("type: standard subset import gone", !mainTs.includes("google-sans-flex/standard.css"));
  const theme = read("src/theme.css");
  for (const tok of ["--lb-wght-plain", "--lb-wght-medium", "--lb-wght-strong", "--lb-wght-emph", "--lb-wght-display", "--lb-fvs-display", "--lb-fvs-display-round"]) {
    ok("type: token " + tok + " defined", theme.includes(tok + ":"));
  }
  ok("type: baseline typescale defined", theme.includes("--md-sys-typescale-display-large-font-weight: 400"));
  ok("type: emphasized typescale defined", theme.includes("--md-sys-typescale-emphasized-label-large-font-weight: 700"));
  const hard = [...theme.matchAll(/font-variation-settings:[^;]*"wght"\s+\d/g)];
  ok("type: no hardcoded weight outside the token ramp", hard.length === 0);
  const toolRow = read("src/ai/ToolRow.tsx");
  /* The demo conversation replaced the thinking morph shape with a
     status pill: loader while the turn runs, check when settled, the
     step cards as outlined cards under the pill. */
  ok("ai: status pill runs the loader while the turn is live", toolRow.includes('<m3e-loading-indicator aria-hidden={true} {...{ class: "lb-ai-stat-load" }} />'));
  ok("ai: settled turns swap the loader for the check", toolRow.includes('name="check_circle"'));
  ok("ai: step cards are outlined cards under the pill", toolRow.includes('<m3e-card variant="outlined" {...{ class: "lb-ai-step" }}>'));
  ok("shape: downloads card file removed", !existsSync(new URL("src/browser/DownloadsCard.tsx", ui)));
  const xpiPrompt = read("src/browser/XpiPrompt.tsx");
  ok("shape: xpi prompt icons are decorative", xpiPrompt.includes('name="extension" aria-hidden={true}'));
  ok("shape: xpi prompt progress is labelled", xpiPrompt.includes('aria-label={"Downloading '));
  ok("shape: reduced motion freezes morphs", /--m3e-shape-transition:\s*none/.test(theme));
}

if (failures > 0) {
  console.error(failures + " check(s) failed");
  process.exit(1);
}
console.log("ui-wave80: all checks passed");
