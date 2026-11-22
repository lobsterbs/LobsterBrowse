/* AI chatbar send control (expressive demo port): the labeled tonal
   button beside the search bar is gone; one trailing icon-only
   m3e-icon-button inside the search bar carries send and stop. It is
   disabled when there is nothing to send, morphs to a filled square
   when a draft or attachment makes sending possible, and aborts the
   live stream while busy. All wiring is real (no mocks).
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
assert.ok(!ai.includes('class: "lb-ai-send"'), "the old labeled send button is gone");
assert.ok(!ai.includes('name={busy ? "stop" : "send"}'), "the old send icon swap is gone");

/* 2. Wiring is real: send fires the real send(), busy fires the real
   abort; nothing is mocked. */
assert.ok(ai.includes("busy ? abortRef.current?.abort() : void send()"), "one handler covers send and abort through the real refs");

/* 3. Demo morph: tonal+rounded when idle, filled+square when there is
   something to send; disabled otherwise. */
assert.ok(ai.includes('{ variant: "filled", shape: "square" }'), "a ready draft morphs the button to filled square");
assert.ok(ai.includes('{ variant: "tonal", shape: "rounded" }'), "the idle rest state is tonal rounded");
assert.ok(ai.includes("busy || draft.trim() || attached.length ? {} : { disabled: true }"), "the button disables when there is nothing to send");

/* 4. Icons: arrow_upward sends, stop aborts. */
assert.ok(ai.includes('name={busy ? "stop" : "arrow_upward"}'), "send is arrow_upward, busy is stop");

/* 5. Theme: the old side-by-side send rule is gone. */
assert.ok(!theme.includes(".lb-ai-send"), "the old send button rule is gone from the theme");

/* 6. The ready state stays legible: the search bar's trailing slot
   recolors every slotted icon button's generic icon token, so the
   filled send state pins its icon to on-primary. */
assert.ok(theme.includes('.lb-ai-bar m3e-search-bar m3e-icon-button[slot="trailing"][variant="filled"] { --m3e-filled-icon-button-icon-color: var(--md-sys-color-on-primary); }'), "the filled send button pins its icon to on-primary");

/* CI runs this check. */
assert.ok(ci.includes("../tests/ai-send-morph/check.mjs"), "ci.yml runs the ai-send-morph check");

console.log("ai-send-morph: all checks passed");

