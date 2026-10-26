/* node --experimental-strip-types tests/page-load/check.mjs */
import assert from "node:assert/strict";
import { samplePageLoad } from "../../ui/src/browser/pageLoad.ts";

const sample = { last: -1, streak: 0 };
const tick = (count, done, armed) => samplePageLoad(sample, count, done, armed);
assert.equal(tick(0, false, true), "loading");
for (let i = 0; i < 80; i++) {
  assert.equal(tick(0, false, true), "loading", "quiet or old document must not settle before load");
}
assert.equal(tick(0, true, true), "settled", "an already-quiescent document can settle after load");
// A late component triggers rearm even when it is just one resource.
assert.equal(tick(1, true, false), "loading");
assert.equal(tick(1, true, true), "loading");
assert.equal(tick(1, true, true), "loading");
assert.equal(tick(1, true, true), "settled");
// Resource activity during the quiet window restarts the window.
assert.equal(tick(2, true, false), "loading");
assert.equal(tick(2, true, true), "loading");
assert.equal(tick(3, true, true), "loading");
assert.equal(tick(3, true, true), "loading");
assert.equal(tick(3, true, true), "loading");
assert.equal(tick(3, true, true), "settled");
// A redirect/new document reopens loading even if no resource is new yet.
assert.equal(tick(0, false, false), "loading");
assert.equal(tick(0, false, true), "loading");
console.log("page-load: parser completion, unbounded wait, quiescence, single-resource rearm, redirect passed");
