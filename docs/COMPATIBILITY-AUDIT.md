# Compatibility & Mock Audit (2026-09-27)

Full-repository audit of mocked/stubbed/spoofed/hardcoded browser
behavior, the guest-origin threat model, and the honest-compatibility
policy. This is the reference for what LobsterBrowse fakes, why, and
what is genuinely unsupported.

## 1. Inventory — every fake / stub / spoof / shim

| Finding | Location | Class | Verdict |
|---|---|---|---|
| `navigator.serviceWorker` stub (register rejects, `ready` never resolved) | `server/bin/server/src/engine-compat.js` | compatibility shim | KEPT, fixed: `ready` now resolves (was a hanging promise), all paths fail immediately, one-time diagnostic explains why |
| `Notification.permission = "denied"`, `requestPermission` → `"denied"` | `engine-compat.js` | deliberate policy | KEPT, documented: permission belongs to the proxy origin, not the site; never granted artificially; one-time diagnostic added |
| `beforeinstallprompt` preventDefault | `engine-compat.js` | deliberate policy | KEPT: the prompt would offer installing LobsterBrowse (the host PWA), never the proxied site; documented in the file |
| AMO Firefox spoof (UA header + `navigator.userAgent`/`vendor`/`oscpu`/`userAgentData`/`InstallTrigger` patch) | `main.rs` (`is_amo_host`, `amo_spoof_script`, `FIREFOX_UA` in `engine_proxy`) | site-scoped spoof | KEPT: scoped strictly to `addons.mozilla.org` (AMO gates .xpi downloads on a Firefox client). NOT generalized anywhere else. `userAgentData` is patched to `undefined` and `vendor` to `""` because that is what Firefox actually reports — the spoof describes a real browser, not a fake capability |
| UA presets (Chrome/Firefox/Safari/Edge/...) | `ui/src/settings.ts` | configuration | Not a spoof: explicit user setting, applied server-side per-request as the `lb_ua` engine option |
| Firefox UA header on `/suggest` proxy requests | `main.rs` `suggest_endpoint` | compatibility shim | KEPT: suggestion providers reject non-browser UAs; scoped to the suggest path only |
| Challenge-host allowlist (Turnstile/hCaptcha/reCAPTCHA/Stripe frames left cross-origin) | `CHALLENGE_HOSTS` in `main.rs`, `CHALLENGE_HOST_RE` in `engine-shim.js` | intentional browser-emulation compat | KEPT: widgets must stay genuinely cross-origin or their own origin checks fail. Lists are documented as needing manual sync (regex comment in the shim mirrors the Rust const) |
| `window.open()` → opens a proxy tab, returns `null` | `engine-shim.js` | intentional emulation | KEPT but honest gap: some sites expect a usable window object. See §4 backlog |
| fetch/XHR/element-setter routing patches | `engine-shim.js` | required for proxy operation | KEPT |
| console/net/resfail diagnostics capture | `engine-shim.js` | diagnostics | KEPT; sanitized centrally (see §2) |
| Decentraleyes local library substitution (jquery/lodash/moment/d3 from jsDelivr) | `ui/public/lobsterjet.js` | deliberate substitution | KEPT, user-toggleable, version mapping documented as approximate |
| CSP meta / `integrity` attribute stripping | `main.rs` `strip_csp_meta` / `strip_integrity` | forced compat | KEPT: rewritten resources legitimately differ from upstream bytes, SRI would reject 100% of them; CSP would forbid the injected shim. Counted and reported per page (`lb-diag` meta) instead of silent. Header-level CSP never reaches the browser (engine_proxy forwards only content-type + cache headers) — documented in AGENTS.md |
| `<base>` tag stripping | `main.rs` `strip_base_tags` | forced compat | KEPT: the server resolves every relative URL against the real page URL, so a surviving `<base>` would re-anchor runtime-resolved URLs away from the engine route. Tests added for case/whitespace variants. Honest gap: pages that mutate `<base>` at runtime are not re-anchored |
| engine error card (own HTML on load failure) | `engine_error_page` | intentional emulation | KEPT: never a fake success; carries `lb-load-error` meta + Try Again |
| 429 captcha-page suppression | `engine_proxy` | deliberate policy | KEPT: a self-refreshing challenge that cannot be solved inside the proxy is replaced by an honest error card |

No genuine test/mock code was found outside CI config. No
`return null`/`return []` fake-success paths were found beyond the
documented stubs above (`getRegistrations() → []` mirrors an honest
"no registrations exist on this origin" answer for a capability that
cannot work; documented in engine-compat.js).

