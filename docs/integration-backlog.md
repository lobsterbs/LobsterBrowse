# Integration backlog and ownership (beta branch)

Status: verified ledger, 2026-10-01. Every row below was checked
against the live code, not memory. Verified at Zeolite main
fbb603a4dc7b2935cbe5748ae4ee03b3988cf67c and LobsterBrowse beta
90ba48848524d1d3e0e82714d57b4a57ad9611a6 (the live beta deployment).

Owner tags: ZEOLITE items belong to the Zeolite session
(lobsterbs/Zeolite); LOBSTERBROWSE items belong to this repo's session.
This repo is the filing location because the two sessions share
LobsterBrowse context; nothing here is pushed to Zeolite from the
LobsterBrowse side.

## ZEOLITE-owned items

### 1. Extension-origin page hosting (highest priority)

Why: every extension options page returns the literal 404 body
"zeolite: extension resource not found" today. app/src/extensions/
serve.ts serves /zl-ext/<id>/<path> as web_accessible_resources only
(WAR glob checked inside getResource) and /zl-cs/<id>/<path> as
declared content-script files only; options pages are never WAR.
compat.ts marks "options pages" and "popup pages" as not supported
with the reason "extension-origin page hosting lands with the
toolbar/popup phase"; the roadmap closed at 3.0 Diamond with no phase
scheduled for it, so it needs to be scheduled.

Needed:

- A same-origin route serving manifest-declared extension pages:
  options_ui.page, options_url, popup, and runtime.getURL targets
  opened as top-level tabs. Gated so arbitrary pages cannot pull
  background or options sources through it. The existing WAR route
  semantics must stay untouched for embedded loads.
- The extension runtime API (browser.* and chrome.*) injected into
  that page context: the same buildApi the background gets, with
  background-only namespaces honestly absent, per the compat matrix
  rules.
- URL contract: either keep the /zl-ext/<id>/<path> shape, in which
  case LobsterBrowse's probe-first options path works with zero
  changes here, or add a zl:openOptions control message (ext id in,
  servable URL out). Both work for LobsterBrowse; the message is the
  cleaner contract.

This also unblocks Tampermonkey's dashboard (open its UI in a tab).

### 2. zl:getJars (jar enumeration and inspection)

roadmap.md Phase 14 note: "The cookie-jar and fingerprint-profile
surfaces still need engine control messages (there is no zl:getJars
today)". Since then zl:jarProfile (default vs throwaway inc profile),
zl:fingerprint, and zl:sameSite exist. Still missing: enumeration
and inspection, so LobsterBrowse Settings cannot list jars or show
and clear per-site cookie state. Needed: zl:getJars plus optionally a
clear variant.

### 3. cookies.* extension API

compat.ts: not supported, reason "requires the Zeolite virtual cookie
jar bridge". Extension parity item riding on the same jar surface as
item 2.

### 4. notifications.* extension API

compat.ts: not supported, reason "requires the LobsterBrowse
notification surface". Needed on the Zeolite side: the API plus a
handoff message following the existing zl:downloadOp pattern. The
LobsterBrowse rendering half is item LOBSTERBROWSE-4 below.

## LOBSTERBROWSE-owned items

### 1. Download state reporting back

compat.ts downloads.*: "download-state queries and events absent
until the UI reports state back". LobsterBrowse must push download
state updates into the engine so browser.downloads queries and
events work for extensions.

### 2. Context menu surface

compat.ts contextMenus.*: "the visible menu surface ships with the
LobsterBrowse integration". LobsterBrowse must render the items and
report clicks over the zl:menuClick channel.

### 3. Adopt the existing jar and fingerprint control messages

The LobsterBrowse UI currently sends only zl:installExt, zl:extInfo,
zl:extEnable, zl:listExt, zl:exportSession, zl:importSession. It has
not adopted zl:jarProfile, zl:fingerprint, or zl:sameSite. Full jar
management in Settings partially waits on ZEOLITE-2.

### 4. Notification rendering

When ZEOLITE-4 lands its handoff message, LobsterBrowse renders the
notifications. Note: the browser's notifications permission was
denied in the user's console; that is the host permission, separate
from this engine surface.

## Explicitly NOT items (verified limits, do not re-litigate)

- Content scripts on Startpage pages through the server /r/ chain
  will never come from Zeolite. Startpage rides the server chain
  precisely because Zeolite's non-negotiable is captcha detection
  only, no solve verb. Pages on that chain are not controlled by the
  service worker, so no extension runtime can inject there. If that
  ever matters, it is LobsterBrowse rewriter work.

- The Startpage intermittent 404 shell is instrumented on the
  LobsterBrowse side (warn log "engine document hit the host
  not-found page" naming the exact original URL, live since build
  90ba488). It is a client-side URL escape hypothesis until the warn
  fires with real data; no Zeolite action exists.

## Delivery pipeline (both sessions)

LobsterBrowse does not track Zeolite main. The Dockerfile pins
ZEOLITE_COMMIT (a01f5990311ae80f52fcf8e8cb1f518e1667d5d6 at the time
of writing) and server Cargo.toml pins the zeolite-server rev, with
Cargo.lock regenerated by the generate-rust-lockfile workflow.
Anything the Zeolite session lands reaches the beta only after a pin
bump and rebuild on the LobsterBrowse side, so the Zeolite session
should flag this side when a needed change is green on its dist
branch.
