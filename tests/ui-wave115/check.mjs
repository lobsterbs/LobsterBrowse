/* Wave 115: settings sub-panel disclosure, pruned debug menu,
   AI chip focus landing, expressive easing fallbacks. The Settings
   sub-panels left m3e-expansion-panel because its height transition
   snapped on open in this app (probed); the grid-rows disclosure is
   the contract now. The debug menu keeps exactly three controls;
   everything else stays permanently at its enabled default. */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const ui = new URL("../../ui/", import.meta.url);
const read = (p) => readFileSync(new URL(p, ui), "utf8");
const settings = read("src/pages/Settings.tsx");
const debugMenu = read("src/pages/DebugMenu.tsx");
const ai = read("src/pages/Ai.tsx");
const theme = read("src/theme.css");
const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

/* 1. Settings disclosure. */
assert.ok(!settings.includes("<m3e-expansion-panel"), "the expansion panel left Settings");
assert.ok(settings.includes('<div id={props.id} className="lb-setp">'), "panel root card renders");
assert.ok(settings.includes('className="lb-setp-toggle"'), "the toggle button renders");
assert.ok(settings.includes('aria-expanded={props.open ? "true" : "false"}'), "the toggle carries aria-expanded");
assert.ok(settings.includes('aria-controls={props.id + "-disc"}'), "the toggle controls the region");
assert.ok(settings.includes('className="lb-setp-disc"'), "the disclosure region renders");
assert.ok(settings.includes('{...(props.open ? { "data-open": "" } : { inert: true })}'), "closed regions are inert (React 19 boolean)");
assert.ok(settings.includes('id={props.anchorId} tabIndex={-1}'), "anchors still render inside the body");
assert.ok(settings.includes("anchorId=\"set-transport\""), "the transport anchor survived");
assert.ok(theme.includes(".lb-setp-disc {") && theme.includes("grid-template-rows: 0fr;"), "disclosure collapses via grid rows");
assert.ok(theme.includes(".lb-setp-disc[data-open] {") && theme.includes("grid-template-rows: 1fr;"), "disclosure expands via grid rows");
assert.ok(theme.includes("grid-template-rows var(--md-sys-motion-duration-medium-2, 300ms) var(--md-sys-motion-easing-emphasized, cubic-bezier(0.2, 0, 0, 1)), visibility 0s var(--md-sys-motion-duration-medium-2, 300ms)"), "collapse curve is tokenized emphasized with a delayed visibility flip");
assert.ok(theme.includes(".lb-setp-discin { min-height: 0; overflow: hidden; }"), "the inner wrapper height-caps the track");
assert.ok(theme.includes('.lb-setp-toggle[aria-expanded="true"] .lb-setp-chev { transform: rotate(180deg); }'), "the chevron rotates open");
assert.ok(theme.includes("  .lb-setp-disc, .lb-setp-disc .lb-setp-body, .lb-setp-chev { transition: none; }"), "reduced motion freezes the disclosure");
assert.ok(!theme.includes("m3e-expansion-header-collapsed-height") && !theme.includes("--m3e-expansion-panel-container-color") && !theme.includes(".lb-net-row {"), "retired panel tokens left everywhere: the devtools net-row container-color left with the Network tab (2026-11-23)");
assert.ok(theme.includes(".lb-setp {") && theme.includes("background: var(--lb-glass-tint);"), "the card surface keeps the glass family");
assert.ok(theme.includes("border-radius: var(--md-sys-shape-corner-large-increased, 20px);"), "the card keeps the corner-large shape");
assert.ok(theme.includes("padding: var(--md-sys-measurement-space150) var(--md-sys-measurement-space200) var(--md-sys-measurement-space200);"), "the body keeps the 12/16/16 rhythm");

/* 2. DebugMenu pruning. */
for (const gone of ["Query-shape routes", "HTTPS upgrade<", "Lazy images", "Mock AI", "Adaptive NativeTransit", "CSP translation"]) {
  assert.ok(!debugMenu.includes(gone), "pruned control stayed out: " + gone);
}
for (const kept of ["Split content origin", "Virtual Service Workers", "Hybrid location rewriting"]) {
  assert.ok(debugMenu.includes(kept), "kept control missing: " + kept);
}
assert.ok(debugMenu.includes("queryRoutes: qr,"), "query-shape rides the deployment /build value");
assert.ok(debugMenu.includes("httpsUpgrade: settings.httpsUpgrade,"), "https-upgrade rides the stored setting");
assert.ok(debugMenu.includes("imageLazy: true,"), "lazy images stay on");
assert.ok(debugMenu.includes("aiMock: false,"), "AI responses stay real");
assert.ok(debugMenu.includes("hybridLocation: ov.experimental?.hybridLocation ?? true,"), "hybrid override still honors its toggle");
assert.ok(debugMenu.includes("virtualSW: ov.experimental?.virtualSW ?? true,"), "virtualSW override still honors its toggle");
assert.ok(debugMenu.includes("experimental: { ...cur.experimental },"), "pushes carry the sanitized selection");
assert.ok(debugMenu.includes("ctrl.abort(), 8000"), "/build abort wiring preserved");
assert.ok(debugMenu.includes("(zl:ping timed out: worker busy)"), "ping race label preserved");

/* 3. AI chips land focus. */
assert.ok(ai.includes("const focusComposer = () =>"), "the focus helper exists");
assert.ok(ai.includes('input[aria-label="Message the assistant"]'), "the helper targets the composer");
assert.ok(ai.includes("onClick={() => { setDraft(t); focusComposer(); }}"), "chips prefill and land focus");

/* 4. Expressive easing fallbacks carry real beziers, not keywords. */
assert.ok(!theme.includes(", ease-out)") && !theme.includes(", ease-in)"), "no keyword easing fallbacks remain");
assert.ok(!theme.includes("var(--bz-slow, ease)"), "the home morph fallback.curve is expressed");
assert.ok(theme.includes("cubic-bezier(0.05, 0.7, 0.1, 1))"), "decelerate fallback present");
assert.ok(theme.includes("cubic-bezier(0.3, 0, 0.8, 0.15))"), "accelerate fallback present");
assert.ok(theme.includes("animation: lb-ai-shimmer 1.8s linear infinite;"), "the deliberate linear shimmer stays");

/* CI registration. */
assert.ok(ci.includes("ui-wave115"), "CI runs the wave 115 check");

console.log("ui-wave115: settings disclosure, debug prune, chip focus, expressive fallbacks all OK");
