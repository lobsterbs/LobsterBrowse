/* Tab label check: a tab frame parked on the proxy's own origin (a
   Cloudflare hop, no page title yet) must be labelled with the real
   site from its history, never with the proxy host. */
import assert from "node:assert/strict";
import { tabLabel } from "../../ui/src/browser/browserShared.ts";

globalThis.location = { href: "https://lobsterbrowse-beta.onrender.com/" };
const tab = (url, stack, idx) => ({ id: 1, url, title: "", stack, idx, sess: "x" });

assert.equal(tabLabel(tab("https://claude.ai/", ["https://claude.ai/"], 0)), "claude.ai");
assert.equal(
  tabLabel(tab("https://lobsterbrowse-beta.onrender.com/zl/x", ["https://claude.ai/", "https://lobsterbrowse-beta.onrender.com/zl/x"], 1)),
  "claude.ai",
  "proxy-origin hop shows the real site",
);
assert.equal(tabLabel(tab("https://lobsterbrowse-beta.onrender.com/zl/x", ["https://lobsterbrowse-beta.onrender.com/zl/x"], 0)), "New tab");
assert.equal(tabLabel({ ...tab("https://www.example.com/a", ["https://www.example.com/a"], 0), title: "Example" }), "Example");
assert.equal(tabLabel(tab("", [], 0)), "New tab");
console.log("tab-label check: all assertions passed");
