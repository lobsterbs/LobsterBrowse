/* Extensions side panel (installed add-ons list + detail view).
   Presentational: the engine control-plane queries and state stay in
   pages/Browser.tsx. */
export type ExtInfo = {
  id: string;
  name: string;
  version: string;
  state: string;
  enabled: boolean;
  lastError: string | null;
};

export type ExtDetail = {
  id: string;
  name: string;
  version: string;
  description: string;
  state: string;
  enabled: boolean;
  lastError: string | null;
  permissions: string[];
  hostPermissions: string[];
  contentScripts: number;
  optionsPath: string | null;
};

export default function ExtensionsPanel(props: {
  list: ExtInfo[] | null;
  busy: boolean;
  error: string | null;
  detail: ExtDetail | null;
  detailError: string | null;
  incognito: Record<string, boolean>;
  onRefresh: () => void;
  onClose: () => void;
  onOpenDetail: (id: string) => void;
  onCloseDetail: () => void;
  onToggleEnabled: (id: string, on: boolean) => void;
  onToggleIncognito: (id: string, on: boolean) => void;
  onOpenOptions: (d: ExtDetail) => void;
}) {
  return (
    <div className="lb-ext-panel" role="dialog" aria-label="Extensions">
      <div className="lb-ext-head">
        <span className="lb-ext-title">Extensions</span>
        <span>
          <m3e-icon-button aria-label="Refresh extensions" onClick={props.onRefresh}>
            <m3e-icon name="refresh" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-icon-button aria-label="Close extensions" onClick={props.onClose}>
            <m3e-icon name="close" aria-hidden={true} />
          </m3e-icon-button>
        </span>
      </div>
      {props.list === null && props.busy ? (
        /* #64: skeleton rows in the exact real-row metrics (28px
           avatar, flex-1 name bar, fixed version bar) so the pending
           list reads as loading, never as "no extensions installed".
           Same shape as the page-load skeleton: sized divs slotted
           into a flex m3e-skeleton. */
        <div className="lb-ext-list" aria-hidden={true}>
          {[0, 1, 2].map((i) => (
            <m3e-skeleton animation="wave" shape="rounded" key={i} {...{ class: "lb-ext-skel-row" }}>
              <div className="lb-ext-skel-ava" />
              <div className="lb-ext-skel-name" />
              <div className="lb-ext-skel-ver" />
            </m3e-skeleton>
          ))}
        </div>
      ) : props.list === null ? (
        <p className="lb-ext-note">
          {props.error
            ? "Engine extensions unavailable: " + props.error
            : "Engine extensions unavailable. No Zeolite service worker on this origin."}
        </p>
      ) : props.list.length === 0 ? (
        <p className="lb-ext-note">No extensions installed.</p>
      ) : (
        <div className="lb-ext-list">
          {props.list.map((e) => (
            <div
              key={e.id}
              className={"lb-ext-item" + (props.detail && props.detail.id === e.id ? " sel" : "")}
              title={e.lastError ?? ""}
              role="button"
              tabIndex={0}
              onClick={() => props.onOpenDetail(e.id)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") props.onOpenDetail(e.id);
              }}
            >
              <m3e-avatar {...{ class: "lb-ext-ava" }} aria-hidden={true}>
                {e.name.replace(/[^A-Za-z0-9].*/, "").slice(0, 2).toUpperCase() || "?"}
              </m3e-avatar>
              <span className="lb-ext-name">{e.name}</span>
              <span className="lb-ext-ver">{e.version}</span>
              <span className={"lb-ext-state" + (e.enabled ? "" : " off")}>
                {e.enabled ? e.state : "disabled"}
              </span>
            </div>
          ))}
        </div>
      )}
      {props.detailError && <p className="lb-ext-err">{props.detailError}</p>}
      {props.detail && (
        <div className="lb-ext-detail">
          <div className="lb-ext-dhead">
            <span className="lb-ext-dtitle">
              <m3e-avatar {...{ class: "lb-ext-ava" }} aria-hidden={true}>
                {props.detail.name.replace(/[^A-Za-z0-9].*/, "").slice(0, 2).toUpperCase() || "?"}
              </m3e-avatar>
              <span className="lb-ext-dname">
                {props.detail.name} <span className="lb-ext-ver">{props.detail.version}</span>
              </span>
            </span>
            <m3e-icon-button aria-label="Close extension details" onClick={props.onCloseDetail}>
              <m3e-icon name="close" aria-hidden={true} />
            </m3e-icon-button>
          </div>
          {props.detail.description && <p className="lb-ext-desc">{props.detail.description}</p>}
          <div className="lb-ext-trow">
            <span className="lb-ext-tlabel">Enabled</span>
            <m3e-switch
              checked={props.detail.enabled ? "" : undefined}
              icons="selected"
              aria-label="Extension enabled"
              onClick={() => props.onToggleEnabled(props.detail!.id, !props.detail!.enabled)}
            />
          </div>
          <div className="lb-ext-trow">
            <span className="lb-ext-tlabel">Allow in incognito tabs</span>
            {/* Permission grant: a checkbox (not an instant-apply switch)
               reads as opt-in consent, matching the grant-and-notice
               pattern below. */}
            <m3e-checkbox
              checked={props.incognito[props.detail.id] ? "" : undefined}
              aria-label="Allow extension in incognito tabs"
              onClick={() => props.onToggleIncognito(props.detail!.id, !props.incognito[props.detail!.id])}
            />
          </div>
          {/* Honest labeling (P0): this records the user's intent only.
              The engine has no incognito concept yet, so the grant is
              NOT enforced; do not present it as a security control. */}
          <p className="lb-ext-desc">
            {props.incognito[props.detail.id]
              ? "Grant recorded, but not enforced yet: the engine does not have incognito tabs."
              : "Not enforced yet: the engine does not have incognito tabs."}
          </p>
          {(props.detail.permissions.length > 0 || props.detail.hostPermissions.length > 0) && (
            <div className="lb-ext-perms">
              {[...props.detail.permissions, ...props.detail.hostPermissions].slice(0, 12).map((p) => (
                <code key={p}>{p}</code>
              ))}
            </div>
          )}
          {props.detail.contentScripts > 0 && (
            <p className="lb-ext-desc">
              {props.detail.contentScripts} content script{props.detail.contentScripts === 1 ? "" : "s"} registered.
            </p>
          )}
          {props.detail.optionsPath && (
            <m3e-button onClick={() => props.onOpenOptions(props.detail!)} {...{ class: "lb-ext-optbtn" }}>
              <m3e-icon name="settings" aria-hidden={true} /> Open options page
            </m3e-button>
          )}
          {props.detail.lastError && <p className="lb-ext-err">{props.detail.lastError}</p>}
        </div>
      )}
    </div>
  );
}
