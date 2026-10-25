/* Favicon requests stay inside the owning engine. The app never fetches an
   upstream icon directly, including links reported by split-origin pages. */
type Query = (message: Record<string, unknown>, boundMs?: number) => Promise<Record<string, unknown> | null>;
export const FAVICON_LIMIT = 400000;
function httpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}
export async function faviconCandidates(pageUrl: string, raw: string, engineOrigin: string, query: Query): Promise<string[]> {
  const candidates: string[] = [];
  if (raw && raw.length <= 550000) {
    if (/^data:image\//i.test(raw)) candidates.push(raw);
    else try {
      const u = new URL(raw, pageUrl);
      if (u.origin === engineOrigin) {
        const reply = await query({ type: "zl:decodeRoutes", routes: [u.href] }, 3000);
        const decoded = Array.isArray(reply?.dests) ? reply.dests[0] : null;
        if (typeof decoded === "string" && httpUrl(decoded)) candidates.push(decoded);
        /* Never reinterpret an expired keyed token as an upstream path. */
        else if (!/^\/(?:__zl_|zl\/|j\/|sj\/)/.test(u.pathname) && !u.searchParams.has("zlNavh")) {
          const relative = new URL(u.pathname + u.search + u.hash, pageUrl).href;
          if (httpUrl(relative)) candidates.push(relative);
        }
      } else if (httpUrl(u.href)) candidates.push(u.href);
    } catch { /* broken icon: conventional fallback below */ }
  }
  try {
    const fallback = new URL("/favicon.ico", pageUrl).href;
    if (httpUrl(fallback) && !candidates.includes(fallback)) candidates.push(fallback);
  } catch { /* invalid page URL */ }
  return candidates;
}
export async function faviconRoute(dest: string, engineOrigin: string, query: Query, legacy: (dest: string) => string): Promise<string | null> {
  if (/^data:image\//i.test(dest)) return dest;
  if (!httpUrl(dest)) return null;
  const reply = await query({ type: "zl:navHandle", dest }, 3000);
  const route = reply?.ok === true && typeof reply.url === "string" && reply.url.startsWith("/") && !reply.url.startsWith("//") ? reply.url : legacy(dest);
  try {
    const u = new URL(route, engineOrigin);
    return u.origin === engineOrigin && /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}
/* Bound bytes while streaming, before allocating the final image blob. */
export async function faviconBlob(response: Response): Promise<Blob | null> {
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!response.ok || !mime.startsWith("image/") || Number(response.headers.get("content-length")) > FAVICON_LIMIT || !response.body) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > FAVICON_LIMIT) { await reader.cancel(); return null; }
      parts.push(new Uint8Array(part.value));
    }
    return size ? new Blob(parts, { type: mime }) : null;
  } finally { reader.releaseLock(); }
}
