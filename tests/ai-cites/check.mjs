/* Gate: AI citations (2026-11-23 report).
   A web-searched answer arrived with bracket-dagger markers pasted
   from the search snippets (【1†source 1】, 【2†source 2】); LB has no
   citation UI and the glyphs rendered as junk.
   - the system prompt teaches plain (1)/(2) citations and forbids
     the marker glyphs;
   - stripCiteMarks scrubs them from every final channel regardless
     (the model ignores instructions sometimes); the scrubber is
     exported so the ai-stream-tokens gate can exercise it live.
   Run: node --experimental-strip-types ../tests/ai-cites/check.mjs */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const ai = read("../../ui/src/pages/Ai.tsx");
const store = read("../../ui/src/ai/aiStore.ts");
const gate = read("../ai-stream-tokens/check.mjs");
const ci = read("../../.github/workflows/ci.yml");

/* 1. The prompt clause. */
assert.ok(ai.includes("Write citations plainly as (1) or (2) in the sentence;"), "the prompt teaches plain citations");
assert.ok(ai.includes("never emit bracket-dagger markers"), "the prompt forbids the marker glyphs");

/* 2. The scrubber defense: whatever the prompt says, the store must
   not let a marker reach the answer. */
assert.ok(store.includes("export function stripCiteMarks(t: string): string"), "the scrubber is exported");
assert.ok(store.match(/stripCiteMarks\(/g).length >= 4, "every final-channel exit scrubs (definition + three splitHarmony sites + loop)");
assert.ok(store.includes("const CITE_MARK_RE = / ?【\\s*\\d+\\s*†[^】]*】/gu;"), "the marker pattern matches the reported glyph shape");
assert.ok(store.includes("idempotent"), "the scrubber is documented idempotent");

/* 3. The behavioral gate exercises the scrubber live (fixtures in
   ai-stream-tokens), and it is registered beside this one. */
assert.ok(gate.includes("bracket-dagger markers must not survive"), "the stream gate carries the citation fixtures");
assert.ok(gate.includes("splitHarmony(cited)"), "the fixtures run through the real splitHarmony");
assert.ok(ci.includes("../tests/ai-cites/check.mjs"), "ci runs the ai-cites gate");
console.log("ai-cites: all checks passed");
