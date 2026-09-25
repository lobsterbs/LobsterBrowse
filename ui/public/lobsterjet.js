/* LobsterJet v1: service-worker cache layer over the server-side
   rewriter. Intercepts GET requests to /lj/<b64url> routes and serves
   them cache-first with a 10-minute freshness window, falling back to
   the network (and then to a stale cached copy when offline).

   The server answers /lj/ routes identically when this worker is not
   installed, so the app works either way. */

const CACHE = "lobsterjet-v1";
const TTL_MS = 10 * 60 * 1000;
const FRESH_HEADER = "lb-cached-at";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

/* Clone a response with a freshness timestamp attached. */
async function stamp(response) {
  try {
    const headers = new Headers(response.headers);
    headers.set(FRESH_HEADER, String(Date.now()));
    return new Response(await response.clone().arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return null;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/lj/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });

      if (hit) {
        const at = Number(hit.headers.get(FRESH_HEADER) || 0);
        if (Date.now() - at < TTL_MS) return hit;
      }

      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const type = fresh.headers.get("content-type") || "";
          if (/text\/html|text\/css|javascript|image\//.test(type)) {
            const stored = await stamp(fresh);
            if (stored) {
              event.waitUntil(cache.put(req, stored));
            }
          }
        }
        return fresh;
      } catch {
        if (hit) return hit;
        return new Response("LobsterJet: offline and no cached copy", {
          status: 504,
          headers: { "content-type": "text/plain" },
        });
      }
    })()
  );
});
