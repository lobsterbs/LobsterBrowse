/* LB#260 popup and recapture burst gate: regression check.
   Runs in CI with node --experimental-strip-types. Exit 1 on fail. */
import { createPopupGate } from "../../ui/src/browser/popupGate.ts";
import { readFileSync } from "node:fs";

let fails = 0;
const ok = (name, cond) => {
  if (!cond) {
    console.error("FAIL: " + name);
    fails++;
  }
};

/* User class is never limited, no matter the rate. */
{
  const g = createPopupGate(2, 5000, 4);
  for (let i = 0; i < 20; i++) ok("user class always allowed", g.allow(false, 1000 * i));
  ok("user class did not consume budget", g.allow(true, 1000 * 20 + 1));
}

/* Scripted burst cap: 4th open inside the window is denied. */
{
  const g = createPopupGate(3, 5000, 10);
  ok("scripted 1", g.allow(true, 1000) === true);
  ok("scripted 2", g.allow(true, 1100) === true);
  ok("scripted 3", g.allow(true, 1200) === true);
  ok("scripted 4 capped", g.allow(true, 1300) === false);
  ok("denied counter", g.denied() === 1);
  ok("scripted 5 still capped", g.allow(true, 1400) === false);
  ok("denied counter grows", g.denied() === 2);
}

/* Window decay: after windowMs slides, scripted opens are allowed again. */
{
  const g = createPopupGate(2, 5000, 10);
  ok("fill burst", g.allow(true, 1000) && g.allow(true, 1500));
  ok("capped inside window", g.allow(true, 2000) === false);
  ok("allowed after decay", g.allow(true, 1500 + 5000 + 1) === true);
}

/* Lifetime total cap hit before burst: stays denied even after decay. */
{
  const g = createPopupGate(3, 1000, 4);
  ok("total 1", g.allow(true, 0));
  ok("total 2", g.allow(true, 10));
  /* spaced out so the burst window never fills */
  ok("total 3", g.allow(true, 2000));
  ok("total 4", g.allow(true, 4000));
  ok("total 5 denied even after decay", g.allow(true, 9000) === false);
  ok("denied count one", g.denied() === 1);
}

/* Source wiring scans: the shim passes scripted=true, the guard consults
   the gate, and the debug menu rows always settle. */
{
  const browser = readFileSync(new URL("../../ui/src/pages/Browser.tsx", import.meta.url), "utf8");
  ok("Browser.tsx imports the gate", browser.includes("createPopupGate") && browser.includes('../browser/popupGate'));
  ok("Browser.tsx marks scripted opens", browser.includes("openInTab(raw, true)"));
  ok("Browser.tsx gate consult in openInTab", browser.includes("popupGate.allow(true, Date.now())"));

  const app = readFileSync(new URL("../../ui/src/App.tsx", import.meta.url), "utf8");
  ok("App.tsx imports the gate", app.includes("./browser/popupGate"));
  const gi = app.indexOf("shell navigate guard");
  ok("App.tsx guard log present", gi !== -1);
  const ctor = app.indexOf("createPopupGate(5, 10000, 30)");
  const consult = app.indexOf("gate.allow(true, Date.now())");
  ok("App.tsx guard constructs and consults the gate in order", ctor !== -1 && consult !== -1 && ctor < consult && consult < gi);

  const dbg = readFileSync(new URL("../../ui/src/pages/DebugMenu.tsx", import.meta.url), "utf8");
  ok("DebugMenu /build abort wired", dbg.includes("ctrl.abort(), 8000"));
  ok("DebugMenu /build catch label", dbg.includes("(/build fetch failed or timed out)"));
  ok("DebugMenu ping race label", dbg.includes("(zl:ping timed out: worker busy)"));

  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  ok("ci.yml wires popup-gate check", ci.includes("tests/popup-gate/check.mjs"));
}

if (fails > 0) {
  console.error("popup-gate: " + fails + " check(s) failed");
  process.exit(1);
}
console.log("popup-gate: all checks passed (13)");
