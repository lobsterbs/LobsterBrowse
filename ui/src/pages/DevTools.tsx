/* DevTools - console / diagnostics for the currently selected proxy
   tab, in an @m3e/web bottom sheet. Each page keeps its own state.

   Redesign: the old floating card lives on as DevToolsLegacy.tsx
   (not imported; kept for rollback). The panel hosts in the
   m3e-bottom-sheet; the sub-tool picker (Console / Diagnostics,
   2026-11-23: the broken Network page is gone) is a real m3e-tabs
   bar, and both pages render their content bare, directly in the
   sheet.

   Both pages stay mounted ([hidden] toggle, no remount churn); the
   tabs bar owns the radiogroup semantics and the change event flows
   back into React state like every other M3E control wiring.

   Diagnostics renders its transport counts as two compact m3e-cards
   (label over an expressive-weight number), a centered m3e-divider,
   then the retained event ring as m3e-list rows (press a row for the
   detailed record), windowed so only the rows the reader actually
   reaches are ever rendered.

   Proxied pages ride the engine's split content origin, so the frame
   is usually cross-origin to the app: iframe.contentWindow.eval then
   throws SecurityError, and the console says so together with the
   two working routes (the page's own F12 DevTools, or the debug-menu
   Split content origin toggle). Same-origin frames still eval
   directly. Console events arrive over the engine's control plane for
   every proxied document either way. */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { type Tab } from "../store";
import { zlContentQuery, zlSend } from "../zeolite";
import { sanitizeText, sanitizeUrl } from "../sanitize";
import {
  diagnosticsScope, snapshotForScope, pollDocumentDiagnostics, mergeDiagHistory,
  type DiagnosticsSnapshot, type DiagnosticsStatus, type DiagHistoryEvent, type EngineSource,
} from "../browser/diagnosticsScope";
import { diagKdl } from "../kdl";
import { copyText, m3eAttrs } from "../browser/browserShared";

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

export type DtState = {
  open: boolean;
  page: "console" | "diagnostics";
  console: ConsoleEntry[];
  fails: ResFailEntry[];
  history: string[];
  engineClientId?: string;
  engineSource?: EngineSource;
};

