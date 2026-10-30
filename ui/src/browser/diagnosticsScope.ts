/* The document identity is required: never use worker-global
   diagnostics as a fallback for an unknown page. */
import { sanitizeText, sanitizeUrl } from "../sanitize.ts";

export type EngineSource = "app" | "content";
export type DiagnosticsScope = { clientId: string; source: EngineSource };
export type ZlFallback = { ts: number; url: string; reason: string; traceId?: string };
export type ZlStats = { native: number; fallback: number; fallbacks: ZlFallback[] };
export type ZlDiagEvent = {
  seq: number; ts: number; category: string; severity: string; message: string;
  stage?: string; url?: string; technicalReason?: string; traceId?: string;
};
export type DiagnosticsSnapshot = {
  scope: DiagnosticsScope;
  generation: number;
  stats: ZlStats;
  events: ZlDiagEvent[];
};
export type DiagnosticsQuery = (message: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

export function diagnosticsScope(clientId?: string, source?: EngineSource): DiagnosticsScope | null {
  return clientId && (source === "app" || source === "content") ? { clientId, source } : null;
}

export function snapshotForScope(snapshot: DiagnosticsSnapshot | null, scope: DiagnosticsScope | null): DiagnosticsSnapshot | null {
  return snapshot && scope && snapshot.scope.clientId === scope.clientId && snapshot.scope.source === scope.source ? snapshot : null;
}

/* Both replies acknowledge the requested scope. An older worker that
   ignores clientId cannot display its global ring as document data.
   A restart between the two reads invalidates the entire pair. */
export function diagnosticsSnapshot(
  scope: DiagnosticsScope,
  net: Record<string, unknown> | null,
  diag: Record<string, unknown> | null,
): DiagnosticsSnapshot | null {
  if (!net || !diag || net.ok === false || diag.ok !== true ||
    net.clientId !== scope.clientId || diag.clientId !== scope.clientId ||
    typeof net.generation !== "number" || !Number.isFinite(net.generation) ||
    net.generation !== diag.generation || !Array.isArray(diag.events)) return null;
  const stats = net.stats as ZlStats | undefined;
  if (!stats || !Number.isFinite(stats.native) || stats.native < 0 ||
    !Number.isFinite(stats.fallback) || stats.fallback < 0 || !Array.isArray(stats.fallbacks)) return null;
  const events = diag.events.filter((event): event is ZlDiagEvent => {
    if (!event || typeof event !== "object") return false;
    const e = event as ZlDiagEvent;
    return typeof e.seq === "number" && Number.isFinite(e.seq) &&
      typeof e.ts === "number" && Number.isFinite(e.ts) &&
      typeof e.message === "string" && typeof e.category === "string" && typeof e.severity === "string";
  }).slice(-200).map((e) => ({
    seq: e.seq, ts: e.ts, category: sanitizeText(e.category), severity: sanitizeText(e.severity), message: sanitizeText(e.message),
    ...(typeof e.stage === "string" ? { stage: sanitizeText(e.stage) } : {}),
    ...(typeof e.url === "string" ? { url: sanitizeUrl(e.url) } : {}),
    ...(typeof e.technicalReason === "string" ? { technicalReason: sanitizeText(e.technicalReason) } : {}),
    ...(typeof e.traceId === "string" ? { traceId: sanitizeText(e.traceId) } : {}),
  }));
  const fallbacks = stats.fallbacks.filter((fallback) => fallback &&
    typeof fallback.url === "string" && typeof fallback.reason === "string" &&
    typeof fallback.ts === "number" && Number.isFinite(fallback.ts)).slice(-30).map((f) => ({
      ts: f.ts, url: sanitizeUrl(f.url), reason: sanitizeText(f.reason),
      ...(typeof f.traceId === "string" ? { traceId: sanitizeText(f.traceId) } : {}),
    }));
  return { scope, generation: net.generation, stats: { native: stats.native, fallback: stats.fallback, fallbacks }, events };
}

/* #220: every collapsed null is classified so the panel can separate a
   collection failure (worker unavailable, refused, unsupported reply
   shape, restart, document change) from a valid empty scoped log. */
export type DiagnosticsStatus = "ok" | "starting" | "identity" | "unavailable" | "rejected" | "unsupported" | "mismatch" | "restart" | "malformed";

export function classifyDiagnosticsReply(
  scope: DiagnosticsScope | null,
  net: Record<string, unknown> | null,
  diag: Record<string, unknown> | null,
): DiagnosticsStatus {
  if (!scope) return "identity";
  if (!net || !diag) return "unavailable";
  if (net.ok === false || diag.ok === false) return "rejected";
  if (diag.ok !== true || typeof net.generation !== "number" || !Number.isFinite(net.generation)) return "unsupported";
  if (net.clientId !== scope.clientId || diag.clientId !== scope.clientId) return "mismatch";
  if (net.generation !== diag.generation) return "restart";
  return "malformed";
}

/* Each tick starts after the preceding one settles. Cleanup discards
   late replies. Scheduling is injectable for lifecycle tests. */
/* Ad-blocking card: "request blocked by rules (Ghostery: startpage.com)"
   carries the blocked host behind the list name; older rules name only
   the host. The event URL is the fallback when the message has neither. */
export function blockedHostOf(e: ZlDiagEvent): string {
  const m = /\(([^()]+)\)\s*$/.exec(e.message);
  if (m) {
    const inner = m[1];
    const i = inner.indexOf(": ");
    return i >= 0 ? inner.slice(i + 2) : inner;
  }
  if (e.url) {
    try {
      return new URL(e.url).hostname;
    } catch {
      /* not a URL */
    }
  }
  return e.message;
}

export function pollDocumentDiagnostics(
  scope: DiagnosticsScope | null,
  appQuery: DiagnosticsQuery,
  contentQuery: DiagnosticsQuery,
  receive: (snapshot: DiagnosticsSnapshot | null, status?: DiagnosticsStatus) => void,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  cancel: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
): () => void {
  let stopped = false;
  let timer: unknown;
  receive(null, scope ? "starting" : "identity");
  if (!scope) return () => { stopped = true; };
  const query = scope.source === "content" ? contentQuery : appQuery;
  const tick = async () => {
    let snapshot: DiagnosticsSnapshot | null = null;
    let status: DiagnosticsStatus = "unavailable";
    try {
      const net = await query({ type: "zl:getNetLog", clientId: scope.clientId, since: 0 });
      if (stopped) return;
      const diag = await query({ type: "zl:getDiag", clientId: scope.clientId, since: 0 });
      snapshot = diagnosticsSnapshot(scope, net, diag);
      status = snapshot ? "ok" : classifyDiagnosticsReply(scope, net, diag);
    } catch {
      /* Unavailable workers clear the preceding snapshot; #220 reports
         it as an explicit unavailable status, never an eternal wait. */
    }
    if (stopped) return;
    receive(snapshot, status);
    timer = schedule(() => { void tick(); }, 5000);
  };
  void tick();
  return () => { stopped = true; if (timer !== undefined) cancel(timer); };
}
