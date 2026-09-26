/* DevTools panel — console / network / inspector for the currently
   selected proxy tab. Each tab keeps its own state.

   Proxied pages are served from the LobsterBrowse origin (/r), rendered
   in a same-origin iframe. That gives the panel real access to the page:
   JavaScript is executed with iframe.contentWindow.eval, and console /
   network events arrive from the hook the server injects into every
   proxied document.

   Built from real M3E components: m3e-card as the container,
   m3e-segmented-button for the section switch, m3e-textinput for the
   edit fields. */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Tab } from "../store";
import { zlSend } from "../zeolite";

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

export type DtState = {
  open: boolean;
  page: "console" | "network" | "inspector" | "diagnostics";
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

/* What the inspector shows for the picked element. */
type Picked = {
  tag: string;
  id: string;
  cls: string;
  text: string;
  style: string;
};

function describe(el: Element): Picked {
  const e = el as HTMLElement;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    cls: el.className && typeof el.className === "string" ? el.className : "",
    text: (e.innerText || "").slice(0, 500),
    style: e.getAttribute("style") || "",
  };
}

type Props = {
  tab: Tab;
  dt: DtState;
  setDt: (patch: Partial<DtState>) => void;
  frame: () => HTMLIFrameElement | null;
  onClose: () => void;
  onOpenLogs: () => void;
};

