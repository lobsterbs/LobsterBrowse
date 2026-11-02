/* KDL serialization for the DevTools Diagnostics Copy logs button
   (user request 2026-10-29): the same content the JSON export carries,
   emitted as a KDL document in the style of the engine's KDL exports.
   Structurally typed against the DevTools console and failure rows so
   this module owns no state and has no import cycle with the page. */
import { sanitizeText, sanitizeUrl } from "./sanitize.ts";
import type { DiagnosticsSnapshot } from "./browser/diagnosticsScope.ts";
import type { DoctorView } from "./browser/exportArtifact.ts";

/* KDL strings escape backslash and double quote; CR, LF, and tab map to
   their KDL escapes; other C0 controls and DEL are dropped. */
export function kdlStr(v: string): string {
  let out = '"';
  for (const ch of v) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else {
      const c = ch.codePointAt(0) ?? 0;
      if (c < 32 || c === 127) continue;
      out += ch;
    }
  }
  return out + '"';
}

type ConsoleLike = { kind: string; text: string; ts: number };
type FailLike = {
  kind?: string;
  url?: string;
  reason: string;
  status?: number;
  nav?: string;
  note?: string;
  ts: number;
};

/* One KDL document per copy: header, collection status, the scoped
   engine snapshot (stats, routing fallbacks, the full retained event
   ring, #228 the retained request ring), the zl:doctor checks when
   the export fetched one, captured console errors and warnings, and
   resource failures. */
export function diagKdl(
  snapshot: DiagnosticsSnapshot | null,
  consoleEntries: ReadonlyArray<ConsoleLike>,
  fails: ReadonlyArray<FailLike>,
  statusLine: string,
  buildChip?: string,
  doctor?: DoctorView | null,
): string {
  const iso = (t: number) => new Date(t).toISOString();
  const errs = consoleEntries.filter((e) => e.kind === "error" || e.kind === "warn");
  const rows: string[] = [];
  rows.push('zeolite-diagnostics "this document" {');
  rows.push("  exported " + kdlStr(new Date().toISOString()));
  /* Build identity (user request 2026-10-29): a capture that cannot
     name its engine build invites stale-worker guesses. The engine
     version line rides the snapshot (zl:getNetLog version); the
     server build chip (buildShort + engine SW sha from /build) is
     passed by the DevTools caller. Both rows are optional so an
     older worker or a failed /build fetch degrades, never blocks. */
  if (snapshot?.engine) rows.push("  engine " + kdlStr(snapshot.engine));
  if (buildChip) rows.push("  build " + kdlStr(buildChip));
  rows.push("  status " + kdlStr(statusLine));
  rows.push("  console-errors-and-warnings " + errs.length);
  rows.push("  resource-failures " + fails.length);
  if (snapshot) {
    rows.push("  source " + kdlStr(snapshot.scope.source));
    rows.push("  generation " + snapshot.generation);
    rows.push("  stats {");
    rows.push("    retained " + (snapshot.stats.native + snapshot.stats.fallback));
    rows.push("    native-transit " + snapshot.stats.native);
    rows.push("    rewrite-routed " + snapshot.stats.fallback);
    for (const f of snapshot.stats.fallbacks) {
      rows.push("    fallback " + kdlStr(f.url) + " reason " + kdlStr(f.reason) + " ts " + kdlStr(iso(f.ts)));
    }
    rows.push("  }");
    rows.push("  events " + snapshot.events.length + " {");
    for (const e of snapshot.events) {
      rows.push(
        "    event " + kdlStr(e.severity) + " " + kdlStr(e.category) + " " + kdlStr(e.message) +
          (e.stage ? " stage " + kdlStr(e.stage) : "") +
          (e.url ? " url " + kdlStr(e.url) : "") +
          (e.technicalReason ? " technical-reason " + kdlStr(e.technicalReason) : "") +
          (e.traceId ? " trace " + kdlStr(e.traceId) : "") +
          " seq " + e.seq + " ts " + kdlStr(iso(e.ts)),
      );
    }
    rows.push("  }");
    /* #228: the retained request ring, so the KDL copy carries the
       same transport rows the JSON artifact does. An older snapshot
       without the ring degrades to an empty section, never a throw. */
    const reqs = Array.isArray(snapshot.requests) ? snapshot.requests : [];
    rows.push("  requests " + reqs.length + " {");
    for (const r of reqs) {
      rows.push(
        "    request " + kdlStr(r.method) + " " + kdlStr(r.dest) + " status " + r.status +
          " ms " + r.ms + " rtype " + kdlStr(r.rtype) +
          (r.transport ? " transport " + kdlStr(r.transport) : "") +
          (r.rewritten ? " rewritten " + kdlStr(r.rewritten) : "") +
          (r.fallbackReason ? " fallback-reason " + kdlStr(r.fallbackReason) : "") +
          (r.err ? " err " + kdlStr(r.err) : "") +
          (r.traceId ? " trace " + kdlStr(r.traceId) : "") +
          " seq " + r.seq + " ts " + kdlStr(iso(r.ts)),
      );
    }
    rows.push("  }");
  }
  /* #228: the session doctor report, when the export fetched one.
   The engine redacts before storage; the view here is sanitized
   field-by-field in exportArtifact.doctorView. */
  if (doctor) {
    rows.push("  doctor {");
    rows.push("    engine " + kdlStr(doctor.engineVersion) + " healthy " + (doctor.healthy === null ? "unknown" : doctor.healthy ? "true" : "false"));
    for (const c of doctor.checks) {
      rows.push(
        "    check " + kdlStr(c.code) + " " + kdlStr(c.status) + " " + kdlStr(c.summary) +
          (c.remedy ? " remedy " + kdlStr(c.remedy) : ""),
      );
    }
    rows.push("  }");
  } else {
    rows.push("  doctor-unavailable \"no doctor report in this capture\"");
  }
  rows.push("  console {");
  for (const e of errs) {
    rows.push("    entry " + kdlStr(e.kind) + " " + kdlStr(sanitizeText(e.text)) + " ts " + kdlStr(iso(e.ts)));
  }
  rows.push("  }");
  rows.push("  failures {");
  for (const f of fails) {
    rows.push(
      "    fail " + kdlStr(f.kind || "unknown") + " " + kdlStr(f.url ? sanitizeUrl(f.url) : "unknown resource") +
        " reason " + kdlStr(sanitizeText(f.reason)) +
        (f.status !== undefined ? " status " + f.status : "") +
        (f.nav ? " nav " + kdlStr(sanitizeText(f.nav)) : "") +
        (f.note ? " note " + kdlStr(sanitizeText(f.note)) : "") +
        " ts " + kdlStr(iso(f.ts)),
    );
  }
  rows.push("  }");
  rows.push("}");
  return rows.join("\n");
}
