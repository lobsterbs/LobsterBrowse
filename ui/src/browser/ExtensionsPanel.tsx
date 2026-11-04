/* Extensions toolbar card: the installed add-ons list as a launcher.
   #230: pressing an extension launches its UI directly (its options
   page); the configuration UI that used to render inside this card
   moved to Settings > Extensions (browser/ExtManage.tsx, mounted by
   pages/Settings.tsx). Search-and-install over the AMO API also lives
   in Settings (browser/AmoSearch.tsx); the engine control-plane
   queries and state stay in pages/Browser.tsx.

   #76: the card animates in and out (Browser.tsx keeps it mounted
   one animation longer and flips the exit class), and uninstall is
   available from every surface: a trash affordance per row here plus
   the Delete button in Settings, both asking first in a m3e-dialog
   (#99). */

import { useEffect, useRef, useState } from "react";
import EmptyState from "../components/ui/EmptyState";

type DialogEl = HTMLElement & { show: () => Promise<void>; returnValue: string };

/* Engine-reported errors that are known honest gaps, not failures this
   card should surface: background.page is an unsupported manifest
   field (Zeolite tracks support for it). */
const shownError = (e: string | null): string | null =>
  e && /background\.page is not supported/.test(e) ? null : e;

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
  /* #230: honest failure text from the last direct-launch attempt. */
  launchError: string | null;
  onRefresh: () => void;
  onClose: () => void;
  /* #230: pressing the row launches the extension UI directly. */
  onLaunch: (id: string) => void;
  onDelete: (id: string) => void;
  /* #214: the empty state's concrete next step, and the card footer:
     both open Settings, where add-ons are installed and configured. */
  onFindAddons?: () => void;
}) {
  /* Removal is irreversible (the engine deletes the extension's stored
     data and caches), so the row trash icon opens a Cancel/Remove
     m3e-dialog (the Settings pattern). Escape, the scrim and Cancel
     all close with no removal. */
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
        <EmptyState
          icon="extension"
          headline="No extensions installed"
          help="Add-ons are installed from the Settings page."
          action={props.onFindAddons ? { label: "Find add-ons", onClick: props.onFindAddons } : undefined}
        />
      ) : (
        <div className="lb-ext-list">
          {props.list.map((e) => (
            <div
              key={e.id}
              className="lb-ext-item"
              title={shownError(e.lastError) ?? ""}
              role="button"
              tabIndex={0}
              onClick={() => props.onLaunch(e.id)}
              onKeyDown={(ev) => {
                /* #118: keys pressed on a nested control (Delete) belong
                   to that control alone; Space must not scroll either. */
                if (ev.target !== ev.currentTarget) return;
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  props.onLaunch(e.id);
                }
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
      {props.launchError && <p className="lb-ext-err">{props.launchError}</p>}
      {props.onFindAddons && (
        <div className="lb-ext-foot">
          <m3e-button onClick={props.onFindAddons}>
            <m3e-icon name="settings" aria-hidden={true} /> Manage in Settings
          </m3e-button>
        </div>
      )}
    </div>
  );
}
