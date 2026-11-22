/* Toolbar audit (2026-11-22): the suggestion list escapes the #283
   dock-clip as a manual popover pinned to the input rect in fixed
   coordinates, the omnibox input carries the combobox contract and
   keeps its caret keys out of m3e-toolbar's roving key manager, reload
   disables on the empty tab like back, the engine-update snackbar camps
   no tab stop, the dead lock CSS is gone, the pill width tokens
   agree, forward disables at the stack end, and a blank tab frame
   never takes a keyboard stop. Source-contract gate: reads authored strings only. */
import { readFileSync } from "node:fs";
const root = new URL("../../", import.meta.url);
const browser = readFileSync(new URL("ui/src/pages/Browser.tsx", root), "utf8");
const app = readFileSync(new URL("ui/src/App.tsx", root), "utf8");
const theme = readFileSync(new URL("ui/src/theme.css", root), "utf8");
const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
let fails = 0;
const ok = (c, l) => { if (c) console.log("ok - " + l); else { fails++; console.log("FAIL - " + l); } };

ok(/id="lb-tb-ac"[\s\S]{0,300}\{\.\.\.{ popover: "manual" }}/.test(browser), "the suggestion list is a manual popover (top layer, not a clipped toolbar child)");
ok(browser.includes('ac.style.bottom = window.innerHeight - r.top + 10 + "px"'), "the list pins to the input rect in fixed coordinates");
ok(browser.includes('!ac.matches(":popover-open")') && browser.includes("ac.showPopover()"), "the list opens imperatively and never double-shows");
ok(/role="combobox"[\s\S]{0,400}aria-haspopup="listbox"/.test(browser) && browser.includes('aria-controls="lb-tb-ac"') && browser.includes("aria-activedescendant") && browser.includes('aria-expanded={tbSuggOpen ? "true" : "false"}'), "the omnibox input carries the combobox contract for assistive tech");
ok(browser.includes('id: "lb-tb-ac-item-" + i,'), "suggestion rows expose themselves to aria-activedescendant");
ok(browser.includes('e.key === "ArrowUp" || e.key === "ArrowDown")') && browser.includes("el.addEventListener(\"keydown\", onKey, true)"), "suggestion and caret keys stay with the input (capture-phase guard; roving intact via boundary arrows)");
ok(/id="lb-reload-btn"[\s\S]{0,120}disabled=\{active\.url \? undefined : true\}/.test(browser), "reload disables on the empty tab like back");
ok(app.includes('M3eSnackbar.open("Engine updated - reload to pick it up", {') && !app.includes('"Reload now"'), "the engine-update snackbar is text-only: no top-layer action button camping the first tab stop");
ok(/\.lb-tb-ac \{[^}]*position: fixed/s.test(theme), "the suggestion list is fixed-positioned for its top-layer pin");
ok(!theme.includes(".lb-tb-lock"), "the dead lock CSS is gone (the lock glyph is no longer rendered)");
ok(/\.lb-tb-pill \{[^}]*max-width: 440px/s.test(theme), "the pill collapsed max-width matches the expanded width token (440px)");
ok(/id="lb-forward-btn"[\s\S]{0,180}disabled=\{active\.idx < active\.stack\.length - 1 \? undefined : true\}/.test(browser), "forward disables at the end of the stack like back and reload");
ok(browser.includes("tabIndex={t.url ? undefined : -1}"), "an empty tab iframe sits out of the keyboard tab cycle");
ok(ci.includes("../tests/toolbar-a11y-popover/check.mjs"), "this gate runs in the CI ui job");
console.log(fails === 0 ? "toolbar-a11y-popover: all contracts hold" : fails + " FAILURES");
process.exit(fails === 0 ? 0 : 1);
