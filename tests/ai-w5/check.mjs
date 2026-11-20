/* W5 regression check: the AI model roles after the Workers AI
   go-live. The fixed MAIN agent is AI_MODELS[0] (the model picker
   is gone); the 2026-11-20 Cloudflare deprecation wave killed the
   operator-requested nemotron-3 main, so the seat stays on
   gpt-oss-120b, and the dead nemotron entry stays in the list with
   its deprecation note. Gemma 4 is the single SUB agent model
   (spawn_agent carries no model parameter anymore; one call per
   sub agent, several calls per turn allowed), scout stays the
   silent vision backend, and the server whitelist still accepts
   every model the client can send. The Cloudflare credentials
   live ONLY in the Render environment: no key-shaped literal is
   committed anywhere.
   Run from the repo root:
   node --experimental-strip-types tests/ai-w5/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const store = read("../../ui/src/ai/aiStore.ts");
const page = read("../../ui/src/pages/Ai.tsx");
const server = read("../../server/bin/server/src/main.rs");
const ci = read("../../.github/workflows/ci.yml");

/* 1. The main agent: gpt-oss-120b, the model the account serves
   after the 2026-11-20 deprecation wave killed the requested
   nemotron; the nemotron entry stays, honestly marked dead. */
const m0 = /export const AI_MODELS: AiModel\[\] = \[[\s\S]*?\{ id: "([^"]+)"/.exec(store);
assert.ok(m0, "AI_MODELS list found");
assert.ok(m0[1] === "@cf/openai/gpt-oss-120b", "GPT-OSS 120b is AI_MODELS[0] (the fixed main agent)");
assert.ok(/nemotron[\s\S]*deprecated by Cloudflare 2026-11-20/.test(store), "the dead nemotron entry carries its deprecation note");
assert.ok(page.includes("const model: AiModel = AI_MODELS[0];"), "the page pins the fixed main agent");
assert.ok(!page.includes("loadModelId("), "the model picker is gone from the page");

/* 2. Gemma is the single sub agent model. */
assert.ok(store.includes('export const SUB_AGENT_MODEL = "@cf/google/gemma-4-26b-a4b-it";'), "SUB_AGENT_MODEL is Gemma 4");
assert.ok(!store.includes("SUB_AGENT_MODELS"), "the two-model sub agent enum is gone");
const tool = /export const SPAWN_AGENT_TOOL = \{([\s\S]*?)\n\} as const;/.exec(store);
assert.ok(tool, "spawn_agent tool schema found");
assert.ok(!tool[1].includes('"model"'), "spawn_agent no longer carries a model parameter");
assert.ok(tool[1].includes('"task"'), "spawn_agent takes the subtask");
assert.ok(/spawn multiple sub agents in parallel/i.test(tool[1]), "the tool description teaches parallel sub agents");

/* 3. The page runs sub agents on Gemma only. */
assert.ok(page.includes("SUB_AGENT_MODEL"), "the page imports SUB_AGENT_MODEL");
assert.ok(page.includes("runSubAgent({ model: SUB_AGENT_MODEL, task"), "sub agent turns run on SUB_AGENT_MODEL");
assert.ok(/spawn_agent to delegate a self-contained subtask to a sub agent \(Gemma\)/.test(page), "the system prompt names the Gemma sub agent");
assert.ok(page.includes("tools: [WEB_SEARCH_TOOL, SPAWN_AGENT_TOOL]"), "both tools ride every turn");

/* 4. Scout stays the vision backend; the server whitelist covers
   each model the client can reach. */
assert.ok(page.includes("AI_MODELS.find((m) => m.vision)"), "image turns re-route to the vision model");
for (const id of ["@cf/nvidia/nemotron-3-120b-a12b", "@cf/google/gemma-4-26b-a4b-it", "@cf/meta/llama-4-scout-17b-16e-instruct"]) {
  assert.ok(server.includes('"' + id + '"'), "server whitelist carries " + id);
}
assert.ok(server.includes("CLOUDFLARE_AI_KEY") && server.includes("CLOUDFLARE_ACCOUNT_ID"), "the server reads the env credentials");

/* 5. Credential hygiene: the Cloudflare key never enters the repo
   (env-only by design; the check scans the shipped trees). */
const keyShaped = /cfat_[A-Za-z0-9_-]{10,}/;
assert.ok(!keyShaped.test(store) && !keyShaped.test(page) && !keyShaped.test(server), "no key-shaped literal in the client/server sources");
assert.ok(!/(CLOUDFLARE_AI_KEY|CLOUDFLARE_ACCOUNT_ID)["']?\s*[:=]\s*["'][^"']{8,}/.test(ci + server + store + page), "no credential assignment literal anywhere");

/* 6. CI wiring. */
assert.ok(ci.includes("node --experimental-strip-types ../tests/ai-w5/check.mjs"), "ci runs the ai-w5 gate");

console.log("ai-w5: all checks passed");
