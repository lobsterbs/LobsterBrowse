/* DevTools panel — real console/network/inspector/storage/scripts views
   for the currently selected proxy tab. Each tab keeps its own state.

   How this works with the document proxy: proxied pages are served
   from the LobsterBrowse origin (/p), rendered in a same-origin iframe.
   That gives the panel real access to the page: JavaScript is executed
   with iframe.contentWindow.eval, and console/network events arrive
   from the hook the server injects into every proxied document. */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Tab } from "../store";

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

export type InjectedScript = { id: number; code: string; autorun: boolean };

export type DtState = {
  open: boolean;
  page: "console" | "network" | "inspector" | "storage" | "scripts";
  console: ConsoleEntry[];
  net: NetEntry[];
  levelFilter: string;
  consoleFilter: string;
  netFilter: string;
  history: string[];
  scripts: InjectedScript[];
};

export function emptyDt(): DtState {
  return {
    open: false,
    page: "console",
    console: [],
    net: [],
    levelFilter: "all",
    consoleFilter: "",
    netFilter: "",
    history: [],
    scripts: [],
  };
}

let entryId = 1;
export function nextEntryId(): number {
  return entryId++;
}

/* ---- Value formatting: expandable objects/arrays, DOM elements ---- */

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

function JsonTree({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const label = name === undefined ? "" : name + ": ";
  if (value !== null && typeof value === "object") {
    let entries: Array<[string, unknown]> = [];
    if (Array.isArray(value)) {
      entries = value.map((v, i) => [String(i), v]);
    } else {
      entries = Object.entries(value as Record<string, unknown>);
    }
    const summary = Array.isArray(value)
      ? `Array(${value.length})`
      : (value as { constructor?: { name?: string } }).constructor?.name || "Object";
    return (
      <details open={depth < 2} style={{ marginLeft: 8 }}>
        <summary style={{ cursor: "pointer", listStyle: "revert" }}>
          {label}
          <span style={{ opacity: 0.6 }}>{summary}</span>
        </summary>
        {entries.map(([k, v]) => (
          <JsonTree key={k} name={k} value={v} depth={depth + 1} />
        ))}
      </details>
    );
  }
  return (
    <div style={{ marginLeft: 8 }}>
      {label}
      <span style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{formatValue(value)}</span>
    </div>
  );
}

function ts(t: number): string {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
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
  ["inspector", "Inspector", "travel_explore"],
  ["storage", "Storage", "database"],
  ["scripts", "Scripts", "code"],
];

export default function DevTools({ tab, dt, setDt, frame, onClose, onOpenLogs }: Props) {
  const [cmd, setCmd] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const [multi, setMulti] = useState(false);
  const [inspectorTick, setInspectorTick] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [dt.console.length]);

  /* Execute JavaScript in the proxied page's context. */
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

  /* Inspector reads, refreshed on demand. */
  const doc = frame()?.contentDocument;
  const win = frame()?.contentWindow;
  const inspect = () => setInspectorTick((t) => t + 1);
  const scriptsList: string[] = doc
    ? Array.from(doc.scripts).map((s) => (s.src ? s.src : "[inline script, " + s.text.length + " chars]"))
    : [];
  const storageKeys = (kind: "localStorage" | "sessionStorage"): string[] => {
    try {
      const s = win?.[kind];
      if (!s) return [];
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) keys.push(s.key(i) ?? "");
      return keys;
    } catch {
      return ["<unavailable>"];
    }
  };
  const cookieValue = (() => {
    try {
      return doc?.cookie || "(none)";
    } catch {
      return "<unavailable>";
    }
  })();

  return (
    <aside className="lb-devtools" aria-label="Developer tools">
      <div className="lb-devtools-head">
        <span className="lb-devtools-title">
          <m3e-icon name="bug_report" aria-hidden={true} /> DevTools — {tab.title || "tab"}
        </span>
        <m3e-icon-button aria-label="Close developer tools" onClick={onClose}>
          <m3e-icon name="close" aria-hidden={true} />
        </m3e-icon-button>
      </div>
      <m3e-divider />
      <m3e-tabs variant="secondary" className="lb-dt-tabs" aria-label="Developer tools sections">
        {PAGES.map(([page, label, icon]) => (
          <m3e-tab
            key={page}
            selected={dt.page === page ? "" : undefined}
            onClick={() => setDt({ page: page })}
          >
            <m3e-icon slot="icon" name={icon} aria-hidden={true} />
            {label}
          </m3e-tab>
        ))}
      </m3e-tabs>

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

      {dt.page === "inspector" && (
        <div className="lb-dt-body">
          <div className="lb-dt-toolbar">
            <m3e-button onClick={inspect}>
              <m3e-icon name="refresh" aria-hidden={true} /> Refresh
            </m3e-button>
          </div>
          {!doc ? (
            <p className="lb-muted">No proxied page in this tab.</p>
          ) : (
            <div className="lb-inspect">
              <div><b>Title:</b> {doc.title || "(none)"}</div>
              <div><b>Ready state:</b> {doc.readyState}</div>
              <div><b>Proxied URL:</b> {tab.url}</div>
              <div><b>Doctype:</b> {doc.doctype ? doc.doctype.name : "(none)"}</div>
              <div><b>Elements:</b> {doc.getElementsByTagName("*").length}</div>
              <div><b>Scripts:</b> {scriptsList.length}</div>
              <ul className="lb-script-list">
                {scriptsList.slice(0, 30).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {dt.page === "storage" && (
        <div className="lb-dt-body">
          <p className="lb-muted">
            The document proxy serves every page from the LobsterBrowse origin, so this is the proxy
            origin's storage — cookies set by target sites are held in the server-side cookie jar, not here.
          </p>
          <div className="lb-inspect">
            <div><b>Cookie (proxy origin):</b> {cookieValue}</div>
            <div><b>localStorage:</b></div>
            <ul className="lb-script-list">
              {storageKeys("localStorage").map((k) => (
                <li key={k}>
                  {k} = {String((win?.localStorage as Storage | null)?.getItem(k) ?? "").slice(0, 120)}
                </li>
              ))}
            </ul>
            <div><b>sessionStorage:</b></div>
            <ul className="lb-script-list">
              {storageKeys("sessionStorage").map((k) => (
                <li key={k}>
                  {k} = {String((win?.sessionStorage as Storage | null)?.getItem(k) ?? "").slice(0, 120)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {dt.page === "scripts" && (
        <div className="lb-dt-body">
          <p className="lb-muted">
            Scripts run in this tab's proxied page context. "Run on page load" executes after each
            navigation of this tab only.
          </p>
          <textarea
            className="lb-input lb-console-area"
            rows={5}
            aria-label="Script source"
            placeholder="// e.g. document.body.style.background = 'red'"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
          />
          <div className="lb-dt-toolbar">
            <m3e-button
              variant="filled"
              onClick={() => {
                if (cmd.trim()) runCode(cmd);
              }}
            >
              <m3e-icon name="play_arrow" aria-hidden={true} /> Execute
            </m3e-button>
            <m3e-button
              onClick={() => {
                if (!cmd.trim()) return;
                setDt({ scripts: [...dt.scripts, { id: nextEntryId(), code: cmd, autorun: false }] });
                setCmd("");
              }}
            >
              <m3e-icon name="save" aria-hidden={true} /> Save
            </m3e-button>
          </div>
          {dt.scripts.length > 0 && (
            <div className="lb-net">
              {dt.scripts.map((s) => (
                <div key={s.id} className="lb-net-row lb-script-item">
                  <code className="lb-script-code">{s.code}</code>
                  <span className="lb-dt-script-run">
                    Run on page load
                    <m3e-switch
                      checked={s.autorun ? "" : undefined}
                      aria-label="Run on page load"
                      onClick={() =>
                        setDt({
                          scripts: dt.scripts.map((x) => (x.id === s.id ? { ...x, autorun: !x.autorun } : x)),
                        })
                      }
                    />
                  </span>
                  <m3e-icon-button aria-label="Run script" onClick={() => runCode(s.code)}>
                    <m3e-icon name="play_arrow" aria-hidden={true} />
                  </m3e-icon-button>
                  <m3e-icon-button
                    aria-label="Delete script"
                    onClick={() => setDt({ scripts: dt.scripts.filter((x) => x.id !== s.id) })}
                  >
                    <m3e-icon name="delete" aria-hidden={true} />
                  </m3e-icon-button>
                </div>
              ))}
            </div>
          )}
          <div className="lb-dt-toolbar">
            <m3e-button onClick={onOpenLogs}>
              <m3e-icon name="history" aria-hidden={true} /> View logs
            </m3e-button>
          </div>
        </div>
      )}
    </aside>
  );
}

/* Expandable result tree used by the console when an expression
   returns an object or array. */
export function ResultTree({ value }: { value: unknown }) {
  return <JsonTree value={value} depth={0} />;
}
