/* LobsterJet service worker: interception + header surgery + streaming
   rewriter + wisp transport.

   URL shape: <origin>/j/<base64url of destination>. Requests that are
   engine assets or the wisp endpoint pass through untouched. Everything
   under /j/ is proxied and (for HTML/CSS) stream-rewritten.

   The rewriter wasm (wasm-bindgen output of crates/rewriter) is emitted
   by the build pipeline to src/rewriter_wasm/ (see .github workflow:
   wasm-pack build --target web -> copy into app/src/rewriter_wasm). */

/// <reference lib="webworker" />
import { decodePath } from "./codec";
import { LJ_WISP_URL } from "./config";

declare const self: ServiceWorkerGlobalScope;

/* ---- HTTP over wisp ----------------------------------------------- */
/* Phase 1: libcurl wasm transport (BareMux-compatible), the same proven
   TLS-termination path Scramjet uses. Vendored by CI into
   src/libcurl-transport (see README: "HTTP over Wisp"). */

let curlReady: Promise<void> | null = null;
async function ensureCurl(): Promise<void> {
  if (!curlReady) {
    curlReady = (async () => {
      const mod = await import("./libcurl-transport");
      await mod.setTransport({ websocket: LJ_WISP_URL });
    })();
  }
  return curlReady;
}

async function wispFetch(dest: string, init?: RequestInit): Promise<Response> {
  await ensureCurl();
  const mod = await import("./libcurl-transport");
  return mod.curlFetch(dest, init);
}

/* ---- Header surgery ------------------------------------------------ */

const HOSTILE = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
];

function stripHostile(headers: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of headers) {
    if (!HOSTILE.includes(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

/* ---- Streaming rewriter wiring ------------------------------------- */

interface JsRewriter {
  process(chunk: string): string;
  finish(): string;
}
interface RewriterMod {
  JsRewriter: new (origin: string, base: string, prefix: string) => JsRewriter;
  rewriteCss(css: string, origin: string, base: string, prefix: string): string;
}
let rewriterMod: Promise<RewriterMod> | null = null;
function rewriter(): Promise<RewriterMod> {
  if (!rewriterMod) rewriterMod = import("./rewriter_wasm/rewriter_wasm.js");
  return rewriterMod;
}

function isHtml(resp: Response): boolean {
  return (resp.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}
function isCss(resp: Response): boolean {
  return (resp.headers.get("content-type") ?? "").toLowerCase().includes("text/css");
}

/** HTML bodies: pipe response chunks through the wasm rewriter. The
    bootstrap needs the page's real destination on window.__LJ, so we
    emit a tiny inline script before the first rewritten chunk. */
function rewriteStream(body: ReadableStream<Uint8Array>, base: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const modP = rewriter();
  let rw: JsRewriter | null = null;
  const ljInit = `<script>window.__LJ=${JSON.stringify({ dest: base })};</script>`;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(ljInit));
      const mod = await modP;
      if (!rw) rw = new mod.JsRewriter(self.location.origin, base, "/j/");
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = rw.finish();
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.close();
            return;
          }
          const out = rw.process(decoder.decode(value, { stream: true }));
          if (out) controller.enqueue(encoder.encode(out));
        }
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

/* ---- Fetch interception -------------------------------------------- */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e: FetchEvent) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // not ours: browser handles it
  if (url.pathname.startsWith("/wisp/")) return; // transport endpoint: passthrough
  if (!url.pathname.startsWith("/j/")) return; // engine asset: passthrough

  const dest = decodePath(url.pathname);
  if (!dest) {
    e.respondWith(new Response("lobsterjet: bad route", { status: 404 }));
    return;
  }
  // Query string travels outside the encoded destination.
  const target = url.search ? dest + url.search : dest;

  e.respondWith(
    (async () => {
      try {
        const resp = await wispFetch(target, {
          method: e.request.method,
          headers: forwardedHeaders(e.request),
          body: ["GET", "HEAD"].includes(e.request.method) ? undefined : e.request.body,
          redirect: "follow",
        });
        const headers = stripHostile(resp.headers);
        headers.set("x-lj-proxy", "1");
        if (isHtml(resp) && resp.body) {
          return new Response(rewriteStream(resp.body, target), { status: resp.status, headers });
        }
        if (isCss(resp) && resp.body) {
          // Standalone stylesheets: one-shot url() pass through the
          // rewriter module. Small bodies, not first-paint documents.
          const mod = await rewriter();
          const css = await resp.text();
          const out = mod.rewriteCss(css, self.location.origin, target, "/j/");
          return new Response(out, { status: resp.status, headers });
        }
        return new Response(resp.body, { status: resp.status, headers });
      } catch (err) {
        return new Response(`lobsterjet: upstream fetch failed: ${String(err)}`, {
          status: 502,
          headers: { "content-type": "text/plain" },
        });
      }
    })(),
  );
});

/** Per-request header surgery: drop hop-by-hop + engine-origin leaks,
    restore the real destination as Referer. */
function forwardedHeaders(req: Request): Headers {
  const out = new Headers();
  const skip = new Set(["host", "connection", "referer", "origin"]);
  for (const [k, v] of req.headers) {
    if (!skip.has(k.toLowerCase())) out.set(k, v);
  }
  if (req.referrer) {
    const ref = decodePath(new URL(req.referrer, self.location.origin).pathname);
    if (ref) out.set("referer", ref);
  }
  if (!out.has("accept-language")) out.set("accept-language", "en-US,en;q=0.9");
  return out;
}
