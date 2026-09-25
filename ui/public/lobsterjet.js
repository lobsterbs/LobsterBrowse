/* LobsterJet v3: service-worker cache layer over the server-side
   rewriter, plus a Decentraleyes-style local library cache.

   Intercepts GET requests to /lj/<b64url> routes:

   - target decodes to a known CDN library (jquery, lodash, moment, d3):
     served from the dedicated library cache, primed from jsDelivr on
     first use (7-day freshness) — the CDN is never contacted through
     the user;
   - fresh page hit (< 10 min): served straight from the cache;
   - stale hit: served immediately AND revalidated in the background
     (stale-while-revalidate);
   - miss: fetched from the server, cached when cacheable;
   - network failure: 504 (no stale copy available).

   The page cache holds at most 60 entries; the oldest (by stored
   timestamp) are evicted on every write. The server answers /lj/
   routes identically when this worker is not installed. */

const CACHE = "lobsterjet-v3";
const DCACHE = "lobsterjet-decentraleyes-v1";
const TTL_MS = 10 * 60 * 1000;
const LIB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 60;
const FRESH_HEADER = "lb-cached-at";

/* base64url decode (UTF-8 safe). */
function b64urlDecode(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* Known CDN library URLs -> self-hostable equivalents on jsDelivr.
   Version mapping is approximate (pinned upstream major line): the
   goal is removing the third-party request, not byte-identical
   versions. SRI is stripped by the server rewriter already. */
const LIBS = [
  {
    match: /^https?:\/\/(code\.jquery\.com\/|ajax\.googleapis\.com\/ajax\/libs\/jquery\/|cdnjs\.cloudflare\.com\/ajax\/libs\/jquery\/)/i,
    asset: "https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js",
  },
  {
    match: /^https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/lodash\.js\//i,
    asset: "https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js",
  },
  {
    match: /^https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/moment\.js\//i,
    asset: "https://cdn.jsdelivr.net/npm/moment@2.30.1/moment.min.js",
  },
  {
    match: /^https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/d3\//i,
    asset: "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js",
  },
];

/* Decentraleyes can be disabled from Settings; the page posts the
   current state to the worker (default on). */
let decentraleyesEnabled = true;
self.addEventListener("message", (event) => {
  if (event.data && event.data.lb === "decentraleyes") {
    decentraleyesEnabled = Boolean(event.data.enabled);
  }
});

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE && k !== DCACHE).map((k) => caches.delete(k))
      );
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

/* ---- Decentraleyes: serve known libraries from the device. ---- */
async function localLibrary(target) {
  const lib = LIBS.find((l) => l.match.test(target));
  if (!lib) return null;
  const cache = await caches.open(DCACHE);
  const hit = await cache.match(lib.asset);
  if (hit) {
    const at = Number(hit.headers.get(FRESH_HEADER) || 0);
    if (Date.now() - at < LIB_TTL_MS) {
      return new Response(await hit.clone().arrayBuffer(), {
        status: 200,
        headers: { "content-type": "application/javascript; charset=utf-8" },
      });
    }
    /* Stale lib: fall through to the re-fetch below, which re-primes
       the cache; the stale copy is the offline fallback at the end. */
  }
  try {
    const fresh = await fetch(lib.asset, { cache: "no-cache" });
    if (fresh.ok) {
      const stored = await stamp(fresh);
      if (stored) await cache.put(lib.asset, stored);
      return new Response(await fresh.clone().arrayBuffer(), {
        status: 200,
        headers: { "content-type": "application/javascript; charset=utf-8" },
      });
    }
  } catch {
    /* jsDelivr unreachable: fall through to the normal /lj/ flow. */
  }
  if (hit) {
    return new Response(await hit.clone().arrayBuffer(), {
      status: 200,
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }
  return null;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/lj/")) return;

  event.respondWith(
    (async () => {
      /* Decentraleyes: the /lj/ target decodes to a known library. */
      if (decentraleyesEnabled) {
        try {
          const target = b64urlDecode(url.pathname.slice(4).split("?")[0]);
          const lib = await localLibrary(target);
          if (lib) return lib;
        } catch {
          /* not decodable or not a lib: normal flow */
        }
      }

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
