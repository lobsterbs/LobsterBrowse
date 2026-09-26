/* Zeolite service worker plumbing shared by the UI surfaces (the
   Browser extensions panel and the Settings extensions importer).

   The engine bundle is vendored into /zlsw at build time and served
   with Service-Worker-Allowed: /, so it registers at the "/" scope.
   The SW fetch handler passes through every non-engine path, so a
   root scope is safe: only /r/, /lj/ and the extension asset routes
   are intercepted, and /zl-ext/, /zl-cs/ asset serving needs the
   wide scope. With no controller on the page (Home, Settings, plain
   tabs) this module is the control plane client. */

export async function zlWorker(): Promise<ServiceWorker | null> {
  if (!("serviceWorker" in navigator)) return null;
  /* The worker that already controls this page wins (engine tabs). */
  const ctrl = navigator.serviceWorker.controller;
  if (ctrl) return ctrl;
  try {
    /* ES module build (static chunk imports): module or the browser
       rejects the script outright. */
    const reg = await navigator.serviceWorker.register("/zlsw/sw.js", {
      scope: "/",
      type: "module",
    });
    /* Fresh install: give activation a moment, but never hang. */
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    return reg.active ?? reg.waiting ?? reg.installing ?? null;
  } catch (err) {
    console.warn("[lb] Zeolite worker registration failed:", err);
    return null;
  }
}

/* One-shot control message: postMessage with a MessageChannel port,
   resolve on the first reply (or null on timeout). Never throws. */
export function zlSend(
  msg: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<Record<string, any> | null> {
  return zlWorker().then(
    (swc) =>
      new Promise<Record<string, any> | null>((resolve) => {
        if (!swc) {
          resolve(null);
          return;
        }
        const ch = new MessageChannel();
        let settled = false;
        const finish = (v: Record<string, any> | null) => {
          if (settled) return;
          settled = true;
          resolve(v);
        };
        ch.port1.onmessage = (ev) => finish(ev.data as Record<string, any>);
        setTimeout(() => finish(null), timeoutMs);
        swc.postMessage(msg, [ch.port2]);
      }),
  );
}
