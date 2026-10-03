/* Lazy PDF.js viewer (#39). pdfjs-dist loads only when a PDF is
   actually opened; the worker asset is imported (?url) from the same
   package so it never drifts from the API version. Text selection
   comes from the transparent TextLayer; search walks page text. */
import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type SearchHit = { page: number; snippet: string };

export default function PdfViewer(props: { blob: Blob }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [fit, setFit] = useState<"width" | "page" | "zoom">("width");
  const [zoom, setZoom] = useState(1.25);
  const [rotation, setRotation] = useState(0);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);

  /* Load the document once per blob. */
  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const data = new Uint8Array(await props.blob.arrayBuffer());
        const d = await pdfjsLib.getDocument({ data }).promise;
        if (dead) { void d.destroy(); return; }
        setDoc(d);
        setNumPages(d.numPages);
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (!dead) {
          setError(
            e?.name === "PasswordException"
              ? "This PDF is password-protected; download it and open it in a dedicated reader."
              : e?.message || String(err),
          );
        }
      }
    })();
    return () => { dead = true; };
  }, [props.blob]);

  useEffect(() => () => { void doc?.destroy(); }, [doc]);

  /* Render the current page (canvas + selection text layer). */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stage = stageRef.current;
      const canvas = canvasRef.current;
      const text = textRef.current;
      if (!doc || !stage || !canvas || !text) return;
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1, rotation });
        const availW = Math.max(200, stage.clientWidth - 16);
        const availH = Math.max(200, stage.clientHeight - 16);
        const scale =
          fit === "width"
            ? availW / base.width
            : fit === "page"
              ? Math.min(availW / base.width, availH / base.height)
              : zoom;
        const viewport = page.getViewport({ scale, rotation });
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = Math.floor(viewport.width) + "px";
        canvas.style.height = Math.floor(viewport.height) + "px";
        const render = page.render({ canvas, viewport });
        await render.promise;
        if (cancelled) return;
        text.innerHTML = "";
        text.style.width = Math.floor(viewport.width) + "px";
        text.style.height = Math.floor(viewport.height) + "px";
        text.style.setProperty("--scale-factor", String(scale));
        const content = await page.getTextContent();
        if (cancelled) return;
        const layer = new pdfjsLib.TextLayer({ textContentSource: content, container: text, viewport });
        await layer.render();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [doc, pageNum, fit, zoom, rotation]);

  const go = (p: number) => {
    if (!doc) return;
    setPageNum(Math.min(Math.max(1, p), doc.numPages));
    setHits(null);
  };

  const runSearch = async () => {
    if (!doc) return;
    const q = query.trim().toLowerCase();
    if (!q) { setHits(null); return; }
    const found: SearchHit[] = [];
    for (let p = 1; p <= doc.numPages && found.length < 50; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const text = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
      const at = text.toLowerCase().indexOf(q);
      if (at !== -1) found.push({ page: p, snippet: text.slice(Math.max(0, at - 40), at + q.length + 60) });
    }
    setHits(found);
  };

  return (
    <div>
      <div className="lb-fv-toolbar">
        <m3e-icon-button aria-label="Previous page" disabled={pageNum <= 1 ? true : undefined} onClick={() => go(pageNum - 1)}>
          <m3e-icon name="chevron_left" aria-hidden={true} />
        </m3e-icon-button>
        <span className="lb-fv-pagecount">{pageNum} / {numPages || "?"}</span>
        <m3e-icon-button aria-label="Next page" disabled={pageNum >= numPages ? true : undefined} onClick={() => go(pageNum + 1)}>
          <m3e-icon name="chevron_right" aria-hidden={true} />
        </m3e-icon-button>
        <m3e-icon-button aria-label="Zoom out" onClick={() => { setFit("zoom"); setZoom((z) => Math.max(0.25, z / 1.25)); }}>
          <m3e-icon name="zoom_out" aria-hidden={true} />
        </m3e-icon-button>
        <m3e-icon-button aria-label="Zoom in" onClick={() => { setFit("zoom"); setZoom((z) => Math.min(8, z * 1.25)); }}>
          <m3e-icon name="zoom_in" aria-hidden={true} />
        </m3e-icon-button>
        <m3e-icon-button aria-label="Fit to width" onClick={() => setFit("width")}>
          <m3e-icon name="width" aria-hidden={true} />
        </m3e-icon-button>
        <m3e-icon-button aria-label="Fit whole page" onClick={() => setFit("page")}>
          <m3e-icon name="crop_square" aria-hidden={true} />
        </m3e-icon-button>
        <m3e-icon-button aria-label="Rotate" onClick={() => setRotation((r) => (r + 90) % 360)}>
          <m3e-icon name="rotate_right" aria-hidden={true} />
        </m3e-icon-button>
        <span className="lb-fv-searchbox">
          <input
            className="lb-input"
            aria-label="Search in PDF"
            placeholder="Search in PDF"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
          />
          <m3e-icon-button aria-label="Search in PDF" onClick={() => void runSearch()}>
            <m3e-icon name="search" aria-hidden={true} />
          </m3e-icon-button>
        </span>
      </div>
      {hits && (
        <div className="lb-fv-results">
          {hits.length === 0 ? (
            <p className="lb-muted">No pages match the search.</p>
          ) : (
            hits.map((h) => (
              <div key={h.page} className="lb-fv-result" onClick={() => go(h.page)}>
                Page {h.page}: ...{h.snippet}...
              </div>
            ))
          )}
        </div>
      )}
      {error && <p className="lb-fv-error">{error}</p>}
      <div className="lb-fv-stage" ref={stageRef}>
        {!doc && !error && <m3e-circular-progress-indicator indeterminate={true} aria-label="Loading PDF" />}
        <div className="lb-fv-canvas-wrap" style={{ display: doc ? "block" : "none" }}>
          <canvas ref={canvasRef} aria-label="PDF page" />
          <div className="lb-fv-textlayer" ref={textRef} />
        </div>
      </div>
    </div>
  );
}
