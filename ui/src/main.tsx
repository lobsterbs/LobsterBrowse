import React from "react";
import ReactDOM from "react-dom/client";
import "@m3e/web/all";
import "material-symbols/outlined.css";
/* Typography is self-hosted too: Google Sans Flex variable, full axis
   set (wght, wdth, opsz, GRAD, ROND, slnt) bundled from npm, no Google
   Fonts CDN request at runtime. */
import "@fontsource-variable/google-sans-flex/full.css";
import App from "./App";
import "./theme.css";

/* #149: a corrupted localStorage value used to throw during render and
   blank the app on every boot with no way out. The loaders validate now;
   this boundary is the last-resort surface. It no longer guesses "stored
   data may be corrupted": it keeps the caught error (message, stack and
   component stack) so the failure screen says what actually broke, with
   reload and copy-details first and the clear-data escape hatch second
   (clearing stored data resets settings, history and tabs). */
class RootBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean; err: Error | null; componentStack: string | null; copied: boolean }
> {
  state: { failed: boolean; err: Error | null; componentStack: string | null; copied: boolean } = {
    failed: false,
    err: null,
    componentStack: null,
    copied: false,
  };
  static getDerivedStateFromError(err: unknown) {
    return { failed: true, err: err instanceof Error ? err : new Error(String(err)) };
  }
  componentDidCatch(_err: unknown, info: { componentStack?: string | null }) {
    this.setState({ componentStack: info?.componentStack ?? null });
  }
  render() {
    if (this.state.failed) {
      const e = this.state.err;
      const detail =
        (e ? e.name + ": " + e.message : "Unknown error") +
        (e && e.stack ? "\n\n" + e.stack : "") +
        (this.state.componentStack ? "\n\nComponent stack:\n" + this.state.componentStack : "");
      const copyDetails = async () => {
        try {
          await navigator.clipboard.writeText(detail);
          this.setState({ copied: true });
        } catch {
          /* clipboard unavailable; the detail block stays selectable */
        }
      };
      return (
        <div style={{ margin: "48px auto", maxWidth: 480, padding: "0 16px", fontFamily: "system-ui", textAlign: "center" }}>
          <h2>LobsterBrowse failed to start</h2>
          <p style={{ margin: 0, color: "#666" }}>
            The browser hit an unexpected error and stopped. This is usually a bug in the app, not a problem with your data. Reloading often brings it back.
          </p>
          <pre
            style={{
              margin: "12px 0",
              padding: 12,
              background: "#f4efef",
              borderRadius: 12,
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
              textAlign: "left",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 220,
              overflow: "auto",
            }}
          >
            {detail}
          </pre>
          <div style={{ display: "grid", gap: 8, justifyItems: "center" }}>
            <button onClick={() => location.reload()}>Reload</button>
            <button onClick={() => void copyDetails()}>{this.state.copied ? "Copied" : "Copy error details"}</button>
            <button
              onClick={() => {
                try {
                  localStorage.clear();
                } catch {
                  /* ignore */
                }
                location.reload();
              }}
            >
              Clear stored data and restart
            </button>
          </div>
          <p style={{ margin: "12px 0 0", color: "#666", fontSize: 13 }}>
            Clearing stored data resets settings, history and tabs. Only use it if reloading keeps failing.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </React.StrictMode>
);
