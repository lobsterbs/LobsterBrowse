/* Embed client: the Scramjet-compatible entry point.
   LobsterBrowse loads <engine-origin>/?url=<target> in a tab iframe; the
   page brings up the engine via the adapter (engine.ts), rehydrates any
   persisted per-site toggles, then navigates the frame to the encoded
   route so all subresource fetches are intercepted. */

import { LobsterJetEngine } from "./engine";
import { encodeDest } from "./codec";

const status = document.getElementById("lj-status")!;
const frame = document.getElementById("lj-frame") as HTMLIFrameElement;

const target = new URLSearchParams(location.search).get("url");

if (!target) {
  status.textContent = "LobsterJet engine. Append ?url=<target> to embed.";
} else {
  void (async () => {
    status.textContent = "Starting engine...";
    const engine = new LobsterJetEngine();
    try {
      await engine.init();
    } catch (err) {
      status.textContent = "Service worker registration failed: " + String(err);
      return;
    }
    if (!navigator.serviceWorker.controller) {
      // First-ever load on this origin: reload once so the SW controls
      // the page, keeping ?url intact.
      location.reload();
      return;
    }
    // Rehydrate persisted per-site toggles into the fresh SW.
    try {
      const disabled = JSON.parse(localStorage.getItem("lj:disabled-sites") ?? "[]") as string[];
      for (const site of disabled) await engine.setSiteRoute(site, false);
    } catch { /* nothing persisted */ }
    status.style.display = "none";
    frame.style.display = "block";
    frame.src = engine.navigate(target);
  })();
}
