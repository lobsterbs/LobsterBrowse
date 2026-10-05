/* Zeolite service worker plumbing shared by the UI surfaces (the
   Browser extensions panel and the Settings extensions importer).

   The engine bundle is vendored into /zlsw at build time and served
   with Service-Worker-Allowed: /, so it registers at the "/" scope.
   The SW fetch handler passes through every non-engine path, so a
   root scope is safe: only /zl/ (plus the legacy /r/ and /lj/
   prefixes the server redirects to it) and the extension asset
   routes are intercepted, and /zl-ext/, /zl-cs/ asset serving needs
   the wide scope. With no controller on the page (Home, Settings,
   plain tabs) this module is the control plane client. */

async function zlRegFresh(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    /* Always (re-)register: this also fetches the registration for the
       already-installed worker. */
    const reg = await navigator.serviceWorker.register("/zlsw/sw.js", {
      scope: "/",
      type: "module",
    });
    /* Ask the browser to check the server for a newer script so an
       update is at least in flight before we pick a worker. */
    try {
      await reg.update();
    } catch {
      /* update failed (offline): fall through to whatever is installed */
    }
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    return reg;
  } catch (err) {
    console.warn("[lb] Zeolite worker registration failed:", err);
    return null;
  }
}

/* #61: zlSend fires every few seconds (DevTools polls netLog/diag
   at 5s, downloads at 2s), and register() + update() on every call
   meant a sw.js revalidation request each time. One acquisition per
   app boot is enough: the registration handle stays live. A null
   result (registration refused) is NOT cached, so a transient
   failure still retries on the next control message. */
let zlRegCache: Promise<ServiceWorkerRegistration | null> | null = null;

async function zlReg(): Promise<ServiceWorkerRegistration | null> {
  if (!zlRegCache) {
    zlRegCache = zlRegFresh().then((r) => {
      if (!r) zlRegCache = null;
      return r;
    });
  }
  return zlRegCache;
}

/* Worker preference: the one controlling this page (or active) first.
   Its in-memory registry is warm. An installing/waiting instance only
   matters as a fallback: a fresh worker boots with a COLD registry and
   answers registry-dependent control messages ("no such extension")
   until its startup finishes, so it must not win the pick. A stale
   pre-zl worker that answers "unknown message" is handled by the
   escalation in zlSend, not by the pick order. */
function zlPick(reg: ServiceWorkerRegistration): ServiceWorker | null {
  return (
    navigator.serviceWorker.controller ??
    reg.active ??
    reg.waiting ??
    reg.installing ??
    null
  );
}

export async function zlWorker(): Promise<ServiceWorker | null> {
  const reg = await zlReg();
  return reg ? zlPick(reg) : null;
}

/* One-shot control message to a single worker handle: postMessage
   with a MessageChannel port, resolve on the first reply (or null on
   timeout). Never throws. */
function zlSendTo(
  swc: ServiceWorker,
  msg: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, any> | null> {
  return new Promise<Record<string, any> | null>((resolve) => {
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
  });
}

/* One-shot control message: postMessage with a MessageChannel port,
   resolve on the first reply (or null on timeout). Never throws. */
export function zlSend(
  msg: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<Record<string, any> | null> {
  return zlReg().then(async (reg) => {
    if (!reg) return null;
    const primary = zlPick(reg);
    if (!primary) return null;
    const reply = await zlSendTo(primary, msg, timeoutMs);
    /* {ok:false, error:"unknown message"} means the worker that
       answered predates the zl: control messages (the legacy SW,
       still active on a stale session). Escalate ONCE to the newer
       installing/waiting instance that is replacing it. */
    const stale =
      reply !== null &&
      reply.ok === false &&
      reply.error === "unknown message";
    if (!stale) return reply;
    const fresh = reg.installing ?? reg.waiting ?? null;
    if (!fresh || fresh === primary) return reply;
    return zlSendTo(fresh, msg, timeoutMs);
  });
}

/* #53 (#63 adoption): ask the Zeolite worker for an opaque
   initial-navigation handle. The engine (Zeolite #63) answers
   { ok, url } where url is /__zl_navh__/<keyed token> - a route that
   carries the destination nowhere decodable, unlike the legacy
   routeUrl b64u tail. Null on refusal (worker without the feature,
   no route key) or timeout: the caller falls back to routeUrl. */
export async function zlNavHandle(dest: string, timeoutMs = 5000): Promise<string | null> {
  const r = await zlSend({ type: "zl:navHandle", dest }, timeoutMs);
  return r && r.ok === true && typeof r.url === "string" ? r.url : null;
}
