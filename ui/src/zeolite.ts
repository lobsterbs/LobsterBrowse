/* Zeolite service worker plumbing shared by the UI surfaces (the
   Browser extensions panel and the Settings extensions importer).

   The engine bundle is vendored into /zlsw at build time and served
   with Service-Worker-Allowed: /, so it registers at the "/" scope.
   The SW fetch handler passes through every non-engine path, so a
   root scope is safe: only /zl/ and the extension asset routes are
   intercepted, and /zl-ext/, /zl-cs/ asset serving needs the wide
   scope. With no controller on the page (Home, Settings,
   plain tabs) this module is the control plane client. */

import { loadDebugOverrides } from "./debug";

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

/* #142 (LB): engine handoff broadcasts (zl:downloadOp, zl:notifyOp,
   zl:engineUpdate, zl:relayLost) arrive as container message events,
   and the ServiceWorkerContainer is an EventTarget any same-origin
   frame can dispatch synthetic events on. Accept them only when the
   source is the engine worker itself. Honest limit: a hostile
   same-origin page can still pass this by forging source as the
   controller object; the complete fix is an engine-side MessageChannel
   port or the #107 origin-isolation work. This check still stops every
   other window, frame and lazy forgery at the boundary. */
export const engineSwSource = (ev: MessageEvent): boolean => {
  const s = ev.source;
  return s instanceof ServiceWorker && new URL(s.scriptURL).pathname === "/zlsw/sw.js";
};

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
    let timer = 0;
    /* #221: one idempotent terminal path: clear the timer, drop the
       port callback and close BOTH ports (close detaches onmessage),
       then resolve. Safe to call twice. */
    const finish = (v: Record<string, any> | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try { ch.port1.close(); } catch { /* already closed */ }
      try { ch.port2.close(); } catch { /* detached by transfer */ }
      resolve(v);
    };
    ch.port1.onmessage = (ev) => finish(ev.data as Record<string, any>);
    /* Install the timer BEFORE dispatch: a synchronous reply or a
       synchronous dispatch failure can no longer strand it. */
    timer = window.setTimeout(() => finish(null), timeoutMs);
    try {
      swc.postMessage(msg, [ch.port2]);
    } catch {
      finish(null);
    }
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

/* LB#66 cold-start gate: the engine only serves a doc route once an
   ACTIVE worker intercepts it. On the first app load the worker is
   still installing, so the nav-handle mint times out and the tab
   falls back to the legacy b64u route - which lands the SW-less
   "Load failed" page until poll recovery re-drives seconds later.
   Wait for an active registration once per app boot before the
   first mint; the per-mint zlNavHandle timeout stays short. Resolves
   (never rejects) so the fallback chain is unchanged. */
let zlActiveWait: Promise<void> | null = null;

