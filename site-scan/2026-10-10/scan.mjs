import { chromium } from '/home/sprite/pw/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const BASE = 'https://lobsterbrowse-server.onrender.com';
const SITES = JSON.parse(fs.readFileSync('/home/sprite/scan-sites.json', 'utf8'));
// __resume: skip labels already recorded (progress.log is append-only
// across restarts; scan.jsonl can be truncated at a restart)
const __done = new Set();
try {
  for (const line of fs.readFileSync('/home/sprite/scan/progress.log', 'utf8').split('\n')) {
    const m = line.match(/\] ([^ ]+) ok=/);
    if (m) __done.add(m[1]);
  }
  for (const line of fs.readFileSync('/home/sprite/scan/scan.jsonl', 'utf8').split('\n')) {
    if (line.trim()) { try { __done.add(JSON.parse(line).label); } catch (e) {} }
  }
} catch (e) {}

const DIR = '/home/sprite/scan';
fs.mkdirSync(DIR, { recursive: true });
const JSONL = DIR + '/scan.jsonl';
fs.appendFileSync(JSONL, '# restart ' + new Date().toISOString() + '\n');
const PROGRESS = DIR + '/progress.log';
fs.appendFileSync(PROGRESS, 'scan start ' + new Date().toISOString() + ' sites=' + SITES.length + '\n');
const log = (m) => fs.appendFileSync(PROGRESS, new Date().toISOString() + ' ' + m + '\n');
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const race = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms))]);
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));

let browser = await chromium.launch({ headless: true });
let idx = 0;
const results = [];

async function freshCtx() {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
  const host = await ctx.newPage();
  await race(host.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 40000 }), 50000).catch(() => {});
  await host.waitForTimeout(2500);
  return { ctx, host };
}

while (idx < SITES.length) {
  if (__done.has(SITES[idx].label)) { idx++; continue; }
  const site = SITES[idx];
  const t0 = Date.now();
  let res = { label: site.label, url: site.url, kind: site.kind, ok: false };
  let ctx = null;
  try {
    if (!browser.isConnected()) { browser = await chromium.launch({ headless: true }); }
    const fc = await freshCtx();
    ctx = fc.ctx;
    const page = await ctx.newPage();
    const errs = [], cons = [], failed = [], bad = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') cons.push(m.type() + ': ' + m.text().slice(0, 220)); });
    page.on('requestfailed', (r) => failed.push(r.url().slice(0, 140) + ' :: ' + (r.failure()?.errorText ?? '?')));
    page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().slice(0, 140)); });
    await race(page.goto(BASE + '/zl/' + b64u(site.url), { waitUntil: 'domcontentloaded', timeout: 45000 }), 55000).catch((e) => { res.gotoErr = String(e).slice(0, 80); });
    await page.waitForTimeout(site.kind === 'captcha' ? 6000 : 7000);
    res.title = await race(page.title(), 20000).catch(() => '');
    res.finalUrl = page.url().slice(0, 170);
    res.frames = page.frames().map((f) => f.url().slice(0, 130)).slice(0, 12);
    res.pageerrors = errs.slice(0, 6);
    res.consoleBad = cons.filter((c) => !/favicon|ERR_NAME_NOT_RES|net::ERR/i.test(c)).slice(0, 8);
    res.failedCount = failed.length;
    res.failed = failed.slice(0, 6);
    res.badCount = bad.length;
    res.bad = bad.slice(0, 6);
    // captcha detection
    const allFrameUrls = page.frames().map((f) => f.url()).join('|');
    const html = await race(page.content(), 20000).catch(() => '');
    res.captcha = {
      recaptcha: /recaptcha/.test(allFrameUrls) || /g-recaptcha|recaptcha\/api/i.test(html),
      hcaptcha: /hcaptcha/.test(allFrameUrls) || /h-captcha|hcaptcha/i.test(html),
      turnstile: /turnstile|challenges\.cloudflare/.test(allFrameUrls) || /cf-turnstile/i.test(html),
    };
    res.interact = await race(page.evaluate(() => ({
      els: document.querySelectorAll('button,a,input,[role=button]').length,
      hasBodyText: (document.body?.innerText || '').trim().length > 40,
      docTitle: document.title,
    })), 20000).catch(() => ({ els: -1 }));
    res.ok = !!res.title && res.interact.els > 0 && res.interact.hasBodyText;
    // captcha press: click the checkbox in the anchor/checkbox frame
    if (site.kind === 'captcha') {
      const anchor = page.frames().find((f) => /anchor/.test(f.url()) && /recaptcha/.test(f.url()))
        || page.frames().find((f) => /recaptcha/.test(f.url()) && /checkbox|anchor/.test(f.url()));
      if (anchor) {
        try {
          const box = await anchor.locator('#recaptcha-anchor-checkbox, .recaptcha-checkbox-checkmark, [role=checkbox]').first().boundingBox({ timeout: 5000 }).catch(() => null);
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(7000);
          } else { res.captchaPress = 'anchor found, no checkbox'; }
        } catch (e) { res.captchaPress = 'click err ' + String(e).slice(0, 60); }
        const chal = page.frames().find((f) => /bframe|challenge/.test(f.url()) && !/anchor/.test(f.url()));
        res.captchaChallengeFrame = chal ? chal.url().slice(0, 140) : null;
        if (chal) {
          const inner = await race(chal.evaluate(() => ({
            els: document.querySelectorAll('*').length,
            text: (document.body?.innerText || '').slice(0, 150),
            imgs: document.querySelectorAll('img,canvas').length,
          })), 20000).catch((e) => ({ err: String(e).slice(0, 80) }));
          res.captchaChallengeInner = inner;
        }
        res.captchaErrorsAfter = cons.filter((c) => /recaptcha|target origin|postMessage|timeout/i.test(c)).slice(0, 6);
        res.captchaErrorCount = errs.length;
      } else {
        res.captchaPress = 'no anchor frame';
      }
    }
  } catch (e) {
    res.fatal = String(e).slice(0, 120);
  } finally {
    if (ctx) await race(ctx.close(), 15000).catch(() => {});
  }
  res.ms = Date.now() - t0;
  fs.appendFileSync(JSONL, JSON.stringify(res) + '\n');
  results.push(res);
  log('[' + (idx + 1) + '/' + SITES.length + '] ' + site.label + ' ok=' + res.ok + ' bad=' + (res.badCount ?? '?') + ' failed=' + (res.failedCount ?? '?') + ' captcha=' + JSON.stringify(res.captcha ?? {}));
  idx++;
  await sleep(rand(2500, 6000));
}

