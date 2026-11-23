/* Gate: the DevTools Diagnostics page redesign (2026-11-23 report).
   - The NativeTransit / Rewrite-routed text badges became two compact
     m3e-cards: a label over an expressive-weight number (the display
     weight, tabular);
   - a slim centered m3e-divider separates the cards from the logs;
   - the engine-event ring renders as m3e-list rows (severity pill
     leading, category + message line, timestamp trailing), pressing
     a row reveals its detail, and only the rendered window grows by
     IntersectionObserver demand - rows nobody scrolls to never mount.
   Run: node --experimental-strip-types ../tests/diag-list-cards/check.mjs */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const d = read("../../ui/src/pages/DevTools.tsx");
const theme = read("../../ui/src/theme.css");
const ci = read("../../.github/workflows/ci.yml");

/* 1. Count cards: one per metric, glass class kept from the card
   family, label + expressive number inside slot="content". */
assert.ok(d.includes('aria-label="NativeTransit handoff count"'), "the NativeTransit card exists");
assert.ok(d.includes('aria-label="Rewrite-routed load count"'), "the Rewrite card exists");
assert.ok(d.includes('class: "lb-dt-card lb-diag-card"'), "both cards ride the dt card glass family");
assert.ok((d.match(/slot="content" className="lb-diag-card-body"/g) ?? []).length === 2, "each card body sits in the content slot");
assert.ok(!d.includes("lb-diag-counts") && !d.includes("lb-diag-chip"), "the old text badges are gone");
assert.ok(theme.includes(".lb-diag-cards { display: grid; grid-template-columns: 1fr 1fr;"), "the cards pair on a 2-col grid");
assert.ok(theme.includes('font-variation-settings: "wght" var(--lb-wght-display);'), "the count number rides the display weight");
assert.ok(theme.includes("font-variant-numeric: tabular-nums;"), "the count digits stay tabular");

/* 2. Divider: slim, breathing on both sides, mid-range margins. */
assert.ok(d.includes('<m3e-divider {...{ class: "lb-diag-sep" }} />'), "the divider mounts between cards and logs");
assert.ok(theme.includes(".lb-diag-sep { margin: var(--md-sys-measurement-space150, 12px) 0; }"), "the divider keeps small mid margins");

/* 3. List rows: m3e-list per ring, expandable in place, keyboard
   reachable, severity pill leading and timestamp trailing. */
assert.ok(d.includes('class: "lb-diag-list"'), "the ring renders as an m3e-list");
assert.ok(d.includes('class: "lb-diag-item" + (open ? " open" : "")'), "the open row carries the open class");
assert.ok(d.includes('"aria-expanded": open ? "true" : "false"'), "expansion is announced");
assert.ok(d.includes("role: \"button\""), "rows are buttons");
assert.ok((d.match(/onKeyDown=/g) ?? []).length >= 1, "rows work from the keyboard");
assert.ok(d.includes('slot="leading" className={"lb-net-status "') , "the severity pill leads");
assert.ok(d.includes('slot="trailing" className="lb-net-dur"'), "the timestamp trails");
assert.ok(d.includes('slot="supporting-text" className="lb-net-detail"'), "the detail expands inside the row");
assert.ok(theme.includes(".lb-diag-item:hover {"), "rows respond to hover");
assert.ok(theme.includes(".lb-diag-item.open { background: var(--lb-glass-lift); }"), "the open row lifts");

/* 4. Render-on-demand windowing: the first window is bounded, the
   sentinel grows it only when reached, and nothing may mount the
   full ring up front. */
assert.ok(d.includes("const DIAG_WINDOW = 24;") && d.includes("rows.slice(0, limit)"), "the rendered window is bounded");
assert.ok(d.includes("new IntersectionObserver((entries) => {"), "the sentinel drives growth");
assert.ok(d.includes('if (entries.some((x) => x.isIntersecting)) setLimit((n) => n + DIAG_WINDOW);'), "only reaching rows grow the window");
assert.ok(d.includes("io.disconnect();"), "the observer disconnects");
assert.ok(!d.includes("rows.map((e)"), "the full ring never mounts in one pass");

/* 5. CI wiring. */
assert.ok(ci.includes("../tests/diag-list-cards/check.mjs"), "ci runs the diag-list-cards gate");
console.log("diag-list-cards: all checks passed");
