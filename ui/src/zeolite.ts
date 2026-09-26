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
  try {
    /* Always (re-)register: this also fetches the registration for the
       already-installed worker. */
    const reg = await navigator.serviceWorker.register("/zlsw/sw.js", {
      scope: "/",
      type: "module",
    });
    /* Root cause of "Import failed: unknown message": a STALE worker
       that controls this page (registered before the zl: control
       messages existed) used to win, and it answers every control
       message with "unknown message". Ask the browser to check the
       server for a newer script, then prefer the NEWEST worker
       instance: installing/waiting beat active/controller, because a
       control message works against any worker instance, not just the
       one controlling this page. */
    try {
      await reg.update();
    } catch {
      /* update failed (offline): fall through to whatever is installed */
    }
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    return (
      reg.installing ??
      reg.waiting ??
      reg.active ??
      navigator.serviceWorker.controller ??
      null
    );
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
