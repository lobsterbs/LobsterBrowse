import { useState } from 'react';

export default function HomePage() {
  const [url, setUrl] = useState("");

  return (
    <m3e-content-pane>
      <m3e-heading variant="display" size="large" level={1}>Browse freely</m3e-heading>
      <p style={{ fontSize: 18 }}>Free, private, fast web proxy with built-in ad blocking.</p>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", margin: "16px 0" }}>
        <m3e-form-field variant="outlined" style={{ flex: 1 }}>
          <label slot="label" htmlFor="url">Enter a URL</label>
          <input id="url" value={url} onChange={(e: any) => setUrl(e.target.value)} placeholder="example.com" />
        </m3e-form-field>
        <m3e-button variant="filled" size="large" onClick={() => { (globalThis as any).M3eSnackbar?.open("Proxy backend wiring coming next"); }}>Go</m3e-button>
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
          <m3e-heading slot="header" variant="title" size="large">Rust core</m3e-heading>
          <p slot="content">Clean-room Wisp v2.1 server with SSRF guard and rate limits.</p>
        </m3e-card>
        <m3e-card variant="outlined">
          <m3e-heading slot="header" variant="title" size="large">Session restore</m3e-heading>
          <p slot="content">Continue exactly where you left off, still logged in.</p>
        </m3e-card>
      </div>
    </m3e-content-pane>
  );
}