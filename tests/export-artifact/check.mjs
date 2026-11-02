/* #228: the Export diagnostics artifact. One artifact must carry both
   halves of the story joined by traceId (the net-log request ring AND
   the diag event ring), the page-side capture (console errors/warns,
   resource failures), the session doctor report, and the identity
   labels (engine version, build chip, net-log generation stamp). The
   doctor degrades to an honest unavailable note; secrets never ride
   the artifact. */
import assert from "node:assert/strict";
import { buildDiagnosticArtifact, doctorView, traceJoin } from "../../ui/src/browser/exportArtifact.ts";
import { diagKdl } from "../../ui/src/kdl.ts";

const secret = "never-export-this";

/* ---- doctorView: shape check, field-by-field sanitization ---- */
const goodDoctor = doctorView({
  ok: true, healthy: false, schemaVersion: 1, engineVersion: "3.0.1 Diamond",
  capturedAt: 1234,
  checks: [
    { code: "worker.running", status: "pass", summary: "Zeolite worker answered" },
    { code: "transport.engine", status: "warn", summary: "Bearer " + secret, remedy: "password=" + secret, junk: true },
    { not: "a check" },
  ],
  /* The engine's own KDL rendering is not carried (free-text blob the
     host would have to trust wholesale); unknown fields drop. */
  kdl: "doctor kdl " + secret,
  extra: "dropped",
});
assert(goodDoctor);
assert.equal(goodDoctor.ok, true);
assert.equal(goodDoctor.healthy, false);
assert.equal(goodDoctor.checks.length, 2, "garbage check rows are dropped");
assert(!("junk" in goodDoctor.checks[1]), "unknown check fields dropped");
assert(!("kdl" in goodDoctor), "the engine KDL blob never rides the artifact");
assert(!JSON.stringify(goodDoctor).includes(secret), "doctor fields are sanitized");
assert.equal(doctorView(null), null);
assert.equal(doctorView("junk"), null);
assert.equal(doctorView({ ok: true }), null, "missing required fields fails closed");
assert.equal(doctorView({ engineVersion: "x", capturedAt: NaN, checks: [] }), null);

/* ---- traceJoin: requests and events joined by traceId ---- */
const joined = traceJoin({
  scope: { clientId: "page-a", source: "content" },
  generation: 7,
  stats: { native: 1, fallback: 1, fallbacks: [] },
  events: [
    { seq: 5, ts: 1, category: "TRANSPORT", severity: "error", message: "upstream failed", traceId: "t-9" },
    { seq: 6, ts: 2, category: "REWRITE", severity: "warning", message: "no trace" },
  ],
  requests: [
    { seq: 1, ts: 1, method: "GET", dest: "https://a.example/x.js", status: 404, ms: 9, bytes: 12, rtype: "SCRIPT", traceId: "t-9" },
    { seq: 2, ts: 2, method: "GET", dest: "https://a.example/y.js", status: 200, ms: 9, bytes: 12, rtype: "SCRIPT" },
    { seq: 3, ts: 3, method: "GET", dest: "https://a.example/z.js", status: 500, ms: 9, bytes: 12, rtype: "SCRIPT", traceId: "t-404-no-events" },
  ],
});
assert.equal(joined.length, 1, "only traces present on BOTH sides join");
assert.deepEqual(joined[0], { traceId: "t-9", requests: [1], events: [5] });
assert.deepEqual(traceJoin(null), []);

