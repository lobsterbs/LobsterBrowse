/* Regression check for wave 99 idle tab unloading (issue #249):
   background proxied tabs free their documents from the shared
   renderer process after an idle deadline. Run from the repo root:
   node --experimental-strip-types tests/ui-wave99/check.mjs */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const b = read("../../ui/src/pages/Browser.tsx");
const appSrc = read("../../ui/src/App.tsx");
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

/* Wave 100: the content column must include its own padding
   (issue #251): content-box made .app-content poke 48px past the
   viewport and clip the right edge of every view. */
const theme = read("../../ui/src/theme.css");
assert.ok(/\.app-content \{[^}]*box-sizing: border-box;/.test(theme), "the app content column is border-box so padding cannot overflow the viewport");

/* Wave 100b: mobile bottom nav items must stretch, not clip
   (#254), and Settings descriptions must wrap on phones (#255). */
assert.ok(theme.includes(".lb-bottom-nav m3e-nav-item { min-width: 0; flex: 1 1 0; }"), "mobile bottom nav items stretch across the bar");
assert.ok(/@media \(max-width: 600px\)[\s\S]*?\.lb-setting-desc, \.lb-setp-sub \{ white-space: normal; \}/.test(theme), "settings descriptions wrap on small screens");

/* The ci ui job runs this check. */
assert.ok(ci.includes("../tests/ui-wave99/check.mjs"), "ci.yml runs the wave 99 check");


/* Wave 101g (issue #267): a session restore must restore activeId
   along with the tabs. Restored tabs keep their persisted ids while
   App used to initialize activeId to 0, which matches no real tab:
   the DevTools mount effect keyed off dt[props.activeId].open, so the
   Developer tools menu toggle could never open the sheet after a
   reload, and Alt+W / the Logs session scope hit the same mismatch. */
assert.ok(
  /const \[activeId, setActiveId\] = useState<number>\(\(\) => \{[\s\S]*?store\.loadSessionTabs\(\)[\s\S]*?restored\[restored\.length - 1\]\.id[\s\S]*?\}\);/.test(appSrc),
  "App restores activeId from the persisted session (last restored tab, #267)"
);
assert.ok(!appSrc.includes("useState<number>(0)"), "activeId no longer initializes to the unmatched sentinel 0");

console.log("ui-wave99: all checks passed");