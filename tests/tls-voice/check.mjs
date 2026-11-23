/* Regression check for the 2026-11-23 TLS voice option.

   - settings.ts: tlsVoice defaults to "ua" (UA-synced shaping); a
     stored deliberate pin keeps winning; junk falls back to "ua".
   - App.tsx: the zl:fingerprint profile carries tlsVoice only when
     it pins a shape ("ua" stays implicit by omission, so stock
     engines ignore the field), and the effect re-sends on change.
   - Settings.tsx: the Advanced panel exists with all four options.

   Run from the repo root:

     node --experimental-strip-types tests/tls-voice/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS, loadSettings } from "../../ui/src/settings.ts";

const data = new Map();
globalThis.localStorage = {
  getItem: key => data.get(key) ?? null,
  setItem: (key, val) => data.set(key, val),
  removeItem: key => data.delete(key),
};

/* Defaults: the voice follows the effective User-Agent. */
assert.equal(DEFAULT_SETTINGS.tlsVoice, "ua");

/* Empty storage and junk fall back to the UA-synced default. */
assert.equal(loadSettings().tlsVoice, "ua");
data.set("lobsterbrowse-settings", JSON.stringify({ seed: "#006A6A", tlsVoice: "bogus" }));
assert.equal(loadSettings().tlsVoice, "ua");
assert.equal(loadSettings().seed, "#006A6A");
data.set("lobsterbrowse-settings", JSON.stringify({ transport: "libcurl" }));
assert.equal(loadSettings().tlsVoice, "ua");

/* A stored deliberate pin keeps winning. */
data.set("lobsterbrowse-settings", JSON.stringify({ tlsVoice: "chromium" }));
assert.equal(loadSettings().tlsVoice, "chromium");
data.set("lobsterbrowse-settings", JSON.stringify({ tlsVoice: "firefox" }));
assert.equal(loadSettings().tlsVoice, "firefox");
data.set("lobsterbrowse-settings", JSON.stringify({ tlsVoice: "native" }));
assert.equal(loadSettings().tlsVoice, "native");

/* App wiring: the profile spreads tlsVoice only on a non-ua pick,
   and the effect re-sends when the setting changes. */
const appTsx = readFileSync(new URL("../../ui/src/App.tsx", import.meta.url), "utf8");
assert.ok(appTsx.includes("tlsVoice: settings.tlsVoice"), "App profile does not carry the tlsVoice pick");
assert.ok(appTsx.includes('settings.tlsVoice !== "ua"'), "the ua default must stay implicit (omitted from the profile)");
assert.ok(/zl:fingerprint/.test(appTsx), "fingerprint push missing");
assert.ok(
  /\[settings\.sameSitePolicy, settings\.uaPreset, settings\.uaCustom, settings\.fingerprintProfile, settings\.tlsVoice, rules\]/.test(appTsx),
  "fingerprint effect does not re-send on the tlsVoice change"
);

/* Settings panel: the voice picker exists between transport and wisp,
   with all four options and the epoxy transport guard. */
const settingsTsx = readFileSync(new URL("../../ui/src/pages/Settings.tsx", import.meta.url), "utf8");
assert.ok(settingsTsx.includes('id="p-tlsvoice"'), "TLS voice panel missing");
for (const opt of ['["ua", "Match user-agent (default)"]', '["chromium", "Chromium"]', '["firefox", "Firefox"]', '["native", "Native (rustls)"]']) {
  assert.ok(settingsTsx.includes(opt), "TLS voice option missing: " + opt);
}
assert.ok(
  settingsTsx.includes('zlOff || settings.transport !== "epoxy" ? "lb-zl-guard"'),
  "TLS voice panel is not guarded like the other Zeolite engine options"
);
const panelIdx = settingsTsx.indexOf('id="p-transport"');
const voiceIdx = settingsTsx.indexOf('id="p-tlsvoice"');
const wispIdx = settingsTsx.indexOf('id="p-wisp"');
assert.ok(panelIdx < voiceIdx && voiceIdx < wispIdx, "TLS voice panel is not between transport and wisp");

console.log("tls-voice: default ua, stored-pin honored, junk fallback, App profile spread + re-send, Settings panel order and guard passed");
