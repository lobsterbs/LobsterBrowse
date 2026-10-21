# LobsterBrowse Roadmap

This is the **single authoritative roadmap** for LobsterBrowse.

- Canonical location: `/ROADMAP.md`
- README and AGENTS.md should point here instead of duplicating the roadmap.
- Zeolite has its own roadmap; do not copy Zeolite milestones into this file.
- This roadmap is a living plan. Milestone scope may be adjusted when repository inspection shows that work is already complete, incorrectly scoped, or architecturally obsolete.

## Project direction

LobsterBrowse is an open-source browser-style proxy application built around Rust/Axum, React + TypeScript, Material 3 Expressive, Wisp transport, structured diagnostics, and Zeolite integration.

The long-term boundary is:

```
LobsterBrowse
      |
      v
   Zeolite
      |
      +-- interception
      +-- rewriting
      +-- virtual origins / browser state primitives
      +-- transport decisions
      |
      v
 Network / Wisp / Native transport
```

LobsterBrowse owns the browser/application experience. Zeolite owns reusable interception and transport functionality. Wisp remains a transport foundation.

The project should prioritize **working browser behavior over feature count**. It is not intended to become a Chromium or Firefox clone.

## Naming system

LobsterBrowse uses **chemical element names** as release codenames.

This deliberately parallels Zeolite's scientific naming style while remaining distinct:

- **Zeolite:** compound/material terminology such as Nitride, Oxide, Halide, Carbide, Boride, Silicide, Hydride, Sulfide, Telluride, Fullerene, Graphene.
- **LobsterBrowse:** individual chemical elements.

Planned sequence:

| Version | Codename | Primary focus |
| --- | --- | --- |
| 0.3 | **Titanium** | Architecture and foundation |
| 0.4 | **Vanadium** | Navigation and compatibility foundation |
| 0.5 | **Cobalt** | Difficult modern websites |
| 0.6 | **Nickel** | Diagnostics and DevTools |
| 0.7 | **Zirconium** | Browser state and persistence |
| 0.8 | **Tungsten** | Extension
s |
| 0.9 | **Iridium** | Stabilization and compatibility freeze |
| 1.0 | **Osmium** | Stable LobsterBrowse |

These are codenames, not replacements for semantic versioning. A release should be written as, for example, **LobsterBrowse 0.4 - Vanadium**.

The exact milestone boundaries may be changed when justified by the actual repository, but the chemical-element naming system should remain.

---

# 0.3 - Titanium

## Foundation and architecture cleanup

Establish a clean and truthful base before expanding the browser.

### RewriteFallback audit

The old RewriteFallback architecture is being removed/replaced. Perform a repository-wide audit before declaring this complete.

Search source, tests, configuration and documentation for:

- `RewriteFallback`
- `rewrite fallback`
- old fallback-rewriter terminology
- obsolete engine flags/configuration
- dead routes/imports
- stale architecture diagrams
- stale DevTools labels

If RewriteFallback is genuinely obsolete, remove remaining implementation and documentation references. If a piece is still required, identify the exact dependency instead of deleting working compatibility infrastructure blindly.

Audit result (2026-09-30, resolved): no RewriteFallback implementation, route, engine flag, DevTools label or fallback-rewriter code remains in the repository (0 code hits on main and beta). The term survives only as design vocabulary in the NativeTransit direction diagrams (README/AGENTS), where "RewriteFallback" names the Zeolite worker wasm rewriter escape hatch, not a removed LobsterBrowse component. Nothing to delete; recorded here per the audit instruction.

### Engine architecture

