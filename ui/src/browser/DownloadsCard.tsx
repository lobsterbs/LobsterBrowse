/* Downloads panel card. Presentational: every download starts, updates
   and finishes in pages/Browser.tsx (the browser page lifecycle owns
   the transfer); this file only renders the list. */
import { dlIconFor, fmtBytes } from "./browserShared";

export type DlItem = {
  id: number;
  name: string;
  url: string;
  size: number;
  got: number;
  status: "active" | "done" | "error";
  error?: string;
};

export default function DownloadsCard(props: {
  downloads: DlItem[];
  onClose: () => void;
  onRemove: (id: number) => void;
}) {
  return (
    <m3e-card variant="elevated" aria-label="Downloads" {...{ class: "lb-dl-card" }}>
      <div slot="header" className="lb-site-head">
        <span className="lb-site-ctitle">Downloads ({props.downloads.length})</span>
        <m3e-icon-button aria-label="Close downloads" onClick={props.onClose}>
          <m3e-icon name="close" aria-hidden={true} />
        </m3e-icon-button>
      </div>
      <div slot="content" className="lb-dl-list">
        {props.downloads.map((d) => (
          <div key={d.id} className="lb-dl-item">
            <m3e-icon name={dlIconFor(d.name)} aria-hidden={true} />
            <div className="lb-dl-body">
              <div className="lb-dl-name" title={d.name}>{d.name}</div>
              {d.status === "active" && (
                <div className="lb-dl-progress">
                  <m3e-linear-progress-indicator
                    aria-label={"Downloading " + d.name}
                    value={d.size > 0 ? String(Math.round((d.got / d.size) * 100)) : undefined}
                    max="100"
                    mode={d.size > 0 ? undefined : "indeterminate"}
                  />
                </div>
              )}
              <div className="lb-dl-meta">
                {d.status === "active"
                  ? (d.size > 0 ? fmtBytes(d.got) + " / " + fmtBytes(d.size) : fmtBytes(d.got)) + " downloaded"
                  : d.status === "done"
                    ? "Complete, saved to your device"
                    : "Failed: " + d.error}
              </div>
            </div>
            <m3e-icon-button
              aria-label={"Remove " + d.name + " from the list"}
              onClick={() => props.onRemove(d.id)}
            >
              <m3e-icon name="close" aria-hidden={true} />
            </m3e-icon-button>
          </div>
        ))}
      </div>
    </m3e-card>
  );
}
