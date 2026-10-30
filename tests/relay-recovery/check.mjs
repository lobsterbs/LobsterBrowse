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
/* #511 regression stub: browsers throw SyntaxError for relative WebSocket
   URLs. The vm harness previously had no WebSocket at all, so the boot
   page's constructor call shipped unexercised; this stub enforces the
   browser rule and records every socket the page opens. */
const wsSockets = [];
class StubWebSocket {
  constructor(url) {
    if (!/^(wss|ws):\/\//.test(url)) throw new SyntaxError("relative WebSocket URL");
    this.url = url; this.readyState = 0; this.sent = [];
    wsSockets.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}
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
  WebSocket: StubWebSocket,
  location: { protocol: "https:", host: "content.example" },
});
await vm.runInContext(script, context);
assert(messages.some((m) => m.zlReg && m.ok));
assert.equal(old.sent.filter((m) => m.data.type === "zl:relayRegister").length, 1);
const oldPort = old.sent.find((m) => m.data.type === "zl:relayRegister").ports[0].peer;
const dispatch = (data, source = context.parent) => Promise.all(events.window.map((fn) => fn({ data, source, origin: "https://app.example" })));
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
await dispatch({ zlQuery: { type: "zl:getNetLog" }, zlId: 7 });
await new Promise(setImmediate);
const reply = messages.find(m => m.zlId === 7);
assert.equal(reply.zlRes.worker, "live"); assert.equal(reply.zlId, 7);
let untrustedReply = false;
await dispatch({ zlQuery: { type: "zl:getNetLog" }, zlId: 8 }, { postMessage: () => { untrustedReply = true; } });
await new Promise(setImmediate);
assert.equal(untrustedReply, false, "non-parent query must be ignored");
const third = worker("controller-change"); current = { active: third };
events.worker.get("controllerchange")(); await new Promise(setImmediate);
assert(third.sent.some((m) => m.data.type === "zl:relayRegister"));
console.log("relay-recovery: live-worker replacement, coalescing, port cleanup, config/Wisp/embedder/query handoffs passed");

/* #511: the zl:wsRelay arm must open the /zlws bridge with an ABSOLUTE
   wss:// URL derived from location. Browsers throw SyntaxError for relative
   WebSocket URLs; the boot page used to construct "/zlws", which wedged every
   page socket in readyState 0 with zero console errors. Drive the live arm
   through the current worker's relay port: bridge construction, connect
   envelope, text and binary data, close envelope echo, and reply parity. */
const liveReg = third.sent.find((m) => m.data.type === "zl:relayRegister");
const enginePort = liveReg.ports[0];
const wsReplies = [];
enginePort.onmessage = (ev) => wsReplies.push(ev.data);
enginePort.postMessage({ type: "zl:wsRelay", rid: 11, url: "wss://echo.example/raw", protocols: [], headers: [] });
await new Promise(setImmediate);
assert.equal(wsSockets.length, 1, "wsRelay constructs the /zlws bridge socket");
const bridge = wsSockets[0];
assert.equal(bridge.url, "wss://content.example/zlws", "bridge URL must be absolute (content origin)");
bridge.onopen();
assert.equal(bridge.sent.length, 1, "connect envelope sent on open");
const envelope = JSON.parse(bridge.sent[0]);
assert.equal(envelope.op, "connect");
assert.equal(envelope.url, "wss://echo.example/raw");
assert.ok(Array.isArray(envelope.protocols) && Array.isArray(envelope.headers));
bridge.onmessage({ data: JSON.stringify({ op: "open", protocol: "chat" }) });
await new Promise(setImmediate);
assert(wsReplies.some((m) => m.type === "zl:wsOpen" && m.rid === 11 && m.protocol === "chat"), "zl:wsOpen reply reaches the engine port");
bridge.onmessage({ data: JSON.stringify({ op: "data", text: "hi" }) });
await new Promise(setImmediate);
assert(wsReplies.some((m) => m.type === "zl:wsData" && m.rid === 11 && m.data === "hi" && m.bin !== true), "text zl:wsData reply reaches the engine port");
bridge.onmessage({ data: new ArrayBuffer(4) });
await new Promise(setImmediate);
assert(wsReplies.some((m) => m.type === "zl:wsData" && m.rid === 11 && m.bin === true && m.data instanceof Uint8Array), "binary zl:wsData reply reaches the engine port");
enginePort.postMessage({ type: "zl:wsSend", rid: 11, data: "hello" });
enginePort.postMessage({ type: "zl:wsSend", rid: 11, data: new Uint8Array([1, 2]), bin: true });
await new Promise(setImmediate);
assert.equal(bridge.sent.length, 3, "wsSend forwards text and binary frames");
assert.equal(JSON.parse(bridge.sent[1]).op, "data");
assert.equal(JSON.parse(bridge.sent[1]).text, "hello");
assert.ok(bridge.sent[2] instanceof Uint8Array, "binary frame forwarded raw");
enginePort.postMessage({ type: "zl:wsClose", rid: 11, code: 1000, reason: "done" });
await new Promise(setImmediate);
assert.equal(bridge.sent.length, 4, "close envelope sent before bridge close");
assert.deepEqual(JSON.parse(bridge.sent[3]), { op: "close", code: 1000, reason: "done" });
bridge.onmessage({ data: JSON.stringify({ op: "close", code: 1000, reason: "done" }) });
await new Promise(setImmediate);
assert(wsReplies.some((m) => m.type === "zl:wsClose" && m.rid === 11 && m.code === 1000), "echoed close reaches the engine as zl:wsClose");
console.log("relay-recovery: ws relay absolute-URL bridge, connect/data/close envelope parity passed");
