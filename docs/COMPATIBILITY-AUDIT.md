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

## 3. Server log isolation (P0, fixed 2026-09-27 pass 2)

`AppState.logs` was a single deployment-wide ring readable by anyone
who could reach `/logs` — including any proxied guest page, since
guests run same-origin. That was a cross-session and cross-tab
diagnostic leak. Fix (per-session correlation, smallest mechanism that
holds):

- The UI mints a session token per tab (`crypto.randomUUID`, in
  `store.Tab.sess`, never persisted to localStorage, regenerated on
  session restore). It threads onto /r/ routes as `lb_sess=` via
  `proxyParams`/`routeUrl` and onward to every rewritten subresource
  through the engine's `params_suffix`.
- Server state: `AppState.sessions: HashMap<String, SessionRing>`
  beside the global ring. `push_log_sess(state, sess, ...)` puts
  tagged lines ONLY in that session's ring; untagged lines go to the
  global ring as before. `/logs` now REQUIRES a valid `lb_sess` and
  returns only that ring; without a token it answers 403. Suggest,
  cert and Anubis-bridge diagnostics are session-tagged too.
- Bounds: per-session ring cap 500 lines; session map cap 128 with
  LRU eviction; idle sessions expire after 1800 s. Worst-case memory
  is bounded by construction.
- Trust: tokens are validated (16–64 chars, `[A-Za-z0-9_-]`). A guest
  page cannot learn another tab's token (it lives in UI state, not in
  anything the page can read), cannot forge a malformed token into the
  map, and an unknown-but-valid token yields an honest empty ring.
- Tests: `session_log_tests` (token validation, cross-session
  isolation, tagged-lines-never-global, ring cap, map cap + idle
  expiry, invalid-token fallback).

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

Known-unmitigated (backlog): a hostile guest can still read LB UI
state keys from localStorage and reach `/healthz`, `/build`,
`/zlsw/*` etc. — but `/logs` now refuses it (403 without a valid
session token, and tokens are not page-readable), and `/suggest` logs
are scoped to the calling tab's ring. Full origin isolation per guest
remains architectural (iframe `srcdoc`/portal-based isolation would
break DevTools as written).

## 5. Honest "still unsupported" list

- Real service workers for guest pages (origin collision with the
  Zeolite root-scope worker). Deterministic failure + diagnostic.
- Guest notifications (permission belongs to the proxy origin).
- PWA install prompts for guest sites (prompt belongs to the host).
- Guest Web Workers: workers created from same-origin (rewritten),
  blob: or data: URLs run unchanged. A worker whose script URL is a
  foreign origin is now blocked loudly (SecurityError +
  WORKER_UNSUPPORTED diagnostic): the script fetch itself would
  bypass the proxy and expose the real IP, exactly like a foreign
  WebSocket. In-worker subresource routing (a same-origin worker
  fetching foreign modules) remains engine-owned and deferred.
- Dynamic `<base>` mutation: a runtime-assigned base href is dropped
  with a one-time diagnostic (property setter and setAttribute). The
  server resolves every URL against the real page URL, so a surviving
  base would re-anchor unrouted URLs; the element stays inert.
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
suites; window.open return object; runtime `srcset` assignment
routing (rare; server rewrites static srcset).
P2: settings versioned migrations; tab lifecycle policy; permissions
model; downloads page/history; accessibility sweep of the M3E UI.
(Done in pass 2: per-session `/logs` correlation; challenge-host
allowlist single source; download streaming; WebSocket proxy-bypass
blocking. Done in pass 3 and removed: `<base>` runtime mutation;
guest worker script routing; anchor/form runtime property bypass.)
Zeolite-dependent deferred work (proxied WebSocket transport,
in-worker subresource routing, session export, inspector, recording,
fingerprint profiles, tracing, engine switching) is planned in
ROADMAP.md "Phase: Zeolite Integration — Deferred"; it is future
planned work, not implemented.

## 8. Incognito data-flow (P0, fixed 2026-09-27)

