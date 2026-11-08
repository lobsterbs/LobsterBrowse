/* Ad-blocking sheet (#236): the overflow card is now a modal
   m3e-bottom-sheet matching the extensions and tab sheets. It shows a
   per-document ad/tracker block counter fed by the scoped diagnostics
   ring (the same sanitized source the DevTools diagnostics page
   reads), plus the site-scoped block switch. The count poll lives
   here (presentational state only) and only runs while the sheet is
   open; the rules themselves live in pages/Browser.tsx and the
   Settings store. The sheet stays mounted; open/close rides the
   sheet's own show()/hide() methods with the closing event flowing
   back into Browser state (the TabSwitcherCard pattern). */
import { useEffect, useRef, useState } from "react";
import { zlContentQuery, zlSend } from "../zeolite";
import {
  blockedHostOf, diagnosticsScope, pollDocumentDiagnostics, snapshotForScope,
  type DiagnosticsSnapshot, type DiagnosticsStatus, type EngineSource,
} from "./diagnosticsScope";

export default function AdBlockCard(props: {
  /* #236: the sheet owns its open state; show/hide ride props.open. */
  open: boolean;
  clientId?: string;
  source?: EngineSource;
  host: string;
  globalAdblock: boolean;
  /* The site rule's adblock field: undefined inherits (on when the
     global setting is on), false disables blocking for this site. */
  siteAdblock: boolean | undefined;
  onSiteToggle: (enabled: boolean) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null);
  const scope = diagnosticsScope(props.clientId, props.source);

  /* Live-props ref: the sheet's event listener outlives renders. */
  const live = useRef(props);
  live.current = props;
  const sheetRef = useRef<HTMLElement & { show: () => void; hide: () => void } | null>(null);

  /* The bottom sheet owns its open state (show/hide methods, per the
     @m3e/web docs). React never writes the open attribute; the
     component's closing event (Escape, scrim dismissal, swipe-down)
     flows back into React state instead. */
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const onClosing = () => live.current.onClose();
    el.addEventListener("closing", onClosing);
    return () => el.removeEventListener("closing", onClosing);
  }, []);
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    if (props.open) el.show();
    else el.hide();
  }, [props.open]);

  /* Same scoped poll as the DevTools diagnostics page: zl:getNetLog
     and zl:getDiag, sanitized and scope-checked before they land.
     #236: the poll only runs while the sheet is open. */
  useEffect(() => {
    if (!props.open) return;
    return pollDocumentDiagnostics(
      diagnosticsScope(props.clientId, props.source), zlSend, zlContentQuery,
      (snap, st) => {
        setSnapshot(snap);
        setStatus(st ?? null);
      },
    );
  }, [props.open, props.clientId, props.source]);

  const current = snapshotForScope(snapshot, scope);
  const blocked = current ? current.events.filter((e) => e.category === "BLOCKED") : [];
  /* Hosts ranked by blocked-request count (top five). */
  const byHost = new Map<string, number>();
  for (const e of blocked) {
    const h = blockedHostOf(e);
    byHost.set(h, (byHost.get(h) ?? 0) + 1);
  }
  const top = [...byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const effective = props.globalAdblock && props.siteAdblock !== false;
  return (
    <m3e-bottom-sheet
      detents="fit"
      modal=""
      handle=""
      hideable=""
      handle-label="Dismiss ad blocking"
      aria-label="Ad blocking"
      {...{ class: "lb-ad-sheet", ref: sheetRef }}
    >
      <m3e-app-bar slot="header" size="small" {...{ class: "lb-sheet-bar" }}>
        <m3e-icon-button slot="leading" aria-label="Back" onClick={props.onClose}>
          <m3e-icon name="arrow_back" aria-hidden={true} />
        </m3e-icon-button>
        <span slot="title">Ad blocking</span>
      </m3e-app-bar>
      <div className="lb-ad-body">
        {current ? (
          <>
            {/* #236: hero row - the shield sits in a tonal circle
                beside the count, so icon and number read as one
                unit. */}
            <div className="lb-ad-hero">
              <div className="lb-ad-hero-ic">
                <m3e-icon name="shield" aria-hidden={true} />
              </div>
              <div className="lb-ad-hero-txt">
                <span className="lb-ad-num">{blocked.length}</span>
                <p className="lb-ad-sub">
                  {blocked.length === 1
                    ? "ad and tracker request blocked on this page"
                    : "ad and tracker requests blocked on this page"}
                </p>
              </div>
            </div>
            {top.length > 0 ? (
              <div className="lb-ad-hosts">
                {top.map(([h, n]) => (
                  <div key={h} className="lb-ad-host"><span className="lb-ad-hostn">{n}</span>{h}</div>
                ))}
              </div>
            ) : (
              <p className="lb-muted">No blocked requests recorded for this document yet.</p>
            )}
          </>
        ) : (
          <p className="lb-muted">
            {status === "identity"
              ? "No engine identity for this document yet."
              : "Collecting blocked-request data for this page..."}
          </p>
        )}
        <div className="lb-ad-row">
          <div>
            <div className="lb-ad-rowtitle">Block ads on {props.host || "this site"}</div>
            <div className="lb-muted">
              {!props.globalAdblock
                ? "Ad blocking is off globally"
                : props.siteAdblock === false
                  ? "Disabled for this site (global blocking stays on)"
                  : "Inherits the global setting"}
            </div>
          </div>
          <m3e-switch
            checked={effective ? "" : undefined}
            disabled={!props.globalAdblock ? "" : undefined}
            icons="selected"
            onClick={() => props.onSiteToggle(!effective)}
          />
        </div>
        {/* #236: full-width tonal footer button, matching the sheet
            pattern. */}
        <m3e-button variant="tonal" {...{ class: "lb-ad-foot" }} onClick={props.onOpenSettings}>
          <m3e-icon name="settings" aria-hidden={true} />
          Configure in Settings
        </m3e-button>
      </div>
    </m3e-bottom-sheet>
  );
}