export function zlWaitActive(timeoutMs = 10000): Promise<void> {
  if (!zlActiveWait) {
    zlActiveWait = (async () => {
      if (!("serviceWorker" in navigator)) return;
      try {
        await navigator.serviceWorker.register("/zlsw/sw.js", {
          scope: "/",
          type: "module",
        });
      } catch {
        return;
      }
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    })();
  }
  return zlActiveWait;
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

/* Zeolite #137 embedder fetch relay. The engine asks the embedder
   origin to fetch for hosts whose wasm TLS ClientHello is
   fingerprint-blocked (policy route "relay"); this server route
   performs them with native TLS and its own SSRF validation.
   Channel: the SW sends {type:"zl:fetchRelay", rid, dest,
   method, headers, body} over the registered port and this
   handler answers head/chunk/end/error frames on the same port
   (Zeolite #145 adds the outbound zl:relayCancel frame: the engine
   aborting a fetch aborts this side's /zlrelay request)
   (Zeolite #470 adds credit flow: the engine grants bytes and this
   side pauses the stream when they run out)
   (the {ok:true} registration ack rides it too - ignored here).
   Re-registering is idempotent; a worker restart drops the port
   (the engine falls back to its own transport with a DIAG), so
   call again on controllerchange. */
function u8ToB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) {
    s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/* #218: relay state is scoped to the registration channel (the
   MessagePort), never globally by rid: each worker instance starts
   its own rid sequence, and a global rid map let one channel's
   cancel abort another channel's same-numbered fetch. */
type RelayChannel = {
  controllers: Map<number, AbortController>;
  creditSinks: Map<number, (bytes: number) => void>;
};

/* Zeolite #470 producer half: the engine's relay transport grants
   byte credits (upfront after zl:fetchRelay, then per drained chunk)
   and this side must pause when they run out, or a page that stops
   draining gets its port flooded. Chunk frames are sliced to 256 KiB
   so grants map to bounded byte counts. Credit mode arms only after
   the FIRST grant: a legacy engine never grants, and it must keep
   streaming exactly as before (no stall). */
const RELAY_CREDIT_FRAME = 256 * 1024;

async function zlRelayFetch(
  m: { rid: number; dest: string; method: string; headers: Array<[string, string]>; body?: unknown },
  port: MessagePort,
  chan: RelayChannel,
): Promise<void> {
  const rid = m.rid;
  /* Zeolite #145: the engine can abort a relayed fetch (page
     AbortController, navigation away). Aborting this fetch drops the
     /zlrelay connection, which drops the server-side upstream request
     mid-flight instead of streaming it to nobody. */
  const ac = new AbortController();
  chan.controllers.set(rid, ac);
  /* #470: the credit sink must be live BEFORE the first await: the
     engine posts its upfront grant as soon as zl:fetchRelay lands,
     which can precede the /zlrelay response. */
  let credit = 0;
  let creditArmed = false;
  let wake: (() => void) | null = null;
  const sink = (bytes: number) => {
    if (bytes > 0) credit += bytes;
    creditArmed = true;
    const w = wake;
    wake = null;
    if (w) w();
  };
  chan.creditSinks.set(rid, sink);
  const waitForCredit = () =>
    new Promise<void>((res) => {
      const onAbort = () => {
        ac.signal.removeEventListener("abort", onAbort);
        wake = null;
        res();
      };
      ac.signal.addEventListener("abort", onAbort, { once: true });
      wake = () => {
        ac.signal.removeEventListener("abort", onAbort);
        res();
      };
    });
  const fail = (error: string) => port.postMessage({ type: "zl:relayError", rid, error });
  try {
    const body =
      typeof m.body === "string"
        ? m.body
        : m.body instanceof ArrayBuffer
          ? u8ToB64(new Uint8Array(m.body))
          : undefined;
    const relayBody = JSON.stringify({
      dest: m.dest,
      method: m.method,
      headers: m.headers,
      ...(typeof m.body === "string" ? { body } : {}),
      ...(typeof body === "string" && typeof m.body !== "string" ? { body_b64: body } : {}),
    });
    /* #157: a 429 rate-window or 503 concurrency rejection is transient;
       retry with backoff instead of failing the rid, which would drop the
       engine fetch onto the doomed wisp fallback. Bounded so the honest
       error still fires; other statuses fail immediately as before. */
    let resp: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      const r = await fetch("/zlrelay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ac.signal,
        body: relayBody,
      });
      const st = Number(r.headers.get("x-zl-relay-status"));
      if (Number.isFinite(st) && st > 0) {
        resp = r;
        break;
      }
      if ((r.status === 429 || r.status === 503) && attempt < 5) {
        try {
          if (r.body) await r.body.cancel();
        } catch {
          /* the rejected body is already gone */
        }
        await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
        if (ac.signal.aborted) throw new Error("relay aborted during retry");
        continue;
      }
      throw new Error("relay endpoint unavailable (" + r.status + ")");
    }
    if (!resp) throw new Error("relay endpoint unavailable");
    const status = Number(resp.headers.get("x-zl-relay-status"));
    const headers = JSON.parse(resp.headers.get("x-zl-relay-headers") || "[]");
    const setCookies = JSON.parse(resp.headers.get("x-zl-relay-set-cookie") || "[]");
    port.postMessage({ type: "zl:relayHead", rid, status, statusText: "", headers, setCookies });
    if (!resp.body) {
      port.postMessage({ type: "zl:relayEnd", rid });
      return;
    }
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      for (let off = 0; off < value.length; ) {
        if (creditArmed && credit <= 0) {
          await waitForCredit();
          if (ac.signal.aborted) throw new Error("relay aborted awaiting credit");
          continue;
        }
        const n = Math.min(RELAY_CREDIT_FRAME, value.length - off);
        port.postMessage({ type: "zl:relayChunk", rid, bytes: value.slice(off, off + n) });
        if (creditArmed) credit -= n;
        off += n;
      }
    }
    port.postMessage({ type: "zl:relayEnd", rid });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    /* Only drop our own controller/sink: a reused rid must not remove
       the entry of a newer fetch, or its cancel would become a no-op. */
    if (chan.creditSinks.get(rid) === sink) chan.creditSinks.delete(rid);
    if (chan.controllers.get(rid) === ac) chan.controllers.delete(rid);
  }
}

