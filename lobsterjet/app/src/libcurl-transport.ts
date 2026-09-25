/* libcurl wasm transport (BareMux-compatible interface).
   TLS cannot terminate inside the service worker, so proxied HTTP(S)
   goes through a libcurl.wasm build that connects over our wisp
   WebSocket, exactly like Scramjet's proven path.

   The actual wasm blob is vendored by CI (workflow: fetch the
   libcurl.js build, place it at src/libcurl-transport/) so this
   module stays a thin, stable seam. Until the vendor step runs, this
   stub throws at runtime and the suite records transport-missing. */

export interface TransportConfig {
  websocket: string;
}

let transport: { fetch: (url: string, init?: RequestInit) => Promise<Response> } | null = null;

export async function setTransport(cfg: TransportConfig): Promise<void> {
  if (transport) return;
  const impl = await import("./libcurl-transport-vendored");
  await impl.init({ websocket: cfg.websocket });
  transport = impl;
}

export async function curlFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!transport) throw new Error("lobsterjet: libcurl transport not initialised");
  return transport.fetch(url, init);
}
