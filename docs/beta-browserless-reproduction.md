# Beta Browserless reproduction and diagnostic availability

Experimental. Tested through the public Beta with Browserless on 2026-10-26.

- `/build`: LB `00fea8b3effbda689dfe7c1d5192561506d72fd7`, Zeolite 3.0
  Diamond, served worker `b09a2bedaa8f77f0`.
- Startpage search for `zeolite mineral` with default libcurl, then with
  epoxy selected through Settings followed by full reload: both delivered
  Startpage's **Access Temporarily Suspended** page, citing shared-connection
  anti-abuse. No result list or result favicon requests were available.
  This does not establish the reported SERP/favicon root cause (#492).
- The deployed page's Startpage links had virtual `href` but engine-host
  `hostname`. Generic anchor component fixes already exist in Zeolite's
  unmerged PR #480; the old deployed bundle is not evidence those fixes failed.
- Example Domain rendered through Beta. Opening Diagnostics returned two
  retained document requests, client-scoped NativeTransit/rewrite counters,
  and routing events. Logging is therefore not universally broken.

## Implemented: #220 availability reporting

A missing identity, failed/timed-out query, incompatible scope/format and
worker restart now have distinct fixed messages instead of indefinite
Awaiting. These messages also enter Copy logs. A valid empty reply remains
ready. Scope/source changes reset presentation; unavailable data never
falls back to another document or worker-global logs. Polling remains
sequential, retries after settlement, and discards late navigation replies.

Tests extend the existing diagnostics-scope check; the strict UI build is
unchanged. These changes are not a deployment or a full fix for Zeolite #492.

Claude through Beta/epoxy rendered a nonblank Cloudflare verification page
followed by Unable to connect to the website. This is not the originally
reported black screen and does not identify its cause (Zeolite #481).

Validation: strict TypeScript/Vite build, diagnostics-scope regression checks
and log-privacy checks passed. A real Chromium check against the built UI
confirmed explicit missing-identity text, absence of indefinite Awaiting,
and availability status in Copy logs. The local UI check used an unavailable
worker to exercise missing identity; live Example Domain supplied the valid
scoped-snapshot case.
