/* DevTools panel: diagnostics for the currently selected proxy tab.
   Each tab keeps its own state.

   #150: the hand-built Console and Network panels are gone. Eruda
   (injected into the proxied page by the button below) is the page
   console and network view, so LB carries no page-eval path of its
   own anymore. This panel keeps the engine diagnostics: transport
   stats, notable diag events, resource failures, the engine
   download registry, and Copy logs. Page console errors and
   resource failures still arrive over the {lb:...} hook messages
   and feed Copy logs; successful requests are not captured.

   Built from real M3E components: m3e-card as the container,
   m3e-tabs for the section switch, m3e-form-field for the edit fields. */

import { useEffect, useRef, useState } from "react";
import { type Tab } from "../store";
import { zlSend } from "../zeolite";
import { sanitizeText, sanitizeUrl } from "../sanitize";

export type ConsoleEntry = {
  id: number;
  kind: "input" | "result" | "error" | "log" | "info" | "warn" | "debug";
  text: string;
  ts: number;
};

/* One resource load failure captured from the page runtime (the
   engine shim reports these as `resfail` hook messages). */
export type ResFailEntry = {
  id: number;
  url: string;
  kind: string;
  reason: string;
  status?: number;
  note?: string;
  /* Navigation the failure belongs to (NAV-XXXX): ties a resource
     failure back to the navigation that triggered it, so the error
     page id and the DevTools entry correlate. */
  nav?: string;
  ts: number;
};

/* Human labels for the structured failure reasons the shim emits. */
const REASON_TEXT: Record<string, string> = {
  HTTP_ERROR: "HTTP error status",
  MIME_TYPE_ERROR: "Wrong content type (MIME mismatch)",
  FETCH_FAILURE: "fetch() failed",
  XHR_FAILURE: "XMLHttpRequest failed",
  RESOURCE_LOAD_FAILURE: "Resource failed to load",
  WEBSOCKET_FAILURE: "WebSocket closed unexpectedly",
  JAVASCRIPT_EXCEPTION: "JavaScript exception",
  UNKNOWN: "Unknown",
};

export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? code;
}

/* #150: the Console/Network pages are gone (Eruda is the page
   console now), so only diagnostics remains. Page console
   errors/warns and resource failures stay captured for Copy logs. */
export type DtState = {
  open: boolean;
  page: "diagnostics";
  console: ConsoleEntry[];
  fails: ResFailEntry[];
};

export function emptyDt(): DtState {
  return {
    open: false,
    page: "diagnostics",
    console: [],
    fails: [],
  };
}

let entryId = 1;
export function nextEntryId(): number {
  return entryId++;
}

function ts(t: number): string {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

/* Honest clipboard write: navigator.clipboard can be absent or reject
   (permissions policy, window not focused) while the page is still
   usable, so fall back to a hidden textarea + execCommand inside the
   same user gesture. Returns true only when the bytes landed. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

type Props = {
  tab: Tab;
  dt: DtState;
  setDt: (patch: Partial<DtState> | ((prev: DtState) => Partial<DtState>)) => void;
  frame: () => HTMLIFrameElement | null;
  onClose: () => void;
  onOpenLogs: () => void;
  /* Session token for the /logs part of the copy-logs button. */
  sess?: string;
  /* #76: false while the close animation plays (mount-stay in
     Browser.tsx); the exit class mirrors the entry animation. */
  open?: boolean;
};

const PAGES: Array<[DtState["page"], string, string]> = [
  ["diagnostics", "Diagnostics", "bug_report"],
];

/* ---- Zeolite engine diagnostics: NativeTransit / RewriteFallback ---- */
/* Live transport stats, fallback records and diag events from the
   engine's control plane. Polled only while this section is mounted
   (the diagnostics page is open): no cost during normal browsing.
   Stats are engine-wide, not per-tab. */

type ZlFallback = { ts: number; url: string; reason: string; traceId?: string };
type ZlStats = { native: number; fallback: number; fallbacks: ZlFallback[] };
type ZlDiagEvent = {
  seq: number;
  ts: number;
  category: string;
  severity: string;
  message: string;
  stage?: string;
  url?: string;
  technicalReason?: string;
  traceId?: string;
};

