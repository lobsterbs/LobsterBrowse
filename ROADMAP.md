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

These are codenames, not replacements for semantic versioning. A release should be written as, for example, **LobsterBrowse 0.4 — Vanadium**.

The exact milestone boundaries may be changed when justified by the actual repository, but the chemical-element naming system should remain.

---

# 0.3 — Titanium

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
- Keep one authoritative decision point for `/r/` vs `/lj/`.
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

---

# 0.4 — Vanadium

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


Status (2026-09-30): started. Tier-8 transit probes gate the
server-side matrix - navigation-surface routing (iframe doc, module
script, dynamic import, XHR, relative/absolute/external links) and
the authentication-redirect flow through /r/, on top of the Tier-7
redirect-chain and method-replay gates. Tier-9 probes gate inline
import maps through /r/: URL values route through the engine,
path-like keys are rewritten byte-identically to the import
specifiers that look them up, and bare keys plus data: values stay
verbatim (the relative-key gap recorded in AGENTS.md is closed
server-side; scope keys stay verbatim and fall back to the top
level). The deployed-pair gate
(transit-live CI job) runs the full transit check against the live
beta + fixture Render services on every beta push, so the
server-side live verification is CI-recorded rather than a one-off.
Execution-level behavior (XHR, dynamic imports, iframe subresource
routing, SPA navigation, reloads, cross-origin navigation) needs the
recorded browser pass and stays open.

---

# 0.5 — Cobalt

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

---

# 0.6 — Nickel

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

---

# 0.7 — Zirconium

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

### Downloads

Provide a proper download flow rather than treating downloads as ordinary navigation.

### Site information

Expose useful site information without exposing sensitive data.

---

# 0.8 — Tungsten

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

---

# 0.9 — Iridium

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

---

# 1.0 — Osmium

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

# Phase: Zeolite Integration — Deferred

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

The immediate roadmap milestone is **0.4 — Vanadium** (0.3 — Titanium
is complete except its recorded browser pass).

Before expanding into more browser features:

1. audit the old RewriteFallback architecture;
2. reconcile LobsterBrowse and Zeolite responsibilities;
3. verify `/r/`, `/lj/`, Wisp and NativeTransit behavior;
4. verify reproducible engine builds/deployments;
5. establish the first real-site compatibility regression suite;
6. update documentation to describe the actual architecture;
7. then proceed into deeper compatibility work.