const PAGES: Array<[DtState["page"], string, string]> = [
  ["console", "Console", "terminal"],
  ["network", "Network", "lan"],
  ["inspector", "Inspect", "travel_explore"],
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

function ZeoliteDiagnostics() {
  const [stats, setStats] = useState<ZlStats | null>(null);
  const [events, setEvents] = useState<ZlDiagEvent[]>([]);
  const diagSeq = useRef(0);

  useEffect(() => {
    let dead = false;
    const tick = async () => {
      const nl = await zlSend({ type: "zl:getNetLog", since: 0 });
      if (!dead && nl && nl.stats) setStats(nl.stats as ZlStats);
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

  if (!stats) return null;
  const notable = events
    .filter((e) => e.severity === "error" || e.severity === "warning" || e.stage === "TRANSPORT_FALLBACK")
    .slice(-25)
    .reverse();
  return (
    <div className="lb-net" style={{ marginBottom: "12px" }}>
      <div className="lb-diag-counts">
        <span className="lb-diag-chip">NativeTransit: {stats.native}</span>
        <span className="lb-diag-chip">RewriteFallback: {stats.fallback} — Alpha</span>
      </div>
      {stats.fallbacks
        .slice(-10)
        .reverse()
        .map((f, i) => (
          <details key={f.ts + "-" + i} className="lb-net-row">
            <summary className="lb-net-summary">
              <span className="lb-net-status lb-bad">FB</span>
              <span className="lb-net-method">{f.reason}</span>
              <span className="lb-net-url">{f.url}</span>
              <span className="lb-net-dur">{ts(f.ts)}</span>
            </summary>
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

export default function DevTools({ tab, dt, setDt, frame, onClose, onOpenLogs }: Props) {
  const [cmd, setCmd] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const [multi, setMulti] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<{ el: HTMLElement; info: Picked } | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [styleDraft, setStyleDraft] = useState("");
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [dt.console.length]);

  /* Stop picking when the panel closes or the section changes. */
  useEffect(() => {
    if (picking) setPicking(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dt.page, dt.open]);

  /* ---- Element picker: hover highlight + click to select, live on the
     proxied document. Same-origin frame, so this is a real DOM access. ---- */
  useEffect(() => {
    if (!picking) return;
    const f = frame();
    if (!f) return;
    let doc: Document | null = null;
    let current: Element | null = null;
    const outline = (el: Element | null, on: boolean) => {
      const e = el as HTMLElement | null;
      if (!e || e === doc?.documentElement || e === doc?.body) return;
      try {
        e.style.outline = on ? "2px solid var(--md-sys-color-primary, #E8552F)" : "";
      } catch {
        /* element belonged to a document that is already gone */
      }
    };
    const onMove = (ev: MouseEvent) => {
      const el = (ev.target as Element | null) ?? null;
      if (el === current) return;
      outline(current, false);
      current = el;
      outline(current, true);
    };
    const onLeave = () => {
      outline(current, false);
      current = null;
    };
    const onClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const el = ev.target as Element;
      outline(current, false);
      current = null;
      setPicking(false);
      if (el instanceof HTMLElement) {
        const info = describe(el);
        setPicked({ el, info });
        setTextDraft(info.text);
        setStyleDraft(info.style);
      }
    };
    const detach = () => {
      if (!doc) return;
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("mouseleave", onLeave, true);
      doc.removeEventListener("click", onClick, true);
      outline(current, false);
      current = null;
      try {
        if (doc.body) doc.body.style.cursor = "";
      } catch {
        /* navigating away already replaced the document */
      }
      doc = null;
    };
    const attach = () => {
      detach();
      doc = frame()?.contentDocument ?? null;
      if (!doc) return;
      doc.addEventListener("mousemove", onMove, true);
      doc.addEventListener("mouseleave", onLeave, true);
      doc.addEventListener("click", onClick, true);
      try {
        if (doc.body) doc.body.style.cursor = "crosshair";
      } catch {
        /* body not ready yet; the load re-attach covers it */
      }
    };
    attach();
    /* The frame's document is replaced on every navigation; re-attach
       so picking survives a mid-pick navigation instead of dying
       silently. */
    f.addEventListener("load", attach);
    return () => {
      f.removeEventListener("load", attach);
      detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking]);

  /* Apply text / style edits live to the picked element. */
  const applyText = (v: string) => {
    setTextDraft(v);
    if (picked) picked.el.innerText = v;
  };
  const applyStyle = (v: string) => {
    setStyleDraft(v);
    if (picked) {
      picked.el.removeAttribute("style");
      if (v.trim()) picked.el.setAttribute("style", v);
    }
  };
  const deletePicked = () => {
    if (picked) picked.el.remove();
    setPicked(null);
  };

  /* ---- Console: real JS eval in the proxied page context. ---- */
  const runCode = (code: string) => {
    const entry = (kind: ConsoleEntry["kind"], text: string) =>
      setDt({ console: [...dt.console, { id: nextEntryId(), kind, text, ts: Date.now() }] });
    const f = frame();
    const w = f?.contentWindow;
    if (!w) {
      entry("error", "No proxied page in this tab — navigate to a site first.");
      return;
    }
    setDt({ console: [...dt.console, { id: nextEntryId(), kind: "input", text: code, ts: Date.now() }] });
    try {
      const result: unknown = (w as unknown as { eval: (c: string) => unknown }).eval(code);
      setDt({
        console: [
          ...dt.console,
          { id: nextEntryId(), kind: "result", text: formatValue(result), ts: Date.now() },
        ],
        history: [...dt.history, code].slice(-100),
      });
    } catch (err) {
      const e = err as Error;
      setDt({
        console: [
          ...dt.console,
          {
            id: nextEntryId(),
            kind: "error",
            text: (e.name || "Error") + ": " + e.message + (e.stack ? "\n" + e.stack : ""),
            ts: Date.now(),
          },
        ],
        history: [...dt.history, code].slice(-100),
      });
    }
  };

  const submit = () => {
    const code = cmd.trim();
    if (!code) return;
    if (code === "clear") {
      setCmd("");
      setDt({ console: [] });
      return;
    }
    runCode(code);
    setCmd("");
    setHistIdx(-1);
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

  /* Failure counts by resource type for the diagnostics summary. */
  const failCounts = dt.fails.reduce<Record<string, number>>((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  }, {});

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
          </m3e-button-segment>
        ))}
      </m3e-segmented-button>

      {dt.page === "console" && (
        <div className="lb-dt-body">
          <div className="lb-dt-toolbar">
            <select
              aria-label="Log level filter"
              value={dt.levelFilter}
              onChange={(e) => setDt({ levelFilter: e.target.value })}
              className="lb-select"
            >
              <option value="all">All levels</option>
              <option value="log">log</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
              <option value="debug">debug</option>
            </select>
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
              onClick={() => navigator.clipboard?.writeText(dt.console.map((c) => ts(c.ts) + " " + c.text).join("\n"))}
            >
              <m3e-icon name="content_copy" aria-hidden={true} />
            </m3e-icon-button>
          </div>
          <div className="lb-console" ref={consoleRef}>
            {consoleEntries.length === 0 && (
              <p className="lb-muted">Console is empty. Expressions run in the proxied page context.</p>
            )}
            {consoleEntries.map((c) => (
              <div key={c.id} className={"lb-console-line lb-" + levelOf(c.kind)}>
                <span className="lb-console-ts">{ts(c.ts)}</span>
                <span className="lb-console-arrow">{c.kind === "input" ? "›" : c.kind === "result" ? "‹" : levelOf(c.kind)}</span>
                <span className="lb-console-text">{c.text}</span>
              </div>
            ))}
          </div>
          <div className="lb-console-input">
            <textarea
              ref={inputRef}
              className="lb-input lb-console-area"
              aria-label="Console input"
              placeholder="Run JavaScript in this page — e.g. document.title"
              value={cmd}
              rows={multi ? 4 : 1}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={keyDown}
            />
            <m3e-button variant="filled" onClick={submit}>Run</m3e-button>
            <m3e-icon-button
              toggle
              selected={multi ? "" : undefined}
              aria-label="Toggle multiline input"
              onClick={() => setMulti(!multi)}
            >
              <m3e-icon name="expand" aria-hidden={true} />
            </m3e-icon-button>
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
          <div className="lb-net">
            {netEntries.length === 0 && <p className="lb-muted">No requests captured yet.</p>}
            {netEntries.map((n) => (
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
        </div>
      )}

      {dt.page === "diagnostics" && (
        <div className="lb-dt-body">
          <div className="lb-dt-toolbar">
            <m3e-icon-button aria-label="Clear diagnostics" onClick={() => setDt({ fails: [] })}>
              <m3e-icon name="mop" aria-hidden={true} />
            </m3e-icon-button>
          </div>
          <p className="lb-muted" style={{ margin: "0 8px 4px" }}>
            Why didn&apos;t this load? Every entry below is a real load failure captured from the page
            runtime (the engine shim&apos;s resfail reports). Successful loads are in the Network section.
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
                    <span className="lb-net-url">{f.url || "(no URL)"}</span>
                    {f.status !== undefined && f.status !== 0 && <span className="lb-net-dur">{f.status}</span>}
                  </summary>
                  <div className="lb-net-detail">
                    <div>Reason: {reasonText(f.reason)} ({f.reason})</div>
                    <div>Resource type: {f.kind}</div>
                    {f.status !== undefined && <div>HTTP status: {f.status}</div>}
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

      {dt.page === "inspector" && (
        <div className="lb-dt-body">
          <div className="lb-dt-toolbar">
            <m3e-button
              variant={picking ? "filled" : "tonal"}
              onClick={() => setPicking(!picking)}
            >
              <m3e-icon name="highlight_alt" aria-hidden={true} />
              {picking ? "Click an element…" : "Pick element"}
            </m3e-button>
            {picked && (
              <>
                <m3e-button onClick={() => setPicked(null)}>
                  <m3e-icon name="close" aria-hidden={true} /> Deselect
                </m3e-button>
                <m3e-button variant="tonal" onClick={deletePicked}>
                  <m3e-icon name="delete" aria-hidden={true} /> Delete element
                </m3e-button>
              </>
            )}
          </div>
          {!frame()?.contentDocument ? (
            <p className="lb-muted">No proxied page in this tab.</p>
          ) : picking ? (
            <p className="lb-muted">
              Move the mouse over the page to highlight an element, then click to select and edit it here.
            </p>
          ) : picked ? (
            <div className="lb-inspect">
              <div className="lb-inspect-id">
                <m3e-icon name="code" aria-hidden={true} />
                <code>
                  &lt;{picked.info.tag}
                  {picked.info.id ? ' id="' + picked.info.id + '"' : ""}
                  {picked.info.cls ? ' class="' + picked.info.cls + '"' : ""}
                  &gt;
                </code>
              </div>
              <label className="lb-inspect-label" htmlFor="lb-dt-text">Text content</label>
              <textarea
                id="lb-dt-text"
                className="lb-input lb-console-area"
                rows={3}
                value={textDraft}
                onChange={(e) => applyText(e.target.value)}
              />
              <label className="lb-inspect-label" htmlFor="lb-dt-style">Inline style (CSS)</label>
              <textarea
                id="lb-dt-style"
                className="lb-input lb-console-area"
                rows={3}
                placeholder="e.g. color: red; font-size: 24px;"
                value={styleDraft}
                onChange={(e) => applyStyle(e.target.value)}
              />
              <p className="lb-muted">Edits apply live to the proxied page. They vanish on the next navigation.</p>
            </div>
          ) : (
            <div className="lb-inspect">
              <div><b>Title:</b> {frame()?.contentDocument?.title || "(none)"}</div>
              <div><b>Proxied URL:</b> {tab.url}</div>
              <div><b>Elements:</b> {frame()?.contentDocument?.getElementsByTagName("*").length ?? 0}</div>
              <p className="lb-muted">Press "Pick element", then hover and click anything on the page to edit its text and inline style.</p>
            </div>
          )}
        </div>
      )}
    </m3e-card>
  );
}
