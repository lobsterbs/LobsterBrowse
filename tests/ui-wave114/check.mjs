/* Regression check for the wave-114 DevTools sheet redesign:
   (1) the sub-tool picker is a connected m3e-button-group of toggle
       segments; the group owns radiogroup semantics and the selected
       segment is the active page;
   (2) the header title is two lines: DevTools over the proxied host,
       keeping the wave-85 title-slot pin intact;
   (3) rows stagger in on sheet open only (not sub-tool flips), 60ms
       out plus 24ms per position, capped at 12 for long consoles;
   (4) the network page reuses the AI status pill above its rows and
       carries the #94-style empty state;
   (5) the sheet exposes fit/half/full detents from its tokens.
   Run from the repo root:
   node --experimental-strip-types tests/ui-wave114/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const d = read("../../ui/src/pages/DevTools.tsx");
const theme = read("../../ui/src/theme.css");
const ci = read("../../.github/workflows/ci.yml");

/* 1. Connected toggle group picker. */
assert.ok(d.includes('variant="connected"'), "the picker group is connected");
assert.ok(d.includes('toggle=""'), "every segment is a toggle button");
assert.ok(d.includes('selected={on}'), "the selected segment is the active page");
assert.ok(d.includes('aria-current={on ? "true" : undefined}'), "aria-current stays on the active segment");
assert.ok(d.includes('"lb-dt-nav-group"'), "the group carries its own class");
assert.ok(!d.includes('variant={on ? "tonal" : "text"}'), "the tonal pill row is retired");
assert.ok(theme.includes(".lb-dt-nav-group"), "the group class exists in css");

/* 2. Two-line title. */
assert.ok(d.includes('<span slot="title">DevTools<span className="lb-dt-title-sub">'), "the title keeps the wave-85 pin and gains the host sub-line");
assert.ok(d.includes("hostOf(tab.url)"), "the sub-line shows the proxied host");
assert.ok(theme.includes(".lb-dt-title-sub"), "the sub-line css exists");

/* 3. Open-only row stagger. */
assert.ok(d.includes("const rows = el.querySelectorAll("), "the open effect gathers rows");
assert.ok(d.includes(".lb-dt-page:not([hidden]) .lb-console-line"), "stagger targets the visible page");
assert.ok(d.includes("i < 12"), "the stagger caps at 12 rows");
assert.ok(d.includes("60 + i * 24"), "60ms out, 24ms per position");
assert.ok(d.indexOf("el.show();") < d.indexOf("const rows = el.querySelectorAll("), "the nav still enters right after show");

/* 4. Network status row + empty state. */
assert.ok(d.includes('import { StatRow } from "../ai/ToolRow"'), "StatRow is reused from the AI page");
assert.ok(d.includes("<StatRow"), "the network page renders the status pill");
assert.ok(d.includes("netFailed > 0"), "the status line only claims failures it counted");
assert.ok(d.includes("No matching requests."), "a filtered-to-nothing network log says so");
assert.ok(d.includes("Network requests will appear here."), "a fresh network log carries the quiet empty state");

/* 5. Detents. */
assert.ok(d.includes('detents="fit half full"'), "the sheet exposes fit/half/full detents");

/* 6. CI wiring. */
assert.ok(ci.includes("node --experimental-strip-types ../tests/ui-wave114/check.mjs"), "ci runs the wave-114 gate");

console.log("ui-wave114: all checks passed");
