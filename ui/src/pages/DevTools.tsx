/* DevTools panel — console / network / diagnostics for the currently
   selected proxy tab. Each tab keeps its own state.

   Proxied pages are served from the LobsterBrowse origin (/zl/),
   rendered in a same-origin iframe. That gives the panel real access to the page:
   JavaScript is executed with iframe.contentWindow.eval, and console /
   network events arrive over the engine's control plane for every
   proxied document.

   Built from real M3E components: m3e-card as the container,
   m3e-segmented-button for the section switch, m3e-textinput for the
   edit fields. */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { type Tab } from "../store";
import M3eSelect from "../M3eSelect";
import { zlSend } from "../zeolite";
import { sanitizeText, sanitizeUrl } from "../sanitize";

export type ConsoleEntry = {
  id: number;
  kind: "input" | "result" | "error" | "log" | "info" | "warn" | "debug";
  text: string;
  ts: number;
};

export type NetEntry = {
  id: number;
  url: string;
  method: string;
  status: number;
  ok?: boolean;
  dur?: number;
  error?: string;
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

/* Human labels for the engine's transport fallback reasons. Fallbacks
   are expected routing decisions (every HTML document and CSS load is
   one by design), not load failures. */
const FALLBACK_TEXT: Record<string, string> = {
  DOCUMENT_REWRITE_REQUIRED: "document needs the rewriter (normal)",
  CSS_URL_REWRITE_REQUIRED: "CSS needs url() rewriting (normal)",
};

function fallbackText(code: string): string {
  return FALLBACK_TEXT[code] ?? code;
}

export type DtState = {
  open: boolean;
  page: "console" | "network" | "diagnostics";
  console: ConsoleEntry[];
  net: NetEntry[];
  fails: ResFailEntry[];
  levelFilter: string;
  consoleFilter: string;
  netFilter: string;
  history: string[];
};

export function emptyDt(): DtState {
  return {
    open: false,
    page: "console",
    console: [],
    net: [],
    fails: [],
    levelFilter: "all",
    consoleFilter: "",
    netFilter: "",
    history: [],
  };
}

let entryId = 1;
export function nextEntryId(): number {
  return entryId++;
}

/* ---- Value formatting ---- */

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "function") return "ƒ " + (v.name || "anonymous") + "()";
  if (typeof v === "symbol") return v.toString();
  try {
    return JSON.stringify(v, null, 2) ?? "undefined";
  } catch {
    return String(v);
  }
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
};

const PAGES: Array<[DtState["page"], string, string]> = [
  ["console", "Console", "terminal"],
  ["network", "Network", "lan"],
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
};

const zlNotable = (e: ZlDiagEvent) =>
  e.severity === "error" || e.severity === "warning" || e.stage === "TRANSPORT_FALLBACK";

/* The rows ZeoliteDiagnostics renders live in component state that
   dies on unmount; Copy logs needs them after the section is gone or
   before its first poll completes, so the component mirrors them
   into this module-level snapshot on every state change. */
