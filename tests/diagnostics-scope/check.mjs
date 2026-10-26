import assert from "node:assert/strict";
import { diagnosticsScope, snapshotForScope, diagnosticsSnapshot, pollDocumentDiagnostics, diagnosticsStatusForScope, diagnosticsStatusText } from "../../ui/src/browser/diagnosticsScope.ts";

const scope = diagnosticsScope("page-a", "content");
const event = (seq, message = "page-a request failed") => ({ seq, ts: seq, category: "TRANSPORT", severity: "error", message });
const net = (generation = 10, clientId = "page-a") => ({ clientId, generation, stats: { native: 3, fallback: 2, fallbacks: [] } });
const diag = (generation = 10, clientId = "page-a", events = [event(1)]) => ({ ok: true, clientId, generation, events });
const snapshot = diagnosticsSnapshot(scope, net(), diag());
assert(snapshot);
assert.equal(snapshot.stats.native + snapshot.stats.fallback, 5);
assert.equal(snapshotForScope(snapshot, scope), snapshot);
assert.equal(snapshotForScope(snapshot, diagnosticsScope("page-b", "content")), null);
assert.equal(snapshotForScope(snapshot, diagnosticsScope("page-a", "app")), null);
assert.equal(snapshotForScope(snapshot, null), null);
assert.equal(diagnosticsScope("", "content"), null);
assert.equal(diagnosticsScope("page-a", undefined), null);
assert.equal(diagnosticsSnapshot(scope, net(10), diag(11)), null, "restart between replies invalidates pair");
assert.equal(diagnosticsSnapshot(scope, net(10, "page-b"), diag()), null);
assert.equal(diagnosticsSnapshot(scope, net(), diag(10, "page-b")), null);
assert.equal(diagnosticsSnapshot(scope, { ...net(), clientId: undefined }, diag()), null, "old global-only worker fails closed");
assert.equal(diagnosticsSnapshot(scope, net(), { ...diag(), generation: undefined }), null);
assert.equal(diagnosticsSnapshot(scope, { ...net(), stats: { native: NaN, fallback: 2, fallbacks: [] } }, diag()), null);
const bounded = diagnosticsSnapshot(scope, net(), diag(10, "page-a", Array.from({ length: 300 }, (_, i) => ({ ...event(i), headers: { authorization: "secret" } }))));
assert.equal(bounded.events.length, 200);
assert.equal(bounded.events[0].seq, 100);
assert(!("headers" in bounded.events[0]), "unknown fields must not ride exports");
const secret = "never-export-this";
const redacted = diagnosticsSnapshot(scope, {
  ...net(), stats: { ...net().stats, fallbacks: [{ ts: 1, url: "https://example.com/?token=" + secret, reason: "Cookie: " + secret }] },
}, diag(10, "page-a", [{ ...event(1, "Bearer " + secret), url: "https://example.com/?token=" + secret, technicalReason: "password=" + secret }]));
assert(!JSON.stringify(redacted).includes(secret), "panel/copy/export snapshot is sanitized before storage");

const flush = () => new Promise((resolve) => setImmediate(resolve));
let calls = [];
let received = [];
let scheduled = [];
const schedule = (fn) => { const timer = { fn }; scheduled.push(timer); return timer; };
const cancel = (timer) => { scheduled = scheduled.filter((item) => item !== timer); };
const stopAbsent = pollDocumentDiagnostics(null, async () => { throw new Error("must not query app"); }, async () => { throw new Error("must not query content"); }, (value) => received.push(value), schedule, cancel);
await flush();
assert.deepEqual(received, [null]);
assert.equal(scheduled.length, 0);
stopAbsent();

