/* ScramJet 2.0 (MercuryWorkshop) - the upstream proxy engine,
   driven from the LB UI. The server vendors the published client
   bundle same-origin under /sj/ (Dockerfile sj-builder stage); this
   module registers the controller worker at the /sj/ scope (it never
   competes with the Zeolite root worker: the browser hands each
   fetch to the longest matching scope), loads the controller API,
   creates the libcurl transport against the ScramJet wisp backend
   (the LB /wisp/ endpoint requires password auth the upstream client
   cannot send) and wraps every tab iframe in an upstream controller
   frame. Everything here mirrors the upstream
   @mercuryworkshop/proxy-bootstrap client (packages/bootstrap/src/
   client.ts in the scramjet repo): no rewriter code lives in this
   repo. */

import { setSjPrefix } from "./settings";

type SjBuildInfo = { sjWisp?: string };

/* The minimal upstream shapes this module drives (controller.api.js
   ships untyped). Route shape: the controller owns
   /sj/r/<controller id>/ and every frame it wraps owns
   /sj/r/<controller id>/<frame id>/<encodeURIComponent target>. The
   controller SW forwards any fetch under the controller prefix to the
   controller, which finds the frame by pathname prefix - a request
   matching no frame prefix answers 500 "No frame found for request",
   so a frame per tab iframe is mandatory, not optional. */
type SjFrameApi = {
  prefix: string;
  go(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
};
type SjControllerApi = {
  prefix: string;
  wait?: () => Promise<void>;
  createFrame(element?: HTMLIFrameElement): SjFrameApi;
};

let initPromise: Promise<void> | null = null;
let controller: SjControllerApi | null = null;

/* One upstream frame per tab iframe element: the SW matches requests
   by route prefix, so the same element must always answer to the same
   frame, and a remounted element needs a fresh one. Closed tabs keep
   their frame in the upstream list (the controller API has no
   destroy); ponytail: the list grows with tab churn, dead frames
   match no future navigation - add a destroy if upstream ships one. */
const frameCache = new WeakMap<HTMLIFrameElement, SjFrameApi>();

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

/* Register /sj/sw.js and wait for activation. No window lives under
   the /sj/ scope, so the worker activates immediately; a 10s timeout
   fails honestly instead of hanging navigation. */
async function activateWorker(): Promise<ServiceWorker> {
  const reg = await navigator.serviceWorker.register("/sj/sw.js");
  const sw = reg.active ?? reg.waiting ?? reg.installing;
  if (!sw) throw new Error("scramjet worker did not install");
  if (sw.state === "activated") return sw;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("scramjet worker activation timeout")), 10000);
    sw.addEventListener("statechange", () => {
      if (sw.state === "activated") {
        clearTimeout(t);
        resolve();
      } else if (sw.state === "redundant") {
        clearTimeout(t);
        reject(new Error("scramjet worker redundant"));
      }
    });
  });
  return sw;
}

async function doInit(): Promise<void> {
  const build = (await fetch("/build?t=" + Date.now(), { cache: "no-store" }).then((r) => r.json())) as SjBuildInfo;
  const wisp = build.sjWisp ?? "";
  if (!wisp) throw new Error("scramjet wisp url not configured on this deployment");
  const sw = await activateWorker();
  /* Same script order as the upstream bootstrap client. */
  await loadScript("/sj/scramjet.js");
  await loadScript("/sj/controller.api.js");
  await loadScript("/sj/scramjet-utils.js");
  await loadScript("/sj/libcurl-client.js");
  const api = (window as unknown as Record<string, unknown>).$scramjetController as {
    config: { prefix: string; scramjetPath: string; wasmPath: string; injectPath: string };
    Controller: new (init: { serviceworker: ServiceWorker; transport: unknown }) => SjControllerApi;
  } | undefined;
  if (!api) throw new Error("scramjet controller api missing");
  /* The controller owns /sj/r/<controller id>/; the per-frame
     segment is added by sjFrame below. */
  api.config.prefix = "/sj/r/";
  api.config.scramjetPath = "/sj/scramjet.js";
  api.config.wasmPath = "/sj/scramjet.wasm";
  api.config.injectPath = "/sj/controller.inject.js";
  const LibcurlClient = (window as unknown as Record<string, Record<string, unknown>>).LibcurlTransport?.LibcurlClient as
    | (new (init: { wisp: string }) => unknown)
    | undefined;
  if (!LibcurlClient) throw new Error("libcurl transport client missing");
  const transport = new LibcurlClient({ wisp });
  controller = new api.Controller({ serviceworker: sw, transport });
  if (typeof controller.wait === "function") await controller.wait();
}

/* Idempotent init; a failed init clears the memo so a later
   navigation retries instead of caching the rejection. */
export function sjInit(): Promise<void> {
  if (!initPromise) {
    initPromise = doInit().catch((e: unknown) => {
      initPromise = null;
      controller = null;
      throw e;
    });
  }
  return initPromise;
}

/* Create (or return) the upstream frame wrapping a tab's iframe, and
   publish its route prefix to settings.ts: the SW answers
   "No frame found" for controller-level prefixes, so every
   routeUrl() caller (favicon fetches, the tab switcher preview)
   must ride a live frame prefix. Rejects when the element is gone or
   the engine init failed; the caller falls back to the Zeolite route. */
export async function sjFrame(el: HTMLIFrameElement | null): Promise<SjFrameApi> {
  if (!el) throw new Error("scramjet frame: no iframe element");
  const cached = frameCache.get(el);
  if (cached) return cached;
  await sjInit();
  if (!controller) throw new Error("scramjet controller missing");
  const frame = controller.createFrame(el);
  frameCache.set(el, frame);
  setSjPrefix(frame.prefix);
  return frame;
}
