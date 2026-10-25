/* Downloads panel card. Presentational: every download starts, updates
   and finishes in pages/Browser.tsx (the browser page lifecycle owns
   the transfer); this file only renders the list. */
import { useReducedMotion } from "motion/react";
import { dlIconFor, fmtBytes } from "./browserShared";

export type DlItem = {
  id: number;
  name: string;
  url: string;
  size: number;
  got: number;
  status: "active" | "done" | "error" | "cancelled";
  error?: string;
};

export default function DownloadsCard(props: {
  /* #76: true while the close animation plays. */
  closing?: boolean;
  downloads: DlItem[];
  onClose: () => void;
  onRemove: (id: number) => void;
  onCancel: (id: number) => void;
}) {
  /* #212: the wavy download progress follows the reduced-motion
     preference (the component itself does not gate its wave). */
  const flatProgress = useReducedMotion() === true;
  return (
    <m3e-card
      variant="elevated"
      aria-label="Downloads"
      {...{ class: props.closing ? "lb-dl-card lb-out" : "lb-dl-card" }}
    >
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
                  {/* #212: wavy progress for active downloads (the variant
                      exists on both indicator shapes in @m3e/web 2.8.2);
                      the flat variant renders under reduced motion. */}
                  <m3e-linear-progress-indicator
                    aria-label={"Downloading " + d.name}
                    variant={flatProgress ? "flat" : "wavy"}
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
                    : d.status === "cancelled"
                      ? "Cancelled"
                      : "Failed: " + d.error}
              </div>
            </div>
            {d.status === "active" ? (
              <m3e-icon-button
                aria-label={"Cancel " + d.name}
                onClick={() => props.onCancel(d.id)}
              >
                <m3e-icon name="close" aria-hidden={true} />
              </m3e-icon-button>
            ) : (
              <m3e-icon-button
                aria-label={"Remove " + d.name + " from the list"}
                onClick={() => props.onRemove(d.id)}
              >
                <m3e-icon name="close" aria-hidden={true} />
              </m3e-icon-button>
            )}
          </div>
        ))}
      </div>
    </m3e-card>
  );
}
