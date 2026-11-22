/* AI chatbar send control: one trailing element of the search bar
   carries send and stop. Wave116: it is an owned button, because the
   m3e-icon-button variant rules flip the whole fill in the same frame
   the disabled attribute changes and nothing outside the shadow root
   can transition that; the morph lived one frame, never animated.
   The owned button stays disabled when there is nothing to send,
   morphs from a greyed-out tonal disc to a filled 12px-round square
   when a draft or attachment makes sending possible (200ms
   emphasized), and aborts the live stream while busy. All wiring is
   real (no mocks). Reduced motion cuts the transitions.
   Run from the repo root:
   node --experimental-strip-types tests/ai-send-morph/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const ai = read("../../ui/src/pages/Ai.tsx");
const theme = read("../../ui/src/theme.css");
const ci = read("../../.github/workflows/ci.yml");

/* 1. The control lives inside the search bar's trailing slot. */
const bar = ai.slice(ai.indexOf("<m3e-search-bar"), ai.indexOf("</m3e-search-bar>"));
assert.ok(bar.indexOf("<m3e-search-bar") !== -1 && bar.includes("</"), "the search bar block was found");
assert.ok(bar.includes('name={busy ? "stop" : "arrow_upward"}'), "the arrow_upward send sits inside the search bar");
assert.ok(bar.includes('slot="trailing"'), "the send control is a trailing element of the bar");
assert.ok(bar.includes('class: "lb-ai-send"'), "the send control is the owned lb-ai-send button");
assert.ok(!ai.includes('variant: "filled", shape: "square"'), "the m3e variant morph spread is gone");

/* 2. Wiring is real: send fires the real send(), busy fires the real
   abort; nothing is mocked. */
assert.ok(ai.includes("busy ? abortRef.current?.abort() : void send()"), "one handler covers send and abort through the real refs");

/* 3. The morph is owned and CSS-driven: ready adds lb-ready, the rest
   is disabling state. */
assert.ok(ai.includes('"lb-ai-send" + (draft.trim() || attached.length ? " lb-ready" : "")'), "a ready draft morphs the button via lb-ready");
assert.ok(ai.includes("disabled={!busy && !draft.trim() && !attached.length}"), "the button disables when there is nothing to send");

/* 4. Icons: arrow_upward sends, stop aborts. */
assert.ok(ai.includes('name={busy ? "stop" : "arrow_upward"}'), "send is arrow_upward, busy is stop");

/* 5. Theme: the owned button owns the morph (bg, radius, color all
   transition); the old variant-token pin is gone. */
assert.ok(theme.includes(".lb-ai-send {"), "the owned send button rule exists");
assert.ok(theme.includes(".lb-ai-send.lb-ready { border-radius: 12px; background: var(--md-sys-color-primary"), "ready morphs to the filled square");
assert.ok(theme.includes("border-radius 200ms cubic-bezier(0.2, 0, 0, 1)"), "the shape morph transitions");
assert.ok(!theme.includes('m3e-icon-button[slot="trailing"][variant="filled"]'), "the old trailing variant pin is gone");

/* 6. Reduced motion cuts the morph. */
assert.ok(theme.includes(".lb-ai-send { transition: none; }"), "reduced motion skips the morph");

/* CI runs this check. */
assert.ok(ci.includes("../tests/ai-send-morph/check.mjs"), "ci.yml runs the ai-send-morph check");

console.log("ai-send-morph: all checks passed");
