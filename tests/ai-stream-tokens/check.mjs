/* Regression check for AI stream sanitizing (aiStore.stripStreamTokens).
   Observed live 2026-11-02: gpt-oss on the Workers AI OpenAI-compatible
   endpoint sometimes returns reasoning and answer glued together with
   harmony control tokens inside delta.content, which rendered as raw
   <|end|> and zero-width-joiner garbage in the chat UI.

   Run from the repo root:

     node --experimental-strip-types tests/ai-stream-tokens/check.mjs */

import assert from "node:assert/strict";
import { stripStreamTokens } from "../../ui/src/ai/aiStore.ts";

/* The user-visible paste reduced to its structural glue. */
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

console.log("ai-stream-tokens: ok");
