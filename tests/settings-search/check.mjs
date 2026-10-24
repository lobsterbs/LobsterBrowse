/* Run from the repo root: node --experimental-strip-types tests/settings-search/check.mjs */
import assert from "node:assert/strict";
import { searchSettings, SETTINGS_SEARCH } from "../../ui/src/settingsSearch.ts";
assert.deepEqual(searchSettings(""), []);
assert.deepEqual(searchSettings("   "), []);
assert.deepEqual(searchSettings("no-such-setting-in-this-browser"), []);
assert.equal(searchSettings("HTTPS upgrade")[0]?.id, "setting-https");
assert.equal(searchSettings("USER AGENT")[0]?.section, "ua");
assert.equal(searchSettings("json backup")[0]?.id, "setting-import");
assert.equal(searchSettings("cache")[0]?.id, "setting-data");
assert.equal(searchSettings("MOZILLA")[0]?.id, "setting-extension-find");
assert.ok(searchSettings("privacy").some((entry) => entry.id === "setting-adblock"));
assert.ok(searchSettings("privacy").every((entry) => entry.section === "privacy"));
assert.ok(searchSettings("auto cloak").some((entry) => entry.id === "lb-ti-cloak-destination"));
assert.equal(searchSettings("backup exported").length, 0, "all query terms must match");
assert.equal(new Set(SETTINGS_SEARCH.map((entry) => entry.id)).size, SETTINGS_SEARCH.length);
console.log("settings-search: labels, sections, descriptions, case, punctuation, multi-term and empty queries passed");