export function emptyDt(): DtState {
  return {
    open: false,
    page: "console",
    console: [],
    fails: [],
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

type Props = {
  tab: Tab;
  dt: DtState;
  setDt: (patch: Partial<DtState> | ((prev: DtState) => Partial<DtState>)) => void;
  frame: () => HTMLIFrameElement | null;
  onClose: () => void;
  onOpenLogs: () => void;
  /* Compatibility prop; session-wide logs remain in App Logs. */
  sess?: string;
  /* #76: false while the close animation plays (mount-stay in
     Browser.tsx); the sheet hides imperatively. */
  open?: boolean;
};

const KIND_ICON: Record<ConsoleEntry["kind"], string> = {
  input: "chevron_right", result: "subdirectory_arrow_left", error: "error", warn: "warning", info: "info", log: "notes", debug: "bug_report",
};

const PAGES: Array<[DtState["page"], string, string]> = [
  ["console", "Console", "terminal"],
  ["diagnostics", "Diagnostics", "bug_report"],
];

/* Diagnostics event window: how many retained ring rows render per
   batch. The sentinel below the visible batch grows the window when
   the reader scrolls that far. */
const DIAG_WINDOW = 24;

/* ---- Zeolite engine diagnostics: NativeTransit / RewriteFallback ---- */
/* This document's retained request/diagnostic rings from its owning
   worker. Unattributed engine lifecycle events remain in Engine DevTools.
   LB#260 (beta): the panel shows EVERY retained event, not only
   errors and warnings, and keeps events from PREVIOUS navigations
   of this tab: each navigation is a new document identity whose
   rings start empty, so a mount-level history (mergeDiagHistory)
   carries the older navigation's events across the boundary while
   the panel is open. */

/* #220: explicit collection statuses replace the eternal "Awaiting..."
   placeholders. A valid empty scoped log renders as a normal snapshot
   with zero events; every collapsed null carries the reason it
   collapsed, with reload guidance where a failed bootstrap handshake
   would otherwise block collection forever. */
const DIAG_STATUS_TEXT: Record<DiagnosticsStatus, string> = {
  ok: "Diagnostics collected.",
  starting: "Collecting diagnostics for this document...",
  identity: "No engine identity for this document yet. Reload the page to retry the handshake.",
  unavailable: "Diagnostics unavailable: the engine worker did not answer the scoped query. Retrying every 5 seconds; reload the page if this persists.",
  rejected: "The engine worker refused the scoped diagnostics query for this document. Retrying every 5 seconds.",
  unsupported: "This engine worker version does not support scoped diagnostics for this document.",
  mismatch: "A different document answered the scoped query; retrying for this document every 5 seconds.",
  restart: "The engine worker restarted while collecting; retrying.",
  malformed: "The diagnostics reply was malformed. Retrying every 5 seconds; reload the page if this persists.",
};

function ZeoliteDiagnostics({ clientId, source, snapshotRef, statusRef, active }: {
  clientId?: string;
  source?: EngineSource;
  snapshotRef: MutableRefObject<DiagnosticsSnapshot | null>;
  statusRef: MutableRefObject<DiagnosticsStatus | null>;
  active: boolean;
}) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null);
  /* LB#260: the mount-level merged history survives the clientId
     changes that every pane navigation causes; the ref is the
     accumulator, the state just re-renders. */
  const historyRef = useRef<DiagHistoryEvent[]>([]);
  const [history, setHistory] = useState<DiagHistoryEvent[]>([]);
  const scope = diagnosticsScope(clientId, source);
  /* Hide the preceding document before effect cleanup. */
  const current = snapshotForScope(snapshot, scope);
  useEffect(() => {
    /* Poll only while the Diagnostics page is open: a hidden 5 s
       loop burns control-plane round trips for a page the user is
       not looking at. */
    if (!active) return;
    return pollDocumentDiagnostics(
      diagnosticsScope(clientId, source), zlSend, zlContentQuery,
      (next, why) => {
        snapshotRef.current = next;
        setSnapshot(next);
        const merged = mergeDiagHistory(historyRef.current, next);
        historyRef.current = merged;
        setHistory(merged);
        const s = why ?? (next ? "ok" : "unavailable");
        statusRef.current = s;
        setStatus(s);
      },
    );
  }, [clientId, source, snapshotRef, statusRef, active]);

  /* React counts hooks in call order, so every hook in this component
     must run on every render - including renders that bail out at the
     early returns below. The windowing hooks used to sit after those
     returns: the first render (no snapshot yet) skipped them, the
     first poll delivery then flipped the guard conditions and mounted
     four extra hooks on the next render, and React's hook-count
     invariant (#310) took the whole app down to the boot failure
     screen the moment the Diagnostics tab opened on a proxied page.
     They run unconditionally now. */
  /* Newest first, every event, with a visible boundary between
     navigations so the previous navigation's rows read as history. */
  const rows = [...history].reverse();
  /* 2026-11-23 report: the ring renders as real m3e-list rows, and
     only the rows the reader actually reaches: the window grows by
     one batch when its sentinel scrolls into view, so a retained
     cross-navigation history never mounts rows nobody scrolled to. */
  const [limit, setLimit] = useState(DIAG_WINDOW);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = moreRef.current;
    if (!el || rows.length <= DIAG_WINDOW) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) setLimit((n) => n + DIAG_WINDOW);
    });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length > limit]);

  if (!scope) {
    return <p className="lb-muted">No engine identity for this document yet. Reload the page to retry the handshake; diagnostics never fall back to worker-global logs.</p>;
  }
  if (!current) {
    return <p className="lb-muted">{DIAG_STATUS_TEXT[status ?? "starting"]}</p>;
  }
  const { stats } = current;
  const shown = rows.slice(0, limit);
  return (
    <div className="lb-net">
      <div className="lb-diag-cards">
        <m3e-card variant="filled" {...{ class: "lb-dt-card lb-diag-card" }} aria-label="NativeTransit handoff count">
          <div slot="content" className="lb-diag-card-body">
            <span className="lb-diag-card-title">NativeTransit</span>
            <span className="lb-diag-card-num">{stats.native}</span>
          </div>
        </m3e-card>
        <m3e-card variant="filled" {...{ class: "lb-dt-card lb-diag-card" }} aria-label="Rewrite-routed load count">
          <div slot="content" className="lb-diag-card-body">
            <span className="lb-diag-card-title">Rewrite-routed (normal)</span>
            <span className="lb-diag-card-num">{stats.fallback}</span>
          </div>
        </m3e-card>
      </div>
      <m3e-divider {...{ class: "lb-diag-sep" }} />
      {rows.length === 0 && (
        <p className="lb-muted" style={{ margin: "0 8px 4px" }}>No engine events for this tab yet. Navigate and keep this page open to retain every event across navigations.</p>
      )}
      <m3e-list aria-label="Engine events" {...{ class: "lb-diag-list" }}>
        {shown.map((e, i) => {
          const boundary = i > 0 && shown[i - 1].clientId !== e.clientId;
          const key = e.clientId + ":" + e.seq;
          const open = openKey === key;
          return (
            <div key={key}>
              {boundary && (
                <p className="lb-muted lb-diag-boundary">previous navigation</p>
              )}
              <m3e-list-item
                {...{
                  class: "lb-diag-item" + (open ? " open" : ""),
                  role: "button",
                  tabIndex: 0,
                  "aria-expanded": open ? "true" : "false",
                }}
                onClick={() => setOpenKey(open ? null : key)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    setOpenKey(open ? null : key);
                  }
                }}
              >
                <span slot="leading" className={"lb-net-status " + (e.severity === "error" ? "lb-bad" : "lb-ok")}>{e.severity}</span>
                <span className="lb-diag-item-line">
                  <span className="lb-net-method">{e.category}</span>
                  <span className="lb-net-url">{e.message}</span>
                </span>
                <span slot="trailing" className="lb-net-dur">{ts(e.ts)}</span>
                {open && (
                  <div slot="supporting-text" className="lb-net-detail">
                    {e.stage && <div>Stage: {e.stage}</div>}
                    {e.url && <div>URL: {e.url}</div>}
                    {e.technicalReason && <div>Technical reason: {e.technicalReason}</div>}
                    {e.traceId && <div>Trace: {e.traceId}</div>}
                  </div>
                )}
              </m3e-list-item>
            </div>
          );
        })}
      </m3e-list>
      {rows.length > shown.length && (
        <div ref={moreRef} className="lb-diag-more" aria-hidden={true} />
      )}
    </div>
  );
}

