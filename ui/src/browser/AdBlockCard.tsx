/* Ad-blocking card (overflow menu): a per-document ad/tracker block
   counter fed by the scoped diagnostics ring (the same sanitized
   source the DevTools diagnostics page reads), plus the site-scoped
   block switch. The count poll lives here (presentational state
   only); the rules themselves live in pages/Browser.tsx and the
   Settings store. */
import { useEffect, useState } from "react";
import { zlContentQuery, zlSend } from "../zeolite";
import {
  blockedHostOf, diagnosticsScope, pollDocumentDiagnostics, snapshotForScope,
  type DiagnosticsSnapshot, type DiagnosticsStatus, type EngineSource,
} from "./diagnosticsScope";

export default function AdBlockCard(props: {
  /* #76: true while the close animation plays. */
  closing?: boolean;
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
  /* Same scoped poll as the DevTools diagnostics page: zl:getNetLog
     and zl:getDiag, sanitized and scope-checked before they land. */
  useEffect(() => pollDocumentDiagnostics(
    diagnosticsScope(props.clientId, props.source), zlSend, zlContentQuery,
    (snap, st) => {
      setSnapshot(snap);
      setStatus(st ?? null);
    },
  ), [props.clientId, props.source]);
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
    <m3e-card
      variant="elevated"
      aria-label="Ad blocking"
      {...{ class: props.closing ? "lb-ad-card lb-out" : "lb-ad-card" }}
    >
      <div slot="header" className="lb-site-head">
        <span className="lb-site-ctitle">Ad blocking</span>
        <m3e-icon-button aria-label="Close ad blocking" onClick={props.onClose}>
          <m3e-icon name="close" aria-hidden={true} />
        </m3e-icon-button>
      </div>
      <div slot="content" className="lb-ad-body">
        {current ? (
          <>
            <div className="lb-ad-count">
              <m3e-icon name="shield" aria-hidden={true} />
              <span className="lb-ad-num">{blocked.length}</span>
            </div>
            <p className="lb-ad-sub">
              {blocked.length === 1
                ? "ad and tracker request blocked on this page"
                : "ad and tracker requests blocked on this page"}
            </p>
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
        <m3e-button onClick={props.onOpenSettings}>
          <m3e-icon name="settings" aria-hidden={true} />
          Configure in Settings
        </m3e-button>
      </div>
    </m3e-card>
  );
}
