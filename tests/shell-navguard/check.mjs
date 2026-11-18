/* Regression check for the shell-side navigation guard (the #416
   lockdown follow-up): the shell window's Navigation API cancels a
   script-initiated cross-document push or replace of the top document
   and reopens the destination as an in-app tab, mirroring the
   worker zlescape recapture. The judgment is pure in frameNav.ts so
   this check pins behavior without a DOM, then pins the App root
   wiring (the browser page alone is not enough: it unmounts on every
   view switch). Run from the repo root:
   node --experimental-strip-types tests/shell-navguard/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shellGuardCancel, shellGuardDest } from "../../ui/src/frameNav.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const a = read("../../ui/src/App.tsx");
const b = read("../../ui/src/pages/Browser.tsx");
const ci = read("../../.github/workflows/ci.yml");

const ORIGIN = "https://lobsterbrowse-beta.onrender.com";
const KNOWN = "https://login.microsoftonline.com/organizations/authorize";

/* The guard judgment: only script-driven cross-document pushes and
   replaces cancel; users, reloads, traverses and hash moves pass. */
const F = (o) => shellGuardCancel({ userInitiated: false, sameDocument: false, navigationType: "push", cancelable: true, ...o });
assert.equal(F({}), true, "a script push cancels");
assert.equal(F({ navigationType: "replace" }), true, "a script replace cancels");
assert.equal(F({ userInitiated: true }), false, "a user navigation passes");
assert.equal(F({ sameDocument: true }), false, "a same-document move passes");
assert.equal(F({ navigationType: "reload" }), false, "a reload passes");
assert.equal(F({ navigationType: "traverse" }), false, "a history traverse passes");
assert.equal(F({ cancelable: false }), false, "a non-cancelable event is not handled");

/* Destination reconstruction. */
assert.equal(
  shellGuardDest("https://outlook.live.com/mail/", null, ORIGIN),
  "https://outlook.live.com/mail/",
  "an off-origin http(s) target reopens directly",
);
assert.equal(
  shellGuardDest("ftp://x.example/", null, ORIGIN),
  null,
  "a non-http(s) scheme never reopens",
);
assert.equal(
  shellGuardDest("/common/oauth2/v2.0/authorize?probe=b2&zlNavh=AAAAgarbage", KNOWN, ORIGIN),
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?probe=b2",
  "a query-shape route reconstructs against the pane host, token stripped",
);
assert.equal(
  shellGuardDest("/common/oauth2/v2.0/authorize?probe=b2&zlNavh=AAAAgarbage", null, ORIGIN),
  null,
  "a query-shape route with no known pane host never guesses",
);
assert.equal(
  shellGuardDest(ORIGIN + "/common/x?probe=b2&zlNavh=T", KNOWN, ORIGIN),
  "https://login.microsoftonline.com/common/x?probe=b2",
  "an absolute same-origin query route also reconstructs",
);
assert.equal(
  shellGuardDest("/zlsw/devtools.html", KNOWN, ORIGIN),
  null,
  "a same-origin app page without a token never reopens",
);
assert.equal(
  shellGuardDest("/not-a-route", KNOWN, ORIGIN),
  null,
  "an opaque same-origin path never reopens",
);
assert.equal(
  shellGuardDest("/common/x?zlNavh=T", "about:blank", ORIGIN),
  null,
  "a non-http(s) pane host never reopens",
);

/* The wiring lives at the app root so every view is guarded. */
assert.ok(a.includes("import { parseNavTab, shellGuardCancel, shellGuardDest, type ShellNavApi, type ShellNavEvent } from \"./frameNav\";"), "App.tsx imports the guard helpers");
assert.ok(a.includes("const navapi = (window as unknown as { navigation?: ShellNavApi }).navigation;"), "the guard reads the Navigation API defensively");
assert.ok(a.includes("if (!navapi) return;"), "a browser without the Navigation API never mounts the guard");
assert.ok(a.includes("if (!shellGuardCancel(ev)) return;"), "the guard consults the pure judgment");
assert.ok(a.includes("ev.preventDefault();"), "the guard cancels the navigation");
assert.ok(a.includes("G.newTab(real);"), "the destination reopens as an in-app tab");
assert.ok(a.includes('"shell navigate guard recaptured to a new tab: "'), "the recapture is logged");
assert.ok(a.includes('"shell navigate guard blocked a navigation without recapture: "'), "a blocked no-recapture case is logged too");
assert.ok(!b.includes("shellGuardCancel"), "the guard is not wired in the browser page, which unmounts on view switches");

/* The ci ui job runs this check. */
assert.ok(ci.includes("../tests/shell-navguard/check.mjs"), "ci.yml runs the shell navguard check");

console.log("shell-navguard: all checks passed");
