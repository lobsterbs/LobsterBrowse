# LobsterBrowse full-site engine scan

Run window: 2026-10-10 ~09:20Z - 11:19Z (main service, zeolite pin 27-29 during the run)
Base: https://lobsterbrowse-server.onrender.com (Zeolite engine, SW-intercepted)
Method: headless Chromium via /zl/<b64url>, load + 7s settle, console/pageerror/request-fail capture;
captcha sites additionally attempt a checkbox click and record the challenge frame (detection only, no solving).
Summary from progress.log (all sites, append-only); per-site jsonl detail for the final-restart subset.

Total: 287 sites. ok: 233. not-ok: 54.

## Not OK (54)

- nopecha-recaptcha (2026-10-10T11:11:08.544Z) interact={'els': 1, 'hasBodyText': False, 'docTitle': 'NopeCHA - reCAPTCHA Demo'}
- nopecha-hcaptcha (2026-10-10T11:11:28.710Z) interact={'els': 1, 'hasBodyText': False, 'docTitle': 'NopeCHA - hCaptcha Demo'}
- nopecha-turnstile (2026-10-10T11:11:42.585Z) interact={'els': 3, 'hasBodyText': False, 'docTitle': 'NopeCHA - Turnstile Demo'}
- startpage (2026-10-10T11:14:31.189Z) interact={'els': 2, 'hasBodyText': True, 'docTitle': ''}
- x (2026-10-10T09:17:56.861Z)
- instagram (2026-10-10T09:18:12.328Z)
- tiktok (2026-10-10T09:18:27.351Z)
- pinterest (2026-10-10T09:19:19.805Z)
- mastodon-social (2026-10-10T09:22:04.212Z)
- threads (2026-10-10T09:22:40.649Z)
- nytimes (2026-10-10T09:24:10.286Z)
- reuters (2026-10-10T09:25:12.535Z)
- dw (2026-10-10T09:26:44.626Z)
- economist (2026-10-10T09:28:28.452Z)
- wsj (2026-10-10T09:28:55.423Z)
- daily-mail (2026-10-10T09:30:45.809Z)
- mirror (2026-10-10T09:31:02.265Z)
- vg (2026-10-10T09:32:50.352Z)
- hs (2026-10-10T09:33:40.489Z)
- engadget (2026-10-10T09:36:37.991Z)
- imdb (2026-10-10T09:40:54.160Z)
- archive (2026-10-10T09:42:44.388Z)
- etsy (2026-10-10T09:44:32.474Z)
- homedepot (2026-10-10T09:46:33.777Z)
- booking (2026-10-10T09:46:49.024Z)
- wayfair (2026-10-10T09:48:57.008Z)
- adidas (2026-10-10T09:49:59.588Z)
- zara (2026-10-10T09:50:15.653Z)
- hnm (2026-10-10T09:50:31.627Z)
- dockerhub (2026-10-10T10:02:06.754Z)
- oracle (2026-10-10T10:05:04.462Z)
- colab (2026-10-10T10:14:04.684Z)
- regex101 (2026-10-10T10:15:39.590Z)
- figma (2026-10-10T10:17:15.735Z)
- asana (2026-10-10T10:17:51.884Z)
- dropbox (2026-10-10T10:19:01.096Z)
- outlook (2026-10-10T10:20:05.214Z)
- icloud (2026-10-10T10:21:50.744Z)
- paypal (2026-10-10T10:23:33.113Z)
- mastercard (2026-10-10T10:25:40.686Z)
- espn (2026-10-10T10:31:39.592Z)
- fifa (2026-10-10T10:31:59.119Z)
- nba (2026-10-10T10:32:15.282Z)
- gog-com2 (2026-10-10T10:35:06.273Z)
- accuweather (2026-10-10T10:35:37.808Z)
- yr-no (2026-10-10T10:35:52.254Z)
- speedtest (2026-10-10T10:37:25.043Z)
- fast (2026-10-10T10:37:39.597Z)
- tinyurl (2026-10-10T10:38:15.506Z)
- imgur (2026-10-10T10:40:26.514Z)
- oglaf (2026-10-10T11:10:54.878Z)
- finn-no (2026-10-10T11:12:23.850Z) gotoErr='TimeoutError: page.goto: Timeout 45000ms exceeded.\nCall log:\n  - navigating to "' interact={'els': -1}
- blocket (2026-10-10T11:14:54.141Z) gotoErr='TimeoutError: page.goto: Timeout 45000ms exceeded.\nCall log:\n  - navigating to "' interact={'els': -1}
- 4chan (2026-10-10T11:17:57.387Z) interact={'els': 0, 'hasBodyText': True, 'docTitle': 'Just a moment...'}

## Captcha detections

