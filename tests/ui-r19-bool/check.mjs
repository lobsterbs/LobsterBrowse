/* Wave 119 regression: user report - every toggle in Settings looked
   stuck off and could not be re-enabled on the live beta. Root cause:
   React 19 assigns props on custom elements as real properties; the
   React-18-era idiom checked={x ? "" : undefined} wrote the string ""
   into Lit boolean properties, which is falsy, so every switch, chip,
   segment and dialog marker rendered off no matter the state. This gate
   pins the JS-boolean idiom across every m3e boolean-prop call site.
   Also pins that the settings nav glider bar stays deleted (operator
   order: the moving line next to the category buttons is gone). */
import { readFileSync } from "node:fs";

const ui = new URL("../../ui/", import.meta.url);
let fails = 0;
function ok(cond, label) {
  if (cond) console.log("OK " + label);
  else { console.error("FAIL " + label); fails++; }
}
const src = (p) => readFileSync(new URL(p, ui), "utf8");

const files = [
  "src/App.tsx",
  "src/pages/Settings.tsx",
  "src/pages/DevTools.tsx",
  "src/pages/DevToolsLegacy.tsx",
  "src/pages/DebugMenu.tsx",
  "src/pages/Browser.tsx",
  "src/browser/ExtManage.tsx",
  "src/browser/AdBlockCard.tsx",
  "src/browser/ArchiveViewer.tsx",
  "src/browser/ExtensionsPanel.tsx",
];
const idiom = /(?:selected|checked|disabled|open|alert|dismissible)=[^=]*\?\s*""\s*:/;
/* Self-test: if this regex stops matching the exact dead idiom, the
   scan below goes silently blind, so the gate proves its own regex. */
if (!idiom.test('checked={on ? "" : undefined}')) {
  console.error("FAIL ui-r19-bool idiom regex no longer catches the empty-string prop");
  process.exit(1);
}
for (const f of files) {
  const t = src(f);
  const m = t.match(idiom);
  ok(!m, f + " has no empty-string m3e boolean prop" + (m ? " (" + m[0].slice(0, 60) + ")" : ""));
}
const settings = src("src/pages/Settings.tsx");
ok(settings.includes("checked={props.on}"), "the settings switch passes a real boolean (live-beta stuck-off switch report)");
ok(!settings.includes("lb-set-nav-ind") && !settings.includes("navInd"), "the settings nav glider line stays removed (operator order)");
ok(!src("src/theme.css").includes("lb-set-nav-ind"), "the glider bar css is gone from the theme");
if (fails > 0) process.exit(1);
console.log("ui-r19-bool all ok");