export function zlRelayInit(): void {
  void zlWorker().then((sw) => {
    if (!sw) return;
    const ch = new MessageChannel();
    /* #218: the channel object is the relay state's whole scope:
       cancel and credit frames route only inside the port they
       arrived on, so two live registrations (a worker restart
       overlap) can never collide on rid. */
    const chan: RelayChannel = { controllers: new Map(), creditSinks: new Map() };
    ch.port1.onmessage = (ev) => {
      const m = ev.data as { type?: string; rid?: number };
      if (m && m.type === "zl:fetchRelay" && typeof m.rid === "number") {
        void zlRelayFetch(ev.data, ch.port1, chan);
      } else if (m && m.type === "zl:relayCancel" && typeof m.rid === "number") {
        chan.controllers.get(m.rid)?.abort();
      } else if (m && m.type === "zl:relayCredit" && typeof m.rid === "number") {
        /* #470: grant frames from the engine; bytes are advisory. */
        chan.creditSinks.get(m.rid)?.(Number((m as { bytes?: unknown }).bytes) || 0);
      }
    };
    /* credits:1 advertises this producer honors the credit protocol;
       a legacy engine ignores the field and registration is by port. */
    sw.postMessage({ type: "zl:relayRegister", credits: 1 }, [ch.port2]);
  });
}

/* Zeolite #168: announce the wisp transit endpoint for the per-host
   policy route "wisp". The engine opens a secondary wisp client on
   the announced ws(s):// URL (the public ScramJet wisp-js
   backend; empty honestly when unset). An empty string withdraws the
   endpoint and the route falls back to the default (relay). */
export function zlWispInit(url: string): void {
  void zlWorker().then((sw) => {
    if (!sw) return;
    sw.postMessage({ type: "zl:wispRegister", url });
  });
}

/* #107: the provisioned content origin for proxied documents
   (ZL_CONTENT_ORIGIN on the server, announced by /build). Empty
   until the operator provisions a second hostname for this service;
   the UI keeps its same-origin frame design until then, and the
   frame message handler accepts only this origin in addition to
   the app origin. */
let contentOrigin = "";

export function zlSetContentOrigin(o: string): void {
  contentOrigin = o;
}

export function zlContentOrigin(): string {
  return contentOrigin;
}

/* #191 boot race: the app learns the content origin from the /build
   boot fetch; a navigation that fires before it resolves must not
   commit proxied content on the app origin while the deployment
   provisions one. The boot effect announces the outcome (the origin,
   empty string when none or the fetch failed) exactly once;
   initialRoute waits for it with a bound. */
let contentAnnounced: ((o: string) => void) | null = null;
const contentAnnounce = new Promise<string>((res) => {
  contentAnnounced = res;
});
export function zlAnnounceContentOrigin(o: string): void {
  zlSetContentOrigin(o);
  if (contentAnnounced) {
    const r = contentAnnounced;
    contentAnnounced = null;
    r(o);
  }
}
export function zlContentAnnounced(): Promise<string> {
  return contentAnnounce;
}

/* Register the engine service worker on the content origin by
   embedding its /zlsw-register page in a hidden iframe (a page can
   only register workers for its own origin). The register page also
   opens the relay channel and announces the wisp endpoint for that
   origin's own worker instance, then posts one origin-validated
   ack. #107: the iframe STAYS embedded (hidden, never navigated,
   the same invariant as the app origin's channel owner) so its
   zl:relayLost self-heal keeps the content origin's channel alive
   across worker restarts. Idempotent. */
let contentReady: Promise<void> | null = null;

/* Split-origin navigation readiness (#107): resolves when the
   register page acks, or after a 30s bound (a free-tier cold start
   or an outage) so a pending navigation degrades to an honest load
   instead of hanging the tab. Resolves, never rejects. */
export function zlContentReady(): Promise<void> {
  return contentReady ?? Promise.resolve();
}

/* #107: prefix a same-origin engine route with the provisioned
   content origin for frame sources, so proxied documents never
   render on the app origin. Non-relative hrefs pass through. */
export function zlContentHref(href: string): string {
  /* Debug override: split === false keeps frames on the app origin
     (the pre-split architecture; the app worker then owns them).
     Existing tabs keep their origin until their next navigation. */
  if (loadDebugOverrides().split === false) return href;
  const co = contentOrigin;
  return co && href.startsWith("/") ? co + href : href;
}

/* Injector phase 2 (per-origin config): the boot-page window once it
   acks registration. The app forwards the same zl:config it pushes
   to the app-origin worker through this frame; the boot page relays
   it over its own control port and acks (zlCfgAck), so a silent
   drop stays detectable. Resolves false when no content origin is
   provisioned or the ack never lands; never throws. */
let contentFrameWin: Window | null = null;
let contentRegState: "none" | "ready" | "failed" = "none";
/* #222: explicit handshake state for diagnostics. "failed" means
   the boot page answered ok:false or the 30s bound expired: content
   queries stay unavailable instead of faking a ready channel. */
export function zlContentRegState(): "none" | "ready" | "failed" {
  return contentRegState;
}

