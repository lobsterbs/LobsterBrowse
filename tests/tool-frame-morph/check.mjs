/* Gate: the toolbar frame lock + the new-tab move (2026-11-23 report).
   - The omnibox edit morph rode width: fit-content, so pressing the
     URL bar resized the whole toolbar (and the pill with it) way past
     its resting size. The fix records the resting toolbar width
     whenever not editing; entering editing pegs the toolbar to that
     width and hands the pill its edit width through --lb-tb-edit-w,
     so the field morphs inside the existing pill and the buttons
     slide out of it (no toolbar growth, no pill overshoot).
   - The + toolbar button moved into the Tabs bottom sheet app bar:
     the toolbar button and its phone hide rule are gone.
   Run: node --experimental-strip-types ../tests/tool-frame-morph/check.mjs */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const browser = read("../../ui/src/pages/Browser.tsx");
const tabs = read("../../ui/src/browser/TabSwitcherCard.tsx");
const theme = read("../../ui/src/theme.css");
const ci = read("../../.github/workflows/ci.yml");

/* 1. The frame-lock effect. */
assert.ok(browser.includes("const tbRestingW = useRef(0);"), "the resting width is recorded in a ref");
assert.ok(browser.includes("const tbEditing = !!active.url && tbExpanded;"), "editing is derived once");
assert.ok(browser.includes("el.style.width = \"\";"), "not editing clears the inline lock so the toolbar reflows naturally");
assert.ok(browser.includes("if (w > 0) tbRestingW.current = w;"), "the resting width is measured while unlocked");
assert.ok(browser.includes("el.style.width = w + \"px\";"), "entering editing pegs the frame");
assert.ok(browser.includes('el.style.setProperty("--lb-tb-edit-w", Math.max(w - 8, 130) + "px");'), "the pill edit width derives from the locked frame");
assert.ok(browser.includes("}, [tbEditing]);"), "the effect keys on the editing transition only");
assert.ok(browser.includes("useLayoutEffect"), "the lock lands before first paint");

/* 2. The slide-out grammar (CSS half pinned by omnibox-morph): the
   toolbar stores no resting-width regressions - the phone rule no
   longer hides a toolbar new-tab button. */
assert.ok(!browser.includes("lb-newtab-btn"), "the toolbar button is gone");
assert.ok(!theme.includes("#lb-newtab-btn"), "no phone hide rule may remain");
assert.ok(theme.includes("#lb-forward-btn { display: none;"), "the phone rule still hides forward");

/* 3. New tab lives in the Tabs sheet app bar. */
assert.ok(tabs.includes('id="lb-tabs-newtab-btn"'), "the sheet bar carries the new-tab button");
assert.ok(tabs.includes("onClick={props.onNewTab}"), "it wires the existing onNewTab prop");
assert.ok(tabs.includes('aria-label="New tab"'), "it is labelled");
assert.ok(tabs.indexOf("lb-tabs-newtab-btn") < tabs.indexOf("lb-tabs-closeall"), "it sits next to the title, before Close all");
assert.ok(browser.includes("onNewTab="), "Browser still passes the callback down");

/* 4. CI wiring. */
assert.ok(ci.includes("../tests/tool-frame-morph/check.mjs"), "ci runs the tool-frame-morph gate");
console.log("tool-frame-morph: all checks passed");
