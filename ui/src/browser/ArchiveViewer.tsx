/* Archive viewer (#40 fflate fast path, #41 zip.js ZIP64/large
   path, #43 Comlink worker RPC). fflate listing/extraction runs in
   the archive worker; zip.js streams archives beyond the fflate
   ceiling (or ones fflate rejects) with ZIP64 support. Simple
   listing + per-file download per issue scope. */
import { useEffect, useRef, useState } from "react";
import * as Comlink from "comlink";
import { fmtBytes } from "./browserShared";
import type { ArchiveApi } from "./archiveWorker";

/* fflate handles ordinary archives fully in a worker; past this
   ceiling the zip.js streaming path takes over (also ZIP64). */
const FFLATE_MAX = 64 * 1024 * 1024;

type Entry = { path: string; size: number; isDir: boolean; date?: string };
type Engine = "fflate" | "zipjs";

function saveBytes(name: string, data: Uint8Array | Blob) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
}

const baseName = (p: string) => p.split("/").pop() || p;

export default function ArchiveViewer(props: { name: string; blob: Blob; kind: "zip" | "gzip" | "zlib" }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [dir, setDir] = useState("");
  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [gunzipped, setGunzipped] = useState<Uint8Array | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        if (props.kind === "gzip" || props.kind === "zlib") {
          const w = new Worker(new URL("./archiveWorker.ts", import.meta.url), { type: "module" });
          workerRef.current = w;
          const api = Comlink.wrap<ArchiveApi>(w);
          const data = new Uint8Array(await props.blob.arrayBuffer());
          const out = await api.stream(Comlink.transfer(data, [data.buffer as ArrayBuffer]), props.kind);
          if (!dead) setGunzipped(out);
          return;
        }
        if (props.blob.size <= FFLATE_MAX) {
          try {
            const w = new Worker(new URL("./archiveWorker.ts", import.meta.url), { type: "module" });
            workerRef.current = w;
            const api = Comlink.wrap<ArchiveApi>(w);
            const data = new Uint8Array(await props.blob.arrayBuffer());
            bytesRef.current = data;
            const res = await api.list(data, "zip");
            if (dead) return;
            if (res.kind === "zip") {
              setEngine("fflate");
              setEntries(res.entries.map((e) => ({ path: e.path, size: e.size, isDir: e.path.endsWith("/") })));
              return;
            }
            /* fflate rejected it: fall through to the zip.js path. */
          } catch {
            /* corrupt or exotic archive: try zip.js below. */
          }
        }
        const z = await import("@zip.js/zip.js");
        const reader = new z.ZipReader(new z.BlobReader(props.blob));
        const raw = await reader.getEntries();
        await reader.close();
        if (dead) return;
        setEngine("zipjs");
        setEntries(
          raw.map((e) => ({
            path: e.filename,
            size: e.uncompressedSize,
            isDir: e.directory,
            date: e.lastModDate ? new Date(e.lastModDate).toISOString().slice(0, 10) : undefined,
          })),
        );
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { dead = true; };
  }, [props.kind, props.blob]);

  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  const downloadEntry = async (path: string) => {
    if (busy) return;
    setBusy(path);
    try {
      if (engine === "fflate" && workerRef.current && bytesRef.current) {
        const api = Comlink.wrap<ArchiveApi>(workerRef.current);
        const out = await api.zipEntry(bytesRef.current, path);
        saveBytes(baseName(path), out);
      } else if (engine === "zipjs") {
        const z = await import("@zip.js/zip.js");
        const reader = new z.ZipReader(new z.BlobReader(props.blob));
        const raw = await reader.getEntries();
        const entry = raw.find((e) => e.filename === path);
        if (entry && !entry.directory) {
          const writer = new z.BlobWriter();
          await entry.getData(writer);
          saveBytes(baseName(path), writer.blob);
        }
        await reader.close();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (props.kind === "gzip" || props.kind === "zlib") {
    const outName = props.name.replace(/\.tgz$/i, ".tar").replace(/\.(gz|zlib|zz)$/i, "");
    return (
      <div>
        {error && <p className="lb-fv-error">{error}</p>}
        {!gunzipped && !error && <p className="lb-muted">Decompressing...</p>}
        {gunzipped && (
          <div>
            <p className="lb-muted">
              {props.kind === "gzip" ? "GZIP" : "ZLIB"} member decompressed: {fmtBytes(props.blob.size)} to {fmtBytes(gunzipped.length)}.
            </p>
            <m3e-button onClick={() => saveBytes(outName || "decompressed", gunzipped)}>
              <m3e-icon name="download" aria-hidden={true} /> Save decompressed copy
            </m3e-button>
          </div>
        )}
      </div>
    );
  }

  /* Directory listing for the current prefix. */
  const prefix = dir ? dir + "/" : "";
  const rows: { name: string; entry: Entry }[] = [];
  const seen = new Set<string>();
  for (const e of entries ?? []) {
    if (!e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (!rest) continue;
    const seg = rest.split("/")[0];
    const isDirHere = rest.includes("/") || e.isDir;
    const key = isDirHere ? seg + "/" : seg;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ name: key, entry: { ...e, path: prefix + key, isDir: isDirHere } });
  }
  rows.sort((a, b) => (a.entry.isDir === b.entry.isDir ? a.name.localeCompare(b.name) : a.entry.isDir ? -1 : 1));

  return (
    <div>
      {error && <p className="lb-fv-error">{error}</p>}
      {!entries && !error && <p className="lb-muted">Reading archive ({engine ?? "picking engine"})...</p>}
      {entries && entries.length === 0 && <p className="lb-muted">The archive is empty.</p>}
      {entries && entries.length > 0 && (
        <div>
          <p className="lb-fv-crumb" onClick={() => setDir("")}>
            /{dir} <span className="lb-muted">({engine === "fflate" ? "fflate fast path" : "zip.js ZIP64 path"})</span>
          </p>
          <table className="lb-fv-entries">
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td>
                    {r.entry.isDir ? (
                      <span className="lb-fv-dir" onClick={() => setDir(prefix + r.name.replace(/\/$/, ""))}>
                        <m3e-icon name="folder" aria-hidden={true} /> {r.name}
                      </span>
                    ) : (
                      <span><m3e-icon name="draft" aria-hidden={true} /> {r.name}</span>
                    )}
                  </td>
                  <td>{r.entry.isDir ? "" : fmtBytes(r.entry.size)}</td>
                  <td>{r.entry.date ?? ""}</td>
                  <td>
                    {!r.entry.isDir && (
                      <m3e-icon-button
                        aria-label={"Download " + r.name}
                        disabled={busy ? true : undefined}
                        onClick={() => void downloadEntry(r.entry.path)}
                      >
                        <m3e-icon name="download" aria-hidden={true} />
                      </m3e-icon-button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
