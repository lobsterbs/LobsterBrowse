import React from "react";
import ReactDOM from "react-dom/client";
import "@m3e/web/all";
/* Self-hosted typography and icon fonts — bundled locally, no CDN. */
import "@fontsource-variable/roboto-flex";
import "material-symbols/outlined.css";
import App from "./App";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
