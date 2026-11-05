/* Regression check for the wave 77 UI batch: the gated suggestor
   (SUGGEST_MIN_CHARS + buildSuggests ordering and sources) and the
   engine brand marks. Wave 78: the ASCII-art background helper
   assertions were replaced by source checks for the liquid-metal
   ribbon background (the .tsx files carry JSX, which node cannot
   import, so they are read from disk instead).

   Run from the repo root:

     node --experimental-strip-types tests/ui-wave77/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ENGINES } from "../../ui/src/settings.ts";
import { buildSuggests, SUGGEST_MIN_CHARS } from "../../ui/src/suggest.ts";
import { markFor, MARKED_ENGINES } from "../../ui/src/engineMarks.ts";

/* ---- The suggestor stays shut until engines accept the request. ---- */
assert.equal(SUGGEST_MIN_CHARS, 2, "engines accept completion requests from 2 chars");
assert.deepEqual(buildSuggests("c", { history: ["cats.com"], engineName: "Brave", search: "s", remote: [{ text: "cats", src: "Brave" }], searchFor: () => "s" }), [], "one character must not open the menu");
assert.deepEqual(buildSuggests("", { history: [], engineName: "Brave", search: "s", remote: [], searchFor: () => "s" }), [], "empty input must not open the menu");
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

/* ---- Wave 78 background: the ASCII canvas is gone; the vendored
   shader-metal component mounts non-interactively from App, and the
   search bar carries one globe icon with a focus-gated suggestor. ---- */
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const appSrc = read("../../ui/src/App.tsx");
const homeSrc = read("../../ui/src/pages/Home.tsx");
const metalSrc = read("../../ui/src/components/ui/shader-metal.tsx");
assert.ok(metalSrc.includes("export function ShaderMetal"), "the vendored shader-metal component exists");
assert.ok(metalSrc.includes("export function createShaderMetal"), "its engine factory is exported");
/* The demo's shipped settings are the component defaults. */
assert.ok(metalSrc.includes("DEFAULT_RIBBONS = 3"), "the default ribbon count is the demo's 3");
assert.ok(metalSrc.includes("DEFAULT_SPEED = 0.3"), "the default speed is the demo's 0.3");
assert.ok(metalSrc.includes("DEFAULT_IRIDESCENCE = 0.2"), "the default iridescence is the demo's 0.2");
assert.ok(metalSrc.includes('chrome: "#F2F3F5"'), "chrome is the default metal");
assert.ok(appSrc.includes("interactive={false}"), "App mounts the ribbon shader non-interactive");
assert.ok(!appSrc.includes("AsciiBackground"), "the ASCII background is gone from App");
assert.ok(appSrc.includes("lb-fx-bg"), "the portal layer uses the wave 78 class");
assert.ok(homeSrc.includes('slot="search-icon"'), "the search bar carries the single globe icon");
assert.ok(!homeSrc.includes('slot="closed-leading"') && !homeSrc.includes('slot="open-leading"'), "no duplicate leading icons in the search bar");
assert.ok(homeSrc.includes('"beforetoggle"'), "the suggestor is gated until rows exist");

console.log("ui-wave77 check: all assertions passed");
