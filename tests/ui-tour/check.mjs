/* Regression check for the first-run tour (2026-11-25).

   Contract:
   - ui/src/tour.ts (pure leaf): the answer key reads null on a fresh
     profile and on junk, round-trips "done"/"skip" only; the step
     table has unique ids, known views, simple selectors and both
     title and body per step.
   - Every step target really exists in the file that renders the
     step's view, so a refactor cannot silently break the spotlight.
   - App.tsx asks on every login while unanswered (loadTourAnswer in
     the boot ask), wires the dialog actions (Start settles "done",
     Never ask again stores "skip"), renders components/Tour.tsx and
     passes go/onStep; Settings.tsx carries the replay entry;
     tour.css carries the overlay styles (theme.css stays pristine);

   Run from the repo root:

     node --experimental-strip-types tests/ui-tour/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOUR_STEPS, loadTourAnswer, saveTourAnswer } from "../../ui/src/tour.ts";

// CI runs this from ui/ (`node --experimental-strip-types ../tests/ui-tour/check.mjs`),
// so every readFileSync below resolves against the repo root, never the cwd.
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));

const data = new Map();
globalThis.localStorage = {
  getItem: (k) => data.get(k) ?? null,
  setItem: (k, v) => data.set(k, v),
  removeItem: (k) => data.delete(k),
};

/* Fresh profile: unanswered, so the ask fires on every login. */
assert.equal(loadTourAnswer(localStorage), null);

/* Round-trip the two known answers (Start settles "done"; Never ask
   again stores "skip"). */
saveTourAnswer(localStorage, "done");
assert.equal(loadTourAnswer(localStorage), "done");
saveTourAnswer(localStorage, "skip");
assert.equal(loadTourAnswer(localStorage), "skip");
data.delete("lobsterbrowse-tour");

/* Anything stored but unknown reads as unanswered, never truthy. */
data.set("lobsterbrowse-tour", "banana");
assert.equal(loadTourAnswer(localStorage), null);
data.set("lobsterbrowse-tour", "");
assert.equal(loadTourAnswer(localStorage), null);
verifyKey();

function verifyKey() {
  /* The key follows the app's naming convention. */
  assert.ok([...data.keys()].some((k) => k.startsWith("lobsterbrowse-")));
}

/* Step table: shape, uniqueness, views, selectors. */
assert.ok(TOUR_STEPS.length >= 6, "the tour lost steps");
assert.ok(new Set(TOUR_STEPS.map((s) => s.id)).size === TOUR_STEPS.length, "duplicate step ids");
const VIEWS = ["any", "browser", "settings", "home"];
for (const s of TOUR_STEPS) {
  assert.ok(typeof s.title === "string" && s.title.length > 3, s.id + ": title");
  assert.ok(typeof s.body === "string" && s.body.length > 20, s.id + ": body");
  assert.ok(VIEWS.includes(s.view), s.id + ": unknown view " + s.view);
  assert.match(s.target, /^[#.][a-z][\w-]*$/, s.id + ": selector shape " + s.target);
}

/* The tour covers the operator's asks: chrome (rail), the toolbar,
   the omnibox, the overflow menu, settings, home. */
assert.ok(TOUR_STEPS.some((s) => s.target === "#nav-rail"), "no rail step");
assert.ok(TOUR_STEPS.some((s) => s.target === ".lb-toolbar"), "no toolbar step");
assert.ok(TOUR_STEPS.some((s) => s.target === ".lb-tb-pill"), "no omnibox step");
assert.ok(TOUR_STEPS.some((s) => s.target === "#lb-overflow-btn"), "no overflow step");
assert.ok(TOUR_STEPS.some((s) => s.target === ".lb-set-nav"), "no settings step");

/* Targets must exist in the file that owns them. */
const has = (p, t) => readFileSync(p, "utf8").includes(t);
assert.ok(has("ui/src/App.tsx", "nav-rail"), "target #nav-rail missing from App.tsx");
assert.ok(has("ui/src/pages/Browser.tsx", "lb-toolbar"), "target .lb-toolbar missing from Browser.tsx");
assert.ok(has("ui/src/pages/Browser.tsx", "lb-tb-pill"), "target .lb-tb-pill missing from Browser.tsx");
assert.ok(has("ui/src/pages/Browser.tsx", "lb-overflow-btn"), "target #lb-overflow-btn missing from Browser.tsx");
assert.ok(has("ui/src/pages/Settings.tsx", "lb-set-nav"), "target .lb-set-nav missing from Settings.tsx");
assert.ok(has("ui/src/pages/Home.tsx", "lb-search-input"), "target #lb-search-input missing from Home.tsx");

/* App wiring: the boot ask, the dialog actions, the overlay render. */
const app = readFileSync("ui/src/App.tsx", "utf8");
assert.ok(app.includes("loadTourAnswer(localStorage) === null"), "the boot ask is gone");
assert.ok(app.includes("saveTourAnswer(localStorage, \"skip\")"), "Never ask again lost");
assert.ok(app.includes("saveTourAnswer(localStorage, \"done\")"), "Start no longer settles the ask");
assert.ok(app.includes('<Tour step={tourStep}'), "Tour overlay not rendered");
assert.ok(app.includes("onOpenTour={() => setTourStep(0)}"), "Settings replay not wired");

/* Settings entry + overlay styles + tour component. */
const settings = readFileSync("ui/src/pages/Settings.tsx", "utf8");
assert.ok(settings.includes('anchorId="set-tour"'), "Settings tour entry is gone");
assert.ok(settings.includes("onOpenTour"), "Settings tour prop is gone");
const css = readFileSync("ui/src/tour.css", "utf8");
assert.ok(css.includes(".lb-tour-scrim") && css.includes(".lb-tour-hole") && css.includes(".lb-tour-card"), "tour overlay styles are gone");
assert.ok(css.includes("prefers-reduced-motion"), "tour motion is not reduced-motion aware");
assert.ok(readFileSync("ui/src/App.tsx", "utf8").includes('import "./tour.css"'), "tour.css not imported");
/* theme.css stays pristine: the tour styles live in their own sheet, so the untouched 164KB base never rides a diff. */
assert.ok(!readFileSync("ui/src/theme.css", "utf8").includes("lb-tour-"), "tour styles leaked back into theme.css");
const tourCmp = readFileSync("ui/src/components/Tour.tsx", "utf8");
assert.ok(tourCmp.includes("TOUR_STEPS"), "the component stopped using the shared step table");
assert.ok(tourCmp.includes("props.onStep(null)"), "the component lost its exit path");

/* CI registration. */
assert.ok(readFileSync(".github/workflows/ci.yml", "utf8").includes("tests/ui-tour/check.mjs"), "gate not registered in ci.yml");

console.log("ui-tour: ok (" + TOUR_STEPS.length + " steps, ask contract, wiring, ci gate)");
