/* Regression check for the 2026-11-23 breakout shell lane.

   - App.tsx: zl:breakout listener guarded by engineSwSource, opens a
     real top-level window (window.open, no noopener: the null return
     is the pop-up-block oracle), falls back to a text-only snackbar,
     and dedupes per host per 30 s.

   Run from the repo root:

     node --experimental-strip-types tests/breakout-shell/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../../ui/src/App.tsx", import.meta.url), "utf8");
const i = app.indexOf('"zl:breakout"');
assert.ok(i > 0, "App.tsx lost the zl:breakout listener");
const pre = app.slice(i - 1400, i);
const post = app.slice(i, i + 2600);
assert.ok(pre.includes("engineSwSource(ev)"), "breakout handler is not guarded by engineSwSource");
assert.ok(post.includes('window.open(d.dest, "_blank")'), "the handler must open d.dest as a top-level window");
assert.ok(!post.includes("noopener"), "noopener makes window.open return null and kills the oracle");
assert.ok(post.includes("M3eSnackbar.open"), "a pop-up-block refusal must degrade to a snackbar");
assert.ok(post.includes("pop-up blocker"), "the snackbar must name the pop-up blocker");
assert.ok(post.includes("BREAKOUT_DEDUP_MS"), "the per-host dedupe must use the named constant");
assert.ok(app.includes("30_000"), "the dedupe window stays 30 s");
assert.ok(!/#[0-9]/.test(post), "user-visible copy must not cite issue numbers");
console.log("breakout-shell: listener, source guard, top-level open, snackbar fallback, dedupe passed");