/* ---- buildDiagnosticArtifact: full assembly ---- */
const snapshot = {
  scope: { clientId: "page-a", source: "content" },
  generation: 42,
  engine: "3.0.1 Diamond",
  stats: { native: 3, fallback: 2, fallbacks: [{ ts: 1, url: "https://example.com/x.js", reason: "JS_LITERAL_REWRITE_REQUIRED" }] },
  events: [
    { seq: 1, ts: 1, category: "TRANSPORT", severity: "error", message: "upstream failed", traceId: "t-1" },
  ],
  requests: [
    { seq: 1, ts: 1, method: "GET", dest: "https://example.com/a.js", status: 200, ms: 8, bytes: 10, rtype: "SCRIPT", rewritten: "js", traceId: "t-1" },
  ],
};
const art = buildDiagnosticArtifact({
  snapshot,
  consoleEntries: [
    { kind: "error", text: "boom Bearer " + secret, ts: 1 },
    { kind: "log", text: "info rows are not error rows", ts: 2 },
    { kind: "warn", text: "careful", ts: 3 },
  ],
  fails: [
    { kind: "script", url: "https://example.com/f.js?token=" + secret, reason: "HTTP_ERROR", status: 404, nav: "NAV-1", note: "note password=" + secret, ts: 2 },
  ],
  statusLine: "Diagnostics collected.",
  buildChip: "e7a0f16 sw b489e3179d77798a",
  doctor: goodDoctor,
  now: new Date("2026-11-03T12:00:00.000Z"),
});
assert.equal(art.artifact, "lobsterbrowse-diagnostics");
assert.equal(art.version, 1);
assert.equal(art.capturedAt, "2026-11-03T12:00:00.000Z", "the caller-supplied clock labels the capture");
assert.equal(art.engine, "3.0.1 Diamond");
assert.equal(art.build, "e7a0f16 sw b489e3179d77798a");
assert.equal(art.netLogGeneration, 42, "the generation stamp rides the artifact so a restart mid-capture is detectable");
assert.deepEqual(art.scope, { clientId: "page-a", source: "content" });
assert.equal(art.status, "Diagnostics collected.");
assert.equal(art.doctor.report.checks.length, 2);
assert.equal(art.console.length, 2, "only error and warn rows ride the artifact");
assert(!JSON.stringify(art).includes(secret), "labeled credentials (bearer, password, query tokens) never ride the artifact");
assert.equal(art.failures[0].status, 404);
assert.equal(art.netLog.requests.length, 1);
assert.deepEqual(art.traces, [{ traceId: "t-1", requests: [1], events: [1] }], "the joined traces ride the artifact");

/* ---- degraded captures: null snapshot, unavailable doctor ---- */
const bare = buildDiagnosticArtifact({
  snapshot: null,
  consoleEntries: [{ kind: "error", text: "boom", ts: 1 }],
  fails: [{ reason: "FETCH_FAILURE", ts: 2 }],
  statusLine: "Awaiting this document's engine identity.",
  doctorNote: "the engine did not answer the doctor request",
});
assert.equal(bare.engine, null);
assert.equal(bare.build, null);
assert.equal(bare.netLogGeneration, null);
assert.equal(bare.scope, null);
assert.deepEqual(bare.netLog.requests, []);
assert.deepEqual(bare.diag.events, []);
assert.deepEqual(bare.traces, []);
assert.equal(bare.doctor.unavailable, "the engine did not answer the doctor request", "a missing doctor degrades to an honest note");
assert.equal(bare.failures[0].url, null, "a failure without a URL ships null, never undefined");
assert.equal(bare.console.length, 1, "the page capture rides a null snapshot");
const defaulted = buildDiagnosticArtifact({ snapshot: null, consoleEntries: [], fails: [], statusLine: "x" });
assert.equal(defaulted.doctor.unavailable, "doctor report unavailable");

/* ---- KDL carries the same new sections ---- */
const doc = diagKdl(snapshot, [], [], "Diagnostics collected.", "e7a0f16 sw b489e3179d77798a", goodDoctor);
assert(doc.includes("requests 1 {"), "request rows section");
assert(doc.includes('request "GET" "https://example.com/a.js" status 200 ms 8 rtype "SCRIPT"'), "request row content");
assert(doc.includes('rewritten "js"'), "request rewrite kind rides the row");
assert(doc.includes('trace "t-1"'), "request trace id rides the row");
assert(doc.includes("doctor {"), "doctor section");
assert(doc.includes('check "worker.running" "pass" "Zeolite worker answered"'), "doctor check rows");
assert(doc.includes('engine "3.0.1 Diamond" healthy false'), "doctor engine + health row");
assert(!doc.includes(secret), "the KDL copy is sanitized too");
const noDoctorDoc = diagKdl(snapshot, [], [], "Diagnostics collected.");
assert(noDoctorDoc.includes('doctor-unavailable "no doctor report in this capture"'), "an export without a doctor says so honestly");
const noRowsDoc = diagKdl({ ...snapshot, requests: undefined }, [], [], "x");
assert(noRowsDoc.includes("requests 0 {"), "an older snapshot without the ring degrades, never throws");

console.log("Export diagnostics artifact: traceId join, doctor shape check, redaction, degraded captures and KDL sections passed");
