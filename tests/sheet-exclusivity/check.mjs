/* Sheet exclusivity regression check (#260 user report): exactly one
   bottom sheet may be up at a time, and the sheet show/hide must run
   in a layout effect so a wedged main thread cannot leave the button
   state and the visible sheet out of sync. Pure source scans; CI runs
   node --experimental-strip-types on this file. */
import { readFileSync } from "node:fs";

let fails = 0;
const ok = (name, cond) => {
  if (!cond) {
    console.error("FAIL: " + name);
    fails++;
  }
};

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

{
  const b = read("../../ui/src/pages/Browser.tsx");

  /* The helper closes every other sheet state and the DevTools flag. */
  ok("closeSheets defined", b.includes('const closeSheets = (except: "tabs" | "ext" | "ad" | "dt") => {'));
  ok("closeSheets closes tabs", b.includes('if (except !== "tabs") setTabsOpen(false);'));
  ok("closeSheets closes ext", b.includes('if (except !== "ext") setExtPanelOpen(false);'));
  ok("closeSheets closes ad", b.includes('if (except !== "ad") setAdOpen(false);'));
  ok("closeSheets closes dt", b.includes('if (except !== "dt") setDt(props.activeId, { open: false });'));

  /* Every open site consults it. */
  ok("tab switcher open closes others", b.includes('if (next) closeSheets("tabs");'));
  ok("diag chip gone (demo measure pass)", !b.includes('closeSheets("dt");\n                setDt(active.id, { open: true, page: "diagnostics" });'));
  ok("devtools checkbox open closes others", b.includes('if (next) closeSheets("dt");\n                setDt(active.id, { open: next });'));
  ok("ext checkbox open closes others", b.includes('if (next) closeSheets("ext");\n                setExtPanelOpen(next);'));
  ok("ext engine-message open closes others", b.includes('const onOpenExt = () => { closeSheets("ext"); setExtPanelOpen(true); };'));
  ok("ad blocking open closes others", b.includes('closeSheets("ad");\n                setAdOpen(true);'));

  /* No open site left unguarded: the old bare forms are gone. */
  ok("no bare tab toggle left", !b.includes("onClick={() => setTabsOpen((v) => !v)}"));
  ok("no bare devtools toggle left", !b.includes("onClick={() => setDt(active.id, { open: !activeDt.open })}"));
  ok("no bare diagnostics chip left", !b.includes('onClick={() => setDt(active.id, { open: true, page: "diagnostics" })}'));
  ok("no bare ad open left", !b.includes("setAdOpen(true);\n                setTabsOpen(false);"));
}

/* The four sheet components run show/hide in a layout effect. */
{
  const sheets = [
    "../../ui/src/pages/DevTools.tsx",
    "../../ui/src/browser/ExtensionsPanel.tsx",
    "../../ui/src/browser/AdBlockCard.tsx",
    "../../ui/src/browser/TabSwitcherCard.tsx",
  ];
  for (const p of sheets) {
    const s = read(p);
    const name = p.split("/").pop();
    ok(name + " imports useLayoutEffect", s.includes("useLayoutEffect"));
    ok(name + " sheet effect is a layout effect", /useLayoutEffect\(\(\) => \{\s*\n\s*const el = sheetRef\.current;/.test(s));
    ok(name + " keeps the closing listener passive", s.includes('el.addEventListener("closing"'));
    ok(name + " still calls show and hide", s.includes("el.show();") && s.includes("el.hide();"));
  }
}

if (fails > 0) {
  console.error("sheet-exclusivity: " + fails + " check(s) failed");
  process.exit(1);
}
console.log("sheet-exclusivity: all checks passed");
