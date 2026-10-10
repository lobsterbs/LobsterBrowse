# Full-site engine scan, 2026-10-10

287 sites through the Zeolite engine on the main Render service
(lobsterbrowse-server.onrender.com, pins 27-29 during the window),
headless Chromium, load + 7s settle, console/pageerror/request-fail
capture. Captcha sites additionally attempt a checkbox click and
record the challenge frame. Detection only, no solving, no bypass.

- REPORT-FULL.md: totals + not-ok list + captcha detections
- progress.log: append-only per-site summary lines (ok/bad/failed)
- scan.jsonl: per-site detail for the final-restart subset (~35
  sites; earlier detail was lost to a restart truncate, summary
  lines for all 287 survive in progress.log)
- scan.mjs: the driver (resume by progress.log label, watchdog
  races on the calls that can wedge)

Rescan caveat: the generic clicker matches /anchor/ + /recaptcha/
in the frame URL; engine routes are opaque so reCAPTCHA anchors were
not clicked by the scan itself - dedicated CDP probes cover that
path (see Zeolite issues #128-#132).
