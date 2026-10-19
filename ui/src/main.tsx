import React from "react";
import ReactDOM from "react-dom/client";
/* Register the M3E set used by the app shell and Home. Lazy pages
   register their own components when their chunks load. */
import "@m3e/web/button";
import "@m3e/web/button-group";
import "@m3e/web/chips";
import "@m3e/web/dialog";
import "@m3e/web/icon";
import "@m3e/web/icon-button";
import "@m3e/web/loading-indicator";
import "@m3e/web/nav-bar";
import "@m3e/web/nav-rail";
import "@m3e/web/search";
import "@m3e/web/snackbar";
import "@m3e/web/theme";
import "material-symbols/outlined.css";
/* Typography is self-hosted too: Google Sans Flex variable (wght + wdth
   axes) bundled from npm, no Google Fonts CDN request at runtime. */
import "@fontsource-variable/google-sans-flex/standard.css";
import App from "./App";
import "./theme.css";

/* #149: a corrupted localStorage value used to throw during render and
   blank the app on every boot with no way out. The loaders validate now;
   this boundary is the last-resort surface with an honest escape hatch
   (clearing stored data resets settings, history and tabs). */
class RootBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div style={{ margin: "48px auto", maxWidth: 420, fontFamily: "system-ui", textAlign: "center" }}>
          <h2>LobsterBrowse failed to start</h2>
          <p>Stored app data may be corrupted. Clearing it resets settings, history and tabs.</p>
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
