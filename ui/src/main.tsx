import React from "react";
import ReactDOM from "react-dom/client";
import "@m3e/web/all";
/* Icon fonts stay self-hosted (npm). Typography now comes from the
   Google Fonts CDN (Google Sans Flex), loaded in index.html. */
import "material-symbols/outlined.css";
import App from "./App";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
