import { useEffect, useState } from 'react';

const SERVER_URL = "https://lobsterbrowse-server.onrender.com";

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"checking" | "online" | "offline">("checking");

  useEffect(() => {
    fetch(SERVER_URL + "/healthz", { mode: "cors" })
      .then((r) => setStatus(r.ok ? "online" : "offline"))
      .catch(() => setStatus("offline"));
  }, []);

  const statusChip =
    status === "online" ? "elevated" : "outlined";
  const statusText =
    status === "checking" ? "Checking server..." :
    status === "online" ? "Proxy server online" : "Server asleep (free tier wakes on first request)";

  return (
    <m3e-content-pane>
      <m3e-heading variant="display" size="large" level={1}>Browse freely</m3e-heading>
      <p style={{ fontSize: 18 }}>Free, private, fast web proxy with built-in ad blocking.</p>

      <m3e-chip-set>
        <m3e-chip variant={statusChip} onClick={() => setStatus("checking")}>{statusText}</m3e-chip>
      </m3e-chip-set>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", margin: "16px 0" }}>
        <m3e-form-field variant="outlined" style={{ flex: 1 }}>
          <label slot="label" htmlFor="url">Enter a URL</label>
          <input id="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="example.com" />
        </m3e-form-field>
        <m3e-button variant="filled" size="large" onClick={() => { (globalThis as any).M3eSnackbar?.open("Wisp transport wiring lands with the Scramjet fork — server is live at " + SERVER_URL); }}>Go</m3e-button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 24 }}>
        <m3e-card variant="outlined">
          <m3e-heading slot="header" variant="title" size="large">Zero logging</m3e-heading>
          <p slot="content">No analytics, no request logs, no cookies of our own.</p>
        </m3e-card>
        <m3e-card variant="outlined">
          <m3e-heading slot="header" variant="title" size="large">Ad blocking</m3e-heading>
          <p slot="content">uBlock Origin lists enforced server-side at CONNECT time.</p>
        </m3e-card>
        <m3e-card variant="outlined">
          <m3e-heading slot="header" variant="title" size="large">TCP + UDP relay</m3e-heading>
          <p slot="content">Clean-room Wisp v2.1 server with SSRF guard, rate limits, and UDP datagram relay.</p>
        </m3e-card>
        <m3e-card variant="outlined">
          <m3e-heading slot="header" variant="title" size="large">Session restore</m3e-heading>
          <p slot="content">Continue exactly where you left off, still logged in.</p>
        </m3e-card>
      </div>
    </m3e-content-pane>
  );
}