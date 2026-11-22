import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

/* Gate: the UI token sweep. One frost per layer (18 sub-cards, 24 chrome,
   28 overlays), one elevation fallback, one emphasized curve, one
   pill fallback, one favicon geometry source, and the AI chips give
   concrete evergreen prompts. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
const fail = (m) => { console.error("ui-consistency: " + m); process.exit(1); };
const has = (s, q, m) => { if (!s.includes(q)) fail(m + " (missing: " + JSON.stringify(q) + ")"); };
const none = (s, q, m) => { if (s.includes(q)) fail(m + " (found: " + JSON.stringify(q) + ")"); };
const count = (s, q) => s.split(q).length - 1;

const theme = readFileSync(resolve(root, "ui/src/theme.css"), "utf8");
const ai = readFileSync(resolve(root, "ui/src/pages/Ai.tsx"), "utf8");

/* Pill fallback: one full-corner fallback, never 9999. */
none(theme, "corner-full, 9999px)", "the corner-full fallback is 999px");
if (count(theme, "corner-full, 999px)") < 2) fail("corner-full 999px fallback lost");

/* Elevation level5: the dock-clip-pinned fallback is the only one. */
none(theme, "elevation-level5, 0 12px 32px", "stray level-5 shadow fallback");
none(theme, "elevation-level5, 0 10px 36px rgba(0, 0, 0, 0.3))", "stale level-5 fallback alpha");
if (count(theme, "var(--md-sys-elevation-level5, 0 10px 36px rgba(0, 0, 0, 0.28))") < 5)
  fail("the unified level-5 fallback must cover the floating panels");
none(theme, "0 4px 8px 3px rgba", "cmdk must ride the level-5 elevation, not a raw shadow");

/* Frost tiers: chrome 24px saturate(1.4), overlay 28px saturate(180%). */
none(theme, "saturate(1.3)", "the shared floating panels ride the 24px/1.4 frost");
none(theme, "saturate(1.7)", "the home wordmark sheet rides the 24px/1.4 frost");
const home = theme.slice(theme.indexOf(".lb-home-sheet {"), theme.indexOf(".lb-home-sheet {") + 700);
has(home, "blur(24px) saturate(1.4)", "home sheet keeps the chrome frost");
const peek = theme.slice(theme.indexOf(".lb-ai-att-peek {"), theme.indexOf(".lb-ai-att-peek {") + 700);
has(peek, "blur(28px) saturate(180%) brightness(.66)", "the attach peek rides the overlay frost");

/* Curves: the app emphasized curve everywhere. The only permitted .3
   form is the canonical M3E standard-accelerate fallback (wave 115). */
{
  const accel = count(theme, "cubic-bezier(0.3, 0, 0.8, 0.15)");
  const any3 = count(theme, "cubic-bezier(0.3,") + count(theme, "cubic-bezier(.3,");
  if (any3 !== accel) fail("local curve drift");
  if (accel === 0 || accel !== count(theme, "standard-accelerate")) fail("the accelerate fallback must stay tokenized on every site using the token it guards");
}
none(theme, "easing-standard, ease)", "the standard-easing fallback is the real bezier");
none(theme, "rgb(255 255 255 / 0.06)", "inset highlight drift");

/* Favicon geometry declared once (the 16px rule owns it). */
if (count(theme, ".lb-tb-favicon { width:") !== 1) fail("favicon geometry must be single-sourced");
has(theme, ".lb-tb-favicon { width: 16px; height: 16px; border-radius: 4px; }", "favicon geometry must live in the 16px rule");

/* Extension notes: card elevation, not a raw drop shadow. */
has(theme, "box-shadow: var(--md-sys-elevation-level2);", "ext notes ride level-2 elevation");
none(theme, "0 4px 12px rgba(0, 0, 0, 0.35)", "ext note raw shadow gone");

/* AI chips: concrete evergreen prompts, still wired to setDraft. */
for (const old of ['"Search the web"', '"Spawn a sub agent"', '"Summarize this page"'])
  none(ai, old, "retired AI chip string still present");
for (const t of ["Solve this: 17 * 24 - 96", "Explain error: ERR_CONNECTION_RESET", "Summarize this tab's page"])
  has(ai, '"' + t + '"', "AI chip missing");
has(ai, "onClick={() => { setDraft(t); focusComposer(); }}", "chips must keep filling the composer draft and land focus");

/* CI registration. */
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
has(ci, "tests/ui-consistency/check.mjs", "gate not registered in ci.yml");
console.log("ui-consistency: OK (one frost per layer, one level-5 fallback, one curve family, one pill fallback, evergreen AI chips)");
