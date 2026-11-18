/* Regression check for the shell escape recapture (the engine
   navigation lockdown): the engine service worker aborts a top-level
   navigation a proxied page aimed at the shell document and posts
   {lb: "zlescape", data: {dest}}; the app must reopen the destination
   as a new in-app tab, never let a proxied page move the shell URL.
   Run from the repo root:
   node --experimental-strip-types tests/ui-wave109/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const b = read("../../ui/src/pages/Browser.tsx");
const ci = read("../../.github/workflows/ci.yml");

/* The escape branch runs ahead of the frame-matching loop. */
assert.ok(b.includes('if (data.lb === "zlescape")'), "the shell escape branch exists");

/* The destination is length-capped and must parse as http(s). */
assert.ok(b.includes('const dest = typeof raw === "string" ? raw.slice(0, 4096) : "";'), "the escape destination is length-capped");
assert.ok(b.includes('safe = /^https?:$/i.test(new URL(dest).protocol);'), "the escape destination must be http(s)");

/* The hijacked navigation reopens as a new in-app tab, not a top-level
   navigation. */
assert.ok(b.includes("live.current.newTab(dest);"), "the escape reopens as a new in-app tab");

/* The recapture is visible in the app log. */
assert.ok(b.includes('"shell escape recaptured to a new tab: "'), "the recapture is logged");

/* The ci ui job runs this check. */
assert.ok(ci.includes("../tests/ui-wave109/check.mjs"), "ci.yml runs the wave 109 check");