/* Failures and abnormal events only. Every TRANSPORT_FALLBACK stage
   record (document/CSS/JS-literal rewrite routing) is expected by
   design, so those info rows are routine routing, not failures, and
   no longer show. The redirect-surfaced marker stays: it names the
   visible reload-cycle symptom, which is not a routine decision. */
const zlNotable = (e: ZlDiagEvent) =>
  e.severity === "error" || e.severity === "warning" || e.message.startsWith("redirect surfaced");

/* The rows ZeoliteDiagnostics renders live in component state that
   dies on unmount; Copy logs needs them after the section is gone or
   before its first poll completes, so the component mirrors them
   into this module-level snapshot on every state change. */
const zlDiagSnapshot: {
  native: number | null;
  fallbackCount: number;
  notable: ZlDiagEvent[];
} = { native: null, fallbackCount: 0, notable: [] };

/* Export serializes exactly what the panel shows: the same
   engine-redacted rows, sanitized at the merge, capped to the last
   200 events. Local file download only; nothing leaves the browser. */
function exportDiag(stats: ZlStats, events: ZlDiagEvent[]) {
  const data = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      stats,
      events: events
        .map((e) => ({
          ...e,
          message: sanitizeText(e.message),
          url: e.url ? sanitizeUrl(e.url) : e.url,
          technicalReason: e.technicalReason ? sanitizeText(e.technicalReason) : e.technicalReason,
          traceId: e.traceId ? sanitizeText(e.traceId) : e.traceId,
        }))
        .slice(-200),
    },
    null,
    2,
  );
  const href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = href;
  a.download = "lobsterbrowse-diagnostics.json";
  a.click();
  /* Revoking synchronously can cancel the fetch the browser has
     only queued, not started; give the download time to attach. */
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