- Make the LobsterBrowse ↔ Zeolite boundary explicit.
- Keep one authoritative decision point for the engine route prefix (`/zl/`; the legacy `/r/` and `/lj/` prefixes answer the honest gone-notice since 2026-10-09, #67).
- Avoid duplicate networking, cookie, rewriting or interception infrastructure.
- Keep reusable engine fixes in Zeolite rather than adding LobsterBrowse-only hacks.
- Keep NativeTransit and rewriting behavior accurately repre
sented as implemented, partial, experimental or planned.

### Build and deployment reliability

- Keep Zeolite revisions immutable/pinned.
- Prevent stale generated Zeolite bundles from silently reaching production.
- Keep `/build` truthful about the actually served bundle.
- Verify Render deployments against the expected engine revision.
- Keep CI strict; do not add fallback build commands that hide failures.

### Documentation

Bring README, AGENTS.md and architecture documentation into agreement with the implementation.

### Titanium gate

Complete only when the architecture is understood, obsolete fallback references are resolved, builds are reproducible, deployed engine assets can be verified, and core browsing still works.

Status (2026-09-30): all Titanium items are in place except the recorded
browser pass, which is deferred until a browser session is free. The
deterministic transit suite (tests/transit, Tiers 0-7) gates everything
CI can gate; the browser pass against a live beta origin is the one
remaining step. The RewriteFallback audit is resolved above, the
LB/Zeolite boundary is documented (AGENTS.md,
docs/zeolite-integration.md), the build/deploy reliability checklist
lives in DEPLOY.md, and README/AGENTS/DEPLOY agree on the current
Zeolite pin (e3f1a171 / dist 3080d559).

Recorded browser pass (2026-10-04, live beta origin, engine mode
`/zl/`, Playwright): PASS antiframe fixture framed through the engine
(frame survives, status flips to "script ran"); PASS in-page fetch to
the site's own API through the shim (200, valid JSON); PASS
localStorage/sessionStorage virtualization roundtrip; PASS
history.pushState + history.back without a document reload; PASS
WebSocket from a proxied page (open + echo roundtrip); PASS heavy
real site (en.wikipedia.org: 300KB rewritten document, CSS present,
1530 links, cross-language link navigation through keyed routes);
PASS engine error card surfacing in the UI overlay. Still open
without a deterministic fixture: dynamic imports, module workers.
Challenge-flow verification was blocked by upstream datacenter-IP
denials (startpage Access Denied, DDG TLS reset) during the pass.

---

# 0.4 - Vanadium

## Navigation and compatibility foundation

Make ordinary browsing behave reliably.

Focus on:

- redirects
- relative and absolute URLs
- history
- `window.location`
- `window.open`
- pushState / replaceState
- SPA navigation
- reloads
- cross-origin navigation
- navigation recovery
- authentication redirects

Improve resource handling for:

- HTML
- CSS
- JavaScript
- images
- fonts
- media
- JSON/API requests
- modules
- MIME-sensitive resources
- streaming
- large responses

Test real behavior involving:

- fetch
- XHR
- dynamic imports
- module scripts
- iframes
- WebSockets
- modern SPAs
- authentication

HTTP 200 alone does not constitute compatibility.


Status (2026-09-30, updated 2026-10-09): started. Tier-8/9/10 probes
were first gated through the server-side /r/ engine (navigation
surfaces and the auth-redirect flow; inline import maps; CSS
url()/@import with data: URLs verbatim, srcset routing, page-query
forwarding with lb_ keys stripped, per-sid session jar, conditional
GET). The 2026-10-01 server-side engine removal deleted the server-side
engine, so those gates went with it: check.mjs now gates the /zl/
honest notice, the legacy-prefix gone-notices (#67), and the wasm alias,
while the Tier-8/9/10 fixtures remain for the recorded browser-level
engine pass (in-worker rewriting owns those surfaces now). The
deployed-pair gate
(transit-live CI job) runs the full transit check against the live
beta + fixture Render services on every beta push, so the
server-side live verification is CI-recorded rather than a one-off.
Execution-level behavior (XHR, dynamic imports, iframe subresource
routing, SPA navigation, reloads, cross-origin navigation) needs the
recorded browser pass and stays open.

Execution-level pass + reload findings (2026-10-04, live beta origin,
recorded in the Titanium note above): fetch through the shim, storage,
history/pushState, WebSocket, cross-origin link navigation and heavy
real sites all pass. The reload work item produced three verified
findings. (1) Long or looping upstream redirect chains: the engine
follows up to 10 hops inside one fetch, then surfaces the 3xx with a
mapped Location the browser follows as a visible reload - a looping
chain repeats in 10-hop batches until the browser's own redirect cap
errors out. The engine now emits a TRANSPORT diag event on every
surfaced redirect so DevTools explains the cycle. (2) The UI poll's
blank-frame guard fired a false "blank document" error about 5s into
any slow navigation while the engine allows 20s; fixed to fire only
when no navigation is pending or past the 20s transport timeout.
(3) Challenge/consent escapes reload through escaped-navigation
recovery by design, once per distinct URL. Still open: a deterministic
dynamic-import fixture; auth-tier probes (blocked on the engine
cookie-jar pass against real providers).

---

# 0.5 - Cobalt

## Difficult modern websites

Make LobsterBrowse substantially more capable with real-world applications.

Focus on:

- complex SPAs
- authentication
- WebSockets
- long-lived connections
- dynamic JavaScript
- cross-origin APIs
- iframes
- streaming
- large media
- challenge/captcha compatibility
- modern frontend frameworks
- unusual resource-loading patterns

Maintain a real-site regression suite covering representative classes such as:

- search
- Git hosting
- ChatGPT-style applications
- social applications
- video platforms
- documentation
- authentication providers
- WebSocket-heavy applications
- complex SPAs
- challenge-protected sites

Tests should verify actual behavior rather than merely status codes.

Status: complete (2026-10-21). The maintained regression suite is
CI-gated: the Zeolite-side suite (397-site interaction crawl corpus,
extension-runtime e2e, games-play, compat scoreboard) plus the LB
transit-live job against the live deployment pair. Live spot checks
at pin 101 verified the classes through the relay-only production
pair: search and wiki (Wikipedia), documentation (MDN), complex SPA
(Excalidraw), and a video platform shell (YouTube). Honest walls,
verified live: GitHub, Mastodon and YouTube answer the datacenter
egress with 429/503/403 rate limits, so the page HTML loads through
the engine while the data-driven rendering stalls (the LB #75 class:
upstream bot management, not an engine defect). WebSockets have no
proxied path on the relay-only deployment; challenge and captcha
handling stays detection-only.

---

# 0.6 - Nickel

## Diagnostics and DevTools

Turn the existing diagnostics system into a serious debugging surface.

Expose useful information for:

- network requests
- request lifecycle
- responses
- console messages
- resource failures
- WebSockets
- Zeolite
- transport decisions
- interception/rewriting
- extensions
- browser/runtime failures

Important failures should identify:

1. what happened
2. which subsystem handled it
3. where it failed
4. why it failed
5. a request/trace identifier where available

Keep diagnostics privacy-safe. Never
 expose or persist passwords, bearer tokens, API keys, authorization headers, raw cookies or equivalent secrets.

Add privacy-safe diagnostic export when appropriate.

Status: complete (2026-10-21). Diagnostics are always on (the toggle
was removed on purpose). A failure row identifies what happened
(message), the subsystem (category), where (stage plus redacted URL),
why (technicalReason) and, when the engine provides one, the trace
identifier; the DevTools diagnostics page renders every part and the
privacy-safe export serializes exactly the panel's sanitized rows
(last 200 events) to a local file. Nothing leaves the browser.

---

# 0.7 - Zirconium

## Browser state and persistence

Build proper browser state around the existing architecture.

### Tabs

Improve:

- lifecycle
- isolation
- crash handling
- restoration
- incognito behavior

### Cookies and storage

Cleanly integrate Zeolite capabilities as they become available:

- cookies
- localStorage
- sessionStorage
- IndexedDB
- Cache API
- origin isolation

### Sessions

Support reliable:

- persistence
- crash recovery
- restore
- import/export where appropriate

Session state record (2026-10-21): tabs (lifecycle, isolation,
incognito, restoration with the full per-tab history stack and
position persisted on every change) and the streaming download
registry shipped in earlier waves; Settings now offers session
export/import (local JSON file: redacted at export, sanitized and
size-capped at import, refused in incognito). The beta branch also
regained the #99 history-undo snackbar it had silently missed. Open
in this phase: the cookies/storage integration checklist against
current Zeolite capabilities.

Origin isolation record (2026-10-21, #107 phase 1): proxied
frames now navigate a distinct content origin (free Render
service lobsterbrowse-content.onrender.com) behind ZL_CONTENT_ORIGIN
(enabled on main, inert on beta pending the UI seam port); the
boot page self-heals the relay channel, and the navigation seam
skips the per-origin navHandle mint in favor of the b64u route.
Honest gaps and the provisioned origins are recorded in AGENTS.md.
#107 stays open.

Origin isolation record (2026-10-21, #107 phase 2): the
cross-origin URL/title sync bridge is live on main. The embedded
frame asks the engine (zl:getEmbedder) for the embedder origin and
its own virtual URL; the bootstrap embedsync module re-emits the
existing {lb:"nav", url, title} message to the parent on load,
virtual-location moves and title mutations, and the UI applies it
to the URL bar and the tab title; the boot page learns the app
origin via the UI's zlRegAsk postMessage and registers it
(zl:embedderOrigin), with the relay self-heal re-registering it
after a channel loss. Honest residual: the URL bar is
frame-reported, so a hostile content-origin page can spoof the URL
for its own tab only (bounded); the remaining gaps stay recorded
in AGENTS.md. #107 stays open for the phase-3 review. Pin 102
(Zeolite dist dc16a50c, sw.js 628614de5754a91f, bootstrap.js
37460e146d217cb7) carries the engine side.

Origin isolation fix record (2026-10-21, #107 phase 2
completion, pin 103): the phase-2 bridge shipped silent -
two engine roots, both probed live. First, the fail-closed
host gate (#170) classified the /zlsw-register boot page as
a proxied sender, so the worker silently refused its
host-only zl:relayRegister / zl:wispRegister /
zl:embedderOrigin registrations: the content-origin relay
never opened (the wave-37 relay channel never actually
worked) and content loads rode the content service own
wisp endpoint instead. Second, nothing sends zl:config to
the content-origin worker, so its prefix stays the default
/j/ and decodeClientUrl nulled every /zl/<b64u> client -
zl:getEmbedder answered url:null and no {lb:"nav"} reached
the UI. Pin 103 (Zeolite main 2b1633b, dist ec7fd8fe,
sw.js ce02ad5c6c73bd90, bootstrap.js unchanged
37460e146d217cb7) adds /zlsw-register to HOST_PATHS
(grants no new capability: "/" is already a host path) and
a decodeClientUrl fallback to decodeLegacyRoute. Security
finding, verified by unauthenticated probe: the content
service /wisp/ endpoint was open (the engine wasm wisp
client has no auth support); the main service endpoint is
password-authed, and the content service is closed to
match it - the engine keeps the relay transport.

Zirconium status record (2026-10-21): tabs (lifecycle, isolation,
incognito, restoration with the per-tab history stack) and
sessions (persistence, crash recovery, restore, export/import)
shipped; origin isolation is live in phases 1-2 (above). Open in
this phase: the cookies/storage integration checklist against
current Zeolite capabilities, and carrying the split-origin seam
to the beta UI line.

### Downloads

Provide a proper download flow rather than treating downloads as ordinary navigation.

### Site information

Expose useful site information without exposing sensitive data.

---

# 0.8 - Tungsten

## Extensions

Continue WebExtension/Gecko compatibility work.

Focus on:

- extension installation
- manifests
- permissions
- content scripts
- background scripts
- service workers
- extension storage
- messaging
- isolated execution
- lifecycle
- diagnostics

Test actual extensions, not only internally-created demo extensions.

Keep extension permissions explicit and isolated.

Provide useful errors for manifest, permission, content-script, background, messaging and blocked-resource failures.

Tungsten status record (2026-10-21): the WebExtension runtime is
engine-owned (Zeolite app/src/extensions) and verified by its own
e2e harness (15/15 checks: install/uninstall/enable/reload,
manifest parsing with unknown-field preservation, permission
gates, content scripts on real proxied pages, storage quotas,
messaging, tabs from a Firefox-style MV3 background, options/popup
pages, the host-only gate, lifecycle); LobsterBrowse owns XPI
install, the extensions panel and per-site enable. Honest gaps:
content scripts run in the page's JS context, not an isolated
world; the suite runs 12 purpose-built test extensions, not
store-distributed ones; while split-origin mode is enabled on
main, extensions do not ride content-origin pages. Tungsten stays
open.

---

# 0.9 - Iridium

## Stabilization and compatibility freeze

Treat this as the major pre-1.0 hardening phase.

### Compatibility

Run the complete real-site regression suite and track:

- navigation failures
- rendering failures
- JavaScript failures
- WebSocket failures
- authentication failures
- storage failures
- extension failures
- resource failures
- challenge failures

### Performance

Measure:

- startup
- navigation latency
- memory
- CPU
- large-page performance
- long-running sessions
- concurrent tabs
- downloads
- streaming

### Reliability

Test:

- upstream failures
- timeouts
- malformed
 responses
- redirects
- connection resets
- WebSocket disconnects
- partial responses
- crashed tabs
- failed extensions
- stale engine bundles

### Security

Review:

- SSRF protection
- DNS rebinding protection
- URL validation
- redirect validation
- origin isolation
- cookie isolation
- header handling
- extension permissions
- diagnostic redaction
- resource limits

### Documentation freeze

Documentation must describe actual behavior. Do not present planned features as implemented and do not retain obsolete architecture diagrams.

Iridium status record (2026-10-21, pre-freeze honest status;
recorded per operator instruction, the project stops here and does
not advance to 1.0 Osmium until the real-site bar is met):

- Compatibility: the last full 397-site interaction crawl (engine
suite harness) ran 2026-10-12 at pin 54 (264 ok, 89 small-ok, 18
botwall, 18 no-frame, 8 error-page, 0 loadfail). It has NOT been
re-run at pin 102; targeted live probes at pins 97-102 cover the
Google AI-mode class, Brave, DuckDuckGo, games and app suites. A
full crawl at the current pin is required before any freeze claim.
- Performance: no systematic startup/memory/CPU/large-page
measurements are recorded (relay TTFB for example.com was 105 ms
at an earlier pin). Open.
- Reliability: the transport-chaos harness proved honest failure
and recovery under a mid-stream server kill; relay burst limits
are sized for page loads (48 concurrent, 150 per 10 s, bounded
429/503 retry, wave 38). Open: a long-running soak and
crashed-tab coverage.
- Security: the cross-origin hostile probe is verified live
(parent title/localStorage/location/cookie blocked on the content
origin; the same-origin contrast reads all four); SSRF
resolve-then-validate and session-scoped /logs hold; downloads
carry budgets. Open: the #107 phase-3 bridge review and the
per-origin cookie-jar split.
- Documentation freeze: AGENTS.md and ROADMAP.md are updated per
wave with honest gaps; a shipped-invisible DevTools panel was
found and fixed in wave 36 (the docs-claim audit working). Open:
the final pre-1.0 sweep.

Iridium stays open. 1.0 Osmium is blocked until the compatibility
crawl at the current pin and the phase-3 review land.

---

# 1.0 - Osmium

## Stable LobsterBrowse

1.0 means the architecture and browser experience are stable enough to document and maintain as a real release.

### Architecture

- clear LobsterBrowse/Zeolite boundary
- no obsolete fallback architecture
- no duplicated networking architecture
- reproducible builds
- reliable deployment
- maintainable engine lifecycle

### Browser

Stable support for the core browser experience:

- tabs
- navigation
- sessions
- incognito
- storage
- downloads
- settings
- site information
- extensions
- DevTools

### Compatibility

Publish an honest compatibility matrix:

- Supported
- Partially supported
- Known limitation
- Not supported

Do not reduce compatibility to a single percentage.

### Security and privacy

Complete a security/privacy review of the proxy and browser-state architecture.

### Documentation

README, AGENTS.md, architecture documentation and DevTools documentation must agree with the implementation.

---

# Phase: Zeolite Integration - Deferred

Status: **started on the beta line, 2026-09-30.** Zeolite's engine
API has stabilized (3.0 Diamond). Deep integration now lands on
beta/zeolite-nativetransit per docs/zeolite-integration-plan.md and
promotes to main via PR #12 only when green and live-verified.
The plan's items are implemented on beta (2026-09-30): per-site
rule push into the engine (zl:rules, Zeolite f3268eff), incognito
throwaway jar (zl:jarProfile, Zeolite cf2d0400),
 per-origin virtual
WebSocket identities (Zeolite e3f1a171; beta pinned at e3f1a171 /
dist 3080d559), and js_antiframe parity confirmed already ported
(the earlier "no counterpart pass" claim was stale). Live
behavioral verification of the engine-mode items rides the recorded
browser pass. Still open beyond the plan: proxied WebSockets pending
the final transport API. main stays pinned to verified dist
releases and does not chase Zeolite internals.

Planned work:

- Validate LobsterBrowse against the final Zeolite 2.x contract.
- Re-test the complete browser → worker → Zeolite → Wisp path.
- Implement proper proxied WebSockets when the final Zeolite
  transport/API is ready (today foreign-origin sockets fail loudly
  with WEBSOCKET_UNSUPPORTED; that stays the behavior until then).
- Decide which Zeolite interception capabilities should be exposed
  by LobsterBrowse.
- Session export/import integration.
- Network inspector integration.
- Recording/replay integration.
- Fingerprint profile integration.
- Useful download integration.
- Tracing/diagnostics integration.
- Worker/service-worker integration where appropriate (today guest
  workers from foreign-origin script URLs are blocked loudly; in-worker
  subresource routing is engine-owned).
- Engine switching and teardown validation.
- Re-run the compatibility/security audit after integration.

These are future planned features, not current failures. Until this
phase starts, LobsterBrowse must remain stable against the pinned
Zeolite revision, and anything that cannot be implemented without the
evolving Zeolite codebase is deferred here rather than shimmed.

---

# Roadmap rules

## This file is authoritative

Do not create duplicate roadmap documents such as:

```
docs/roadmap.md
docs/ROADMAP.md
ROADMAP-v2.md
future-roadmap.md
```

unless a future architectural change explicitly requires a separate document.

The canonical roadmap is:

```
/ROADMAP.md
```

README and AGENTS.md should point here.

## Zeolite remains
 separate

Do not merge Zeolite's roadmap into this file.

LobsterBrowse milestones may depend on Zeolite milestones, but each repository maintains its own roadmap.

## Living plan

Agents may adjust:

- milestone scope
- milestone ordering
- individual tasks
- version boundaries

when inspection of the actual codebase proves the current plan inaccurate or impractical.

Significant changes should be recorded in ROADMAP.md rather than silently changing the project's direction.

## Completion standard

A milestone is not complete merely because:

- code compiles
- CI passes
- an endpoint returns 200
- a UI exists
- a feature is mocked

Where applicable, completion requires implementation, tests, and real browser/deployment verification.

## Immediate priority

The immediate roadmap milestone is **0.7 - Zirconium** (0.4 -
Vanadium, 0.5 - Cobalt and 0.6 - Nickel are complete). The Cobalt
groundwork stands: the RewriteFallback architecture was audited and
reconciled into the engine's expected routing decisions,
LobsterBrowse and Zeolite responsibilities are documented in
AGENTS.md, /zl/ with Wisp and NativeTransit behavior is verified
live on every deploy, engine builds are reproducible (dist pin plus
sha256 checks in CI and in the Docker build), and the real-site
regression suite runs in CI.

Operator note (2026-10-21): status records for 0.7, 0.8 and 0.9
are appended to their sections; the project does not advance to
1.0 Osmium until the real-site compatibility bar is met.

