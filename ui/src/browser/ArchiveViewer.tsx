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
  const blob = data instanceof Blob ? data : new Blob([data.slice().buffer as ArrayBuffer]);
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
          saveBytes(baseName(path), await writer.getData());
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

  /* Full hierarchy in one pass: every path creates its directory
     chain on demand, so archives without explicit dir entries still
     nest correctly. */
  type Node = { name: string; path: string; isDir: boolean; size: number; date?: string; children: Node[] };
  const root: Node = { name: "", path: "", isDir: true, size: 0, children: [] };
  const byPath = new Map<string, Node>([["", root]]);
  const dirNode = (p: string): Node => {
    let n = byPath.get(p);
    if (!n) {
      n = { name: baseName(p), path: p, isDir: true, size: 0, children: [] };
      byPath.set(p, n);
      const slash = p.lastIndexOf("/");
      dirNode(slash < 0 ? "" : p.slice(0, slash)).children.push(n);
    }
    return n;
  };
  for (const e of entries ?? []) {
    if (e.isDir) {
      dirNode(e.path.replace(/\/$/, ""));
      continue;
    }
    const slash = e.path.lastIndexOf("/");
    const parent = slash < 0 ? "" : e.path.slice(0, slash);
    dirNode(parent).children.push({ name: baseName(e.path), path: e.path, isDir: false, size: e.size, date: e.date, children: [] });
  }
  const sortNodes = (ns: Node[]) => {
    ns.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    for (const n of ns) sortNodes(n.children);
  };
  sortNodes(root.children);

  /* The tree keeps the ancestors of the visited folder expanded so
     the breadcrumb trail and the tree agree on where you are. */
  const isOpen = (p: string) => dir === p || dir.startsWith(p + "/");
  const renderNode = (n: Node) =>
    n.isDir ? (
      <m3e-tree-item key={n.path} open={isOpen(n.path) ? "" : undefined}>
        <span slot="label" className="lb-fv-dir" onClick={() => setDir(n.path)}>
          <m3e-icon name="folder" aria-hidden={true} /> {n.name}
        </span>
        {n.children.map(renderNode)}
      </m3e-tree-item>
    ) : (
      <m3e-tree-item key={n.path}>
        <span slot="label">
          <m3e-icon name="draft" aria-hidden={true} /> {n.name}
          <span className="lb-fv-meta">{fmtBytes(n.size)}</span>
          {n.date && <span className="lb-fv-meta">{n.date}</span>}
          <m3e-icon-button
            aria-label={"Download " + n.name}
            disabled={busy ? true : undefined}
            onClick={() => void downloadEntry(n.path)}
          >
            <m3e-icon name="download" aria-hidden={true} />
          </m3e-icon-button>
        </span>
      </m3e-tree-item>
    );
  const segs = dir ? dir.split("/") : [];

  return (
    <div>
      {error && <p className="lb-fv-error">{error}</p>}
      {!entries && !error && <p className="lb-muted">Reading archive ({engine ?? "picking engine"})...</p>}
      {entries && entries.length === 0 && <p className="lb-muted">The archive is empty.</p>}
      {entries && entries.length > 0 && (
        <div>
          <p className="lb-fv-crumb">
            <m3e-breadcrumb aria-label="Archive folder">
              <m3e-breadcrumb-item
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setDir("");
                }}
              >
                {props.name}
              </m3e-breadcrumb-item>
              {segs.map((s, i) => {
                const p = segs.slice(0, i + 1).join("/");
                return i === segs.length - 1 ? (
                  <m3e-breadcrumb-item key={p}>{s}</m3e-breadcrumb-item>
                ) : (
                  <m3e-breadcrumb-item
                    key={p}
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setDir(p);
                    }}
                  >
                    {s}
                  </m3e-breadcrumb-item>
                );
              })}
            </m3e-breadcrumb>{" "}
            <span className="lb-muted">({engine === "fflate" ? "fflate fast path" : "zip.js ZIP64 path"})</span>
          </p>
          <m3e-tree className="lb-fv-tree" aria-label="Archive contents">
            {root.children.map(renderNode)}
          </m3e-tree>
        </div>
      )}
    </div>
  );
}
