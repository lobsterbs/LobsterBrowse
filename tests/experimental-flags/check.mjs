/* Run: node --experimental-strip-types tests/experimental-flags/check.mjs */
import assert from "node:assert/strict";
import {
  EXPERIMENTAL_KEYS, emptyExperimental, cleanExperimental,
  loadDebugOverrides, saveDebugOverrides, clearDebugOverrides,
} from "../../ui/src/debug.ts";

const data = new Map();
globalThis.localStorage = {
  getItem: key => data.get(key) ?? null,
  setItem: (key, val) => data.set(key, val),
  removeItem: key => data.delete(key),
};

assert.deepEqual(EXPERIMENTAL_KEYS, ["adaptiveTransit", "hybridLocation", "cspTranslation", "virtualSW"]);
assert.deepEqual(Object.values(emptyExperimental()), [false, false, false, false]);
assert.deepEqual(cleanExperimental(null), {});
assert.deepEqual(cleanExperimental([]), {});
assert.deepEqual(cleanExperimental({
  adaptiveTransit: true, hybridLocation: false,
  cspTranslation: "true", virtualSW: true, __proto__: { enabled: true },
}), { adaptiveTransit: true, hybridLocation: false, virtualSW: true });

const selected = { ...emptyExperimental(), adaptiveTransit: true, virtualSW: true };
saveDebugOverrides({ queryRoutes: false, experimental: selected });
assert.deepEqual(loadDebugOverrides(), { queryRoutes: false, experimental: selected });
assert.deepEqual({ ...emptyExperimental(), ...loadDebugOverrides().experimental }, selected);

data.set("lb_debug_overrides", JSON.stringify({
  queryRoutes: "false", imageLazy: true,
  experimental: { adaptiveTransit: 1, hybridLocation: true, bogus: true, virtualSW: "yes" },
}));
assert.deepEqual(loadDebugOverrides(), {
  imageLazy: true, experimental: { hybridLocation: true },
});

data.set("lb_debug_overrides", "{broken");
assert.deepEqual(loadDebugOverrides(), {});
clearDebugOverrides();
assert.deepEqual(loadDebugOverrides(), { experimental: {} });

console.log("experimental-flags: four default-off picks, migration, validation, reset passed");
