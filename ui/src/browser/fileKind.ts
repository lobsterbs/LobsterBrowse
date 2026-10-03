/* Central file-kind detection (#42): the single path every surface
   (downloads, opened files, drag-drop) uses to learn what a byte
   stream really is. Precedence policy, highest first:
     1. magic bytes (file-type, lazily imported; signature pre-checks
        keep the common cases import-free)
     2. Content-Type (as delivered)
     3. file extension (last resort)
   Detection is a convenience/classification layer only - it never
   drives execution of anything, and disagreement resolves toward
   the magic bytes: what the bytes say wins over what the server
   claims or the file name suggests. */

export type FileKind =
  | "pdf"
  | "zip"
  | "gzip"
  | "zlib"
  | "image"
  | "audio"
  | "video"
  | "text"
  | "html"
  | "other";

export type FileMeta = { name: string; mime?: string };

/* file-type never needs more than the first 4100 bytes. */
export const HEAD_BYTES = 4100;

/* Cheap head slice: never buffer a whole file just to identify it. */
export async function headOf(blob: Blob, max = HEAD_BYTES): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(0, max).arrayBuffer());
}

function extKind(name: string): FileKind | null {
  const n = name.toLowerCase();
  if (/\.(pdf|epub)$/.test(n)) return "pdf";
  if (/\.(zip|xpi|crx|apk|jar)$/.test(n)) return "zip";
  if (/\.(gz|tgz)$/.test(n)) return "gzip";
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(n)) return "image";
  if (/\.(mp3|flac|wav|ogg|m4a|opus)$/.test(n)) return "audio";
  if (/\.(mp4|mkv|webm|mov|m4v)$/.test(n)) return "video";
  if (/\.(html?|xhtml)$/.test(n)) return "html";
  if (/\.(txt|md|json|csv|xml|js|mjs|ts|tsx|css|log|ya?ml|toml|ini|py|rs|go|c|h|cpp|sh)$/.test(n)) return "text";
  return null;
}

function mimeKind(mime?: string): FileKind | null {
  if (!mime) return null;
  const m = mime.split(";")[0].trim().toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m === "application/zip" || m === "application/x-zip-compressed" || m === "application/x-xpinstall" || m === "application/vnd.android.package-archive") return "zip";
  if (m === "application/gzip" || m === "application/x-gzip" || m === "application/x-tar") return "gzip";
  if (m === "application/zlib" || m === "application/x-zlib") return "zlib";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m === "text/html" || m === "application/xhtml+xml") return "html";
  if (m.startsWith("text/") || m === "application/json" || m === "application/javascript" || m === "application/xml") return "text";
  return null;
}

export async function detectFileKind(meta: FileMeta, head: Uint8Array): Promise<FileKind> {
  /* Signature pre-checks: the formats the viewers key on, zero imports. */
  if (head.length >= 4) {
    if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "pdf";
    if (head[0] === 0x50 && head[1] === 0x4b) return "zip";
    if (head[0] === 0x1f && head[1] === 0x8b) return "gzip";
    if (head[0] === 0x78 && (head[1] === 0x01 || head[1] === 0x9c || head[1] === 0xda || head[1] === 0x5e)) return "zlib";
  }
  /* file-type covers the long tail (images, media, documents). */
  try {
    const { fileTypeFromBuffer } = await import("file-type");
    const t = await fileTypeFromBuffer(head);
    if (t?.mime) {
      const k = mimeKind(t.mime);
      if (k) return k;
    }
  } catch {
    /* file-type chunk unavailable: policy falls to metadata. */
  }
  return mimeKind(meta.mime) ?? extKind(meta.name) ?? "other";
}
