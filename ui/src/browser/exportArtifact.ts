/* #228: the Export diagnostics artifact assembler.

   One artifact per export: the scoped engine snapshot (stats, the
   sanitized diag event ring AND the sanitized net-log request ring)
   joined by traceId, the page-side capture (console errors/warnings,
   resource failures), and one session zl:doctor report. Pure and
   structurally typed so a node check can exercise the join and the
   redaction guarantees without a browser.

   Redaction contract (AGENTS.md): the engine redacts secrets before
   anything is stored; this module must not add any back. Every field
   passes through the central sanitizers or arrives already sanitized
   in the snapshot; the doctor report is sanitized field-by-field
   here, and a doctor that answers with garbage degrades to an
   honest "unavailable" note instead of shipping unvetted text. */

import { sanitizeText, sanitizeUrl } from "../sanitize.ts";
import type { DiagnosticsSnapshot, ZlNetRow, ZlDiagEvent } from "./diagnosticsScope.ts";

export type DoctorCheckView = {
  code: string;
  status: string;
  summary: string;
  remedy?: string;
};

/* The doctor report the artifact ships: only known fields, all
   strings sanitized. The engine's own KDL rendering is NOT carried:
   a free-text blob would be the one field the host has to trust
   wholesale, and the structured checks + the KDL renderer already
   cover both export surfaces. */
export type DoctorView = {
  ok: boolean;
  healthy: boolean | null;
  schemaVersion: number;
  engineVersion: string;
  capturedAt: number;
  checks: DoctorCheckView[];
};

export function doctorView(raw: unknown): DoctorView | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.engineVersion !== "string" || typeof d.capturedAt !== "number" ||
    !Number.isFinite(d.capturedAt) || !Array.isArray(d.checks)) return null;
  const checks: DoctorCheckView[] = d.checks
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .filter((c) => typeof c.code === "string" && typeof c.status === "string" && typeof c.summary === "string")
    .map((c) => ({
      code: sanitizeText(c.code as string),
      status: sanitizeText(c.status as string),
      summary: sanitizeText(c.summary as string),
      ...(typeof c.remedy === "string" ? { remedy: sanitizeText(c.remedy) } : {}),
    }));
  return {
    ok: d.ok === true,
    healthy: d.healthy === true ? true : d.healthy === false ? false : null,
    schemaVersion: typeof d.schemaVersion === "number" && Number.isFinite(d.schemaVersion) ? d.schemaVersion : 1,
    engineVersion: sanitizeText(d.engineVersion),
    capturedAt: d.capturedAt,
    checks,
  };
}

/* Why the doctor section can be missing: the request failed, the
   worker was wedged, or the reply failed the shape check. */
export type DoctorSection = { report: DoctorView } | { unavailable: string };

export type TraceJoin = {
  traceId: string;
  requests: number[];
  events: number[];
};

export type LbDiagnosticArtifact = {
  artifact: "lobsterbrowse-diagnostics";
  version: 1;
  capturedAt: string;
  engine: string | null;
  build: string | null;
  netLogGeneration: number | null;
  scope: { clientId: string; source: string } | null;
  status: string;
  doctor: DoctorSection;
  stats: DiagnosticsSnapshot["stats"] | null;
  netLog: { requests: ZlNetRow[] };
  diag: { events: ZlDiagEvent[] };
  traces: TraceJoin[];
  console: Array<{ kind: string; text: string; ts: number }>;
  failures: Array<{ kind: string; url: string | null; reason: string; status?: number; nav?: string; note?: string; ts: number }>;
};

export type ArtifactInputs = {
  snapshot: DiagnosticsSnapshot | null;
  consoleEntries: ReadonlyArray<{ kind: string; text: string; ts: number }>;
  fails: ReadonlyArray<{ kind?: string; url?: string; reason: string; status?: number; nav?: string; note?: string; ts: number }>;
  statusLine: string;
  buildChip?: string;
  doctor: DoctorView | null;
  doctorNote?: string;
  now?: Date;
};

/* The traceId join: traces that appear in BOTH the request ring and
   the diag event ring, with their request and event seq numbers so a
   reader can pull both sides without re-deriving the join. */
export function traceJoin(snapshot: DiagnosticsSnapshot | null): TraceJoin[] {
  if (!snapshot) return [];
  const reqs = new Map<string, number[]>();
  for (const r of snapshot.requests) {
    if (typeof r.traceId !== "string" || !r.traceId) continue;
    const arr = reqs.get(r.traceId) ?? [];
    arr.push(r.seq);
    reqs.set(r.traceId, arr);
  }
  const evs = new Map<string, number[]>();
  for (const e of snapshot.events) {
    if (typeof e.traceId !== "string" || !e.traceId) continue;
    const arr = evs.get(e.traceId) ?? [];
    arr.push(e.seq);
    evs.set(e.traceId, arr);
  }
  const out: TraceJoin[] = [];
  for (const [traceId, requests] of reqs) {
    const events = evs.get(traceId);
    if (!events) continue;
    out.push({ traceId, requests, events });
  }
  return out;
}

export function buildDiagnosticArtifact(inputs: ArtifactInputs): LbDiagnosticArtifact {
  const { snapshot } = inputs;
  const consoleRows = inputs.consoleEntries
    .filter((e) => e && typeof e.text === "string" && (e.kind === "error" || e.kind === "warn"))
    .map((e) => ({ kind: sanitizeText(e.kind), text: sanitizeText(e.text), ts: e.ts }));
  const failureRows = inputs.fails.map((f) => ({
    kind: sanitizeText(f.kind || "unknown"),
    url: typeof f.url === "string" ? sanitizeUrl(f.url) : null,
    reason: sanitizeText(f.reason),
    ...(typeof f.status === "number" ? { status: f.status } : {}),
    ...(typeof f.nav === "string" ? { nav: sanitizeText(f.nav) } : {}),
    ...(typeof f.note === "string" ? { note: sanitizeText(f.note) } : {}),
    ts: f.ts,
  }));
  return {
    artifact: "lobsterbrowse-diagnostics",
    version: 1,
    capturedAt: (inputs.now ?? new Date()).toISOString(),
    engine: snapshot?.engine ?? null,
    build: inputs.buildChip ? sanitizeText(inputs.buildChip) : null,
    netLogGeneration: snapshot ? snapshot.generation : null,
    scope: snapshot ? { clientId: snapshot.scope.clientId, source: snapshot.scope.source } : null,
    status: sanitizeText(inputs.statusLine),
    /* The doctor degrades to an honest note - never blocks the
       export, never ships unvetted text. */
    doctor: inputs.doctor
      ? { report: inputs.doctor }
      : { unavailable: sanitizeText(inputs.doctorNote || "doctor report unavailable") },
    stats: snapshot ? snapshot.stats : null,
    netLog: { requests: snapshot ? snapshot.requests : [] },
    diag: { events: snapshot ? snapshot.events : [] },
    traces: traceJoin(snapshot),
    console: consoleRows,
    failures: failureRows,
  };
}