const zlDiagSnapshot: {
  native: number | null;
  fallbackCount: number;
  fallbacks: ZlFallback[];
  notable: ZlDiagEvent[];
} = { native: null, fallbackCount: 0, fallbacks: [], notable: [] };

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
          [...prev, ...(dg.events as ZlDiagEvent[]).filter((ev) => !prev.some((p) => p.seq === ev.seq))].slice(-60),
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
    zlDiagSnapshot.fallbacks = stats?.fallbacks ?? [];
    zlDiagSnapshot.notable = events.filter(zlNotable).slice(-25).reverse();
  }, [stats, events]);

  if (!stats) return null;
  const notable = events.filter(zlNotable).slice(-25).reverse();
  return (
    <div className="lb-net" style={{ marginBottom: "12px" }}>
      <div className="lb-diag-counts">
        <span className="lb-diag-chip">NativeTransit: {stats.native}</span>
      </div>
      {stats.fallbacks
        .slice(-10)
        .reverse()
        .map((f, i) => (
          <details key={f.ts + "-" + i} className="lb-net-row">
            <summary className="lb-net-summary">
              <span className="lb-net-status">FB</span>
              <span className="lb-net-method">{fallbackText(f.reason)}</span>
              <span className="lb-net-url">{f.url}</span>
              <span className="lb-net-dur">{ts(f.ts)}</span>
            </summary>
            <div className="lb-net-detail">
              <div>Reason code: {f.reason}</div>
              <div>Time: {ts(f.ts)}</div>
            </div>
          </details>
        ))}
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
   Polled only while the Network page is open. */

type ZlDownload = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  received: number;
  startedAt: number;
  endedAt: number;
  status: "active" | "done" | "error" | "cancelled" | "paused";
  source: string;
  speed: number;
  /* #118: engine-set; false above the resume cap or without buffered bytes. */
  resumable?: boolean;
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
  const act = async (id: string, type: "zl:cancelDownload" | "zl:pauseDownload" | "zl:resumeDownload") => {
    setBusy(id);
    await zlSend({ type, id }, 15000);
    setBusy(null);
    /* The next poll tick (2 s) picks up the new state. */
  };
  /* #118: the engine hands back the assembled partial (the blob
     crosses the MessageChannel by structured clone); the UI host owns
     the actual save, same rule as the extension download handoff. */
  const save = async (id: string) => {
    setBusy(id);
    const r = await zlSend({ type: "zl:saveDownload", id }, 15000);
    setBusy(null);
    if (r && r.ok && r.blob instanceof Blob) {
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = typeof r.filename === "string" && r.filename ? r.filename : "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  };
  return (
    <div className="lb-net" style={{ marginBottom: "12px" }}>
      <div className="lb-diag-counts">
        <span className="lb-diag-chip">Engine download registry: {dls.length}</span>
      </div>
      {dls.map((d) => (
        <div key={d.id} className="lb-net-summary" style={{ alignItems: "center" }}>
          <span
            className={
              "lb-net-status " +
              (d.status === "paused"
                ? "lb-paused"
                : d.status === "done" || d.status === "active"
                  ? "lb-ok"
                  : "lb-bad")
            }
          >
            {d.status}
          </span>
          <span className="lb-net-url">{d.filename}</span>
          <span className="lb-net-dur">
            {fmtBytes(d.received)}
            {d.size >= 0 ? " / " + fmtBytes(d.size) : ""}
            {d.status === "active" ? " (" + fmtBytes(d.speed) + "/s)" : ""}
          </span>
          {d.status === "active" && d.resumable === true && (
            <m3e-button disabled={busy === d.id ? true : undefined} onClick={() => void act(d.id, "zl:pauseDownload")}>
              Pause
            </m3e-button>
          )}
          {d.status === "paused" && d.resumable === true && (
            <m3e-button disabled={busy === d.id ? true : undefined} onClick={() => void act(d.id, "zl:resumeDownload")}>
              Resume
            </m3e-button>
          )}
          {d.status === "paused" && d.resumable === true && (
            <m3e-button disabled={busy === d.id ? true : undefined} onClick={() => void save(d.id)}>
              Save partial
            </m3e-button>
          )}
          {d.status === "active" && (
            <m3e-button disabled={busy === d.id ? true : undefined} onClick={() => void act(d.id, "zl:cancelDownload")}>
              Cancel
            </m3e-button>
          )}
        </div>
      ))}
    </div>
  );
}

export default function DevTools({ tab, dt, setDt, frame, onClose, onOpenLogs, sess }: Props) {
  const [cmd, setCmd] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const [copyState, setCopyState] = useState<"" | "ok" | "fail">("");
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [dt.console.length]);

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
      zl.push("Zeolite NativeTransit requests: " + zlDiagSnapshot.native + ", rewrite fallbacks: " + zlDiagSnapshot.fallbackCount);
    for (const f of zlDiagSnapshot.fallbacks.slice(-10).reverse())
      zl.push(line(f.ts, "FB", fallbackText(f.reason) + " " + f.url));
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

  /* ---- Console: real JS eval in the proxied page context. ---- */
  const runCode = (code: string) => {
    const f = frame();
    const w = f?.contentWindow;
    /* Functional setDt in every branch, and one append per branch:
       an async zl: reply (echo/emit) can land between this render
       and the submit click, so a patch built from the render-time
       dt.console would drop it; prev is always the fresh state. */
    const entry = { id: nextEntryId(), kind: "input" as ConsoleEntry["kind"], text: code, ts: Date.now() };
    if (!w) {
      setDt((prev) => ({ console: [...prev.console, { id: nextEntryId(), kind: "error" as const, text: "No proxied page in this tab — navigate to a site first.", ts: Date.now() }].slice(-500) }));
      return;
    }
    try {
      const result: unknown = (w as unknown as { eval: (c: string) => unknown }).eval(code);
      setDt((prev) => ({
        console: [
          ...prev.console,
          entry,
          { id: nextEntryId(), kind: "result" as const, text: formatValue(result), ts: Date.now() },
        ].slice(-500),
        history: [...prev.history, code].slice(-100),
      }));
    } catch (err) {
      const e = err as Error;
      setDt((prev) => ({
        console: [
          ...prev.console,
          entry,
          {
            id: nextEntryId(),
            kind: "error" as const,
            text: (e.name || "Error") + ": " + e.message + (e.stack ? "\n" + e.stack : ""),
            ts: Date.now(),
          },
        ].slice(-500),
        history: [...prev.history, code].slice(-100),
      }));
    }
  };

  /* ---- Engine control-plane commands (zl:*), the useful half of the
     removed Terminal page. No shell, no remote execution: every
     command talks to the engine control plane and every reply passes
     the diagnostics sanitizer before it enters console state. These
     run in DevTools, not the page, so they never need a proxied frame.
     Async replies append through the functional setDt patch so they
     cannot race the render-time state snapshot. ---- */
  const echo = (text: string) =>
    setDt((prev) => ({
      console: [...prev.console, { id: nextEntryId(), kind: "input" as const, text, ts: Date.now() }].slice(-500),
      history: [...prev.history, text].slice(-100),
    }));
  const emit = (lines: string[], kind: ConsoleEntry["kind"] = "result") => {
    if (!lines.length) return;
    setDt((prev) => ({
      console: [
        ...prev.console,
        ...lines.map((text) => ({ id: nextEntryId(), kind, text: sanitizeText(text), ts: Date.now() })),
      ].slice(-500),
    }));
  };
  const runZlCommand = (code: string): boolean => {
    if (!code.startsWith("zl:")) return false;
    void (async () => {
      echo(code);
      if (code === "zl:help") {
        emit([
          "zl:status    engine summary (extensions, downloads, transit)",
          "zl:ping      engine round-trip latency",
          "zl:transit   native vs rewrite-fallback routing counts",
          "zl:netlog    latest transport fallback records",
          "zl:ext [id]  extension list, or detail for one id",
          "zl:downloads engine download registry",
          "zl:storage   storage diagnostic (not exposed by the engine)",
          "zl:workers   worker diagnostic (not exposed by the engine)",
        ]);
        return;
      }
      if (code === "zl:ping") {
        const t0 = Date.now();
        const res = await zlSend({ type: "zl:getDiag", since: 0 }, 8000);
        emit([res ? "engine replied in " + (Date.now() - t0) + " ms" : "engine unreachable (no reply within 8 s)"]);
        return;
      }
      if (code === "zl:status") {
        const [ext, dl, nl] = await Promise.all([
          zlSend({ type: "zl:listExt" }, 8000),
          zlSend({ type: "zl:downloads" }, 8000),
          zlSend({ type: "zl:getNetLog", since: 0 }, 8000),
        ]);
        const extList: unknown[] = Array.isArray(ext?.exts) ? ext.exts : [];
        const dlList: unknown[] = Array.isArray(dl?.downloads) ? dl.downloads : [];
        emit([
          "extensions: " + (ext ? String(extList.length) : "engine unreachable"),
          "downloads in registry: " + (dl ? String(dlList.length) : "engine unreachable"),
          "transit: " + (nl?.stats ? "native " + String(nl.stats.native) + ", fallback " + String(nl.stats.fallback) : "engine unreachable"),
        ]);
        return;
      }
      if (code === "zl:transit" || code === "zl:netlog") {
        const nl = await zlSend({ type: "zl:getNetLog", since: 0 }, 8000);
        if (!nl?.stats) { emit(["engine unreachable"]); return; }
        const st = nl.stats as { native: number; fallback: number; fallbacks?: { ts: number; url: string; reason: string }[] };
        const lines = ["native transit: " + String(st.native) + "  rewrite fallbacks: " + String(st.fallback)];
        if (code === "zl:netlog") {
          const fb = st.fallbacks ?? [];
          lines.push(fb.length ? "latest fallback records:" : "no fallback records");
          for (const f of fb.slice(-10).reverse()) {
            lines.push("  " + new Date(f.ts).toISOString().slice(11, 19) + "  " + sanitizeUrl(f.url) + "  (" + f.reason + ")");
          }
        }
        emit(lines);
        return;
      }
      if (code === "zl:ext" || code.startsWith("zl:ext ")) {
        const id = code.slice(7).trim();
        if (id) {
          const res = await zlSend({ type: "zl:extInfo", id }, 8000);
          let s: string;
          try { s = JSON.stringify(res, null, 2) ?? "undefined"; } catch { s = String(res); }
          emit(["extension " + id + ":", s]);
        } else {
          const res = await zlSend({ type: "zl:listExt" }, 8000);
          const extList: { id?: string; name?: string; enabled?: boolean }[] = Array.isArray(res?.exts) ? res.exts : [];
          if (!res) emit(["engine unreachable"]);
          else if (!extList.length) emit(["no extensions installed"]);
          else emit(extList.map((x) => "  " + String(x.id ?? "?") + "  " + String(x.name ?? "?") + (x.enabled === false ? "  (disabled)" : "")));
        }
        return;
      }
      if (code === "zl:downloads") {
        const res = await zlSend({ type: "zl:downloads" }, 8000);
        const dlList: { filename?: string; status?: string; received?: number }[] = Array.isArray(res?.downloads) ? res.downloads : [];
        if (!res) emit(["engine unreachable"]);
        else if (!dlList.length) emit(["download registry empty"]);
        else emit(dlList.map((x) => "  " + String(x.filename ?? "?") + "  " + String(x.status ?? "?") + "  " + String(x.received ?? "?") + " bytes"));
        return;
      }
      if (code === "zl:storage" || code === "zl:workers") {
        emit([code + ": no such diagnostic surface in the engine control plane (honest no-op)"]);
        return;
      }
      emit(["unknown command: " + code + " - try zl:help"], "error");
    })();
    return true;
  };

  const submit = () => {
    const code = cmd.trim();
    if (!code) return;
    if (code === "clear") {
      setCmd("");
      setDt({ console: [] });
      return;
    }
    setCmd("");
    setHistIdx(-1);
    /* Engine commands run here; everything else is page eval. */
    if (runZlCommand(code)) return;
    runCode(code);
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" && !cmd.includes("\n")) {
      e.preventDefault();
      const h = dt.history;
      const next = histIdx < 0 ? h.length - 1 : Math.max(0, histIdx - 1);
      if (h[next] !== undefined) {
        setCmd(h[next]);
        setHistIdx(next);
      }
    } else if (e.key === "ArrowDown" && !cmd.includes("\n")) {
      e.preventDefault();
      const h = dt.history;
      const next = histIdx + 1;
      if (next >= h.length) {
        setCmd("");
        setHistIdx(-1);
      } else {
        setCmd(h[next]);
        setHistIdx(next);
      }
    }
  };

  const levelOf = (k: ConsoleEntry["kind"]) =>
    k === "error" ? "error" : k === "warn" ? "warn" : k === "info" ? "info" : k === "debug" ? "debug" : "log";

  const consoleEntries = dt.console.filter((c) => {
    if (dt.levelFilter !== "all" && levelOf(c.kind) !== dt.levelFilter) return false;
    if (dt.consoleFilter && !c.text.toLowerCase().includes(dt.consoleFilter.toLowerCase())) return false;
    return true;
  });

  const netEntries = dt.net.filter((n) =>
    dt.netFilter ? n.url.toLowerCase().includes(dt.netFilter.toLowerCase()) : true
  );

  /* Network log pagination (m3e-paginator): the page event is the
     component's only output, so mirror it into state like the M3eSelect
     change wiring. Clamped at render so shrinking logs never leave a
     page index past the end. */
  const [netPage, setNetPage] = useState(0);
  const [netPageSize, setNetPageSize] = useState(25);
  const pagerRef = useRef<HTMLElement & { pageSize: number | "all" } | null>(null);
  useEffect(() => {
    const el = pagerRef.current;
    if (!el) return;
    const onPage = (e: Event) => {
      const d = (e as CustomEvent<{ pageIndex?: number; pageSize?: number | "all" }>).detail;
      if (typeof d?.pageIndex === "number") setNetPage(d.pageIndex);
      if (typeof d?.pageSize === "number") setNetPageSize(d.pageSize);
    };
    el.addEventListener("page", onPage);
    return () => el.removeEventListener("page", onPage);
  }, []);
  useEffect(() => {
    setNetPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dt.netFilter]);
  const netPages = Math.max(1, Math.ceil(netEntries.length / netPageSize));
  const netPageClamped = Math.min(netPage, netPages - 1);
  const pagedNet = netEntries.slice(netPageClamped * netPageSize, (netPageClamped + 1) * netPageSize);

  /* Failure counts by resource type for the diagnostics summary. */
  const failCounts = dt.fails.reduce<Record<string, number>>((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  }, {});

  /* Entry count per section, shown on the segment buttons like real
     devtools do. */
  const pageCounts: Record<DtState["page"], number> = {
    console: dt.console.length,
    network: dt.net.length,
    diagnostics: dt.fails.length,
  };

  return (
    <m3e-card
      variant="elevated"
      {...{
        ref: (el: any) => {
          if (el) el.classList.add("lb-devtools");
        },
      }}
      aria-label="Developer tools"
    >
      <div className="lb-devtools-head">
        <span className="lb-devtools-title">
          <m3e-icon name="bug_report" aria-hidden={true} /> DevTools — {tab.title || "tab"}
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

      {/* Real M3E segmented button for the section switch. */}
      <m3e-segmented-button
          {...{
            ref: (el: any) => {
              if (el) el.classList.add("lb-dt-seg");
            },
          }}
          aria-label="Developer tools sections"
        >
        {PAGES.map(([page, label, icon]) => (
          <m3e-button-segment
            key={page}
            checked={dt.page === page ? "" : undefined}
            onClick={() => setDt({ page: page })}
          >
            <m3e-icon slot="icon" name={icon} aria-hidden={true} />
            {label}
            {(pageCounts[page] ?? 0) > 0 ? " · " + pageCounts[page] : ""}
          </m3e-button-segment>
        ))}
      </m3e-segmented-button>

      {dt.page === "console" && (
        <div className="lb-dt-body">
          <div className="lb-dt-toolbar">
            <M3eSelect
              label="Log level filter"
              value={dt.levelFilter}
              options={[
                ["all", "All levels"],
                ["log", "log"],
                ["info", "info"],
                ["warn", "warn"],
                ["error", "error"],
                ["debug", "debug"],
              ]}
              onChange={(v) => setDt({ levelFilter: v })}
            />
            <input
              className="lb-input"
              placeholder="Filter"
              aria-label="Filter console output"
              value={dt.consoleFilter}
              onChange={(e) => setDt({ consoleFilter: e.target.value })}
            />
            <m3e-icon-button aria-label="Clear console" onClick={() => setDt({ console: [] })}>
              <m3e-icon name="mop" aria-hidden={true} />
            </m3e-icon-button>
            <m3e-icon-button
              aria-label="Copy console output"
              onClick={() => void writeClipboard(dt.console.map((c) => ts(c.ts) + " " + c.text).join("\n"))}
            >
              <m3e-icon name="content_copy" aria-hidden={true} />
            </m3e-icon-button>
          </div>
          <div className="lb-console" ref={consoleRef}>
            {consoleEntries.map((c) => (
              <div key={c.id} className={"lb-console-line lb-" + levelOf(c.kind)}>
                <span className="lb-console-ts">{ts(c.ts)}</span>
                <span className="lb-console-arrow">{c.kind === "input" ? "›" : c.kind === "result" ? "‹" : levelOf(c.kind)}</span>
                <span className="lb-console-text">{c.text}</span>
              </div>
            ))}
          </div>
          <div className="lb-console-input">
            {/* m3e-textarea-autosize grows the console input to fit
                multi-line expressions (Shift+Enter), replacing the old
                manual rows=4 toggle. */}
            <m3e-textarea-autosize for="lb-dt-console-in" min-rows={1} max-rows={10} />
            <textarea
              ref={inputRef}
              id="lb-dt-console-in"
              className="lb-input lb-console-area"
              aria-label="Console input"
              value={cmd}
              rows={1}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={keyDown}
            />
            <m3e-button variant="filled" onClick={submit}>Execute</m3e-button>
          </div>
        </div>
      )}

      {dt.page === "network" && (
        <div className="lb-dt-body">
          <div className="lb-dt-toolbar">
            <input
              className="lb-input"
              placeholder="Filter by URL"
              aria-label="Filter network requests"
              value={dt.netFilter}
              onChange={(e) => setDt({ netFilter: e.target.value })}
            />
            <m3e-icon-button aria-label="Clear network log" onClick={() => setDt({ net: [] })}>
              <m3e-icon name="mop" aria-hidden={true} />
            </m3e-icon-button>
          </div>
          <p className="lb-muted" style={{ margin: "0 8px 4px" }}>
            Requests made by the page's JavaScript (fetch/XHR/WebSocket). Headers and byte sizes are not
            exposed to the page context by the browser — this is a page-level view, not a network tap.
          </p>
          <ZeoliteDownloads />
          <div className="lb-net">
            {netEntries.length === 0 && <p className="lb-muted">No requests captured yet.</p>}
            {pagedNet.map((n) => (
              <details key={n.id} className="lb-net-row">
                <summary className="lb-net-summary">
                  <span className={"lb-net-status " + (n.error || (!n.ok && n.status >= 400) ? "lb-bad" : "lb-ok")}>
                    {n.error ? "ERR" : n.status}
                  </span>
                  <span className="lb-net-method">{n.method}</span>
                  <span className="lb-net-url">{n.url}</span>
                  {n.dur !== undefined && <span className="lb-net-dur">{n.dur} ms</span>}
                </summary>
                <div className="lb-net-detail">
                  <div>URL: {n.url}</div>
                  <div>Method: {n.method}</div>
                  <div>Status: {n.error ? n.error : n.status}</div>
                  {n.dur !== undefined && <div>Duration: {n.dur} ms</div>}
                  <div>Time: {ts(n.ts)}</div>
                  <div className="lb-muted">Request/response headers, sizes, and bodies: unavailable — the page context cannot read them.</div>
                </div>
              </details>
            ))}
          </div>
          {netEntries.length > netPageSize && (
            <m3e-paginator
              length={netEntries.length}
              page-size={netPageSize}
              page-sizes="25,50,100"
              aria-label="Network log pages"
              {...{ class: "lb-dt-pager", ref: pagerRef }}
            />
          )}
        </div>
      )}

      {dt.page === "diagnostics" && (
        <div className="lb-dt-body">
          <div className="lb-dt-toolbar">
            <m3e-icon-button aria-label="Clear diagnostics" onClick={() => setDt({ fails: [] })}>
              <m3e-icon name="mop" aria-hidden={true} />
            </m3e-icon-button>
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
            are the rows marked FAIL; successful loads are in the Network section. The engine
            transport section shows routing decisions, not failures: FB rows are expected rewrite
            fallbacks (every HTML and CSS load uses one).
          </p>
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

    </m3e-card>
  );
}
