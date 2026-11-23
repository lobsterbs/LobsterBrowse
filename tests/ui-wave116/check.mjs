/* UI wave 116 gate: animation review fixes (bubble entrance, chevron
   and hover durations, logs entrance, AI history sheet stagger) plus
   the wave-116 UI work: owned send morph, settings deep links and the
   gliding nav indicator, the adblock hero shape + spacing, the spin
   of the home background shapes, the toolbar edit pill balance, and
   the real skeleton.
   Run from the repo root:
   node --experimental-strip-types tests/ui-wave116/check.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const theme = read("../../ui/src/theme.css");
const ai = read("../../ui/src/pages/Ai.tsx");
const ad = read("../../ui/src/browser/AdBlockCard.tsx");
const browser = read("../../ui/src/pages/Browser.tsx");
const settings = read("../../ui/src/pages/Settings.tsx");
const app = read("../../ui/src/App.tsx");
const ci = read("../../.github/workflows/ci.yml");

/* 1. Review: the non-compliant bubble entrance is gone, the compliant
   row entrance remains the single user-message motion. */
assert.ok(!theme.includes("lb-ai-me-in"), "the scale .4 620ms bubble entrance is gone");
assert.ok(theme.includes("lb-ai-msg-user-in"), "the 300ms translateY row entrance remains");
assert.ok(theme.includes(".lb-ai-user .lb-ai-bubble { align-self: flex-end; max-width: 85%; padding: 12px 18px;"), "bubble styling preserved");

/* 2. Review: chevron and hover durations live inside the budget. */
assert.ok(theme.includes(".lb-ai-tool-chev { order: 3; width: 18px; height: 18px; transform: rotate(90deg); transition: transform 250ms cubic-bezier(0.2, 0, 0, 1); }"), "tool chevron ramps in 250ms");
assert.ok(theme.includes(".lb-ai-stat-chev { font-size: 18px; transition: transform 250ms cubic-bezier(0.2, 0, 0, 1); }"), "stat chevron ramps in 250ms");
assert.ok(theme.includes("transition: background-color 150ms cubic-bezier(0.2, 0, 0, 1); }"), "stat hover reacts in 150ms");
assert.ok(theme.includes(".lb-ai-tool-chev, .lb-ai-stat-chev { transition: none; }"), "chevrons freeze under reduced motion");

/* 3. Review find: AI history rows stagger on open (WAAPI, rows are
   mounted at boot so CSS would fire at the wrong time). */
assert.ok(ai.includes("const histEnter = () => {"), "the history stagger helper exists");
assert.ok(ai.includes("histEnter();"), "the stagger runs when the sheet opens");
assert.ok(ai.includes("delay: Math.min(i, 9) * 30"), "the stagger is capped at ten rows");
assert.ok(ai.includes('if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;'), "the stagger skips under reduced motion");

/* 4. Review find: log rows surface with a quiet opacity entrance. */
assert.ok(theme.includes("@keyframes lb-log-in { from { opacity: 0; } }"), "log rows have the entrance keyframes");
assert.ok(theme.includes(".lb-log-line { animation: lb-log-in var(--md-sys-motion-duration-short-3, 150ms)"), "log rows run the entrance");
assert.ok(theme.includes(".lb-ai-send { transition: none; }"), "the send morph freezes under reduced motion");
assert.ok(theme.includes(".lb-log-line { animation: none; }"), "log rows rest under reduced motion");

/* 5. Send morph: owned trailing button (full contract in the
   ai-send-morph gate). */
const bar = ai.slice(ai.indexOf("<m3e-search-bar"), ai.indexOf("</m3e-search-bar>"));
assert.ok(bar.includes('slot="trailing"') && bar.includes('class: "lb-ai-send"'), "the owned send button sits in the trailing slot");

/* 6. AdBlock sheet: shield in a real m3e shape, no empty-state text,
   footer icon spacing, privacy deep link. */
