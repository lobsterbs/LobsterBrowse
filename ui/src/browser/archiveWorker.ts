/* Archive worker (#40 fflate fast path, #43 Comlink RPC). All
   decompression happens off the main thread; results move back with
   Comlink.transfer so nothing is structured-cloned twice. */
import * as Comlink from "comlink";
import { gunzipSync, inflateSync, unzip, type Unzipped, type UnzipFileInfo } from "fflate";

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

const extractZip = (data: Uint8Array, path: string): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    unzip(
      data,
      { filter: (f: UnzipFileInfo) => f.name === path },
      (err, unzipped: Unzipped) => {
        if (err) return reject(new Error(err.message || String(err)));
        const hit = unzipped[path];
        if (!hit) return reject(new Error("entry not found: " + path));
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
  /* Whole-stream decompress for gzip/zlib members; transfers out. */
  async stream(data: Uint8Array, kind: "gzip" | "zlib"): Promise<Uint8Array> {
    const out = kind === "gzip" ? gunzipSync(data) : inflateSync(data);
    return Comlink.transfer(out, [out.buffer as ArrayBuffer]);
  },
};

export type ArchiveApi = typeof api;
Comlink.expose(api);