Audited every persistent path. What incognito already did NOT persist:
tabs/session (`saveSessionTabs` skipped), browsing history (`onHistory`
gated). What it accidentally DID persist: page diagnostic entries
(console lines, resfail reports) reached `pushLog`, which writes the
`lobsterbrowse-logs` localStorage key. Fixed: `store.setIncognitoLogging`
keeps the ring in memory only while incognito is on (App.tsx wires it
to the incognito state); no new entries are written or flushed to
localStorage during an incognito session. The pre-incognito log tail
remains visible (like a real browser's pre-existing state).

What deliberately survives incognito (documented): server-side
`/logs` ring (shared, sanitized, per-deployment), the ScramJet
incognito cookie jar in RAM until restart, Zeolite `/lj/` cookie jar
(documented gap: shared with normal tabs).

## 9. rewrite_html dropped all text nodes (P0, fixed 2026-09-27)

Found during live verification of deploy e8e64f2: /r/ pages rendered
with empty bodies — `<h1></h1><p></p>`, empty link labels, empty
`<title>` — while tags, attributes and injected scripts survived.
Root cause (present since before this task's baseline): the
`rewrite_html` scanner loop jumped straight to the next `<` and never
emitted the bytes between `i` and the tag start, so every inter-tag
text node was silently discarded on both /r/ and /lj/. Fix: emit
`html[i..start]` when a tag is found after non-empty text. Regression
test `text_nodes_are_preserved` added. This is exactly the class of
"looks fine, isn't" breakage the live-verification requirement exists
to catch; it also invalidates any earlier visual impression that /r/
HTML pages were serving correctly.

## 10. Fixed in pass 2 (2026-09-27)

- P0 server log isolation: per-session rings, token-gated /logs (see
  §3).
- P0 WebSocket proxy bypass: the shim's WebSocket wrapper passed the
  page's original ws(s):// URL to the native constructor, so proxied
  pages silently connected straight to foreign hosts (real-IP leak).
  Foreign-origin ws/wss now fail immediately: thrown SecurityError +
  WEBSOCKET_UNSUPPORTED diagnostic. Same-origin sockets (the proxy
  origin's own, e.g. the Zeolite wisp server) pass through.
- P0 download architecture: downloads now stream to disk via the File
  System Access API when available (showSaveFilePicker + writable,
  O(1) memory, cancel discards the partial file); the in-memory Blob
  path remains as a fallback with the 1 GiB honest ceiling. Incognito
  downloads now carry lb_inc (they used the shared cookie jar).
  O(n²) chunk accounting replaced with a running total. "Cancelled"
  is a first-class state, not a fake error.
- P0 extension incognito toggle: no longer persisted to localStorage
  during incognito sessions (was leaking which extensions the user
  toggled while incognito). Enforcement itself remains unsupported
  (honest UI); see §5.
- P1 challenge-host drift: main.rs injects
  window.__LB_CHALLENGE_HOSTS (serialized from the Rust const) before
  engine-shim.js; the shim builds its regex from that list (hardcoded
  fallback retained). One source of truth.
- engine_proxy now forwards content-type (POST forms/multipart work),
  range + if-none-match + if-modified-since (media seeking, 304
  revalidation) from the browser, and passes content-range /
  accept-ranges through on streamed responses (206 media works).
  content-length is still NOT forwarded (reqwest auto-decompresses;
  the length would lie).
- engine_error_page postMessage targetOrigin "*" → location.origin.
- Shim redact() key list aligned with sanitize.ts / redact_secrets()
  (adds pwd/passwd/sessionid/session_id/sid/refresh_token/
  client_secret).
- unroute(): fromCharCode.apply over an unbounded route segment could
  overflow the stack; segments > 8192 chars now pass through
  unrouted.
- Repo text corruption: control chars (U+0014) in main.rs comments and
  double-encoded mojibake in Browser.tsx comments repaired.

Changed mocks/shims (behavior + why):
- WebSocket wrapper: passthrough → foreign-origin block (honest
  immediate failure instead of silent proxy bypass).
- CHALLENGE_HOST_RE: hardcoded → server-injected single source.
- Download sink: capped-Blob-only → disk streaming when the platform
  allows, capped Blob otherwise; ceiling documented per path.

## 11. Full-repo ponytail sweep findings (pass 2)

Real bugs fixed: the nine items in §10 plus the /logs leak (§3) and
the previously reported text-node drop (§9).
Classified and left alone (intentional or not fixable here):
- window.open returns null: sites read it as popup-blocked; a fake
  Window object would be fake success. Honest null + navigate message
  kept (backlog: return a minimal non-functional marker object? —
  rejected for now, it would be a lie).
- /lj/ cookie jar shared between incognito and normal tabs, and /lj/
  has no session-log correlation (traffic never reaches the server
  by design): Zeolite-owned, documented, not modified.
- document.cookie on /r/ pages is the shared proxy-origin jar
  (cross-site crosstalk possible): architectural, documented in §4;
  Zeolite virtualizes it on /lj/.
- <base> stripping is correct for the current architecture (all URLs
  are rewritten against the page URL); runtime base mutation is now
  dropped with a diagnostic instead of silently re-anchoring URLs
  (pass 3, see §13).
- Settings "migrations" are merge-with-defaults; a version field adds
  nothing until a breaking schema change exists (YAGNI, documented).
- Tab lifecycle: all tab iframes stay mounted (the tab switcher needs
  live previews). A freeze/suspend policy is backlog.
- Same-origin guest execution model: kept (DevTools depends on it);
  documented threat model in §4 with per-session /logs now closed.

## 12. Tests (pass 2)

Rust (cargo test): existing suites (redact_tests 7,
rewrite_hardening_tests 5, js_literals, challenge_frame, js_import,
anubis_bridge, url_fragment, res_id, version, antiframe, suggest)
plus NEW session_log_tests (6): token validation, session isolation,
no global-ring leakage of tagged lines, per-ring cap, map cap + idle
expiry, invalid-token fallback. CI gates: cargo fmt --check, build
--locked, test, clippy -D warnings; UI: npm run build + tsc.
Browser-level checks are exercised on the live deploy (see the final
report): /logs 403 without token, /r/ page text integrity, challenge
host injection, WS block diagnostics.

## 13. Fixed in pass 3 (2026-09-27)

- CHALLENGE_HOST_RE construction was semantically dead on main: a
  pass-2 splice had inlined the deleted fallback literal into the
  hostname-escaping replace() replacement string. The line parsed,
  so nothing failed loudly, but the built regex could never match
  and every runtime-created challenge iframe (reCAPTCHA/Turnstile/
  hCaptcha render their frames via JS) was routed through the engine,
  breaking the widgets. Fixed to the intended `"\\Browser-level checks are exercised on the live deploy (see the final
report): /logs 403 without token, /r/ page text integrity, challenge
host injection, WS block diagnostics."` escape; a Rust
  regression test (`challenge_regex_construction`) now guards the
  line. This is the second "parses fine, matches nothing" splice bug
  found by reading bytes, and it was invisible to CI because
  engine-shim.js is include_str!'d, never executed as JS by tests.
- Runtime property assignment bypass: `a.href = u` and
  `form.action = u` (and `setAttribute("formaction")` on submit
  buttons) were NOT routed — only image/script/iframe/media/source/
  link setters were. A runtime-assigned real URL navigated the tab
  straight off the proxy origin (same bypass class as the WebSocket
  hole). HTMLAnchorElement.href, HTMLFormElement.action and the
  formaction attribute now route through the engine.
- `<base>` runtime mutation: dropped with a one-time diagnostic
  (property setter + setAttribute). See §5.
- Foreign-origin Worker/SharedWorker script URLs: blocked loudly
  (SecurityError + WORKER_UNSUPPORTED), matching the WebSocket
  policy; same-origin/blob/data workers unchanged. See §5.
- ROADMAP.md gained the "Phase: Zeolite Integration — Deferred"
  section listing all future Zeolite-coupled work as planned, not
  implemented.
