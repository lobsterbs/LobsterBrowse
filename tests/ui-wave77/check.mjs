/* Regression check for the wave 77 UI batch: the gated suggestor
   (SUGGEST_MIN_CHARS + buildSuggests ordering and sources), the
   engine brand marks, and the ASCII-art background config helpers
   (toneMap, bayerAt, charsFor, ASCII_PARAMS).

   Run from the repo root:

     node --experimental-strip-types tests/ui-wave77/check.mjs */

import assert from "node:assert/strict";
import { ENGINES } from "../../ui/src/settings.ts";
import { buildSuggests, SUGGEST_MIN_CHARS } from "../../ui/src/suggest.ts";
import { markFor, MARKED_ENGINES } from "../../ui/src/engineMarks.ts";
import { ASCII_PARAMS, bayerAt, charsFor, toneMap } from "../../ui/src/asciiConfig.ts";

/* ---- The suggestor stays shut until engines accept the request. ---- */
assert.equal(SUGGEST_MIN_CHARS, 2, "engines accept completion requests from 2 chars");
assert.deepEqual(buildSuggests("c", { history: ["cats.com"], engineName: "Brave", search: "s", remote: [{ text: "cats", src: "Brave" }], searchFor: () => "s" }), [], "one character must not open the menu");
assert.deepEqual(buildSuggests("", { history: [], engineName: "Brave", search: "s", searchFor: () => "s" }), [], "empty input must not open the menu");
/* Whitespace never fakes the gate: the count applies to the
   trimmed query, so padded single chars stay shut and padded two
   chars open. */
assert.deepEqual(buildSuggests("  c  ", { history: ["cats.com"], engineName: "Brave", search: "s", remote: [{ text: "cats", src: "Brave" }], searchFor: () => "s" }), [], "padded single char stays shut");
assert.equal(buildSuggests(" ca", { history: [], engineName: "Brave", search: "s", remote: [], searchFor: () => "s" }).length, 1, "padded two chars open the menu");

/* ---- Ordering: relevance-ranked engine suggestions lead. ---- */
const opts = {
  history: ["https://cats.example/old"],
  engineName: "Brave",
  search: "https://search.brave.com/search?q=cat",
  searchFor: (q) => "https://search.brave.com/search?q=" + encodeURIComponent(q),
};
const rows = buildSuggests("cat", {
  ...opts,
  remote: [
    { text: "wildcats", src: "Brave" },
    { text: "concatenate", src: "Brave" },
    { text: "catalogue", src: "Brave" },
  ],
});
/* Engine rows come first, prefix hit leading the substring hits. */
assert.equal(rows[0].text, "catalogue", "prefix match must lead the engine rows");
/* Stable sort keeps the provider order within the same rank. */
assert.equal(rows[1].text, "wildcats", "substring rank preserves provider order");
assert.equal(rows[2].text, "concatenate", "substring rank preserves provider order");
assert.equal(rows[3].text, "cat · Brave search", "the direct search row follows the engine rows");
assert.equal(rows[3].src, "Brave", "the direct search row carries the engine source");
assert.equal(rows[4].text, "https://cats.example/old", "matching history follows the direct row");
assert.ok(rows.every((r) => r.url.length > 0), "every row carries a URL");

/* A URL query appends the URL row LAST, after the direct search. */
const urlRows = buildSuggests("cats.example", { ...opts, remote: [] });
assert.equal(urlRows[0].text, "cats.example · Brave search");
assert.ok(urlRows[urlRows.length - 1].icon === "language", "the URL row is the last row");

/* Every engine suggestion row passes its source through. */
for (const r of rows.slice(0, 3)) assert.equal(r.src, "Brave", "engine rows keep their source for the brand mark");

/* ---- Engine brand marks: real logos for every provider except
   the documented Bing gap (no simple-icons entry). ---- */
assert.ok(markFor("Brave"), "Brave has a brand mark");
assert.equal(markFor("brave"), markFor("Brave"), "mark lookup is case-insensitive");
assert.equal(markFor(null), null, "no source means no mark");
assert.equal(markFor(undefined), null, "undefined source means no mark");
assert.equal(markFor("Bing"), null, "Bing is the documented gap: generic icon");
for (const [id, e] of Object.entries(ENGINES)) {
  if (id === "bing") continue;
  assert.ok(markFor(e.name), "engine " + id + " (" + e.name + ") must have a brand mark");
}
assert.deepEqual([...MARKED_ENGINES].sort(), ["brave", "duckduckgo", "google", "mojeek", "startpage"], "marked engine set");

/* ---- ASCII background helpers. ---- */
assert.equal(ASCII_PARAMS.renderMode, "dither", "the recipe's render mode");
assert.equal(ASCII_PARAMS.cellSize, 13, "the recipe's cell size");
assert.equal(ASCII_PARAMS.bgMode, "blur", "the recipe's background mode");
assert.equal(ASCII_PARAMS.pfx.vignette.enabled, true, "vignette on");
assert.equal(ASCII_PARAMS.pfx.bloom.enabled, true, "bloom on");
assert.equal(ASCII_PARAMS.animStyle, "ripple", "the recipe's animation style");

/* toneMap: identity curve end points, monotone interpolation. */
const curve = ASCII_PARAMS.toneCurve;
assert.equal(toneMap(0, curve), 0, "tone curve maps black to black");
assert.equal(toneMap(1, curve), 1, "tone curve maps white to white");
assert.equal(toneMap(0.5, curve), 0.5, "identity midpoint");
let prev = -1;
for (let v = 0; v <= 1.0001; v += 0.05) {
  const y = toneMap(v, curve);
  assert.ok(y >= prev, "tone curve stays monotone");
  prev = y;
}
/* A real contrast curve: S-curve lifts midtones predictably. */
const s = [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }];
assert.ok(toneMap(0.5, s) === 0.6, "piecewise midpoint");
assert.ok(Math.abs(toneMap(0.25, s) - 0.3) < 1e-9, "piecewise interpolation between points");
assert.equal(toneMap(-0.5, s), 0, "clamped below the curve");
assert.equal(toneMap(1.5, s), 1, "clamped above the curve");

/* bayerAt: the standard 4x4 ordered-dither matrix, periodic in
   both axes, values in 0..15. */
assert.equal(bayerAt(0, 0), 0, "corner threshold");
assert.equal(bayerAt(1, 0), 8);
assert.equal(bayerAt(0, 1), 12);
assert.equal(bayerAt(3, 3), 5);
assert.equal(bayerAt(4, 4), 0, "period 4 in both axes");
for (let y = 0; y < 8; y++) {
  for (let x = 0; x < 8; x++) {
    const b = bayerAt(x, y);
    assert.ok(b >= 0 && b <= 15 && Number.isInteger(b), "bayer value in range");
  }
}

/* charsFor: the standard ramp, customChars override, unknown set
   falls back to standard. */
const std = charsFor({ charSet: "standard", customChars: "" });
assert.equal(std[0], " ", "the standard ramp starts at the blank");
assert.equal(std[std.length - 1], "@", "the standard ramp ends at @");
assert.deepEqual(charsFor({ charSet: "standard", customChars: "abc" }), ["a", "b", "c"], "customChars wins");
assert.equal(charsFor({ charSet: "nonexistent", customChars: "" }).length, std.length, "unknown set falls back to the standard ramp");
assert.ok(charsFor({ charSet: "blocks", customChars: "" }).length >= 4, "the blocks set exists");

console.log("ui-wave77 check: all assertions passed");