/* Host of a proxied URL for the sheet title line; bare strings
   (about:blank, no-site) pass through. */
function hostOf(u: string): string {
  try { return new URL(u).hostname; } catch { return u; }
}

/* Engine-side developer tools: Eruda (an embeddable console/network
   panel) injected into the live proxied page - same-origin frames
   only: split-origin frames are cross-origin and refuse injection,
   which the button then says plainly.
   Control rides the engine plane (zlSend). The tracing toggle and
   session recording were removed from this surface; zl:tracing /
   zl:recordStart / zl:recordStop stay available on the engine
   plane. */
function ZeoliteEngineTools({ frame }: { frame: () => HTMLIFrameElement | null }) {
  /* #266: the tool lives in the sheet header now, so its notes go
     through the snackbar (the same channel as the copy
     confirmations) instead of an inline span at the sheet edge. */
  const say = (msg: string) => {
    if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
      M3eSnackbar.open(msg, { duration: 4000 });
    }
  };
  /* Eruda availability: the tool greys out
     and stops responding when /eruda.js cannot be fetched. HEAD
     first; a static layer that refuses HEAD falls back to a one-byte
     ranged GET. */
  const [erudaReady, setErudaReady] = useState<boolean | null>(null);
  useEffect(() => {
    let dead = false;
    const probe = async (): Promise<boolean> => {
      try {
        const h = await fetch("/eruda.js", { method: "HEAD", cache: "no-store" });
        if (h.ok) return true;
      } catch { /* fall through to the ranged GET */ }
      try {
        const g = await fetch("/eruda.js", { cache: "no-store", headers: { Range: "bytes=0-0" } });
        if (g.body) { try { void g.body.cancel(); } catch { /* ignore */ } }
        return g.ok;
      } catch { return false; }
    };
    void probe().then((ok) => { if (!dead) setErudaReady(ok); });
    return () => { dead = true; };
  }, []);
  const injectEruda = async () => {
    const w = frame()?.contentWindow;
    if (!w) { say("No proxied page in this tab."); return; }
    let d: Document | null = null;
    try { d = w.document; } catch {
      say("This page rides the split content origin, so the app cannot inject into it. Turn 'Split content origin' off in the debug menu and reload the tab, or use the page's own F12 DevTools.");
      return;
    }
    if (!d) { say("No proxied document in this tab."); return; }
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
      if (eruda && eruda.init) { eruda.init(); say("Eruda loaded in the page."); }
      else say("Eruda script ran but did not register; the page context may block it.");
    } catch {
      say("Could not load eruda.js.");
    }
  };
  return (
    <>
      <m3e-icon-button
        slot="trailing"
        id="lb-dt-eruda-btn"
        aria-label={erudaReady === false ? "Eruda in page (unavailable)" : "Eruda in page"}
        disabled={erudaReady === false ? true : undefined}
        {...{ class: erudaReady === false ? "lb-tool-disabled" : undefined }}
        onClick={() => void injectEruda()}
      >
        <m3e-icon name="terminal" aria-hidden={true} />
      </m3e-icon-button>
      <m3e-tooltip for="lb-dt-eruda-btn" position="below">Eruda in page</m3e-tooltip>
    </>
  );
}

