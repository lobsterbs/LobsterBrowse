/* UI sheet attribute regression check.
 *
 * React 19 assigns a custom-element prop as a DOM property when the
 * element class defines that property, so the attribute never lands;
 * @m3e/web parses modal/handle/hideable/detents from DOM attributes.
 * JSX props authored as empty strings therefore silently unset those
 * features: the tab sheet lost its modal top layer and rendered
 * off-screen inside the transformed dock (its fixed-position top calc
 * anchored to the dock's translateX box), and the DevTools sheet lost
 * its handle and detents to a raw string. Contract: every sheet sets
 * its attribute contracts imperatively through the shared m3eAttrs
 * helper at mount, and no attribute-shaped JSX props remain. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const shared = read("../../ui/src/browser/browserShared.ts");

/* Helper exists with the rationale. */
assert.ok(shared.includes("export function m3eAttrs("), "the m3eAttrs helper exists in browserShared.ts");
assert.ok(shared.includes("React 19"), "the helper documents the React 19 property-mode cause");
assert.ok(shared.includes('el.setAttribute(name, attrs[name]);'), "the helper lands attributes verbatim");

const sheets = {
  "browser/TabSwitcherCard.tsx": { detents: "fit", modal: true, handle: true, hideable: true },
  "browser/AdBlockCard.tsx": { detents: "fit", modal: true, handle: true, hideable: true },
  "browser/ExtensionsPanel.tsx": { detents: "fit", modal: true, handle: true, hideable: true },
  "pages/DevTools.tsx": { detents: "fit half full", modal: false, handle: true, hideable: true },
  "pages/Ai.tsx": { detents: "fit", modal: false, handle: false, hideable: false },
};

for (const [file, want] of Object.entries(sheets)) {
  const t = read("../../ui/src/" + file);
  assert.ok(t.includes("m3eAttrs"), file + " uses the m3eAttrs helper");
  assert.ok(t.includes('detents: "' + want.detents + '"'), file + " sets its detent through the helper");
  if (want.modal) assert.ok(t.includes('modal: ""'), file + " keeps modal through the helper");
  if (want.handle) assert.ok(t.includes('handle: ""'), file + " keeps the drag handle");
  if (want.hideable) assert.ok(t.includes('hideable: ""'), file + " keeps hideable");
  assert.ok(!t.includes('modal=""'), file + " has no attribute-shaped modal prop (dead under React 19)");
  assert.ok(!t.includes('handle=""'), file + " has no attribute-shaped handle prop");
  assert.ok(!t.includes('hideable=""'), file + " has no attribute-shaped hideable prop");
  assert.ok(!t.includes('detents="'), file + " has no attribute-shaped detents prop");
}

/* The DevTools picker segments restore their toggle attribute through
   the same helper; the JSX prop was silently a falsy "" property. */
const d = read("../../ui/src/pages/DevTools.tsx");
assert.ok(d.includes('m3eAttrs(el, { toggle: "" })'), "every DevTools segment restores its toggle attribute");

/* No attribute-shaped sheet props hide anywhere else in the tree. */
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".tsx")) {
      const t = readFileSync(p, "utf8");
      assert.ok(!t.includes('modal=""'), p + " has no dead modal prop");
      assert.ok(!t.includes('hideable=""'), p + " has no dead hideable prop");
      assert.ok(!/<m3e-bottom-sheet[^>]*detents=/.test(t.replace(/\n/g, " ")), p + " has no dead detents prop on a sheet");
    }
  }
};
walk(new URL("../../ui/src/", import.meta.url).pathname);

/* CI wiring. */
assert.ok(read("../../.github/workflows/ci.yml").includes("../tests/ui-sheet-attrs/check.mjs"), "ci runs the sheet-attrs gate");
console.log("ui-sheet-attrs: all contracts hold");
