/* Regression check for the 2026-11-23 debug-menu wire-voice pickers.

   - settings.ts: fingerprintProfile defaults to "ua"; uaPreset
     defaults to the Windows Chrome preset; a stored fingerprint
     preset pin keeps winning; junk falls back; the legacy
     fingerprintSpoof:false profile migrates to "native".
   - App.tsx: the zl:fingerprint profile build honors the pick -
     "ua" matches the effective User-Agent, a preset id pins the
     preset UA string, "native" pushes a null profile - and the
     effect re-sends when the pick changes.
   - Home.tsx / DebugMenu.tsx: the debug menu drill passes update
     and the three pickers (User-Agent preset, fingerprint profile,
     TLS voice) write through update(...); the wire preview mirrors
     the App build rule-less.
   - The Settings manual UA panel stays gone: the pickers live only
     in the hidden debug menu.

   Run from the repo root:

     node --experimental-strip-types tests/ui-debug-voice/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS, FP_PRESETS, UA_PRESETS, loadSettings } from "../../ui/src/settings.ts";

const data = new Map();
globalThis.localStorage = {
  getItem: key => data.get(key) ?? null,
  setItem: (key, val) => data.set(key, val),
  removeItem: key => data.delete(key),
};

/* Defaults: the fingerprint matches the User-Agent; the wire UA is
   the Windows Chrome preset. */
assert.equal(DEFAULT_SETTINGS.fingerprintProfile, "ua");
assert.equal(DEFAULT_SETTINGS.uaPreset, "chrome-win");
assert.ok(UA_PRESETS["chrome-win"].ua.includes("Windows NT 10.0; Win64; x64"));
assert.ok(!FP_PRESETS.includes("server-default"));

/* Empty storage and junk fall back to the defaults. */
assert.equal(loadSettings().fingerprintProfile, "ua");
data.set("lobsterbrowse-settings", JSON.stringify({ fingerprintProfile: "bogus" }));
assert.equal(loadSettings().fingerprintProfile, "ua");
assert.equal(loadSettings().uaPreset, "chrome-win");

/* A stored deliberate pin keeps winning. */
data.set("lobsterbrowse-settings", JSON.stringify({ fingerprintProfile: "edge-win" }));
assert.equal(loadSettings().fingerprintProfile, "edge-win");

/* The legacy fingerprintSpoof:false migrated profile reads native. */
data.set("lobsterbrowse-settings", JSON.stringify({ fingerprintSpoof: false }));
assert.equal(loadSettings().fingerprintProfile, "native");

/* App wiring: preset pin, native null, ua fallback to the device. */
const appTsx = readFileSync(new URL("../../ui/src/App.tsx", import.meta.url), "utf8");
assert.ok(appTsx.includes('settings.fingerprintProfile === "native" ? null : {'), "native pick must push a null profile");
assert.ok(appTsx.includes("UA_PRESETS[settings.fingerprintProfile].ua"), "preset pick must pin the preset UA string");
assert.ok(appTsx.includes('pinned ?? resolveUa(settings, rules, "") ?? navigator.userAgent'), "ua pick must match the effective User-Agent");
assert.ok(
  appTsx.includes("[settings.sameSitePolicy, settings.uaPreset, settings.uaCustom, settings.fingerprintProfile, settings.tlsVoice, rules]"),
  "fingerprint effect does not re-send on the fingerprintProfile change"
);

/* The debug menu carves the pickers: App drills update into Home,
   Home into DebugMenu, and the three selects write through it. */
const homeTsx = readFileSync(new URL("../../ui/src/pages/Home.tsx", import.meta.url), "utf8");
assert.ok(homeTsx.includes("update: (patch: Partial<Settings>) => void;"), "Home props miss the update drill");
assert.ok(homeTsx.includes("settings={settings} update={update} />"), "DebugMenu does not receive update");

const dbgTsx = readFileSync(new URL("../../ui/src/pages/DebugMenu.tsx", import.meta.url), "utf8");
assert.ok(dbgTsx.includes("update({ uaPreset:"), "User-Agent picker does not write the setting");
assert.ok(dbgTsx.includes("update({ fingerprintProfile:"), "fingerprint picker does not write the setting");
assert.ok(dbgTsx.includes("update({ tlsVoice:"), "TLS voice picker does not write the setting");
assert.ok(dbgTsx.includes("function wirePreview"), "wire preview missing");
assert.ok(dbgTsx.includes('s.fingerprintProfile === "native" || s.fingerprintProfile === "ua"'), "preview must mirror the App pinned lane");
assert.ok(dbgTsx.includes('["native", "Native (no spoofing)"]'), "fingerprint picker must offer native");
assert.ok(dbgTsx.includes('["ua", "Match user-agent (default)"]'), "TLS voice picker must keep the ua option");
assert.ok(dbgTsx.includes('["native", "Native (rustls)"]'), "TLS voice picker must keep the native option");
assert.ok(dbgTsx.includes('["custom", "Custom string"]'), "UA picker must keep the custom lane");

/* The Settings manual UA panel stays removed. */
const settingsTsx = readFileSync(new URL("../../ui/src/pages/Settings.tsx", import.meta.url), "utf8");
for (const banned of ["User-Agent preset", "Fingerprint profile"]) {
  assert.ok(!settingsTsx.includes(banned), "the manual UA panel must not return to Settings: " + banned);
}

console.log("ui-debug-voice: defaults, stored pins, legacy migration, App profile lanes, debug-menu pickers, no Settings UA panel passed");