// report
const md = ['# Overnight engine scan ' + new Date().toISOString(), '', 'Total: ' + results.length + ' sites', ''];
const okc = results.filter((r) => r.ok).length;
md.push('OK: ' + okc + ' / ' + results.length + '');
md.push('');
md.push('## Not OK');
for (const r of results.filter((x) => !x.ok)) {
  md.push('- ' + r.label + ' (' + r.url + '): title=' + JSON.stringify(r.title || '') + ' gotoErr=' + JSON.stringify(r.gotoErr || '') + ' fatal=' + JSON.stringify(r.fatal || '') + ' interact=' + JSON.stringify(r.interact || {}) + ' bad=' + (r.bad ?? []).slice(0, 2).join(' ; '));
}
md.push('');
md.push('## Sites with >=400 responses');
for (const r of results.filter((x) => (x.badCount || 0) > 3)) md.push('- ' + r.label + ': ' + (r.bad || []).slice(0, 3).join(' ; '));
md.push('');
md.push('## Console/page errors (non-trivial)');
for (const r of results.filter((x) => (x.pageerrors || []).length > 0 || (x.consoleBad || []).length > 2)) {
  md.push('- ' + r.label + ': pageerrors=' + JSON.stringify((r.pageerrors || []).slice(0, 2)) + ' console=' + JSON.stringify((r.consoleBad || []).slice(0, 2)));
}
md.push('');
md.push('## Captcha results');
for (const r of results.filter((x) => x.kind === 'captcha')) {
  md.push('- ' + r.label + ': detected=' + JSON.stringify(r.captcha) + ' press=' + JSON.stringify(r.captchaPress || 'clicked') + ' challengeFrame=' + JSON.stringify(r.captchaChallengeFrame || null) + ' challengeInner=' + JSON.stringify(r.captchaChallengeInner || null) + ' errorsAfter=' + JSON.stringify(r.captchaErrorsAfter || []));
}
fs.writeFileSync(DIR + '/REPORT.md', md.join('\n'));
log('SCAN_DONE ok=' + okc + '/' + results.length);