export async function zlContentConfig(cfg: Record<string, unknown>): Promise<boolean> {
  await zlContentReady();
  const co = contentOrigin;
  const w = contentFrameWin;
  if (!co || !w) return false;
  /* The LB#15 installing-worker drop class applies to the content
     worker too (a cold free-tier boot can outlast one shot), so
     retry until an explicit ok ack or the bound is spent. */
  for (const d of [0, 3000, 8000]) {
    if (d) await new Promise((res) => setTimeout(res, d));
    const ok = await new Promise<boolean>((resolve) => {
      const onAck = (ev: MessageEvent) => {
        if (ev.origin !== co) return;
        const dd = ev.data as { zlCfgAck?: boolean; ok?: boolean } | null;
        if (!dd || dd.zlCfgAck !== true) return;
        window.removeEventListener("message", onAck);
        window.clearTimeout(t);
        resolve(dd.ok === true);
      };
      window.addEventListener("message", onAck);
      const t = window.setTimeout(() => {
        window.removeEventListener("message", onAck);
        resolve(false);
      }, 10000);
      try {
        w.postMessage({ zlCfg: cfg }, co);
      } catch {
        window.removeEventListener("message", onAck);
        window.clearTimeout(t);
        resolve(false);
      }
    });
    if (ok) return true;
  }
  return false;
}

/* #194/#195: control-plane query to the CONTENT worker, relayed by
   the boot page (its only same-origin client). Returns the
   worker's reply, or null when no content origin is provisioned,
   the boot page is not ready, or the bound expires. Never
   throws. */
let contentQuerySeq = 0;

export async function zlContentQuery(
  msg: Record<string, unknown>,
  boundMs = 8000,
): Promise<Record<string, unknown> | null> {
  await zlContentReady();
  const co = contentOrigin;
  const w = contentFrameWin;
  if (!co || !w) return null;
  const zlId = ++contentQuerySeq;
  return new Promise((resolve) => {
    const onReply = (ev: MessageEvent) => {
      if (ev.origin !== co || ev.source !== w) return;
      const d = ev.data as { zlQueryReply?: boolean; zlId?: number; zlRes?: Record<string, unknown> } | null;
      if (!d || d.zlQueryReply !== true || d.zlId !== zlId) return;
      window.removeEventListener("message", onReply);
      window.clearTimeout(t);
      resolve(d.zlRes ?? null);
    };
    window.addEventListener("message", onReply);
    const t = window.setTimeout(() => {
      window.removeEventListener("message", onReply);
      resolve(null);
    }, boundMs);
    try {
      w.postMessage({ zlQuery: msg, zlId }, co);
    } catch {
      window.removeEventListener("message", onReply);
      window.clearTimeout(t);
      resolve(null);
    }
  });
}

export function zlContentRegister(co: string): void {
  if (document.querySelector("iframe[data-lb-zlreg]")) return;
  const f = document.createElement("iframe");
  f.setAttribute("data-lb-zlreg", "1");
  f.style.display = "none";
  contentReady = new Promise<void>((resolve) => {
    let deadline = 0;
    /* #222: every terminal path funnels through done(), which clears
       the deadline and listener exactly once. Failure (ok:false or
       the 30s bound) leaves contentFrameWin null so queries stay
       unavailable, and records an explicit state. */
    const done = (ok: boolean) => {
      window.clearTimeout(deadline);
      window.removeEventListener("message", onMsg);
      contentRegState = ok ? "ready" : "failed";
      if (ok) contentFrameWin = f.contentWindow;
      resolve();
    };
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== co) return;
      if (ev.source !== f.contentWindow) return;
      const d = ev.data as { zlReg?: boolean; ok?: boolean } | null;
      if (!d || d.zlReg !== true) return;
      if (d.ok !== true) { done(false); return; }
      /* #107 phase 2: introduce the app to the boot page; its worker
         stores the embedder origin so proxied frames can sync URL and
         title (the boot page re-registers it on its relayLost heal). */
      try { f.contentWindow?.postMessage({ zlRegAsk: true }, co); } catch { /* cold frame: the heal covers it */ }
      done(true);
    };
    window.addEventListener("message", onMsg);
    deadline = window.setTimeout(() => done(false), 30000);
  });
  f.src = co + "/zlsw-register";
  document.body.appendChild(f);
}

/* #477 wave 3: the Zeolite SW cannot create workers itself, so guest
   service-worker realms spawn on the engine-origin guest-host page.
   Keep one hidden guest-host iframe open per engine origin (app plus
   content when split-origin is active). The page connects itself to
   its own service worker (zl:guestHost) and stays embedded so guests
   survive app navigation. Idempotent; best-effort, no ack needed. */
export function zlGuestHost(co: string | null): void {
  const open = (src: string) => {
    if (document.querySelector('iframe[data-lb-zlguest="' + src + '"]')) return;
    const f = document.createElement("iframe");
    f.setAttribute("data-lb-zlguest", src);
    f.style.display = "none";
    f.src = src;
    document.body.appendChild(f);
  };
  open("/guest-host.html");
  if (co) open(co + "/guest-host.html");
}
