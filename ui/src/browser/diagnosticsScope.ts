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
export type DiagnosticsStatus = "identity-missing" | "loading" | "query-unavailable" | "incompatible-worker" | "worker-restarted" | "ready";
export type DiagnosticsState = { scope: DiagnosticsScope | null; status: DiagnosticsStatus };
export function diagnosticsStatusForScope(state: DiagnosticsState | null, scope: DiagnosticsScope | null): DiagnosticsStatus {
  if (!scope) return "identity-missing";
  return state?.scope?.clientId === scope.clientId && state.scope.source === scope.source ? state.status : "loading";
}
export function diagnosticsStatusText(status: DiagnosticsStatus): string {
  return {
    "identity-missing": "Diagnostics unavailable: this document has not reported a verified engine identity. Reload the page to retry. No other document's logs are shown.",
    "loading": "Loading diagnostics for this document.",
    "query-unavailable": "Diagnostics unavailable: the worker query failed or timed out. Retrying automatically.",
    "incompatible-worker": "Diagnostics unavailable: the worker reply lacks a valid matching document scope or format. Reload after updating the engine.",
    "worker-restarted": "Diagnostics unavailable: the worker restarted between replies. Retrying automatically.",
    "ready": "Document diagnostics received.",
  }[status];
}

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

/* Each tick starts after the preceding one settles. Cleanup discards
   late replies. Scheduling is injectable for lifecycle tests. */
export function pollDocumentDiagnostics(
  scope: DiagnosticsScope | null,
  appQuery: DiagnosticsQuery,
  contentQuery: DiagnosticsQuery,
  receive: (snapshot: DiagnosticsSnapshot | null) => void,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  cancel: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  report: (status: DiagnosticsStatus) => void = () => {},
): () => void {
  let stopped = false;
  let timer: unknown;
  receive(null);
  report(scope ? "loading" : "identity-missing");
  if (!scope) return () => { stopped = true; };
  const query = scope.source === "content" ? contentQuery : appQuery;
  const tick = async () => {
    let snapshot: DiagnosticsSnapshot | null = null;
    let status: DiagnosticsStatus = "query-unavailable";
    try {
      const net = await query({ type: "zl:getNetLog", clientId: scope.clientId, since: 0 });
      if (stopped) return;
      const diag = await query({ type: "zl:getDiag", clientId: scope.clientId, since: 0 });
      snapshot = diagnosticsSnapshot(scope, net, diag);
      status = snapshot ? "ready" : !net || !diag || net.ok === false || diag.ok === false ? "query-unavailable" :
        net.clientId === scope.clientId && diag.clientId === scope.clientId &&
        typeof net.generation === "number" && Number.isFinite(net.generation) &&
        typeof diag.generation === "number" && Number.isFinite(diag.generation) && net.generation !== diag.generation ?
          "worker-restarted" : "incompatible-worker";
    } catch {
      /* Unavailable workers clear the preceding snapshot. */
    }
    if (stopped) return;
    receive(snapshot);
    report(status);
    timer = schedule(() => { void tick(); }, 5000);
  };
  void tick();
  return () => { stopped = true; if (timer !== undefined) cancel(timer); };
}