/* Composite-only entrance (opacity + translateY) shared by the sheet open
   and the sub-tool switch. The three pages stay mounted on purpose (no
   remount churn between sub-tools), so mount CSS never fires on a
   switch: WAAPI is the trigger. Reduced motion skips the entrance. */
const DT_ENTER = "cubic-bezier(0.2, 0, 0, 1)";
function dtEnter(el: Element | null, delay = 0) {
  if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.animate?.(
    [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }],
    /* fill: backwards holds the first keyframe through the delay:
       without it the entering page painted at rest for the 40ms
       delay, then teleported down 6px and faded back in - the
       second of the two switch jumps (2026-11-24 report). */
    { duration: 200, easing: DT_ENTER, delay, fill: "backwards" },
  );
}

export default function DevTools({ tab, dt, setDt, frame, onClose, onOpenLogs, open }: Props) {
  const [cmd, setCmd] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /* Copy flash: the header icon shows a check for a beat when the
     bytes landed, so the press reads as done without watching the
     snackbar. */
  const [copyFlash, setCopyFlash] = useState(false);

  /* Live-props ref: the sheet's event listeners outlive renders. */
  const live = useRef({ onClose, onOpenLogs });
  live.current = { onClose, onOpenLogs };

  const sheetRef = useRef<HTMLElement & { show: () => void; hide: () => void } | null>(null);
  /* The sub-tool tablist: the component owns selection, and its
     change event (bubbling from the tab) is the single source React
     subscribes to; the map below keeps both in step. */
  const tabsRef = useRef<HTMLElement & { selectedIndex: number } | null>(null);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onChange = () => {
      const page = PAGES[el.selectedIndex]?.[0];
      if (page) setDt({ page });
    };
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, []);
  /* The bottom sheet owns its own open state (show/hide methods, per
     the @m3e/web docs). React never writes the `open` attribute - a
     half-synced attribute would wedge the sheet open or closed after
     an internal dismissal. The component's `closing` event flows back
     into React state instead. */
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const onClosing = () => live.current.onClose();
    el.addEventListener("closing", onClosing);
    return () => el.removeEventListener("closing", onClosing);
  }, []);
  /* Attribute contracts land as attributes (m3eAttrs): React 19
     property-mode assignment unset these features. Runs before the
     show effect so a mount with open=true opens correctly. */
  useLayoutEffect(() => {
    m3eAttrs(sheetRef.current, {
      detents: "fit half full",
      handle: "",
      hideable: "",
    });
  }, []);
  /* #260 user report: a LAYOUT effect, not a passive one. On a
     wedged main thread passive effects starve far behind the
     commit, so the checkbox said open while the sheet never showed.
     The layout effect runs in the commit task itself: state and
     sheet can no longer diverge. */
  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    if (open) {
      el.show();
      /* Content entrance trails the sheet's own slide: nav first. */
      requestAnimationFrame(() => dtEnter(el.querySelector(".lb-dt-nav")));
      /* Row stagger, sheet open only - sub-tool flips use the page
         effect below. Visible rows enter 60ms out plus 24ms per
         position, capped at 12 so a long console stays cheap. */
      requestAnimationFrame(() => {
        const rows = el.querySelectorAll(
          ".lb-dt-page:not([hidden]) .lb-console-line, .lb-dt-page:not([hidden]) .lb-diag-item, .lb-dt-page:not([hidden]) .lb-dt-card"
        );
        rows.forEach((r, i) => {
          if (i < 12) dtEnter(r, 60 + i * 24);
        });
      });
    } else el.hide();
  }, [open]);

  /* Sub-tool switch (and open): the visible page enters with the same
     composite keyframes, 40ms behind the nav. Covers the initial open
     and every console/diagnostics switch alike. */
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() =>
      dtEnter(sheetRef.current?.querySelector(".lb-dt-page:not([hidden])") ?? null, 40));
    return () => cancelAnimationFrame(id);
  }, [dt.page, open]);

  /* Switch stability (2026-11-24 report), first hop: the sheet's
     ResizeObserver refits the raw px height instantly when the
     visible page's height changes (its snap animation is not on that
     path), so the sheet edges snapped once per toggle. The class
     swaps the registered --_bottom-sheet-height property into a
     transition for the switch window only: detent drags keep
     writing the raw height per frame and must never see it, and the
     open entrance (transform slide) never overlaps it. */
  const switchableRef = useRef(false);
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!open) { switchableRef.current = false; return; }
    /* The open run claims the window; only real toggles tween. */
    if (!switchableRef.current) { switchableRef.current = true; return; }
    if (!sheet) return;
    sheet.classList.add("lb-dt-switch");
    const t = setTimeout(() => sheet.classList.remove("lb-dt-switch"), 350);
    return () => clearTimeout(t);
  }, [dt.page, open]);


  /* Stick to the newest line only while the reader is already there. */
  useEffect(() => {
    const el = consoleRef.current;
    if (el && !away) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dt.console.length]);

  const snapshotRef = useRef<DiagnosticsSnapshot | null>(null);
  /* #220: the latest collection status, mirrored for copy/export. */
  const diagStatusRef = useRef<DiagnosticsStatus | null>(null);
  const scope = diagnosticsScope(dt.engineClientId, dt.engineSource);
  /* A mounted instance may be reused across tabs or document navigation. */
  snapshotRef.current = snapshotForScope(snapshotRef.current, scope);

  /* Only this document's page reports and scoped worker snapshot.
     The server session ring spans navigations and remains in App Logs. */
  /* Copy logs is page-aware (2026-11-23): on the Console page it
     copies the console log itself (timestamp + text lines); on
     Diagnostics it serializes the document diagnostics as KDL:
     header, stats, console errors and warnings, resource failures,
     and the full retained event ring. It is the single export path
     since Export and Share to MCP were removed. */
  const copyLogs = async () => {
    let ok: boolean;
    let say: string;
    if (dt.page === "console") {
      ok = await copyText(dt.console.map((c) => ts(c.ts) + " " + c.text).join("\n"));
      say = ok ? "Console copied" : "Copy failed";
    } else {
      const snapshot = snapshotForScope(snapshotRef.current, scope);
      const statusLine = snapshot
        ? "Diagnostics collected."
        : scope
          ? DIAG_STATUS_TEXT[diagStatusRef.current ?? "starting"]
          : "No engine identity for this document yet.";
      ok = await copyText(diagKdl(snapshot, dt.console, dt.fails, statusLine));
      say = ok ? "Diagnostics copied" : "Copy failed";
    }
    /* #262: snackbar confirmation; the inline label alone was easy
       to miss at the sheet edge. */
    if (ok) {
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1200);
    }
    if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
      M3eSnackbar.open(say, { duration: 3000 });
    }
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
      setDt((prev) => ({ console: [...prev.console, { id: nextEntryId(), kind: "error" as const, text: "No proxied page in this tab - navigate to a site first.", ts: Date.now() }].slice(-500) }));
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
      /* Split content origin: the frame is cross-origin, so the
         browser blocks page eval from the app outright. Say what
         works instead of dumping a bare SecurityError stack. */
      const crossOrigin = e.name === "SecurityError";
      setDt((prev) => ({
        console: [
          ...prev.console,
          entry,
          {
            id: nextEntryId(),
            kind: "error" as const,
            text: crossOrigin
              ? "This page rides the split content origin, so the browser blocks the app from executing JavaScript in it. Either run the snippet in the page's own DevTools (F12 on that tab), or turn 'Split content origin' off in the debug menu (five quick Home wordmark clicks), reload the tab, and run it here. Engine zl: commands are unaffected."
              : (e.name || "Error") + ": " + e.message + (e.stack ? "\n" + e.stack : ""),
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

  /* Jump-to-latest FAB: shows once the log is scrolled away from the
     newest line. */
  const [away, setAway] = useState(false);
  const onLogScroll = () => {
    const el = consoleRef.current;
    if (el) setAway(el.scrollTop + el.clientHeight < el.scrollHeight - 48);
  };

  /* Entry count per section, shown on the picker tabs like real
     devtools do. */
  const pageCounts: Record<DtState["page"], number> = {
    console: dt.console.length,
    diagnostics: dt.fails.length,
  };

  return (
    <m3e-bottom-sheet
      handle-label="Dismiss developer tools"
      aria-label="Developer tools"
      {...{ class: "lb-dt-sheet", ref: sheetRef }}
    >
      <m3e-app-bar slot="header" size="small" {...{ class: "lb-sheet-bar" }}>
        <m3e-icon-button slot="leading" aria-label="Back" onClick={() => live.current.onClose()}>
          <m3e-icon name="arrow_back" aria-hidden={true} />
        </m3e-icon-button>
        <span slot="title">DevTools<span className="lb-dt-title-sub">{tab.url ? hostOf(tab.url) : tab.title || "no site"}</span></span>
        {/* #266: Copy logs and Eruda in page moved up here, out of the
            Diagnostics page body: the header keeps them reachable from
            every sub-page and the page body stays cards only. */}
        <m3e-icon-button slot="trailing" id="lb-dt-copy-btn" aria-label="Copy logs" onClick={() => void copyLogs()}>
          <m3e-icon name={copyFlash ? "check" : "content_copy"} aria-hidden={true} />
        </m3e-icon-button>
        <m3e-tooltip for="lb-dt-copy-btn" position="below">Copy logs</m3e-tooltip>
        <ZeoliteEngineTools frame={frame} />
      </m3e-app-bar>

      <div className="lb-dt-content">
        {/* Sub-tool picker (2026-11-23): a real m3e-tabs bar - an
            icon plus label per page, the ink bar and selected tab
            semantics owned by the component. The change event from
            the tablist is mirrored into state (the M3eSelect
            pattern); React never writes the sheet-open attributes. */}
        <div className="lb-dt-nav">
          <m3e-tabs
            aria-label="Developer tools sections"
            {...{ class: "lb-dt-nav-tabs", ref: tabsRef }}
          >
            {PAGES.map(([page, label, icon]) => {
              const on = dt.page === page;
              return (
                <m3e-tab
                  key={page}
                  selected={on}
                  aria-current={on ? "true" : undefined}
                  onClick={() => setDt({ page })}
                >
                  <m3e-icon slot="icon" name={icon} aria-hidden={true} />
                  {label}
                  {(pageCounts[page] ?? 0) > 0 ? " · " + pageCounts[page] : ""}
                </m3e-tab>
              );
            })}
          </m3e-tabs>
        </div>

        {/* Console and Diagnostics render bare (user request
            2026-11-13): the filled cards are gone and the content
            sits directly in the sheet. Both pages stay mounted; the
            sub-tool switch toggles [hidden], so flipping sub-tools
            no longer unmounts and remounts everything. The broken
            Network page is gone entirely (2026-11-23). */}
        <div className="lb-dt-page" hidden={dt.page !== "console"}>
          <div className="lb-console-wrap">
          <div className="lb-console" ref={consoleRef} onScroll={onLogScroll} role="log" aria-label="Console output">
            {/* #94: quiet empty state; a filtered-to-nothing list says
                so instead of implying nothing was ever logged. */}
            {dt.console.length === 0 && (
              <p className="lb-muted lb-console-empty">Console output will appear here.</p>
            )}
            {dt.console.map((c) => (
              <div key={c.id} className={"lb-console-line lb-" + levelOf(c.kind)}>
                <span className="lb-console-ts">{ts(c.ts)}</span>
                <m3e-icon name={KIND_ICON[c.kind]} aria-hidden={true} {...{ class: "lb-console-arrow" }} />
                <span className="lb-console-text">{c.text}</span>
              </div>
            ))}
          </div>
          {away && (
            <m3e-fab size="small" aria-label="Jump to latest" {...{ class: "lb-dt-fab" }}
              onClick={() => { const el = consoleRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }}>
              <m3e-icon name="arrow_downward" aria-hidden={true} />
            </m3e-fab>
          )}
          </div>
          <m3e-divider />
          {/* 2026-11-23: the mop and the duplicate copy button are
              gone. Clearing stays the `clear` command in the input;
              copying rides the header copy button, which copies the
              console log whenever the Console page is open. */}
          <div className="lb-console-input">
            {/* m3e-textarea-autosize grows the console input to fit
                multi-line expressions (Shift+Enter). */}
            <m3e-form-field variant="outlined" {...{ class: "lb-dt-run" }}>
              <label slot="label" htmlFor="lb-dt-console-in">Run JavaScript</label>
              <textarea
                ref={inputRef}
                id="lb-dt-console-in"
                className="lb-console-area"
                value={cmd}
                rows={1}
                spellCheck={false}
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={keyDown}
              />
              <span slot="hint">Enter runs · Shift+Enter adds a line</span>
            </m3e-form-field>
            <m3e-textarea-autosize for="lb-dt-console-in" min-rows={1} max-rows={10} />
            <m3e-button variant="filled" onClick={submit}>
              <m3e-icon slot="icon" name="play_arrow" aria-hidden={true} />
              Execute
            </m3e-button>
          </div>
        </div>

        <div className="lb-dt-page" hidden={dt.page !== "diagnostics"}>
          <ZeoliteDiagnostics
            clientId={dt.engineClientId}
            source={dt.engineSource}
            snapshotRef={snapshotRef}
            statusRef={diagStatusRef}
            active={dt.page === "diagnostics"}
          />
        </div>
      </div>
    </m3e-bottom-sheet>
  );
}