assert.ok(ad.includes('name="4-sided-cookie"'), "the shield rides a cookie shape");
assert.ok(ad.includes('<m3e-icon name="shield" aria-hidden={true} />'), "the shield icon remains");
assert.ok(theme.includes(".lb-ad-hero-shape {"), "the hero shape rule exists");
assert.ok(!theme.includes(".lb-ad-hero-ic"), "the circle housing rule is gone");
assert.ok(!ad.includes("No blocked requests recorded"), "the empty-state sentence is gone");
assert.ok(theme.includes(".lb-ad-foot m3e-icon { margin-inline-end: var(--md-sys-measurement-space100, 8px); }"), "the footer icon keeps its distance");
assert.ok(browser.includes('onOpenSettings={() => props.onOpenSettings("privacy")}'), "the adblock sheet opens Privacy");
assert.ok(browser.includes('onFindAddons={() => props.onOpenSettings("extensions")}'), "the extension panels open Extensions");
assert.ok(browser.includes("onOpenSettings: (section?: SectionId) => void;"), "the browser carries the section-aware handler");

/* 7. Settings deep links + gliding nav indicator. */
assert.ok(settings.includes("export type SectionId"), "SectionId is exported for callers");
assert.ok(settings.includes("section: sectionLink }"), "the panel takes a section link prop");
assert.ok(settings.includes("useEffect(() => { if (sectionLink) setSection(sectionLink); }, [sectionLink]);"), "the link syncs once per mount");
assert.ok(app.includes("const openSettings = (sec?: SectionId)"), "App owns the settings entry point");
assert.ok(app.includes("section={settingsSection ?? undefined}"), "the panel receives the linked section");
assert.ok(!settings.includes("lb-set-nav-ind") && !settings.includes("navInd"), "the nav glider is gone (operator order, wave 119)");
assert.ok(!theme.includes("lb-set-nav-ind"), "the glide bar css went with it");

/* 8. Home background shapes spin slowly, constant rate, RM off. */
assert.ok(theme.includes("@keyframes lb-home-hl-spin { to { transform: rotate(1turn); } }"), "the spin keyframes exist");
assert.ok(theme.includes(".lb-home-hl1 m3e-shape { animation: lb-home-hl-spin 90s linear infinite; }"), "the big burst crawls at 90s");
assert.ok(theme.includes(".lb-home-hl2 m3e-shape { animation: lb-home-hl-spin 60s linear infinite reverse; }"), "the small sunny counter-turns at 60s");
assert.ok(theme.includes(".lb-home-hl m3e-shape { animation: none; }"), "the spin stops under reduced motion");

/* 9. Toolbar: the edit pill takes the toolbar and centers. */
assert.ok(theme.includes(".lb-tb-pill.expanded { max-width: min(92vw, 440px); }"), "the expandable pill escapes the trim clamp");
assert.ok(theme.includes(".lb-toolbar.editing { --m3e-toolbar-spacing: 0px; }"), "editing closes the row spacing");
assert.ok(theme.includes(".lb-tb-pill { interpolate-size: allow-keywords; width: max-content; min-width: 130px; max-width: clamp(130px, 28vw, 280px); }"), "the resting hug trim remains");

/* 10. Skeleton: real blocks, gentle breathe, no black flash. */
assert.ok(!theme.includes("background: #000;"), "the black frame is gone");
assert.ok(!browser.includes('<m3e-skeleton animation="pulse">'), "the giant empty pulse skeleton is gone");
assert.ok(theme.includes("animation: lb-sk-breathe 2s var(--md-sys-motion-easing-standard, cubic-bezier(0.2, 0, 0, 1)) infinite;"), "the blocks breathe on one slow shared pulse");
assert.ok(theme.includes(".lb-sk-head { width: 42%; height: 24px; border-radius: var(--md-sys-shape-corner-small, 8px); flex: 0 0 auto; background: var(--md-sys-color-surface-container-highest"), "the mock blocks are painted");
assert.ok(browser.includes("lb-sk-chips"), "the skeleton carries a chip row");
assert.ok(theme.includes(".lb-sk, .lb-sk-page { animation: none; }"), "the skeleton rests under reduced motion");

/* CI runs this check. */
assert.ok(ci.includes("../tests/ui-wave116/check.mjs"), "ci.yml runs the wave 116 gate");

console.log("ui-wave116: all checks passed");
