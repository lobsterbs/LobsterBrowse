/* Embed client: the Scramjet-compatible entry point.
   LobsterBrowse loads <engine-origin>/?url=<target> in a tab iframe; the
   page registers the service worker, then navigates the frame to the
   encoded route so all subresource fetches are intercepted. */

import { encodeDest } from "./codec";

const status = document.getElementById("lj-status")!;
const frame = document.getElementById("lj-frame") as HTMLIFrameElement;

const target = new URLSearchParams(location.search).get("url");

if (!target) {
  status.textContent = "LobsterJet engine. Append ?url=<target> to embed.";
} else {
  void (async () => {
    status.textContent = "Starting engine...";
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      // Take control of this page too, so the embed document itself is
      // managed (not strictly needed for proxied content, but it makes
      // devtools and lifecycle observable).
      if (reg.active && !navigator.serviceWorker.controller) {
        // First load after registration: reload once to become
        // controlled, keeping ?url intact.
        location.reload();
        return;
      }
    } catch (err) {
      status.textContent = "Service worker registration failed: " + String(err);
      return;
    }
    status.style.display = "none";
    frame.style.display = "block";
    frame.src = encodeDest(target);
  })();
}
