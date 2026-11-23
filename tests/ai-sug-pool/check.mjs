/* Gate: the AI page refresh (2026-11-23 report).
   - The AI view shares the Home background (HomeBg renders behind
     the conversation, inside an isolated stacking context);
   - the starter chips rotate: the math prompt stays first, the other
     two roll per page visit from a generic pool (no dev-facing
     prompts);
   - a finished answer carries a hover-revealed copy button beside
     the elapsed time.
   Run: node --experimental-strip-types ../tests/ai-sug-pool/check.mjs */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const ai = read("../../ui/src/pages/Ai.tsx");
const theme = read("../../ui/src/theme.css");
const ci = read("../../.github/workflows/ci.yml");

/* 1. Home background behind the conversation. */
assert.ok(ai.includes('import HomeBg from "./HomeBg";'), "the AI page imports HomeBg");
assert.ok(ai.includes("<HomeBg />"), "the background renders in the AI view");
assert.ok(theme.includes(".lb-ai { position: relative; isolation: isolate;"), "the view isolates its stacking context so the background stays inside");

/* 2. Rotating starter pool. */
assert.ok(ai.includes("const MATH_PROMPT = \"Solve this: 17 * 24 - 96\";"), "the math starter stays first");
assert.ok(ai.includes("const SUGGESTION_POOL = ["), "the generic pool exists");
assert.ok(ai.includes("while (out.length < 3 && pool.length > 0)"), "two distinct draws join the math prompt");
assert.ok(ai.includes("const [suggestions] = useState(rollSuggestions);"), "the roll happens once per mount");
assert.ok(ai.includes("{suggestions.map((t) => ("), "the chips render the rolled suggestions");
for (const dev of ["ERR_CONNECTION_RESET", "Summarize this tab's page", "Explain error"])
  assert.ok(!ai.slice(ai.indexOf("SUGGESTION_POOL")).includes(dev), "the retired dev-facing prompt is out of the pool: " + dev);
assert.ok(ai.includes('"What should I make for dinner tonight?",'), "the pool keeps a concrete generic example");

/* 3. Hover-revealed response copy. */
assert.ok(ai.includes('aria-label="Copy response"'), "the copy button reads as response copy");
assert.ok(ai.includes("void copyText(m.text ?? \"\")"), "it copies the answer text through the shared helper");
assert.ok(ai.includes("copiedAt === i ? \"check\" : \"content_copy\""), "a successful copy flashes the check glyph");
assert.ok(theme.includes(".lb-ai-copy { opacity: 0;"), "the copy button is quiet at rest");
assert.ok(theme.includes(".lb-ai-meta:hover .lb-ai-copy"), "hover reveals it");
assert.ok(theme.includes(".lb-ai-meta .lb-ai-copy:focus-visible { opacity: 1; }"), "keyboard focus reveals it too");

/* 4. CI wiring. */
assert.ok(ci.includes("../tests/ai-sug-pool/check.mjs"), "ci runs the ai-sug-pool gate");
console.log("ai-sug-pool: all checks passed");
