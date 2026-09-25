import React from "react";
import ReactDOM from "react-dom/client";
import "@m3e/web/all";
import "material-symbols/outlined.css";
/* Typography is self-hosted too: Google Sans Flex variable (wght + wdth
   axes) bundled from npm, no Google Fonts CDN request at runtime. */
import "@fontsource-variable/google-sans-flex/standard.css";
import App from "./App";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