let releaseNet;
let releaseDiag;
const content = (message) => {
  calls.push(message);
  return new Promise((resolve) => {
    if (message.type === "zl:getNetLog") releaseNet = resolve;
    else releaseDiag = resolve;
  });
};
received = [];
const stop = pollDocumentDiagnostics(scope, async () => { throw new Error("wrong worker"); }, content, (value) => received.push(value), schedule, cancel);
assert.deepEqual(calls, [{ type: "zl:getNetLog", clientId: "page-a", since: 0 }]);
assert.equal(scheduled.length, 0, "no overlapping tick while net query is pending");
releaseNet(net());
await flush();
assert.deepEqual(calls[1], { type: "zl:getDiag", clientId: "page-a", since: 0 });
assert.equal(scheduled.length, 0, "no overlapping tick while diag query is pending");
releaseDiag(diag());
await flush();
assert.equal(received[1].events[0].message, "page-a request failed");
assert.equal(scheduled.length, 1, "next tick schedules only after full pair settles");
scheduled.shift().fn();
releaseNet(net(11));
await flush();
releaseDiag(diag(12));
await flush();
assert.equal(received.at(-1), null, "generation mismatch clears previous document snapshot");
scheduled.shift().fn();
releaseNet(net(12));
await flush();
releaseDiag(diag(12, "page-a", [event(1, "fresh worker")]));
await flush();
assert.equal(received.at(-1).events.length, 1);
assert.equal(received.at(-1).events[0].message, "fresh worker", "restarted low sequences replace old snapshots");
stop();
assert.equal(scheduled.length, 0, "cleanup cancels pending poll timer");

calls = [];
received = [];
const stopPending = pollDocumentDiagnostics(scope, async () => { throw new Error("wrong worker"); }, content, (value) => received.push(value), schedule, cancel);
stopPending();
releaseNet(net());
await flush();
assert.equal(calls.length, 1, "stopped generation does not issue the second query");
assert.deepEqual(received, [null], "navigation cleanup ignores late worker replies");

const appCalls = [];
const appStop = pollDocumentDiagnostics(diagnosticsScope("page-a", "app"), async (message) => {
  appCalls.push(message);
  return message.type === "zl:getNetLog" ? net() : diag();
}, async () => { throw new Error("wrong worker"); }, () => {}, schedule, cancel);
await flush();
assert.equal(appCalls.length, 2);
appStop();
console.log("Diagnostics scope: worker selection, identity, restart, bounded snapshots, redaction and sequential cleanup passed");

// #220: failed/old replies have an explicit terminal status, not endless Awaiting.
for (const [netReply, diagReply, expected] of [
  [null, null, "query-unavailable"],
  [{ok:false}, {ok:false}, "query-unavailable"],
  [{...net(), clientId:undefined}, diag(), "incompatible-worker"],
  [net(1), diag(2), "worker-restarted"],
  [net(1,"page-b"), diag(2,"page-b"), "incompatible-worker"],
  [net(), diag(10,"page-a",[]), "ready"],
]) {
  const statuses = [];
  const stop = pollDocumentDiagnostics(scope, async()=>{throw Error("wrong worker");},
    async m=>m.type === "zl:getNetLog" ? netReply : diagReply, ()=>{}, schedule, cancel, status=>statuses.push(status));
  await flush();
  assert.deepEqual(statuses, ["loading", expected]);
  stop();
}
const absentStatuses = [];
const stopNoIdentity = pollDocumentDiagnostics(null, async()=>{throw Error("must not query");}, async()=>{throw Error("must not query");}, ()=>{}, schedule, cancel, s=>absentStatuses.push(s));
assert.deepEqual(absentStatuses,["identity-missing"]);
stopNoIdentity();
assert.equal(diagnosticsStatusForScope({scope,status:"query-unavailable"},diagnosticsScope("page-b","content")),"loading");
assert.equal(diagnosticsStatusForScope({scope,status:"query-unavailable"},diagnosticsScope("page-a","app")),"loading");
assert.equal(diagnosticsStatusForScope({scope,status:"ready"},null),"identity-missing");
const failedStatuses=[];
const stopFailure=pollDocumentDiagnostics(scope,async()=>null,async()=>{throw Error("SECRET-canary");},()=>{},schedule,cancel,s=>failedStatuses.push(s));
await flush();
assert.equal(failedStatuses.at(-1),"query-unavailable");
assert(!diagnosticsStatusText(failedStatuses.at(-1)).includes("SECRET-canary"));
stopFailure();
console.log("Diagnostics availability statuses, stale-scope isolation and failed-query redaction passed");
