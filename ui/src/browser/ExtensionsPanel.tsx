/* Extensions bottom sheet (#234): the installed add-ons list as one
   mini-card per extension - icon stand-in, then title; press launches
   the extension UI directly (#230). Configuration stays in Settings
   > Extensions (browser/ExtManage.tsx); search-and-install over the
   AMO API lives in Settings too (browser/AmoSearch.tsx); the engine
   control-plane queries and state stay in pages/Browser.tsx.

   The sheet stays mounted and owns its open state (show/hide, the
   closing event flowing back into Browser state), exactly like the
   tab switcher. Uninstall is available from every surface: the
   trash affordance per card here plus the Delete button in Settings,
   both asking first in a m3e-dialog (#99). */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
  /* Wave 89: the engine reports the extension's icon route
     (zl:listExt iconPath); absent on older engine pins. */
  iconPath?: string | null;
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
  /* Issue #242: the engine icon route is a page token that expires
     after 5 minutes, and an img subresource from a page the worker
     does not control bypasses it entirely - both 404 and paint the
     browser's broken-image glyph. Extensions whose icon failed fall
     back to the initials avatar instead, and one list refresh per
     mount re-mints the tokens (the sheet-open refresh already does
     this on every open). A fresh list clears the failed marks so a
     working icon is retried. */
  const [badIcons, setBadIcons] = useState<Record<string, true>>({});
  const iconRefreshedRef = useRef(false);
  useEffect(() => {
    setBadIcons({});
  }, [props.list]);
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

  /* #234: the bottom sheet owns its open state (show/hide, per the
     @m3e/web docs). React never writes the open attribute; the
     component's closing event (Escape, scrim dismissal, swipe-down)
     flows back into React state instead, like the tab switcher. */
  const sheetRef = useRef<HTMLElement & { show: () => void; hide: () => void } | null>(null);
  const live = useRef(props);
  live.current = props;
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

  return (
    <m3e-bottom-sheet
      detents="fit"
      modal=""
      handle=""
      hideable=""
      handle-label="Dismiss extensions"
      aria-label="Extensions"
      {...{ class: "lb-ext-sheet", ref: sheetRef }}
    >
      <m3e-app-bar slot="header" size="small" {...{ class: "lb-sheet-bar" }}>
        <m3e-icon-button slot="leading" aria-label="Back" onClick={props.onClose}>
          <m3e-icon name="arrow_back" aria-hidden={true} />
        </m3e-icon-button>
        <span slot="title">Extensions</span>
      </m3e-app-bar>
      <div className="lb-ext-sheet-body">
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
            /* #234: one mini-card per extension - icon, then
               title; press launches the extension UI directly (#230).
               Version and state stay in Settings; the avatar shows the
               engine-reported icon when zl:listExt carries one (wave
               89), initials otherwise. */
            <m3e-card
              key={e.id}
              variant="outlined"
              {...{
                class: "lb-ext-tile",
                role: "button",
                tabIndex: 0,
                title: shownError(e.lastError) ?? "",
                "aria-label": "Open " + e.name,
                onClick: () => props.onLaunch(e.id),
                onKeyDown: (ev: KeyboardEvent) => {
                  /* #118: keys pressed on a nested control (Delete) belong
                     to that control alone; Space must not scroll either. */
                  if (ev.target !== ev.currentTarget) return;
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    props.onLaunch(e.id);
                  }
                },
              }}
            >
              <div slot="content" className="lb-ext-tile-inner">
                <div className="lb-ext-ava" aria-hidden={true}>
                {/* Wave 89: the real icon when the engine reports one,
                   initials otherwise. Wave 90 (issue #242): a failed
                   load falls back to initials, never a broken glyph. */}
                {e.iconPath && !badIcons[e.id] ? (
                  <img
                    className="lb-ext-ava-img"
                    src={e.iconPath}
                    alt=""
                    onError={() => {
                      setBadIcons((m) => ({ ...m, [e.id]: true }));
                      if (!iconRefreshedRef.current) {
                        iconRefreshedRef.current = true;
                        props.onRefresh();
                      }
                    }}
                  />
                ) : (
                  e.name.replace(/[^A-Za-z0-9].*/, "").slice(0, 2).toUpperCase() || "?"
                )}
              </div>
              <span className="lb-ext-name">{e.name}</span>
                <m3e-icon-button
                  aria-label={"Delete " + e.name}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setPendingDelete({ id: e.id, name: e.name });
                  }}
                >
                  <m3e-icon name="delete" aria-hidden={true} />
                </m3e-icon-button>
              </div>
            </m3e-card>
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
    </m3e-bottom-sheet>
  );
}
