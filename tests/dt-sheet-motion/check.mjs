import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

/* Gate: DevTools sheet motion must stay composite-only, WAAPI-driven
   (pages stay mounted, so mount CSS cannot re-fire on a switch) and
   disabled under reduced motion. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
const fail = (m) => { console.error("dt-sheet-motion: " + m); process.exit(1); };
const has = (s, q, m) => { if (!s.includes(q)) fail(m + " (missing: " + JSON.stringify(q) + ")"); };

const dt = readFileSync(resolve(root, "ui/src/pages/DevTools.tsx"), "utf8");

/* Motion layer: helper with reduced-motion guard + composite keyframes. */
has(dt, "function dtEnter(el", "dtEnter helper missing");
has(dt, "(prefers-reduced-motion: reduce)", "reduced-motion guard missing");
has(dt, "el.animate?.(", "WAAPI el.animate call missing");
has(dt, "translateY(6px)", "entrance keyframes must slide from 6px (composite-only)");
has(dt, "opacity: 0", "entrance keyframes missing opacity 0");
has(dt, "opacity: 1", "entrance keyframes missing opacity 1");
has(dt, "duration: 200", "entrance duration must be 200ms (occasional-tier)");
has(dt, 'const DT_ENTER = "cubic-bezier(0.2, 0, 0, 1)"', "easing constant must be the codebase emphasized curve");
/* Open: nav entrance behind the show() call in the open branch. */
const showIdx = dt.indexOf("el.show();");
if (showIdx < 0) fail("show call missing");
const navIdx = dt.indexOf('dtEnter(el.querySelector(".lb-dt-nav"))');
if (navIdx < 0 || navIdx - showIdx > 400) fail("open branch must stagger the .lb-dt-nav entrance right after show()");
/* Switch: a page effect keyed on dt.page, 40ms behind the nav. */
has(dt, '.lb-dt-page:not([hidden])', "page entrance effect must target .lb-dt-page:not([hidden])");
const pgEff = dt.indexOf(".lb-dt-page:not([hidden])");
has(dt, "}, [dt.page, open]);", "page entrance effect must depend on [dt.page, open]");
has(dt, ", 40));", "page entrance must come 40ms behind the nav");
/* Anti-patterns: no layout property animations in the motion layer. */
const helper = dt.slice(dt.indexOf("function dtEnter"), dt.indexOf("export default function DevTools"));
if (/width|height|margin|top:|left:/.test(helper)) fail("entrance must not animate layout properties");
const theme = readFileSync(resolve(root, "ui/src/theme.css"), "utf8");
const dtBlock = theme.slice(theme.indexOf(".lb-dt-content"), theme.indexOf(".lb-dt-content") + 5000);
if (dtBlock.includes("transition: all")) fail("no transition:all in the dt css block");

/* Switch stability (2026-11-24 report): no rest-frame flash on the
   delay, and the fit-detent refit tweens inside the switch window. */
has(dt, 'fill: "backwards"', "entering elements must hold the from-frame through their delay (no rest-then-teleport)");
has(dt, 'classList.add("lb-dt-switch")', "the switch window class must be added pre-paint");
has(dt, 'classList.remove("lb-dt-switch")', "the switch window class must come off after the window");
has(theme, ".lb-dt-sheet.lb-dt-switch { transition:", "the switch window height tween exists");
has(theme, "--_bottom-sheet-height 250ms cubic-bezier(0.2, 0, 0, 1); }", "the refit height tweens on the emphasized curve");
has(theme, ".lb-dt-sheet.lb-dt-switch { transition: none; }", "reduced motion kills the switch height tween");
has(theme, "transform var(--md-sys-motion-duration-medium-2, 300ms) var(--md-sys-motion-easing-standard-decelerate, cubic-bezier(0, 0, 0, 1))", "the component's own host transition list is restated, so the sheet slide survives");
/* CI registration. */
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
has(ci, "tests/dt-sheet-motion/check.mjs", "gate not registered in ci.yml");
console.log("dt-sheet-motion: OK (composite WAAPI entrance, 200ms emphasized curve, 40ms stagger, reduced-motion guard, switch window height tween, ci-registered)");
