import assert from "node:assert/strict";
import { diagnosticsScope, snapshotForScope, diagnosticsSnapshot, pollDocumentDiagnostics } from "../../ui/src/browser/diagnosticsScope.ts";

const scope = diagnosticsScope("page-a", "content");
const event = (seq, message = "page-a request failed") => ({ seq, ts: seq, category: "TRANSPORT", severity: "error", message });
const net = (generation = 10, clientId = "page-a") => ({ clientId, generation, stats: { native: 3, fallback: 2, fallbacks: [] } });
const diag = (generation = 10, clientId = "page-a", events = [event(1)]) => ({ ok: true, clientId, generation, events });
const snapshot = diagnosticsSnapshot(scope, net(), diag());
assert(snapshot);
assert(!("engine" in snapshot), "no version in the netlog reply, no engine field");
const versioned = diagnosticsSnapshot(scope, { ...net(), version: "3.0 Diamond" }, diag());
assert.equal(versioned.engine, "3.0 Diamond", "engine version line rides the snapshot for the KDL export");
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

/* #228: the net-log request ring rides the snapshot, sanitized
   field-by-field like the events. */
const entry = (seq, traceId) => ({
  seq, ts: seq, method: "GET", path: "/zl/x", dest: "https://example.com/a.js?token=" + secret,
  status: 200, ms: 12, bytes: 100, rtype: "SCRIPT",
  rewritten: "js", transport: "RewriteFallback", fallbackReason: "JS_LITERAL_REWRITE_REQUIRED",
  err: "password=" + secret, traceId,
  headers: { authorization: "Bearer " + secret },
});
const withRows = diagnosticsSnapshot(scope, {
  ...net(), version: "3.0 Diamond",
  entries: [entry(1, "t-1"), { bogus: true }, entry(2), null],
}, diag());
assert(withRows);
assert.equal(withRows.requests.length, 2, "malformed and null entries are dropped, the ring stays exportable");
const row = withRows.requests[0];
assert.deepEqual(
  Object.keys(row).sort(),
  ["bytes", "dest", "err", "fallbackReason", "method", "ms", "rewritten", "rtype", "seq", "status", "traceId", "transport", "ts"],
  "unknown fields must not ride the request rows",
);
assert(!JSON.stringify(withRows).includes(secret), "request rows are sanitized before storage");
assert.equal(withRows.requests[1].traceId, undefined, "a request without a traceId stays traceless");
assert.equal(withRows.engine, "3.0 Diamond");
/* bounded like the events */
const flood = diagnosticsSnapshot(scope, {
  ...net(), entries: Array.from({ length: 300 }, (_, i) => entry(i)),
}, diag());
assert.equal(flood.requests.length, 200);
assert.equal(flood.requests[0].seq, 100);
/* an absent entries array (older reply shape) degrades to an empty ring */
const noEntries = diagnosticsSnapshot(scope, net(), diag());
assert(noEntries && noEntries.requests.length === 0);

console.log("Diagnostics scope: worker selection, identity, restart, bounded snapshots, redaction, request ring and sequential cleanup passed");
