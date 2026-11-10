/* Regression check for wave 99 idle tab unloading (issue #249):
   background proxied tabs free their documents from the shared
   renderer process after an idle deadline. Run from the repo root:
   node --experimental-strip-types tests/ui-wave99/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const b = read("../../ui/src/pages/Browser.tsx");
const ci = read("../../.github/workflows/ci.yml");

/* The 5-minute idle deadline drives the unload ticker. */
assert.ok(b.includes("const IDLE_UNLOAD_MS = 5 * 60 * 1000"), "the 5-minute idle deadline is pinned");

/* The active tab never unloads. */
assert.ok(b.includes("if (t.id === activeIdRef.current || !t.url) continue;"), "the active tab is exempt from unloading");

/* A mid-load tab never unloads. */
assert.ok(b.includes("statusRef.current[t.id]?.loading || pendingNav.current.has(t.id)"), "a loading tab is exempt from unloading");

/* Playing media keeps a tab alive. */
assert.ok(b.includes("if (!el.paused && !el.ended) { playing = true; break; }"), "playing media keeps a tab alive");
assert.ok(b.includes("if (playing) { tabActiveAt.current.set(t.id, now); continue; }"), "a media-playing tab gets a fresh idle deadline");

/* The unload parks the frame at about:blank without committing it. */
assert.ok(b.includes('try { f.src = "about:blank"; } catch { sleeping.current.delete(t.id); }'), "the frame unloads to about:blank");
assert.ok(b.includes("if (sleeping.current.has(t.id)) { sleeping.current.delete(t.id); return; }"), "the about:blank load event is not treated as a first paint");

/* The commitment is reset before unloading so the return shows the skeleton. */
assert.ok(b.includes("sleeping.current.add(t.id);"), "unloading marks the tab sleeping");
assert.ok(b.includes("minorNav.current.delete(t.id);"), "unloading clears the minor-nav commitment");

/* Returning to an unloaded tab re-navigates. */
assert.ok(b.includes("if (lastNav.current.get(t.id) === t.url && !blankFrame(t.id)) return;"), "the blank-frame arm re-navigates unloaded tabs");
assert.ok(b.includes('f.contentWindow.location.href === "about:blank"'), "blankFrame detects the parked frame");

/* Navigating resets the idle deadline; closing cleans the bookkeeping. */
assert.ok(b.includes("tabActiveAt.current.set(tab.id, Date.now());"), "navigation resets the idle deadline");
assert.ok(b.includes("tabActiveAt.current.delete(id);"), "tab close cleans the idle map");
assert.ok(b.includes("sleeping.current.delete(id);"), "tab close cleans the sleeping set");

/* The ci ui job runs this check. */
assert.ok(ci.includes("../tests/ui-wave99/check.mjs"), "ci.yml runs the wave 99 check");

console.log("ui-wave99: all checks passed");