## 2. Central secret sanitization (P0, fixed 2026-09-27)

Website diagnostics are untrusted. Two central sanitizers now own
redaction; individual call sites no longer remember to redact:

- `ui/src/sanitize.ts` — `sanitizeUrl` / `sanitizeText`. Applied to
  every console text, net URL/error, resfail URL/note and the
  "url sync" app-log line in `Browser.tsx` before anything enters
  DevTools state or the persisted app log.
- `main.rs` `redact_secrets()` — applied inside `push_log`, so the
  entire `/logs` ring is sanitized at write time (secret query params,
  JWTs, Bearer/basic/labeled credentials). Patterns mirror the TS
  module. Unit tests in `redact_tests`.

Deliberately conservative: emails and arbitrary long strings are not
redacted (they are page content; over-redaction destroys diagnostics).

## 3. Server log isolation (P0)

`AppState.logs` is a single bounded (1000-line) ring shared by the
whole deployment. The deployment model today is a single-user Render
service; on a shared deployment the ring WOULD be visible to every
user via `/logs`. Full per-session correlation is a redesign (backlog,
§4). What is fixed now: every entry is centrally sanitized (§2), so
cross-user leakage can no longer include session tokens, JWTs or API
keys carried in URLs/diagnostics. The ring stays bounded.

## 4. Guest-origin threat model (P0)

Proxied pages are served from the LobsterBrowse origin in a
same-origin iframe. That is load-bearing architecture: DevTools
`contentWindow.eval`, the title/favicon/error-meta poll and the
DevTools DOM inspector all depend on it. A `sandbox` attribute without
`allow-same-origin` would kill DevTools and the cookie-clearing site
card; full origin isolation per guest is not possible on one origin.

What a guest page CAN do today (accepted risk, documented):
- read/write this origin's localStorage/sessionStorage and cookies
  (engine state, not user credentials; LB UI state stores no secrets)
- reach internal endpoints: `/logs`, `/healthz`, `/build`, `/suggest`,
  `/zlsw/`, `/zl-ext/`, `/zl-cs/` — same as any same-origin script
- postMessage to the parent.

Mitigations in place after this pass:
- The shim's diagnostics `postMessage` now uses `targetOrigin:
  location.origin` instead of `"*"` (was harmless same-origin, now
  explicit).
- The parent's message handler validates `e.origin ===
  window.location.origin`, matches `e.source` against a known tab
  frame, schema-validates `{lb, data}`, caps every string field and
  batch size, and drops unknown `lb` types.
- `navigate` messages are scheme-validated (http/https only); the
  toolbar URL state is updated from tab state, not from raw messages.

Known-unmitigated (backlog): a hostile guest can read LB UI state keys
from localStorage and fetch `/logs`/`/suggest`. Per-session log
sharding and iframe `srcdoc`/portal-based isolation are the candidate
redesigns; both break DevTools as written.

## 5. Honest "still unsupported" list

- Real service workers for guest pages (origin collision with the
  Zeolite root-scope worker). Deterministic failure + diagnostic.
- Guest notifications (permission belongs to the proxy origin).
- PWA install prompts for guest sites (prompt belongs to the host).
- Guest Web Workers: NOT stubbed; they run, but their scripts route
  through the engine only if created from a rewritten URL — a worker
  created from an absolute origin URL escapes the proxy. Unchanged;
  needs a worker-script proxy route (backlog).
- Full back/forward history through OAuth popup flows and
  `window.open` return values (returns `null`).
- Zeolite-mode incognito: `/lj/` tabs share the engine cookie jar
  (documented AGENTS gap; ScramJet `/r/` has a real separate jar).
- Session restoration preserves the full stack + index (fixed this
  pass); timestamps/favicons per entry are not stored (backlog).

## 6. /r/ vs /lj/ ownership rule

When a site breaks: reproduce on `/r/` (server ScramJet rewrite) and
`/lj/` (Zeolite service worker). `/lj/` failures where `/r/` works are
engine-side; document them separately with reproduction and evidence,
never patch Zeolite from LobsterBrowse. Everything in this document
and the 2026-09-27 pass is LobsterBrowse-owned (shim, compat, UI,
server rewrite).

## 7. Remaining backlog (ranked, not done in this pass)

P1: form/upload/media/range/compression/redirect compatibility
suites; `<base>` runtime mutation; window.open return object; guest
worker script routing; per-session `/logs` correlation; challenge-host
allowlist generation (Rust↔JS single source).
P2: settings versioned migrations; favicon SSRF hardening; tab
lifecycle policy; permissions model; downloads page/history.