function ZeoliteDiagnostics() {
  const [stats, setStats] = useState<ZlStats | null>(null);
  const [events, setEvents] = useState<ZlDiagEvent[]>([]);
  const diagSeq = useRef(0);
  /* #65: the engine stamps a netLog generation per worker evaluation
     and carries it on every zl:getNetLog reply. The diag seq ring
     lives in worker memory and resets on every restart (idle kill,
     update, crash), so on a generation change the buffered rows and
     the cursor are dropped before the next delta merges - otherwise
     the new ring's rows collide with buffered seqs and the dedup
     silently eats them. The first sighting just records it. */
  const netGen = useRef<number | null>(null);

  useEffect(() => {
    let dead = false;
    const tick = async () => {
      const nl = await zlSend({ type: "zl:getNetLog", since: 0 });
      if (!dead && nl) {
        if (typeof nl.generation === "number" && nl.generation !== netGen.current) {
          const restarted = netGen.current !== null;
          netGen.current = nl.generation;
          if (restarted) {
            diagSeq.current = 0;
            setEvents([]);
          }
        }
        if (nl.stats) setStats(nl.stats as ZlStats);
      }
      const dg = await zlSend({ type: "zl:getDiag", since: diagSeq.current });
      if (!dead && dg && dg.ok && Array.isArray(dg.events)) {
        if (typeof dg.lastSeq === "number" && dg.lastSeq > diagSeq.current) diagSeq.current = dg.lastSeq;
        setEvents((prev) =>
          [...prev, ...(dg.events as ZlDiagEvent[])
            .filter((ev) => !prev.some((p) => p.seq === ev.seq))
            /* #148: event fields carry upstream-derived strings; sanitize
               at the merge so nothing raw reaches React state or Copy logs. */
            .map((ev) => ({
              ...ev,
              message: sanitizeText(ev.message),
              url: ev.url ? sanitizeUrl(ev.url) : ev.url,
              technicalReason: ev.technicalReason ? sanitizeText(ev.technicalReason) : ev.technicalReason,
            }))].slice(-60),
        );
      }
    };
    void tick();
    const iv = setInterval(tick, 5000);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, []);

  useEffect(() => {
    zlDiagSnapshot.native = stats?.native ?? null;
    zlDiagSnapshot.fallbackCount = stats?.fallback ?? 0;
    zlDiagSnapshot.notable = events.filter(zlNotable).slice(-25).reverse();
  }, [stats, events]);

  if (!stats) return null;
  const notable = events.filter(zlNotable).slice(-25).reverse();
  return (
    <div className="lb-net" style={{ marginBottom: "12px" }}>
      <div className="lb-diag-counts">
        <span className="lb-diag-chip lb-diag-ok">NativeTransit: {stats.native}</span>
        <span className="lb-diag-chip">Rewrite-routed loads (normal): {stats.fallback}</span>
        <m3e-button onClick={() => exportDiag(stats, events)}>
          <m3e-icon name="download" aria-hidden={true} /> Export
        </m3e-button>
      </div>
      {notable.length === 0 && (
        <p className="lb-muted" style={{ margin: "0 8px 4px" }}>No transport or rewrite failures.</p>
      )}
      {notable.map((e) => (
        <details key={e.seq} className="lb-net-row">
          <summary className="lb-net-summary">
            <span className={"lb-net-status " + (e.severity === "error" ? "lb-bad" : "lb-ok")}>{e.severity}</span>
            <span className="lb-net-method">{e.category}</span>
            <span className="lb-net-url">{e.message}</span>
            <span className="lb-net-dur">{ts(e.ts)}</span>
          </summary>
          <div className="lb-net-detail">
            {e.stage && <div>Stage: {e.stage}</div>}
            {e.url && <div>URL: {e.url}</div>}
            {e.technicalReason && <div>Technical reason: {e.technicalReason}</div>}
            {e.traceId && <div>Trace: {e.traceId}</div>}
          </div>
        </details>
      ))}
    </div>
  );
}

/* ---- Zeolite download registry ---- */
/* The engine owns download tracking (attachment responses go through
   its registry; the bytes themselves land in the browser's own download
   machinery). This section only mirrors the engine's registry and
   forwards cancels over the control plane: no parallel LB state.
   Polled only while the Diagnostics page is open. */

type ZlDownload = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  received: number;
  startedAt: number;
  endedAt: number;
  status: "active" | "done" | "error" | "cancelled";
  source: string;
  speed: number;
  error?: string;
};

