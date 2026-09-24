import { useEffect, useState } from 'react';

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"checking" | "online" | "offline">("checking");

  useEffect(() => {
    // Same origin now: the server serves this UI, so it is awake whenever
    // the page is open. /healthz just confirms it. The check retries every
    // 10s so a transient failure (e.g. deploy rolling over) self-heals.
    let cancelled = false;
    const check = () => {
      fetch("/healthz")
        .then((r) => { if (!cancelled) setStatus(r.ok ? "online" : "offline"); })
        .catch(() => { if (!cancelled) setStatus("offline"); });
    };
    check();
    const timer = setInterval(check, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const dot =
    status === "online" ? "var(--md-sys-color-primary)" :
    status === "checking" ? "var(--md-sys-color-outline)" :
    "var(--md-sys-color-error)";
  const statusText =
    status === "checking" ? "Connecting…" :
    status === "online" ? "Server online" : "Reconnecting…";

  const go = () => {
    (globalThis as any).M3eSnackbar?.open(
      "Browsing arrives with the Wisp client — the relay server is live."
    );
  };

  return (
    <section style={{ textAlign: "center", marginTop: 32 }}>
      <m3e-heading variant="display" size="medium" level={2}>Browse freely</m3e-heading>
      <p style={{ opacity: 0.7, marginTop: 8 }}>Private proxy with ad blocking.</p>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", margin: "32px 0 8px" }}>
        <m3e-form-field variant="outlined" style={{ flex: 1 }}>
          <label slot="label" htmlFor="url">URL</label>
          <input
            id="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") go(); }}
            placeholder="example.com"
          />
        </m3e-form-field>
        <m3e-button variant="filled" onClick={go}>Go</m3e-button>
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", fontSize: 13, opacity: 0.8, marginBottom: 40 }}>
        <span aria-hidden={true} style={{ width: 8, height: 8, borderRadius: "50%", background: dot, display: "inline-block" }} />
        {statusText}
      </div>

      <m3e-chip-set>
        <m3e-chip>No logs</m3e-chip>
        <m3e-chip>Ad blocking</m3e-chip>
        <m3e-chip>TCP + UDP</m3e-chip>
      </m3e-chip-set>
    </section>
  );
}
