/* Execute the actual content-origin boot page. #196: current registration
   wins over an orphaned controller, including every control-plane handoff. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(new URL("../../server/bin/server/src/main.rs", import.meta.url), "utf8");
const page = source.split('const ZL_BOOT_PAGE: &str = r#"')[1].split('"#;')[0];
const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const events = { worker: new Map(), window: [] };
class Port {
  closed = false; onmessage = null;
  postMessage(data) {
    if (this.closed) throw new Error("closed port");
    queueMicrotask(() => { if (!this.peer.closed) this.peer.onmessage?.({ data }); });
  }
  close() { this.closed = true; }
}
class Channel {
  constructor() {
    this.port1 = new Port(); this.port2 = new Port();
    this.port1.peer = this.port2; this.port2.peer = this.port1;
  }
}
const worker = (id) => ({ state: "activated", id, sent: [], postMessage(data, ports = []) {
  this.sent.push({ data, ports });
  if (data.type === "zl:config") ports[0]?.postMessage({ ok: true, prefix: data.prefix, queryRoutes: data.queryRoutes });
  if (data.type === "zl:getNetLog") ports[0]?.postMessage({ ok: true, worker: id });
} });
const old = worker("orphaned"), fresh = worker("live");
let current = { active: old };
const messages = [], relayRequests = [];
const timer = (fn, ms) => { const id = setTimeout(fn, ms); id.unref(); return id; };
const serviceWorker = { controller: old, ready: Promise.resolve(current),
  register: async () => current, getRegistration: async () => current,
  addEventListener: (name, fn) => events.worker.set(name, fn),
};
const context = vm.createContext({ navigator: { serviceWorker },
  parent: { postMessage: (m) => messages.push(m) },
  window: { addEventListener: (_, fn) => events.window.push(fn), setTimeout: timer },
  MessageChannel: Channel, Map, AbortController, ArrayBuffer, Uint8Array, Blob,
  TextEncoder, DataView, JSON, Date, Object, Promise, Error, String, Number, setTimeout: timer,
  fetch: async (url, init) => {
    if (url === "/build") return { json: async () => ({ sjWisp: "wss://relay.example/wisp/" }) };
    relayRequests.push(init);
    return new Response("uploaded", { headers: { "x-zl-relay-status": "200", "x-zl-relay-headers": "[]", "x-zl-relay-set-cookie": "[]" } });
  }, btoa: (s) => Buffer.from(s, "binary").toString("base64"),
});
await vm.runInContext(script, context);
assert(messages.some((m) => m.zlReg && m.ok));
assert.equal(old.sent.filter((m) => m.data.type === "zl:relayRegister").length, 1);
const oldPort = old.sent.find((m) => m.data.type === "zl:relayRegister").ports[0].peer;
const dispatch = (data, source = { postMessage() {} }) => Promise.all(events.window.map((fn) => fn({ data, source, origin: "https://app.example" })));
await dispatch({ zlRegAsk: true });
await dispatch({ zlCfg: { type: "zl:config", prefix: "/zl/", queryRoutes: true } });
await new Promise(setImmediate);
const before = old.sent.length;
current = { active: fresh }; // controller intentionally remains the orphaned worker.
events.worker.get("message")({ data: { type: "zl:relayLost" }, source: fresh });
events.worker.get("message")({ data: { type: "zl:relayLost" }, source: fresh });
await new Promise(setImmediate);
assert.equal(old.sent.length, before, "orphaned worker gets no healed messages");
assert.equal(fresh.sent.filter((m) => m.data.type === "zl:relayRegister").length, 1, "wake broadcasts coalesce");
assert(oldPort.closed, "obsolete relay port closes");
for (const type of ["zl:config", "zl:wispRegister", "zl:embedderOrigin"]) assert(fresh.sent.some((m) => m.data.type === type), type);
let reply;
await dispatch({ zlQuery: { type: "zl:getNetLog" }, zlId: 7 }, { postMessage: (m) => { reply = m; } });
await new Promise(setImmediate);
assert.equal(reply.zlRes.worker, "live"); assert.equal(reply.zlId, 7);
const third = worker("controller-change"); current = { active: third };
events.worker.get("controllerchange")(); await new Promise(setImmediate);
assert(third.sent.some((m) => m.data.type === "zl:relayRegister"));
console.log("relay-recovery: live-worker replacement, coalescing, port cleanup, config/Wisp/embedder/query handoffs passed");
