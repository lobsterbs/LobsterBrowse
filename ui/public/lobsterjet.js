/* LobsterJet v2: service-worker cache layer over the server-side
   rewriter. Intercepts GET requests to /lj/<b64url> routes:

   - fresh hit (< 10 min): served straight from the cache;
   - stale hit: served immediately AND revalidated in the background
     (stale-while-revalidate);
   - miss: fetched from the server, cached when cacheable;
   - network failure: 504 (no stale copy available).

   The cache holds at most 60 entries; the oldest (by stored timestamp)
   are evicted on every write. The server answers /lj/ routes
   identically when this worker is not installed. */

const CACHE = "lobsterjet-v2";
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 60;
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

/* HTML documents, styles, scripts and images are cached; everything
   else (downloads, media streams) passes through uncached. */
function cacheable(response) {
  if (!response || !response.ok) return false;
  const type = response.headers.get("content-type") || "";
  return /text\/html|text\/css|javascript|image\//.test(type);
}

/* Evict oldest entries beyond MAX_ENTRIES (LRU-ish by timestamp). */
async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  const entries = [];
  for (const k of keys) {
    const r = await cache.match(k);
    entries.push({ k, at: Number((r && r.headers.get(FRESH_HEADER)) || 0) });
  }
  entries.sort((a, b) => a.at - b.at);
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) {
    await cache.delete(entries[i].k);
  }
}

async function store(cache, req, response) {
  try {
    const stored = await stamp(response);
    if (stored) {
      await cache.put(req, stored);
      await trim(cache);
    }
  } catch {
    /* cache write failed; the response still goes to the page */
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
        /* Stale: serve it now, refresh it in the background. */
        event.waitUntil(
          (async () => {
            try {
              const fresh = await fetch(req);
              if (cacheable(fresh)) await store(cache, req, fresh);
            } catch {
              /* offline: the stale copy stays served */
            }
          })()
        );
        return hit;
      }

      try {
        const fresh = await fetch(req);
        if (cacheable(fresh)) event.waitUntil(store(cache, req, fresh));
        return fresh;
      } catch {
        return new Response("LobsterJet: offline and no cached copy", {
          status: 504,
          headers: { "content-type": "text/plain" },
        });
      }
    })()
  );
});
