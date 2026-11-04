/* Regression check for AI turn metrics (formatElapsed in ui/src/ai/metrics.ts).

   Run from the repo root:

     node --experimental-strip-types tests/ai-metrics/check.mjs */

import assert from "node:assert/strict";
import { formatElapsed } from "../../ui/src/ai/metrics.ts";

/* Milliseconds render bare; leading zero units are skipped. */
assert.equal(formatElapsed(70), "70ms");
assert.equal(formatElapsed(210), "210ms");
assert.equal(formatElapsed(1000), "1 second, 0ms");
assert.equal(formatElapsed(1000 + 210), "1 second, 210ms");
assert.equal(formatElapsed(65000), "1 minute, 5 seconds, 0ms");
assert.equal(formatElapsed(60000), "1 minute, 0 seconds, 0ms");

/* The user's example shape: hour, minutes, seconds, milliseconds. */
assert.equal(formatElapsed(6260070), "1 hour, 44 minutes, 20 seconds, 70ms");

/* Singular/plural units and negative input never render negative. */
assert.equal(formatElapsed(3600000), "1 hour, 0 minutes, 0 seconds, 0ms");
assert.equal(formatElapsed(-5), "0ms");

console.log("ai-metrics: ok");
