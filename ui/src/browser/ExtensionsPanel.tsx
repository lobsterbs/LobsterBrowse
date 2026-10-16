/* Extensions toolbar panel: installed add-ons list + detail view.
   Search-and-install over the AMO API lives in Settings
   (browser/AmoSearch.tsx); the engine control-plane queries and
   state stay in pages/Browser.tsx.

   #76: the panel animates in and out (Browser.tsx keeps it mounted
   one animation longer and flips the exit class), and uninstall is
   available from every surface: a trash affordance per row plus a
   Delete in the detail view. Both ask first in a m3e-dialog (#99). */

import { useEffect, useRef, useState } from "react";

type DialogEl = HTMLElement & { show: () => Promise<void>; returnValue: string };

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
  open: boolean;
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
  onDelete: (id: string) => void;
}) {
  /* Removal is irreversible (the engine deletes the extension's stored
     data and caches), so both the row trash icon and the detail button
     open a Cancel/Remove m3e-dialog (the Settings pattern). Escape,
     the scrim and Cancel all close with no removal. */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const pendingRef = useRef(pendingDelete);
  pendingRef.current = pendingDelete;
  const onDeleteRef = useRef(props.onDelete);
  onDeleteRef.current = props.onDelete;
  const deleteDialogRef = useRef<DialogEl | null>(null);
  useEffect(() => {
    const el = deleteDialogRef.current;
    if (!el) return;
    const onClosed = () => {
      const target = pendingRef.current;
      const confirmed = el.returnValue === "remove";
      el.returnValue = "";
      setPendingDelete(null);
      if (confirmed && target) onDeleteRef.current(target.id);
    };
    el.addEventListener("closed", onClosed);
    return () => el.removeEventListener("closed", onClosed);
  }, []);
  useEffect(() => {
    const el = deleteDialogRef.current;
    if (!pendingDelete || !el) return;
    el.returnValue = "";
    void el.show();
  }, [pendingDelete]);

  return (
    <div className={"lb-ext-panel" + (props.open ? "" : " lb-out")} role="dialog" aria-label="Extensions">
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
      <m3e-dialog {...{ ref: deleteDialogRef }} alert="">
        <span slot="header">Remove {pendingDelete?.name ?? "extension"}?</span>
        <p>Its stored data and caches are removed from the engine. This cannot be undone.</p>
        <div slot="actions">
          <m3e-button autofocus>
            <m3e-dialog-action return-value="cancel">Cancel</m3e-dialog-action>
          </m3e-button>
          <m3e-button variant="filled">
            <m3e-dialog-action return-value="remove">Remove</m3e-dialog-action>
          </m3e-button>
        </div>
      </m3e-dialog>
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
              <div className="lb-ext-ava" aria-hidden={true}>
                {e.name.replace(/[^A-Za-z0-9].*/, "").slice(0, 2).toUpperCase() || "?"}
              </div>
              <span className="lb-ext-name">{e.name}</span>
              <span className="lb-ext-ver">{e.version}</span>
              <span className={"lb-ext-state" + (e.enabled ? "" : " off")}>
                {e.enabled ? e.state : "disabled"}
              </span>
              <span className="lb-ext-item-actions">
                <m3e-icon-button
                  aria-label={"Delete " + e.name}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setPendingDelete({ id: e.id, name: e.name });
                  }}
                >
                  <m3e-icon name="delete" aria-hidden={true} />
                </m3e-icon-button>
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
              <div className="lb-ext-ava" aria-hidden={true}>
                {props.detail.name.replace(/[^A-Za-z0-9].*/, "").slice(0, 2).toUpperCase() || "?"}
              </div>
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
            <m3e-checkbox
              checked={props.incognito[props.detail.id] ? "" : undefined}
              aria-label="Allow extension in incognito tabs"
              onClick={() => props.onToggleIncognito(props.detail!.id, !props.incognito[props.detail!.id])}
            />
          </div>
          <div className="lb-ext-actions">
            {props.detail.optionsPath && (
              <m3e-button onClick={() => props.onOpenOptions(props.detail!)} {...{ class: "lb-ext-optbtn" }}>
                <m3e-icon name="settings" aria-hidden={true} /> Open options page
              </m3e-button>
            )}
            <m3e-button
              onClick={() => setPendingDelete({ id: props.detail!.id, name: props.detail!.name })}
              {...{ class: "lb-ext-delbtn" }}
            >
              <m3e-icon name="delete" aria-hidden={true} />
              Delete extension
            </m3e-button>
          </div>
          {props.detail.lastError && <p className="lb-ext-err">{props.detail.lastError}</p>}
        </div>
      )}
    </div>
  );
}
