/* Regression check: content-worker control pushes survive the boot race.

   #286 recurrence class, convicted live on the beta pair (2026-11-27):
   the App.tsx parity effects (zl:config, zl:adblock, zl:rules,
   zl:sameSite, zl:fingerprint) fire at mount, BEFORE the /build boot
   fetch resolves and announces the content origin. zlContentQuery /
   zlContentConfig read the still-empty contentOrigin, silently
   return null/false, and nothing retries the push: on a fresh
   session the content worker never receives the fingerprint
   profile, so content-served proxied pages keep the NATIVE JS
   client-hints surface (the run-9 wire-vs-JS contradiction) and the
   #540 engine fix never reaches the sign-in page.

   This check drives the REAL ui/src/zeolite.ts module (stripped
   types) with a stubbed DOM: a mount-time query and config push are
   issued before any announce, the boot page then acks, and both
   pushes must still DELIVER. Pre-fix, both calls resolve at once
   (null / false) and the assertions fail.

   Run from the repo root (as CI does, from the ui directory):

     node --experimental-strip-types ../tests/content-push-boot/check.mjs */

import assert from "node:assert/strict";

const co = "https://content.example";

/* The window/document/navigator surface zeolite.ts touches when the
   content relay runs. Timers are unref'd so stray bounds never keep
   the process alive. */
const windowListeners = new Map();
let iframe = null;
globalThis.window = {
  addEventListener: (name, fn) => {
    if (!windowListeners.has(name)) windowListeners.set(name, []);
    windowListeners.get(name).push(fn);
  },
  removeEventListener: (name, fn) => {
    const a = windowListeners.get(name) ?? [];
    const i = a.indexOf(fn);
    if (i !== -1) a.splice(i, 1);
  },
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t && typeof t.unref === "function") t.unref();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t),
};
globalThis.document = {
  createElement: () => {
    iframe = { style: {}, setAttribute() {}, contentWindow: null, src: "" };
    return iframe;
  },
  body: { appendChild() {} },
  querySelector: () => null,
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    serviceWorker: {
      controller: null,
      ready: Promise.resolve({}),
      addEventListener() {},
      register: async () => ({}),
      getRegistration: async () => null,
    },
  },
});

const dispatch = (data, source) => {
  const ev = { origin: co, data, source };
  for (const fn of [...(windowListeners.get("message") ?? [])]) fn(ev);
};

const zl = await import("../../ui/src/zeolite.ts");

/* Mount-time pushes, issued BEFORE the /build announce: they must
   stay pending until the boot completes, not silently resolve. */
let earlyResult;
const early = zl.zlContentQuery({ type: "zl:fingerprint", profile: { userAgent: "Mozilla/5.0" } }, 8000);
early.then((r) => { earlyResult = { value: r }; }, (e) => { earlyResult = { error: e }; });
let earlyCfgResult;
const earlyCfg = zl.zlContentConfig({ type: "zl:config", prefix: "/zl/" });
earlyCfg.then((r) => { earlyCfgResult = { value: r }; }, (e) => { earlyCfgResult = { error: e }; });

await new Promise(setImmediate);
assert.equal(earlyResult, undefined, "mount-time zlContentQuery must wait for the content-origin announce (pre-fix it silently resolved null and the push was lost)");
assert.equal(earlyCfgResult, undefined, "mount-time zlContentConfig must wait for the content-origin announce (pre-fix it silently resolved false and the push was lost)");

/* The /build boot: announce the content origin, register the boot
   page, and let it ack. The hidden register iframe's window plays the
   boot page: it records everything the app posts into it. */
zl.zlAnnounceContentOrigin(co);
zl.zlContentRegister(co);
const bootPage = {
  sent: [],
  postMessage(data, targetOrigin) { this.sent.push({ data, targetOrigin }); },
};
iframe.contentWindow = bootPage;
dispatch({ zlReg: true, ok: true }, bootPage);
await new Promise(setImmediate);
assert.ok(
  bootPage.sent.some((m) => m.data.zlRegAsk === true && m.targetOrigin === co),
  "the app introduces itself to the boot page after the ack",
);

/* Both mount-time pushes must now flow through the boot page. */
await new Promise(setImmediate);
const q = bootPage.sent.find((m) => m.data && m.data.zlQuery && m.data.zlQuery.type === "zl:fingerprint");
assert.ok(q, "the mount-time fingerprint push reaches the boot page after the announce");
assert.equal(q.targetOrigin, co, "queries post to the announced content origin only");
assert.equal(typeof q.data.zlId, "number", "queries carry a correlation id");

/* The boot page relays to the worker and returns the reply. */
dispatch({ zlQueryReply: true, zlId: q.data.zlId, zlRes: { ok: true, platform: "Win32" } }, bootPage);
assert.deepEqual(await early, { ok: true, platform: "Win32" }, "the mount-time query resolves with the worker reply, not null");

const cfgMsg = bootPage.sent.find((m) => m.data && m.data.zlCfg);
assert.ok(cfgMsg, "the mount-time zl:config push reaches the boot page after the announce");
assert.equal(cfgMsg.data.zlCfg.type, "zl:config");
assert.equal(cfgMsg.targetOrigin, co);
dispatch({ zlCfgAck: true, ok: true }, bootPage);
assert.equal(await earlyCfg, true, "the mount-time config push resolves acked, not false");

/* A query issued AFTER the boot must behave exactly as before: no
   announce-wait regression for steady-state callers. */
const late = zl.zlContentQuery({ type: "zl:getNetLog" }, 4000);
await new Promise(setImmediate);
const lateQ = bootPage.sent.find((m) => m.data && m.data.zlQuery && m.data.zlQuery.type === "zl:getNetLog");
assert.ok(lateQ, "steady-state queries still deliver");
dispatch({ zlQueryReply: true, zlId: lateQ.data.zlId, zlRes: { ok: true, worker: "live" } }, bootPage);
assert.deepEqual(await late, { ok: true, worker: "live" });

console.log("content-push-boot: mount-time pushes wait for the announce and deliver to the content worker passed");
