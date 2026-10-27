import assert from "node:assert/strict";
import { diagnosticsScope, snapshotForScope, diagnosticsSnapshot, pollDocumentDiagnostics } from "../../ui/src/browser/diagnosticsScope.ts";

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
let statuses = [];
let scheduled = [];
const schedule = (fn) => { const timer = { fn }; scheduled.push(timer); return timer; };
const cancel = (timer) => { scheduled = scheduled.filter((item) => item !== timer); };
const stopAbsent = pollDocumentDiagnostics(null, async () => { throw new Error("must not query app"); }, async () => { throw new Error("must not query content"); }, (value, status) => { received.push(value); statuses.push(status); }, schedule, cancel);
await flush();
assert.deepEqual(received, [null]);
assert.deepEqual(statuses, ["identity"], "absent identity reports identity, not an eternal wait");
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
statuses = [];
const stop = pollDocumentDiagnostics(scope, async () => { throw new Error("wrong worker"); }, content, (value, status) => { received.push(value); statuses.push(status); }, schedule, cancel);
assert.deepEqual(calls, [{ type: "zl:getNetLog", clientId: "page-a", since: 0 }]);
assert.equal(scheduled.length, 0, "no overlapping tick while net query is pending");
releaseNet(net());
await flush();
assert.deepEqual(calls[1], { type: "zl:getDiag", clientId: "page-a", since: 0 });
assert.equal(scheduled.length, 0, "no overlapping tick while diag query is pending");
releaseDiag(diag());
await flush();
assert.equal(received[1].events[0].message, "page-a request failed");
assert.equal(statuses[1], "ok", "a collected pair reports ok");
assert.equal(scheduled.length, 1, "next tick schedules only after full pair settles");
scheduled.shift().fn();
releaseNet(net(11));
await flush();
releaseDiag(diag(12));
await flush();
assert.equal(received.at(-1), null, "generation mismatch clears previous document snapshot");
assert.equal(statuses.at(-1), "restart", "generation mismatch reports restart");
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
const stopPending = pollDocumentDiagnostics(scope, async () => { throw new Error("wrong worker"); }, content, (value, status) => { received.push(value); statuses.push(status); }, schedule, cancel);
stopPending();
releaseNet(net());
await flush();
assert.equal(calls.length, 1, "stopped generation does not issue the second query");
assert.deepEqual(received, [null], "navigation cleanup ignores late worker replies");

/* #220: collapsed replies are classified, never an eternal wait. A
   valid empty scoped log is an empty snapshot with status ok, not a
   loading state. */
const collect = (app, contentWorker) => {
  received = []; statuses = [];
  return pollDocumentDiagnostics(scope, app, contentWorker, (value, status) => { received.push(value); statuses.push(status); }, schedule, cancel);
};
const gone = async () => { throw new Error("worker gone"); };
const stopGone = collect(gone, gone);
await flush();
assert.deepEqual(statuses, ["starting", "unavailable"], "thrown query reports unavailable");
stopGone();

const silent = async () => null;
const stopSilent = collect(silent, silent);
await flush();
assert.deepEqual(statuses, ["starting", "unavailable"], "missing reply reports unavailable");
stopSilent();

const refused = async () => ({ ok: false });
const stopRefused = collect(refused, refused);
await flush();
assert.equal(statuses.at(-1), "rejected", "explicit refusal reports rejected");
assert.equal(received.at(-1), null, "refusal clears the snapshot");
stopRefused();

const older = async (m) => (m.type === "zl:getNetLog" ? net() : { clientId: "page-a", generation: 10, events: [] });
const stopOlder = collect(older, older);
await flush();
assert.equal(statuses.at(-1), "unsupported", "old worker without ok:true reports unsupported");
stopOlder();

const otherDoc = async (m) => (m.type === "zl:getNetLog" ? net(10, "page-b") : diag(10, "page-b", []));
const stopOther = collect(otherDoc, otherDoc);
await flush();
assert.equal(statuses.at(-1), "mismatch", "different document answers report mismatch");
stopOther();

const emptyScoped = async (m) => (m.type === "zl:getNetLog" ? net() : { ok: true, clientId: "page-a", generation: 10, events: [] });
const stopEmpty = collect(emptyScoped, emptyScoped);
await flush();
assert.equal(statuses.at(-1), "ok", "valid empty scoped log reports ok");
const empty = received.at(-1);
assert(empty && empty.events.length === 0, "a valid empty scoped log is an empty snapshot, not a collection failure");
stopEmpty();

const appCalls = [];
const appStop = pollDocumentDiagnostics(diagnosticsScope("page-a", "app"), async (message) => {
  appCalls.push(message);
  return message.type === "zl:getNetLog" ? net() : diag();
}, async () => { throw new Error("wrong worker"); }, () => {}, schedule, cancel);
await flush();
assert.equal(appCalls.length, 2);
appStop();
console.log("Diagnostics scope: worker selection, identity, restart, bounded snapshots, redaction, sequential cleanup and #220 collection statuses passed");
