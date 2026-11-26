/* Gate: the Diagnostics-tab boot crash and the crash screen honesty.
   (1) ZeoliteDiagnostics must run every hook on every render: the
   windowing hooks (limit, openKey, moreRef, the IntersectionObserver
   effect) used to sit after the !scope / !current early returns, so
   the first render skipped them and the first poll snapshot mounted
   four extra hooks on the next render - React's hook-count invariant
   (#310) threw and the RootBoundary replaced the whole app with the
   boot failure screen.
   (2) The RootBoundary keeps the error it catches: name, message,
   stack and component stack render on the failure screen with a
   reload and a copy-details action, and the clear-data escape hatch
   stays as the honest secondary option instead of the opening claim.
   (3) The Settings nav shape morphs to sunny on the active category.
   Run: node --experimental-strip-types ../tests/dt-diag-crash/check.mjs */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const d = read("../../ui/src/pages/DevTools.tsx");
const m = read("../../ui/src/main.tsx");
const s = read("../../ui/src/pages/Settings.tsx");
const ci = read("../../.github/workflows/ci.yml");

/* (1) Hook order: every hook in ZeoliteDiagnostics runs before the
   early returns. The !scope guard is the first bail-out after the
   poll effect, so each pinned hook must sit before it. */
const diagStart = d.indexOf("function ZeoliteDiagnostics");
assert.ok(diagStart !== -1, "ZeoliteDiagnostics exists");
const diagBody = d.slice(diagStart, d.indexOf("function hostOf"));
assert.ok(diagBody.indexOf("useState(DIAG_WINDOW)") !== -1, "the window limit hook exists");
assert.ok(
  diagBody.indexOf("useState(DIAG_WINDOW)") < diagBody.indexOf("if (!scope) {"),
  "the window limit hook runs before the early returns (the #310 crash)",
);
assert.ok(
  diagBody.indexOf("useState<string | null>(null)") < diagBody.indexOf("if (!scope) {"),
  "the open-row key hook runs before the early returns",
);
assert.ok(
  diagBody.indexOf("new IntersectionObserver((entries) => {") < diagBody.indexOf("if (!scope) {"),
  "the sentinel observer effect runs before the early returns",
);
/* No hook call may follow the early returns inside the component body. */
const afterGuards = diagBody.slice(diagBody.indexOf("if (!scope) {"));
assert.ok(!/use(State|Ref|Effect)\(/.test(afterGuards.slice(0, afterGuards.indexOf("const shown = rows.slice(0, limit);"))), "no hook call sits after the early returns");
assert.ok(diagBody.includes("const shown = rows.slice(0, limit);"), "the windowed slice survives the reorder");

/* (2) The boundary reports the real error. */
assert.ok(m.includes("componentDidCatch"), "the boundary captures the error through componentDidCatch");
assert.ok(m.includes("info?.componentStack"), "the component stack is captured");
assert.ok(/getDerivedStateFromError\(err: unknown\)/.test(m), "the boundary keeps the thrown error object");
assert.ok(m.includes("e.name + \": \" + e.message"), "the failure screen shows the error name and message");
assert.ok(m.includes("e.stack"), "the failure screen shows the stack");
assert.ok(m.includes("Copy error details"), "a copy-details action exists");
assert.ok(m.includes("navigator.clipboard.writeText(detail)"), "the copy action copies the captured detail");
assert.ok(m.includes("Reload"), "a reload action exists");
assert.ok(m.includes("Clear stored data and restart"), "the clear-data escape hatch stays");
assert.ok(!m.includes("Stored app data may be corrupted."), "the failure screen no longer blames stored data first");

/* (3) The Settings nav morph: active category = sunny, rest = the
   per-category shape; the m3e-shape name transition tweens the swap. */
assert.ok(s.includes('name={section === id ? "sunny" : SECTION_META[id].shape}'));

/* CI wiring. */
assert.ok(ci.includes("../tests/dt-diag-crash/check.mjs"), "ci runs the dt-diag-crash gate");
console.log("dt-diag-crash: all checks passed");