function fmtBytes(n: number): string {
  if (n < 0) return "unknown";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function ZeoliteDownloads() {
  const [dls, setDls] = useState<ZlDownload[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const tick = async () => {
      const r = await zlSend({ type: "zl:downloads" });
      if (!dead && r && r.ok && Array.isArray(r.downloads)) setDls(r.downloads as ZlDownload[]);
    };
    void tick();
    const iv = setInterval(tick, 2000);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, []);

  if (!dls || dls.length === 0) return null;
  const cancel = async (id: string) => {
    setBusy(id);
    await zlSend({ type: "zl:cancelDownload", id });
    setBusy(null);
    /* The next poll tick (2 s) picks up the cancelled state. */
  };
  return (
    <div className="lb-net" style={{ marginBottom: "12px" }}>
      <div className="lb-diag-counts">
        <span className="lb-diag-chip">Engine download registry: {dls.length}</span>
      </div>
      {dls.map((d) => (
        <div key={d.id} className="lb-net-summary" style={{ alignItems: "center" }}>
          <span className={"lb-net-status " + (d.status === "done" || d.status === "active" ? "lb-ok" : "lb-bad")}>
            {d.status}
          </span>
          <span className="lb-net-url">{d.filename}</span>
          <span className="lb-net-dur">
            {fmtBytes(d.received)}
            {d.size >= 0 ? " / " + fmtBytes(d.size) : ""}
            {d.status === "active" ? " (" + fmtBytes(d.speed) + "/s)" : ""}
          </span>
          {d.status === "active" && (
            <m3e-button disabled={busy === d.id ? true : undefined} onClick={() => void cancel(d.id)}>
              Cancel
            </m3e-button>
          )}
        </div>
      ))}
    </div>
  );
}

/* Engine-side developer tools: the tracing toggle, deterministic
   session recording, and Eruda (an embeddable console/network panel)
   injected into the live proxied page - the iframe is same-origin,
   so the script runs in the page JS context directly. All control
   rides the engine plane (zlSend). */
function ZeoliteEngineTools({ frame }: { frame: () => HTMLIFrameElement | null }) {
  const [tracingOn, setTracingOn] = useState(false);
  const [recId, setRecId] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    let dead = false;
    void zlSend({ type: "zl:getTracing" }, 8000).then((r) => {
      if (!dead && r && r.ok) setTracingOn(Boolean(r.enabled));
    });
    return () => { dead = true; };
  }, []);
  const toggleTracing = async () => {
    const r = await zlSend({ type: "zl:tracing", enabled: !tracingOn }, 8000);
    if (r && r.ok) setTracingOn(Boolean(r.enabled));
  };
  const startRec = async () => {
    const id = "lb-" + Date.now();
    const r = await zlSend({ type: "zl:recordStart", recId: id }, 8000);
    if (r && r.ok) {
      const rid = typeof r.record === "object" && r.record !== null && "id" in r.record ? String((r.record as { id?: unknown }).id) : id;
      setRecId(rid);
      setNote("Recording engine activity (tracing is forced on while recording).");
    } else {
      setNote(String((r as { error?: unknown } | null)?.error ?? "engine refused the recording"));
    }
  };
  const stopRec = async () => {
    const r = await zlSend({ type: "zl:recordStop" }, 15000);
    if (r && r.ok) {
      const blob = new Blob([JSON.stringify(r.record, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "zeolite-record.json";
      a.click();
      URL.revokeObjectURL(a.href);
      setRecId("");
      setNote("Recording saved as zeolite-record.json.");
    } else {
      setNote(String((r as { error?: unknown } | null)?.error ?? "engine refused the recording"));
    }
  };
  const injectEruda = async () => {
    const w = frame()?.contentWindow;
    if (!w) { setNote("No proxied page in this tab."); return; }
    const d = w.document;
    if (d.querySelector("script[data-lb-eruda]")) {
      const eruda = (w as unknown as { eruda?: { toggle?: () => void } }).eruda;
      if (eruda && eruda.toggle) eruda.toggle();
      return;
    }
    try {
      /* Inline injection, not a src: the page shim rewrites URL
         assignments, and eruda must load in the page realm as-is. */
      const code = await (await fetch("/eruda.js")).text();
      const s = d.createElement("script");
      s.textContent = code;
      s.setAttribute("data-lb-eruda", "1");
      d.head.appendChild(s);
      const eruda = (w as unknown as { eruda?: { init?: () => void } }).eruda;
      if (eruda && eruda.init) { eruda.init(); setNote("Eruda loaded in the page."); }
      else setNote("Eruda script ran but did not register; the page context may block it.");
    } catch {
      setNote("Could not load eruda.js.");
    }
  };
  return (
    <div className="lb-dt-toolbar" style={{ flexWrap: "wrap", rowGap: 8 }}>
      <m3e-button onClick={() => void toggleTracing()}>
        <m3e-icon name={tracingOn ? "pause_circle" : "play_circle"} aria-hidden={true} />
        {tracingOn ? "Tracing on" : "Tracing off"}
      </m3e-button>
      {recId ? (
        <m3e-button onClick={() => void stopRec()}>
          <m3e-icon name="stop_circle" aria-hidden={true} />
          Stop recording
        </m3e-button>
      ) : (
        <m3e-button onClick={() => void startRec()}>
          <m3e-icon name="radio_button_checked" aria-hidden={true} />
          Record session
        </m3e-button>
      )}
      <m3e-button onClick={() => void injectEruda()}>
        <m3e-icon name="terminal" aria-hidden={true} />
        Eruda in page
      </m3e-button>
      <m3e-button onClick={() => window.open("/zlsw/devtools.html", "_blank", "noopener")}>
        <m3e-icon name="memory" aria-hidden={true} />
        Engine DevTools
      </m3e-button>
      {note && <span className="lb-muted">{note}</span>}
    </div>
  );
}

export default function DevTools({ tab, dt, setDt, frame, onClose, onOpenLogs, sess, open }: Props) {
  const [copyState, setCopyState] = useState<"" | "ok" | "fail">("");

  /* ---- Copy logs: THIS TAB's errors only - console error/warn
     entries, captured resource failures and the Zeolite diagnostics
     rows shown on this page (mirrored in zlDiagSnapshot), then this
     session's server ring (/logs needs the tab's lb_sess token). ---- */
  const copyLogs = async () => {
    const line = (t: number, level: string, msg: string) => new Date(t).toISOString() + " " + level + " " + msg;
    let text = [
      ...dt.console.filter((e) => e.kind === "error" || e.kind === "warn").map((e) => line(e.ts, e.kind, e.text)),
      ...dt.fails.map((f) => line(f.ts, "FAIL", (f.kind ? f.kind + " " : "") + (f.url || "unknown resource") + ": " + reasonText(f.reason) + (f.nav ? " (" + f.nav + ")" : ""))),
    ].join("\n");
    const zl: string[] = [];
    if (zlDiagSnapshot.native !== null)
      zl.push(
        "Zeolite NativeTransit requests: " +
          zlDiagSnapshot.native +
          ", rewrite-routed loads (normal): " +
          zlDiagSnapshot.fallbackCount +
          ", failures: " +
          zlDiagSnapshot.notable.length,
      );
    for (const e of zlDiagSnapshot.notable)
      zl.push(
        line(
          e.ts,
          e.severity,
          e.category +
            ": " +
            e.message +
            (e.stage ? " stage=" + e.stage : "") +
            (e.url ? " " + e.url : "") +
            (e.technicalReason ? " (" + e.technicalReason + ")" : ""),
        ),
      );
    if (zl.length) text += (text ? "\n" : "") + zl.join("\n");
    if (sess) {
      try {
        const r = await fetch("/logs?lb_sess=" + encodeURIComponent(sess));
        if (r.ok) {
          const arr: unknown = await r.json();
          if (Array.isArray(arr)) {
            const server = (arr as unknown[]).filter((e) => typeof e === "string").join("\n");
            if (server) text += (text ? "\n" : "") + server;
          }
        }
      } catch {
        /* offline or session gone: the client ring is still copied */
      }
    }
    const ok = await writeClipboard(text);
    setCopyState(ok ? "ok" : "fail");
    window.setTimeout(() => setCopyState(""), 2000);
  };

  /* Failure counts by resource type for the diagnostics summary. */
  const failCounts = dt.fails.reduce<Record<string, number>>((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  }, {});

  /* Entry count per section, shown on the segment buttons like real
     devtools do. */
  const pageCounts: Record<DtState["page"], number> = {
    diagnostics: dt.fails.length,
  };

  return (
    <m3e-card
      variant="elevated"
      {...{
        ref: (el: any) => {
          if (el) {
            el.classList.add("lb-devtools");
            el.classList.toggle("lb-devtools-out", open === false);
          }
        },
      }}
      aria-label="Developer tools"
    >
      <div className="lb-devtools-head">
        <span className="lb-devtools-title">
          <m3e-icon name="bug_report" aria-hidden={true} /> DevTools - {tab.title || "tab"}
        </span>
        <span className="lb-devtools-head-actions">
          <m3e-icon-button aria-label="View app logs" onClick={onOpenLogs}>
            <m3e-icon name="history" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-icon-button aria-label="Close developer tools" onClick={onClose}>
            <m3e-icon name="close" aria-hidden={true} />
          </m3e-icon-button>
        </span>
      </div>

      {/* #103: the section switch is m3e-tabs (real tablist/tab roles,
          the component own roving focus, typeahead and ink bar). The
          tab panels are siblings of the switcher, not children:
          m3e-tabs sizes its internal slide to its content, which would
          overflow this bounded card; sibling panels flex inside it.
          Panels stay mounted so each tab aria-controls keeps pointing
          at a live element, but their content stays React-conditional
          so the pollers (diagnostics, download registry) only run
          while their page is open. */}
      <m3e-tabs
        {...{
          ref: (el: any) => {
            if (el) el.classList.add("lb-dt-tabs");
          },
        }}
        aria-label="Developer tools sections"
      >
        {PAGES.map(([page, label, icon]) => (
          <m3e-tab
            key={page}
            for={"lb-dt-panel-" + page}
            selected={dt.page === page ? "" : undefined}
            onClick={() => setDt({ page: page })}
          >
            <m3e-icon slot="icon" name={icon} aria-hidden={true} />
            {label}
            {(pageCounts[page] ?? 0) > 0 ? " · " + pageCounts[page] : ""}
          </m3e-tab>
        ))}
      </m3e-tabs>

      <m3e-tab-panel id="lb-dt-panel-diagnostics" {...{ hidden: dt.page === "diagnostics" ? undefined : true, class: "lb-dt-panel" }}>
      {dt.page === "diagnostics" && (
        <div className="lb-dt-body">
          <div className="lb-dt-toolbar">
            <m3e-button onClick={() => void copyLogs()}>
              <m3e-icon name="content_copy" aria-hidden={true} />
              {copyState === "ok" ? "Copied" : copyState === "fail" ? "Copy failed" : "Copy logs"}
            </m3e-button>
            <m3e-button
              onClick={() => window.open("https://github.com/lobsterbs/LobsterBrowse/issues/new", "_blank", "noopener")}
            >
              <m3e-icon name="bug_report" aria-hidden={true} />
              Report
            </m3e-button>
          </div>
          <p className="lb-muted" style={{ margin: "0 8px 4px" }}>
            Real load failures captured from the page runtime (the engine shim&apos;s resfail reports)
            are the rows marked FAIL; the page console and per-request network view live in Eruda
            (button below). The engine transport section lists failures and abnormal events only:
            rewrite-routed loads
            (every HTML, CSS and JS load is routed through the rewriter by design) are counted,
            not listed.
          </p>
          <ZeoliteEngineTools frame={frame} />
          {/* #150: the downloads registry moved here from the removed
              Network page; it is the only download Cancel surface. */}
          <ZeoliteDownloads />
          <ZeoliteDiagnostics />
          {dt.fails.length === 0 ? (
            <div className="lb-net">
              <p className="lb-muted">No resource failures captured.</p>
            </div>
          ) : (
            <div className="lb-net">
              <div className="lb-diag-counts">
                {Object.entries(failCounts).map(([kind, n]) => (
                  <span key={kind} className="lb-diag-chip">
                    {n} × {kind}
                  </span>
                ))}
              </div>
              {dt.fails.map((f) => (
                <details key={f.id} className="lb-net-row">
                  <summary className="lb-net-summary">
                    <span className="lb-net-status lb-bad">FAIL</span>
                    <span className="lb-net-method">{f.kind}</span>
                    <span className="lb-net-url">{f.url || "unknown resource"}</span>
                    {f.status !== undefined && f.status !== 0 && <span className="lb-net-dur">{f.status}</span>}
                  </summary>
                  <div className="lb-net-detail">
                    <div>Resource type: {f.kind}</div>
                    <div>Resource URL: {f.url || "unknown (element failed before a URL could be identified)"}</div>
                    <div>Reason: {reasonText(f.reason)} ({f.reason})</div>
                    {/* Honest status: element-level load failures have no
                        observable HTTP status; show unknown instead of a
                        fabricated 0 that reads like a browser network
                        error. */}
                    <div>HTTP status: {f.status !== undefined ? f.status : "unknown"}</div>
                    <div>Transport: Zeolite engine (/zl/)</div>
                    {f.nav && <div>Navigation: {f.nav}</div>}
                    {f.note && <div>Note: {f.note}</div>}
                    <div>Time: {ts(f.ts)}</div>
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
      )}
      </m3e-tab-panel>

    </m3e-card>
  );
}