- nopecha-recaptcha: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- nopecha-hcaptcha: {"recaptcha": true, "hcaptcha": true, "turnstile": false}
- nopecha-turnstile: {"recaptcha": false, "hcaptcha": false, "turnstile": true}
- 2captcha-recaptcha: {"recaptcha": false, "hcaptcha": true, "turnstile": false}
- 2captcha-hcaptcha: {"recaptcha": false, "hcaptcha": true, "turnstile": false}
- 2captcha-turnstile: {"recaptcha": true, "hcaptcha": true, "turnstile": true}
- recaptcha-demo: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- quora: {"recaptcha": false, "hcaptcha": false, "turnstile": true}
- npr: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- techcrunch: {"recaptcha": true, "hcaptcha": false, "turnstile": true}
- urbandictionary: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- bitbucket: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- netlify: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- heroku: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- kaggle: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- atlassian: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- asana: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- evernote: {"recaptcha": false, "hcaptcha": true, "turnstile": false}
- coingecko: {"recaptcha": false, "hcaptcha": false, "turnstile": true}
- netflix: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- spotify: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- bandcamp: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- myanimelist: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- mal-org: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- manga: {"recaptcha": true, "hcaptcha": false, "turnstile": false}
- flickr: {"recaptcha": false, "hcaptcha": false, "turnstile": true}
- skatteetaten: {"recaptcha": true, "hcaptcha": false, "turnstile": false}

## Notable per-site page errors (jsonl detail subset)

- nopecha-hcaptcha: ["TypeError: Cannot read properties of undefined (reading 'get')"]
- nopecha-turnstile: ["TypeError: Cannot read properties of undefined (reading 'get')"]
- nopecha-perc: ["TypeError: Cannot read properties of undefined (reading 'get')"]
- bing: ["ReferenceError: _w is not defined", "ReferenceError: sj_be is not defined"]
- dmi: ["ChunkLoadError: Loading chunk 8451 failed.\n(error: https://lobsterbrowse-server.onrender.com/zl/favouriteslist.dfa4ac4c0c5aedd224fe.js)"]
- svt: ["Error: Minified React error #418; visit https://react.dev/errors/418?args[]=text&args[]= for the full message or use the non-minified dev environment for full errors and additional helpful warnings."]
- skatteetaten: ["TypeError: Cannot set properties of undefined (setting 'enableBackground')"]
- helsenorge: ["TypeError: Cannot read properties of null (reading 'useMemoCache')", "TypeError: Cannot read properties of null (reading 'useMemoCache')"]
- resetera: ["TypeError: Cannot read properties of undefined (reading 'getSubscription')", "InvalidAccessError: Failed to set the 'timeout' property on 'XMLHttpRequest': Timeouts cannot be set for synchronous requests made from a document."]
- neogaf: ["TypeError: Cannot read properties of undefined (reading 'getSubscription')", "InvalidAccessError: Failed to set the 'timeout' property on 'XMLHttpRequest': Timeouts cannot be set for synchronous requests made from a document."]

## High bad-response counts (>=10)

- nopecha-perc: bad=12 failed=5
- reddit: bad=19 failed=4
- apnews: bad=33 failed=24
- npr: bad=67 failed=7
- politico: bad=21 failed=15
- nbcnews: bad=41 failed=62
- abcnews: bad=38 failed=12
- foxnews: bad=36 failed=17
- elmundo: bad=17 failed=8
- corriere: bad=53 failed=42
- aftenposten: bad=10 failed=4
- dagens: bad=26 failed=1
- techcrunch: bad=40 failed=18
- superuser: bad=12 failed=3
- geeksforgeeks: bad=18 failed=9
- britannica: bad=13 failed=7
- archive: bad=24 failed=24
- target: bad=17 failed=5
- nike: bad=10 failed=3
- bitbucket: bad=10 failed=51
- netlify: bad=25 failed=3
- ibm: bad=28 failed=15
- microsoft: bad=15 failed=4
- stackblitz: bad=11 failed=5
- atlassian: bad=13 failed=14
- trello: bad=42 failed=139
- dropbox: bad=53 failed=55
- googledrive: bad=10 failed=2
- typeform: bad=17 failed=1
- coinbase: bad=22 failed=13
- coinmarketcap: bad=12 failed=0
- blockchain: bad=43 failed=16
- disney: bad=27 failed=2
- soundcloud: bad=12 failed=0
- gog: bad=13 failed=9
- uefa: bad=50 failed=50
- metacritic: bad=19 failed=7
- tinyurl: bad=39 failed=58
- knowyourmeme: bad=31 failed=14
- explosm: bad=24 failed=7
- dmi: bad=13 failed=12
- yle: bad=10 failed=1
