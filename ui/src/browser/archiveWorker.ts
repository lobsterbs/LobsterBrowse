/* Archive worker (#40 fflate fast path, #43 Comlink RPC). All
   decompression happens off the main thread; results move back with
   Comlink.transfer so nothing is structured-cloned twice. */
import * as Comlink from "comlink";
import { Gunzip, Inflate, unzip, type Unzipped, type UnzipFileInfo } from "fflate";

/* fflate 0.8.x has no concat export; join the streamed chunks by
   hand. ponytail: four lines, no dependency churn. */
const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export type ZipEntry = { path: string; size: number };

export type ArchiveList =
  | { kind: "zip"; entries: ZipEntry[] }
  | { kind: "gzip" }
  | { kind: "zlib" }
  | { kind: "unsupported"; error: string };

/* Listing reads the central directory only: the filter returning
   false skips every payload inflation, so listing never decompresses
   the whole archive. */
const listZip = (data: Uint8Array): Promise<ZipEntry[]> =>
  new Promise((resolve, reject) => {
    const entries: ZipEntry[] = [];
    unzip(
      data,
      {
        filter: (f: UnzipFileInfo) => {
          entries.push({ path: f.name, size: f.originalSize ?? 0 });
          return false;
        },
      },
      (err) => {
        if (err) reject(new Error(err.message || String(err)));
        else resolve(entries);
      },
    );
  });

/* #146: decompression-bomb ceiling. The cap bounds the OUTPUT of
   gzip/zlib stream decompression and any single zip entry; listing
   reads only the central directory and never inflates payloads. */
export const DECOMP_CAP = 256 * 1024 * 1024;

/* The gzip trailer's ISIZE field holds the output size modulo 2^32:
   a cheap pre-check that rejects most bombs before decompression
   starts (sizes that genuinely wrap 4 GiB still hit the streaming
   cap below). */
const gzipReportedSize = (data: Uint8Array): number | null => {
  if (data.length < 18) return null;
  return (
    (data[data.length - 4] |
      (data[data.length - 3] << 8) |
      (data[data.length - 2] << 16) |
      (data[data.length - 1] << 24)) >>>
    0
  );
};

/* Streaming gunzip/inflate with a running output cap: the sync APIs
   buffer the whole result before any code could count it. */
const streamDecompress = (data: Uint8Array, kind: "gzip" | "zlib"): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const parts: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const sink = (chunk: Uint8Array, final: boolean) => {
      if (done) return;
      total += chunk.length;
      if (total > DECOMP_CAP) {
        done = true;
        reject(new Error("decompressed output exceeds the 256 MiB cap"));
        return;
      }
      parts.push(chunk);
      if (final) {
        done = true;
        resolve(concatBytes(parts));
      }
    };
    const d = kind === "gzip" ? new Gunzip(sink) : new Inflate(sink);
    d.push(data, true);
    /* An empty stream may end without a final chunk: settle honestly. */
    if (!done) resolve(concatBytes(parts));
  });

const extractZip = (data: Uint8Array, path: string): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    unzip(
      data,
      { filter: (f: UnzipFileInfo) => f.name === path && (f.originalSize ?? 0) <= DECOMP_CAP },
      (err, unzipped: Unzipped) => {
        if (err) return reject(new Error(err.message || String(err)));
        const hit = unzipped[path];
        if (!hit) return reject(new Error("entry not found or above the 256 MiB cap: " + path));
        resolve(hit);
      },
    );
  });

export const api = {
  /* Never throws for unsupported archives: an honest "unsupported"
     answer lets the caller fall back to the zip.js path. */
  async list(data: Uint8Array, kind: "zip" | "gzip" | "zlib"): Promise<ArchiveList> {
    if (kind === "gzip") return { kind: "gzip" };
    if (kind === "zlib") return { kind: "zlib" };
    try {
      return { kind: "zip", entries: await listZip(data) };
    } catch (err) {
      return { kind: "unsupported", error: err instanceof Error ? err.message : String(err) };
    }
  },
  /* Decompress one entry; the result transfers out (no clone). */
  async zipEntry(data: Uint8Array, path: string): Promise<Uint8Array> {
    const out = await extractZip(data, path);
    return Comlink.transfer(out, [out.buffer as ArrayBuffer]);
  },
  /* Whole-stream decompress for gzip/zlib members; transfers out.
     #146: the gzip trailer is pre-checked and the stream itself is
     capped, so a bomb fails with the honest cap error instead of
     taking the tab down. */
  async stream(data: Uint8Array, kind: "gzip" | "zlib"): Promise<Uint8Array> {
    if (kind === "gzip") {
      const reported = gzipReportedSize(data);
      if (reported !== null && reported > DECOMP_CAP) {
        throw new Error("gzip trailer reports an output above the 256 MiB cap");
      }
    }
    const out = await streamDecompress(data, kind);
    return Comlink.transfer(out, [out.buffer as ArrayBuffer]);
  },
};

export type ArchiveApi = typeof api;
Comlink.expose(api);
