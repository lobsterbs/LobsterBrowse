/* ScramJet 2.0 (MercuryWorkshop) — the upstream proxy engine,
   driven from the LB UI. The server vendors the published client
   bundle same-origin under /sj/ (Dockerfile sj-builder stage); this
   module registers the controller worker at the /sj/ scope (it never
   competes with the Zeolite root worker: the browser hands each
   fetch to the longest matching scope), loads the controller API,
   creates the libcurl transport against the ScramJet wisp backend
   (the LB /wisp/ endpoint requires password auth the upstream client
   cannot send) and publishes the per-session engine route prefix to
   settings.ts (setSjPrefix).
   Everything here mirrors the upstream @mercuryworkshop/proxy-bootstrap
   client (packages/bootstrap/src/client.ts in the scramjet repo): no
   rewriter code lives in this repo. */

import { setSjPrefix } from "./settings";

type SjBuildInfo = { sjWisp?: string };

let initPromise: Promise<void> | null = null;

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
    Controller: new (init: { serviceworker: ServiceWorker; transport: unknown }) => { prefix: string; wait?: () => Promise<void> };
  } | undefined;
  if (!api) throw new Error("scramjet controller api missing");
  /* Engine routes live under the worker scope: /sj/r/<session id>/. */
  api.config.prefix = "/sj/r/";
  api.config.scramjetPath = "/sj/scramjet.js";
  api.config.wasmPath = "/sj/scramjet.wasm";
  api.config.injectPath = "/sj/controller.inject.js";
  const LibcurlClient = (window as unknown as Record<string, Record<string, unknown>>).LibcurlTransport?.LibcurlClient as
    | (new (init: { wisp: string }) => unknown)
    | undefined;
  if (!LibcurlClient) throw new Error("libcurl transport client missing");
  const transport = new LibcurlClient({ wisp });
  const controller = new api.Controller({ serviceworker: sw, transport });
  if (typeof controller.wait === "function") await controller.wait();
  setSjPrefix(controller.prefix);
}

/* Idempotent init; a failed init clears the memo so a later
   navigation retries instead of caching the rejection. */
export function sjInit(): Promise<void> {
  if (!initPromise) {
    initPromise = doInit().catch((e: unknown) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}
