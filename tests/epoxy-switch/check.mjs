/* Regression check for the 2026-11-22 anura/epoxy switch.

   - settings.ts: transport default flips to "epoxy"; a stored
     deliberate "libcurl" keeps winning; junk falls back to the
     default. wispServer stays "" by default (deployment default).
   - zeolite.ts: the wisp announcement now carries BOTH engine pushes
     (zl:wispRegister + zl:wispPrimary) so the primary transport rides
     the announced endpoint.
   - Settings.tsx: the segmented control names epoxy the default.

   Run from the repo root:

     node --experimental-strip-types tests/epoxy-switch/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS, loadSettings } from "../../ui/src/settings.ts";

const data = new Map();
globalThis.localStorage = {
  getItem: key => data.get(key) ?? null,
  setItem: (key, val) => data.set(key, val),
  removeItem: key => data.delete(key),
};

/* Defaults: epoxy is the default engine from this switch on. */
assert.equal(DEFAULT_SETTINGS.transport, "epoxy");
assert.equal(DEFAULT_SETTINGS.wispServer, "");

/* Empty storage and junk fall back to the new default. */
assert.equal(loadSettings().transport, "epoxy");
data.set("lobsterbrowse-settings", JSON.stringify({ seed: "#006A6A", transport: "bogus" }));
assert.equal(loadSettings().transport, "epoxy");
assert.equal(loadSettings().seed, "#006A6A");

/* A stored deliberate libcurl choice keeps winning. */
data.set("lobsterbrowse-settings", JSON.stringify({ transport: "libcurl" }));
assert.equal(loadSettings().transport, "libcurl");
data.set("lobsterbrowse-settings", JSON.stringify({ transport: "epoxy" }));
assert.equal(loadSettings().transport, "epoxy");

/* wispServer validation is unchanged: junk is dropped to the
   deployment default, never survives a load. */
data.set("lobsterbrowse-settings", JSON.stringify({ wispServer: "not-a-url" }));
assert.equal(loadSettings().wispServer, "");
data.set("lobsterbrowse-settings", JSON.stringify({ wispServer: "wss://wisp.example/ws/" }));
assert.equal(loadSettings().wispServer, "wss://wisp.example/ws/");

/* The wisp announcement flip: the same push carries the primary. */
const zts = readFileSync(new URL("../../ui/src/zeolite.ts", import.meta.url), "utf8");
const regIdx = zts.indexOf("zl:wispRegister");
assert.notEqual(regIdx, -1, "alt wisp push missing");
assert.ok(zts.indexOf("zl:wispPrimary", regIdx) - regIdx < 200, "primary wisp push is not beside the alt push (the anura switch)");

/* Settings copy: epoxy is named the default, libcurl is not. */
const settingsTsx = readFileSync(new URL("../../ui/src/pages/Settings.tsx", import.meta.url), "utf8");
assert.ok(settingsTsx.includes("epoxy (default)"), "epoxy default label missing");
assert.ok(!settingsTsx.includes("libcurl (default)"), "stale libcurl default label");

console.log("epoxy-switch: transport default epoxy, stored-choice honored, wispServer validation, primary-wisp push, Settings labels passed");