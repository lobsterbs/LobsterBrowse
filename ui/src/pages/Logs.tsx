/* Technical logs: client-side ring buffer (navigations, proxy results,
   errors) plus the server-side proxy log served from /logs. */

import { useEffect, useState } from "react";
import { clearLogs, getLogs, pushLog, type LogEntry } from "../store";

type ServerLog = { ts: number; level: string; msg: string };

export default function LogsPage({ onBack }: { onBack: () => void }) {
  const [client, setClient] = useState<LogEntry[]>([]);
  const [server, setServer] = useState<ServerLog[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2000);
  };

  const copyText = (label: string, text: string) => {
    if (!navigator.clipboard?.writeText) {
      notify("Clipboard unavailable");
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => notify(label + " copied"))
      .catch(() => notify("Copy failed"));
  };

  useEffect(() => {
    setClient(getLogs());
    let cancelled = false;
    const refresh = () =>
      fetch("/logs", { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then((data: ServerLog[]) => {
          if (!cancelled) {
            setServer(Array.isArray(data) ? data : []);
            setErr(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
        });
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const fmt = (t: number) => new Date(t * 1000).toLocaleTimeString();

  return (
    <section className="lb-view-content" aria-label="Logs">
      <m3e-heading variant="title" size="medium" level={2}>
        <m3e-icon-button aria-label="Back" onClick={onBack}>
          <m3e-icon name="arrow_back" aria-hidden={true} />
        </m3e-icon-button>{" "}
        Logs
      </m3e-heading>
      <p className="lb-muted">Client and server-side proxy events. Not sensitive request data is logged.</p>

      <div className="lb-logs-toolbar">
        <m3e-button
          onClick={() => {
            clearLogs();
            setClient([]);
            pushLog("info", "client log cleared");
          }}
        >
          <m3e-icon name="mop" aria-hidden={true} /> Clear client logs
        </m3e-button>
        <m3e-button
          onClick={() =>
            copyText(
              "Client logs",
              client.map((l) => new Date(l.ts).toISOString() + " " + l.level + " " + l.msg).join("\n")
            )
          }
        >
          <m3e-icon name="content_copy" aria-hidden={true} /> Copy client logs
        </m3e-button>
        <m3e-button
          onClick={() =>
            copyText(
              "Server logs",
              server.map((l) => new Date(l.ts * 1000).toISOString() + " " + l.level + " " + l.msg).join("\n")
            )
          }
        >
          <m3e-icon name="content_copy" aria-hidden={true} /> Copy server logs
        </m3e-button>
      </div>

      <div className="lb-log-section">
        <div className="lb-setting-label">Server proxy log (/logs)</div>
        {err && <p className="lb-error-text">Could not load server logs: {err}</p>}
        <div className="lb-log-list">
          {server.length === 0 && !err && <p className="lb-muted">No server log entries yet.</p>}
          {server.map((l, i) => (
            <div key={i} className={"lb-log-line lb-" + (l.level === "error" ? "error" : l.level === "warn" ? "warn" : "log")}>
              <span className="lb-console-ts">{fmt(l.ts)}</span> <b>{l.level}</b> {l.msg}
            </div>
          ))}
        </div>
      </div>

      <div className="lb-log-section">
        <div className="lb-setting-label">Client log (this device)</div>
        <div className="lb-log-list">
          {client.length === 0 && <p className="lb-muted">No client log entries yet.</p>}
          {client.map((l, i) => (
            <div key={i} className={"lb-log-line lb-" + l.level}>
              <span className="lb-console-ts">{new Date(l.ts).toLocaleTimeString()}</span> <b>{l.level}</b> {l.msg}
            </div>
          ))}
        </div>
      </div>

      {toast && <div className="lb-toast" role="status">{toast}</div>}
    </section>
  );
}
