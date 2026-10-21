/* Unified local file viewer (#39-#42, #44): the single entry point
   for finished local transfers. Detection (fileKind.ts) picks the
   kind; this surface mounts the matching viewer. Owned HTML previews
   pass through the DOMPurify wrapper (#44) and render in a fully
   sandboxed iframe; proxied page content NEVER enters here - that
   path keeps iframe/origin isolation plus CSP as its boundary. */
import { useEffect, useState } from "react";
import type { FileKind } from "./fileKind";
import { sanitizeOwnedHtml } from "./htmlPreview";
import PdfViewer from "./PdfViewer";
import ArchiveViewer from "./ArchiveViewer";
import { fmtBytes } from "./browserShared";
import "./fileViewer.css";

const TEXT_CAP = 2 * 1024 * 1024;

function saveBlob(name: string, blob: Blob) {
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
}

export default function FileViewer(props: { name: string; blob: Blob; kind: FileKind; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [objUrl, setObjUrl] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    let made: string | null = null;
    void (async () => {
      try {
        if (props.kind === "text" || props.kind === "html") {
          if (props.blob.size > TEXT_CAP) return;
          const raw = await props.blob.text();
          if (dead) return;
          if (props.kind === "text") setText(raw);
          else setHtml(await sanitizeOwnedHtml(raw));
          return;
        }
        if (props.kind === "image" || props.kind === "audio" || props.kind === "video") {
          made = URL.createObjectURL(props.blob);
          if (!dead) setObjUrl(made);
        }
      } catch {
        /* viewer stays empty; Download still works */
      }
    })();
    return () => { dead = true; if (made) URL.revokeObjectURL(made); };
  }, [props.kind, props.blob]);

  return (
    <div className="lb-fv-overlay" onClick={props.onClose}>
      <m3e-card variant="elevated" {...{ class: "lb-fv-card" }} onClick={(e) => e.stopPropagation()}>
        <div slot="header" className="lb-site-head">
          <span className="lb-site-ctitle">
            {props.name} <span className="lb-muted">({fmtBytes(props.blob.size)}, {props.kind})</span>
          </span>
          <m3e-icon-button aria-label="Close viewer" onClick={props.onClose}>
            <m3e-icon name="close" aria-hidden={true} />
          </m3e-icon-button>
        </div>
        <div slot="content" className="lb-fv-body">
          {props.kind === "pdf" && <PdfViewer blob={props.blob} />}
          {(props.kind === "zip" || props.kind === "gzip" || props.kind === "zlib") && (
            <ArchiveViewer name={props.name} blob={props.blob} kind={props.kind} />
          )}
          {props.kind === "image" &&
            (objUrl ? <img className="lb-fv-image" src={objUrl} alt={props.name} /> : <p className="lb-muted">Loading...</p>)}
          {props.kind === "audio" &&
            (objUrl ? <audio className="lb-fv-media" controls src={objUrl} /> : <p className="lb-muted">Loading...</p>)}
          {props.kind === "video" &&
            (objUrl ? <video className="lb-fv-media" controls src={objUrl} /> : <p className="lb-muted">Loading...</p>)}
          {props.kind === "text" &&
            (text !== null ? (
              <pre className="lb-fv-text">{text}</pre>
            ) : (
              <p className="lb-muted">{props.blob.size > TEXT_CAP ? "File above the 2 MiB preview cap - use Download." : "Loading..."}</p>
            ))}
          {props.kind === "html" &&
            (html !== null ? (
              <iframe title="HTML preview" className="lb-fv-preview" sandbox="" srcDoc={html} />
            ) : (
              <p className="lb-muted">{props.blob.size > TEXT_CAP ? "File above the 2 MiB preview cap - use Download." : "Loading..."}</p>
            ))}
          {props.kind === "other" && (
            <p className="lb-muted">No preview for this file type. The Download button saves the original transfer.</p>
          )}
        </div>
        <div slot="actions" className="lb-fv-actions">
          <m3e-button onClick={() => saveBlob(props.name, props.blob)}>
            <m3e-icon name="download" aria-hidden={true} /> Download
          </m3e-button>
        </div>
      </m3e-card>
    </div>
  );
}
