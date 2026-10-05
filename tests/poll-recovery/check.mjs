/* Regression check for the navigation-poll routing decision
   (ui/src/browser/pollRecovery.ts). Run from the repo root:

     node --experimental-strip-types tests/poll-recovery/check.mjs

   The failure mode this pins down: a navigation still in flight
   leaves the frame on about:blank, whose location.pathname is the
   literal string "blank". The poll used to hand that to the
   escaped-navigation recovery, which fabricated <site>/blank,
   aborted the real in-flight navigation and reloaded the tab in a
   loop (m.ome.tv). pollAction() must keep such frames in "wait". */

import assert from "node:assert/strict";
import { pollAction } from "../../ui/src/browser/pollRecovery.ts";
import { decodeRoute } from "../../ui/src/settings.ts";

const cases = [
  /* The regression: about: frames must never be treated as escapes. */
  ["about:", "blank", "https://m.ome.tv/", "wait"],
  ["about:", "blank", "https://example.com/page", "wait"],
  ["about:srcdoc", "srcdoc", "https://example.com/", "wait"],
  /* Engine routes sync, including the SW's navigation marker path. */
  ["http:", "/lj/aHR0cHM6Ly9leGFtcGxlLmNvbS8", "https://example.com/", "sync"],
  ["http:", "/r/aHR0cHM6Ly9leGFtcGxlLmNvbS8", "https://example.com/", "sync"],
  ["http:", "/zl/aHR0cHM6Ly9leGFtcGxlLmNvbS8", "https://example.com/", "sync"],
  ["http:", "/__zl_nav__/x", "https://example.com/", "sync"],
  /* App-shell routes and the root wait for the engine to move on. */
  ["http:", "/", "https://example.com/", "wait"],
  ["http:", "/zlsw/sw.js", "https://example.com/", "wait"],
  ["http:", "/logs", "https://example.com/", "wait"],
  ["http:", "/build", "https://example.com/", "wait"],
  /* No readable path or tab URL: nothing to decide. */
  ["http:", "", "https://example.com/", "wait"],
  ["http:", "/anything", "", "wait"],
  /* Genuine escaped navigation to a bare app path still recovers. */
  ["http:", "/some-bare-app-path", "https://example.com/", "recover"],
];

for (const [protocol, path, tabUrl, want] of cases) {
  const got = pollAction(protocol, path, tabUrl);
  assert.equal(
    got,
    want,
    "pollAction(" +
      JSON.stringify(protocol) + ", " +
      JSON.stringify(path) + ", " +
      JSON.stringify(tabUrl) +
      ") should be " + want + ", got " + got
  );
}

/* #58: decodeRoute must fail closed on keyed route tails
   instead of returning binary garbage the poll sync re-navigates to. */
assert.equal(decodeRoute("/zl/aHR0cHM6Ly9leGFtcGxlLmNvbS8"), "https://example.com/");
assert.equal(decodeRoute("/r/aHR0cHM6Ly9leGFtcGxlLmNvbS8"), "https://example.com/");
assert.equal(decodeRoute("/lj/aHR0cHM6Ly9leGFtcGxlLmNvbS8"), "https://example.com/");
assert.equal(decodeRoute("/__zl_navh__/Ae4YgFO74dqswiEjLIjZlA"), "");
assert.equal(decodeRoute("/zl/Ae4YgFO74dqswiEjLIjZlA3DjVoQ4UjI5"), "");
assert.equal(decodeRoute("/not-a-route"), "");

console.log("poll-recovery check: " + cases.length + " cases ok");
