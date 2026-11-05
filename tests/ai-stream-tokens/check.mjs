/* Regression check for AI stream sanitizing (aiStore.stripStreamTokens
   and aiStore.splitHarmony).
   Observed live 2026-11-02: gpt-oss on the Workers AI OpenAI-compatible
   endpoint sometimes returns reasoning and answer glued together with
   harmony control tokens inside delta.content, which rendered as raw
   <|end|> and zero-width-joiner garbage in the chat UI.
   Observed live 2026-11-05: a second leak class where analysis-channel
   text poured verbatim into the answer; splitHarmony now splits the
   stream so analysis text moves to the thinking panel and only
   final-channel text remains in the answer.

   Run from the repo root:

     node --experimental-strip-types tests/ai-stream-tokens/check.mjs */

import assert from "node:assert/strict";
import { splitHarmony, stripStreamTokens } from "../../ui/src/ai/aiStore.ts";

/* ---- 2026-11-02 leak: harmony tokens and zero-width joiners in the
   visible stream. ---- */
const leaked =
  "User wrote ws.\n" +
  "<|channel|>analysis<|message|>likely wants web search<|end|>" +
  "<|start|>assistant<|channel|>final<|message|>WS usually means WebSocket.\n" +
  "The Node\u200b\u2013\u200bws library.";

const clean = stripStreamTokens(leaked);

/* Every harmony token is gone, including the structural glue. */
assert.ok(!clean.includes("<|"), "harmony tokens must be stripped: " + JSON.stringify(clean));
assert.ok(!clean.includes("assistantfinal"), "structural glue must be stripped");
assert.ok(!/[\u200c\u200d\u2060\ufeff\u200b]/.test(clean), "zero-width joiners must be stripped");

/* The actual reasoning and answer text survives. */
assert.ok(clean.includes("User wrote ws."), "reasoning text kept");
assert.ok(clean.includes("WS usually means WebSocket."), "answer text kept");
assert.ok(clean.includes("Node\u2013ws library."), "zero-width removal must not eat real characters");

/* Plain text passes through unchanged; the strip is idempotent. */
assert.equal(stripStreamTokens("hello world"), "hello world");
assert.equal(stripStreamTokens(clean), clean);

/* ---- 2026-11-05 leak, verbatim from the user report, including the
   degenerate <|start|>assistantfinal glue where the model ate the
   channel token. ---- */
const leak2 =
  "A LONG LONG ONE\n" +
  "<|channel|>analysis\n" +
  "need to longer paragraph ( maybe multiple paragraphs). Provide extended descriptive writing.<|end|>" +
  "<|start|>assistant<|channel|>final\n" +
  "** twilight twilight... etc. ...**<|end|>" +
  "<|start|>assistantanalysis\n" +
  "We need to produce a long long paragraph ( presumably extended narrative). Provide a lengthy descriptive paragraph ( maybe multiple paragraphs). Let's produce a very long paragraph about something. We'll comply.<|end|>" +
  "<|start|>assistantfinal\n" +
  "** twilight twilight ... ( long paragraph )...** ( Provide extended descriptive writing )...<|end|>" +
  "<|start|>assistantanalysis\n" +
  "We need to respond with a long paragraph as requested: \" A LONG LONG one\". So produce a very long paragraph ( but extremely long). We'll produce a lengthy descriptive paragraph about a scene or story. Provide one long paragraph ( but extremely long). Let's produce about 100 sentences.<|end|>" +
  "<|start|>assistantfinal\n" +
  "The sun Sun Sun Sun... ( need to output long paragraph )...\n(Stop.)<|return|>";

const h2 = splitHarmony(leak2);
assert.ok(h2.final.startsWith("A LONG LONG ONE"), "answer keeps the pre-channel text");
assert.ok(!h2.final.includes("<|"), "answer must be harmony-token free");
assert.ok(!h2.final.includes("assistantfinal"), "degenerate glue must not survive in the answer");
assert.ok(!h2.final.includes("need to longer paragraph"), "analysis text must not leak into the answer");
assert.ok(h2.final.includes("twilight"), "final-channel text kept in the answer");
assert.ok(h2.final.includes("The sun"), "final-channel text kept in the answer");
assert.ok(h2.analysis.includes("need to longer paragraph"), "analysis text recovered for the thinking panel");
assert.ok(h2.analysis.includes("We need to produce"), "degenerate analysis channel recovered");
assert.ok(h2.analysis.includes("We need to respond"), "degenerate analysis channel recovered");
assert.ok(!h2.analysis.includes("<|"), "analysis must be harmony-token free too");

/* stripStreamTokens keeps the old single-string contract: analysis
   text first, then the answer, both clean. */
const s2 = stripStreamTokens(leak2);
assert.equal(s2, h2.analysis + "\n" + h2.final);

/* Plain text passes through whole; the split is idempotent. */
assert.deepEqual(splitHarmony("hello world"), { analysis: "", final: "hello world" });
assert.deepEqual(splitHarmony(h2.final), { analysis: "", final: h2.final });
assert.deepEqual(splitHarmony(s2), { analysis: "", final: s2 });

console.log("ai-stream-tokens: ok");
