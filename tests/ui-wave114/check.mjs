/* Regression check for the wave-114 DevTools sheet redesign:
   (1) the sub-tool picker is a real m3e-tabs bar (2026-11-23
       supersession of the connected button group); the component
       owns the ink bar and the selected tab is the active page;
   (2) the header title is two lines: DevTools over the proxied host,
       keeping the wave-85 title-slot pin intact;
   (3) rows stagger in on sheet open only (not sub-tool flips), 60ms
       out plus 24ms per position, capped at 12 for long consoles;
   (4) the broken Network page is fully removed (2026-11-23);
   (5) the sheet exposes fit/half/full detents from its tokens.
   Run from the repo root:
   node --experimental-strip-types tests/ui-wave114/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const d = read("../../ui/src/pages/DevTools.tsx");
const theme = read("../../ui/src/theme.css");
const ci = read("../../.github/workflows/ci.yml");

/* 1. Tabs picker (2026-11-23 supersession): the connected button
   group became a real m3e-tabs bar; the component owns the ink bar
   and tab semantics, the change event mirrors selected pages into
   state, and each visible tab carries aria-current. */
assert.ok(d.includes("<m3e-tabs"), "the picker is an m3e-tabs bar");
assert.ok(d.includes("lb-dt-nav-tabs"), "the tabs bar carries its own class");
assert.ok(d.includes('selected={on}'), "the selected tab is the active page");
assert.ok(d.includes('aria-current={on ? "true" : undefined}'), "aria-current stays on the active tab");
assert.ok(!d.includes('variant="connected"'), "the connected button group is retired");
assert.ok(!d.includes('m3eAttrs(el, { toggle: "" })'), "the toggle-attribute helper left with the segments");
assert.ok(theme.includes(".lb-dt-nav-tabs"), "the tabs class exists in css");

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

/* 4. Network page removed (2026-11-23): the tab was fully broken and
   served no purpose, so its status pill, empty states, and the
   download registry left with it. */
assert.ok(!d.includes('import { StatRow } from "../ai/ToolRow"'), "StatRow left with the network page");
assert.ok(!d.includes("<StatRow"), "the network status pill is gone");
assert.ok(!d.includes("netFailed"), "the network failure counter is gone");
assert.ok(!d.includes("No matching requests."), "the network empty state is gone");
assert.ok(!d.includes("Network requests will appear here."), "the network quiet empty state is gone");

/* 5. Detents. */
assert.ok(d.includes('detents: "fit half full"'), "the sheet exposes fit/half/full detents");

/* 6. CI wiring. */
assert.ok(ci.includes("node --experimental-strip-types ../tests/ui-wave114/check.mjs"), "ci runs the wave-114 gate");

console.log("ui-wave114: all checks passed");
