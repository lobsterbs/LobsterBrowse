/* Regression check for the wave-113 AI + toolbar + tabs wave:
   (1) the AI status pill loader is 20px so the morphing shape stops
       towering over the pill;
   (2) the step list expands and collapses on the grid-rows curve with
       an inner fade/slide, killed for reduced motion;
   (3) the token counter is gone; the meta line shows elapsed only;
   (4) the first turn silently names the conversation through the sub
       model, guarded by a turn counter;
   (5) the system prompt asks for a human voice and plain-text math
       while keeping the tool docs;
   (6) the reload button spins its icon once, clockwise;
   (7) the toolbar pill hugs its content between a 130px floor and the
       old clamp ceiling, with interpolate-size carrying the width
       transition;
   (8) the tab switcher favicon is centered inside the cookie shape;
   (9) the home search commits navigation at wipe start so the proxy
       load runs under the wipe.
   Run from the repo root:
   node --experimental-strip-types tests/ui-wave113/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const ai = read("../../ui/src/pages/Ai.tsx");
const store = read("../../ui/src/ai/aiStore.ts");
const toolRow = read("../../ui/src/ai/ToolRow.tsx");
const browser = read("../../ui/src/pages/Browser.tsx");
const home = read("../../ui/src/pages/Home.tsx");
const settings = read("../../ui/src/pages/Settings.tsx");
const theme = read("../../ui/src/theme.css");
const ci = read("../../.github/workflows/ci.yml");

/* 1. Loader size. */
assert.ok(theme.includes(".lb-ai-stat-load { width: 20px; height: 20px;"), "the status loader shrunk to 20px");
assert.ok(!theme.includes("width: 26px; height: 26px;"), "the old 26px loader rule is gone");

/* 2. Steps expand/collapse. */
assert.ok(toolRow.includes('className={"lb-ai-steps" + (open ? " open" : "")}'), "steps toggle is class-based");
assert.ok(!toolRow.includes("hidden={!open}"), "the hidden toggle is gone");
assert.ok(toolRow.includes('<div className="lb-ai-steps-in">{children}</div>'), "the inner wrapper renders the steps");
assert.ok(theme.includes(".lb-ai-steps { display: grid; grid-template-rows: 0fr;"), "steps collapse on grid rows");
assert.ok(theme.includes(".lb-ai-steps.open { grid-template-rows: 1fr; }"), "steps expand to 1fr");
assert.ok(theme.includes("grid-template-rows 300ms cubic-bezier(0.2, 0, 0, 1)"), "grid expansion rides the standard curve");
assert.ok(theme.includes(".lb-ai-steps-in { min-height: 0; overflow: hidden;"), "the inner wrapper clips the collapse");
assert.ok(theme.includes("@media (prefers-reduced-motion: reduce) { .lb-ai-steps, .lb-ai-steps-in { transition: none; } }"), "reduced motion kills the expand");

/* 3. Token counter removal. */
assert.ok(!ai.includes("tokens ("), "the in/out token split display is gone");
assert.ok(ai.includes("!busy && m.ms != null"), "the meta line keys on elapsed only");
assert.ok(ai.includes("{formatElapsed(m.ms)}"), "elapsed stays");

/* 4. Silent naming. */
assert.ok(store.includes("export async function nameChat"), "nameChat is exported");
assert.ok(store.includes("2-4 word title"), "the naming reply contract is taught");
assert.ok(ai.includes("nameChat(text)"), "the first turn asks the sub model to name the chat");
assert.ok(ai.includes("turnsRef.current !== atTurn"), "a stale rename cannot clobber the chat");
assert.ok(ai.includes("titleRef.current = gen;"), "the generated title becomes the title");

/* 5. System prompt: human voice + plain math + tool docs. */
assert.ok(ai.includes("Reply like a person"), "the human voice is taught");
assert.ok(ai.includes("never LaTeX"), "math stays plain text");
assert.ok(ai.includes("web_search"), "web search doc kept");
assert.ok(ai.includes("spawn_agent"), "spawn agent doc kept");

/* 6. Reload spin. */
assert.ok(browser.includes('classList.add("lb-reload-spin")'), "a reload press spins the icon");
assert.ok(theme.includes("@keyframes lb-reload-spin { to { transform: rotate(360deg); } }"), "one clockwise revolution");
assert.ok(theme.includes("#lb-reload-btn m3e-icon.lb-reload-spin { animation: lb-reload-spin 460ms"), "the spin mounts on the reload icon only");
assert.ok(theme.includes("#lb-reload-btn m3e-icon.lb-reload-spin { animation: none; }"), "reduced motion skips the spin");

/* 7. Pill hug. */
assert.ok(theme.includes(".lb-tb-pill { interpolate-size: allow-keywords; width: max-content; min-width: 130px; max-width: clamp(130px, 28vw, 280px); }"), "the pill hugs with floor and ceiling");

/* 8. Favicon centering. */
assert.ok(theme.includes(".lb-tab-favicon { position: absolute; inset: 0; margin: auto; display: block; width: 24px; height: 24px;"), "the favicon centers inside the shape");
assert.ok(/\.lb-tab-shape \{[^}]*position: relative;/.test(theme), "the shape is the positioning context");

/* 9. Eager commit. */
assert.ok(home.includes("setWiping(true);\n    onNavigate(target);\n    shapeWipe("), "navigation starts at wipe start");
assert.ok(!home.includes("      onNavigate(target);\n      setUrl"), "navigation no longer waits for the wipe peak");

/* 10. The settings search is gone here too (wave-112 check owns the CSS side). */
assert.ok(!settings.includes("Search settings"), "the settings filter field is removed");

/* 11. CI wiring. */
assert.ok(ci.includes("node --experimental-strip-types ../tests/ui-wave113/check.mjs"), "ci runs the wave-113 gate");

console.log("ui-wave113: all checks passed");
