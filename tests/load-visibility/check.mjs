/* Regression check for the load visibility gate
   (ui/src/browser/navGate.ts + the App/Browser wiring). Run from
   the repo root:

     node --experimental-strip-types tests/load-visibility/check.mjs

   The failure modes this pins down (2026-11-21 operator report):
   reload LobsterBrowse Beta with a restored tab and the site loads
   in the background while the user sits on Home; then a search from
   Home leaves the previous site painted while the new one loads.
   The contract now: no site loads at all until the user actually
   sees the frame - the frame blanks before the route mint and the
   auto-load effect parks hidden views entirely. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { autoLoadGate, navInFlight } from "../../ui/src/browser/navGate.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const app = readFileSync(join(root, "ui", "src", "App.tsx"), "utf8");
const browser = readFileSync(join(root, "ui", "src", "pages", "Browser.tsx"), "utf8");

/* 1. The gate: a hidden view parks any tab, seen or not. The
   restored-session regression: same tab, same URL - only the view
   state differs between a parked tab and a loaded one. */
assert.equal(autoLoadGate({ hasActive: true, hasUrl: true, visible: false, recovering: false, sameLastNav: false, blankFrame: false }), "hidden");
assert.equal(autoLoadGate({ hasActive: true, hasUrl: true, visible: false, recovering: false, sameLastNav: true, blankFrame: false }), "hidden");
assert.equal(autoLoadGate({ hasActive: true, hasUrl: true, visible: false, recovering: false, sameLastNav: false, blankFrame: true }), "hidden");

/* Visible views: a never-loaded tab starts loading (#249's
   idle-unloaded blank frame re-navigates too). */
assert.equal(autoLoadGate({ hasActive: true, hasUrl: true, visible: true, recovering: false, sameLastNav: false, blankFrame: false }), "load");
assert.equal(autoLoadGate({ hasActive: true, hasUrl: true, visible: true, recovering: false, sameLastNav: true, blankFrame: true }), "load");

/* The intact-frame return: the same URL already loaded this tab
   and the frame is not blank - coming back to the view shows the
   kept-alive document, it does not reload. */
assert.equal(autoLoadGate({ hasActive: true, hasUrl: true, visible: true, recovering: false, sameLastNav: true, blankFrame: false }), "done");

/* Hold positions stay holds in and out of view. */
assert.equal(autoLoadGate({ hasActive: true, hasUrl: true, visible: true, recovering: true, sameLastNav: false, blankFrame: false }), "recovery-hold");
assert.equal(autoLoadGate({ hasActive: false, hasUrl: false, visible: true, recovering: false, sameLastNav: false, blankFrame: false }), "no-tab");
assert.equal(autoLoadGate({ hasActive: true, hasUrl: false, visible: true, recovering: false, sameLastNav: false, blankFrame: false }), "no-tab");

/* 2. The in-flight dedupe: the same destination already loading
   is not a second navigation; a changed destination, a settled
   tab, or an unrelated pendingNav all proceed. */
assert.equal(navInFlight({ lastNav: "https://example.com/", pendingNav: "https://example.com/", loading: true }, "https://example.com/"), true);
assert.equal(navInFlight({ lastNav: "https://example.com/", pendingNav: "https://example.com/", loading: true }, "https://other.com/"), false);
assert.equal(navInFlight({ lastNav: "https://example.com/", pendingNav: "https://example.com/", loading: false }, "https://example.com/"), false);
assert.equal(navInFlight({ lastNav: undefined, pendingNav: undefined, loading: false }, "https://example.com/"), false);

/* 3. The wiring: App passes the visibility, Browser consumes it in
   the auto-load deps, the frame blanks before the mint, and the
   blank never commits. */
assert.ok(app.includes('visible={view === "browser"}'), "App gates BrowserView on the view being browser");
assert.ok(browser.includes("visible: props.visible,\n      recovering:"), "the auto-load effect reads props.visible through the gate");
assert.ok(browser.includes("[active?.id, active?.url, settings, rules, props.visible]"), "the auto-load effect re-runs when the view becomes visible");
assert.ok(browser.includes("import { autoLoadGate, navInFlight } from \"../browser/navGate\";"), "Browser runs the gate module, not a copy");
assert.ok(browser.includes("sleeping.current.add(tab.id);"), "load() blanks the frame under the sleeping guard before the mint");
assert.ok(/const curFrame = frames\.current\.get\(tab\.id\);\s*\n\s*if \(curFrame && !blankFrame\(tab\.id\)\) \{/.test(browser), "the blank happens before the async route mint");
assert.ok(browser.includes("if (blankFrame(t.id)) { return; }"), "a load event on an about: frame never commits");
assert.ok(/sleeping\.current\.delete\(tab\.id\);\s*\n\s*if \(f\) f\.src = href;/.test(browser), "the mint callback clears the guard before assigning the real route");
assert.ok(!browser.includes("if (sameOrigin(tab.url, url)) minorNav.current.add(tab.id);"), "no navigation keeps the previous page visible any more (#247 behavior dropped)");

console.log("load-visibility check: gate + dedupe + wiring ok");
