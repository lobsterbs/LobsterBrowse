/* Settings > Extensions: installed add-on management (#230). The
   configuration UI that lived in the toolbar extension card moved
   here - enable/disable, the manifest detail view, the options page,
   and removal - while the toolbar card became a direct launcher.

   Self-contained on purpose: it talks to the Zeolite control plane
   through zlSend itself (the same plumbing the Browser page and the
   import flows use), so Settings does not thread extension state
   through props, and it re-lists whenever an install lands (the
   window event the AMO search and the local importer dispatch).

   #76: uninstall stays available from every surface: a trash
   affordance per row plus Delete in the detail view, both asking
   first in a m3e-dialog (#99). */
import { useEffect, useRef, useState } from "react";
import { zlSend } from "../zeolite";
import { pushLog } from "../store";
import { extLaunchPlan, openExtPageWindow } from "./extLaunch";
import type { ExtDetail, ExtInfo } from "./ExtensionsPanel";

type DialogEl = HTMLElement & { show: () => Promise<void>; returnValue: string };

/* Same honest-gap filter as the toolbar card: background.page is an
   unsupported manifest field (Zeolite tracks support for it). */
const shownError = (e: string | null): string | null =>
  e && /background\.page is not supported/.test(e) ? null : e;

export default function ExtManage() {
  const [list, setList] = useState<ExtInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExtDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    if (!("serviceWorker" in navigator)) {
      setBusy(false);
      setList(null);
      setError("this browser has no service worker support");
      return;
    }
    setBusy(true);
    const rep = await zlSend({ type: "zl:listExt" }, 5000);
    setBusy(false);
    if (!rep) {
      setList(null);
      setError("the Zeolite service worker could not be registered or reached on this origin");
      return;
    }
    if (!rep.ok) {
      setList(null);
      setError(rep.error ? String(rep.error) : "zl:listExt failed");
      return;
    }
    setList(Array.isArray(rep.extensions) ? (rep.extensions as ExtInfo[]) : []);
  };

  useEffect(() => {
    void load();
    /* Installs can land from the AMO search or the local importer in
       the same panel: both dispatch lb-ext-changed, this re-lists. */
    const onChanged = () => void load();
    window.addEventListener("lb-ext-changed", onChanged);
    return () => window.removeEventListener("lb-ext-changed", onChanged);
  }, []);

  const openDetail = async (id: string) => {
    setDetailError(null);
    setDetail(null);
    const rep = await zlSend({ type: "zl:extInfo", extId: id }, 6000);
    if (rep && rep.ok && rep.extension) {
      setDetail(rep.extension as ExtDetail);
    } else {
      setDetailError(
        rep && rep.error ? String(rep.error) : "the worker did not answer zl:extInfo",
      );
    }
  };

  const toggleEnabled = async (id: string, on: boolean) => {
    const rep = await zlSend({ type: "zl:extEnable", extId: id, enabled: on }, 6000);
    if (!rep || !rep.ok) {
      setDetailError(
        rep && rep.error ? String(rep.error) : "the worker did not answer zl:extEnable",
      );
      return;
    }
    /* Mirror the new state locally and refresh the list. */
    void load();
    setDetail((d) => (d && d.id === id ? { ...d, enabled: on } : d));
  };

  const openOptions = async (d: ExtDetail) => {
    const plan = extLaunchPlan(d);
    if (!plan.launch) {
      setDetailError(plan.reason);
      return;
    }
    const err = await openExtPageWindow(zlSend, d.id, plan.which);
    if (err) {
      setDetailError(err);
      return;
    }
    pushLog("info", "ext options open " + d.id);
  };

  /* Uninstall (#76): the manager owns removal (storage, caches,
     menus, alarms, background). The list refreshes from the reply. */
  const uninstall = async (id: string) => {
    const rep = await zlSend({ type: "zl:extUninstall", extId: id }, 8000);
    if (!rep || !rep.ok) {
      setDetailError(
        rep && rep.error ? String(rep.error) : "the worker did not answer zl:extUninstall",
      );
      return;
    }
    if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
      M3eSnackbar.open("Extension removed", { duration: 3000 });
    }
    setDetail(null);
    void load();
  };

  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const pendingRef = useRef(pendingDelete);
  pendingRef.current = pendingDelete;
  const onDeleteRef = useRef(uninstall);
  onDeleteRef.current = uninstall;
  const deleteDialogRef = useRef<DialogEl | null>(null);
  useEffect(() => {
    const el = deleteDialogRef.current;
    if (!el) return;
    const onClosed = () => {
      const target = pendingRef.current;
      const confirmed = el.returnValue === "remove";
      el.returnValue = "";
      setPendingDelete(null);
      if (confirmed && target) void onDeleteRef.current(target.id);
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
    <div className="lb-ext-manage">
      <div className="lb-ext-mhead">
        <span className="lb-ext-title">Installed extensions</span>
        <m3e-icon-button aria-label="Refresh extensions" onClick={() => void load()}>
          <m3e-icon name="refresh" aria-hidden={true} />
        </m3e-icon-button>
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
      {list === null && busy ? (
        <div className="lb-ext-list" aria-hidden={true}>
          {[0, 1, 2].map((i) => (
            <m3e-skeleton animation="wave" shape="rounded" key={i} {...{ class: "lb-ext-skel-row" }}>
              <div className="lb-ext-skel-ava" />
              <div className="lb-ext-skel-name" />
              <div className="lb-ext-skel-ver" />
            </m3e-skeleton>
          ))}
        </div>
      ) : list === null ? (
        <p className="lb-ext-note">
          {error
            ? "Engine extensions unavailable: " + error
            : "Engine extensions unavailable. No Zeolite service worker on this origin."}
        </p>
      ) : list.length === 0 ? (
        <p className="lb-ext-note">No extensions installed yet.</p>
      ) : (
        <div className="lb-ext-list">
          {list.map((e) => (
            <md-card variant="filled"
              key={e.id}
              className={"lb-ext-item" + (detail && detail.id === e.id ? " sel" : "")}
              title={shownError(e.lastError) ?? ""}
              role="button"
              tabIndex={0}
              onClick={() => void openDetail(e.id)}
              onKeyDown={(ev) => {
                if (ev.target !== ev.currentTarget) return;
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  void openDetail(e.id);
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
            </md-card>
          ))}
        </div>
      )}
      {detailError && <p className="lb-ext-err">{detailError}</p>}
      {detail && (
        <md-card variant="filled" className="lb-ext-detail">
          <div className="lb-ext-dhead">
            <span className="lb-ext-dtitle">
              <div className="lb-ext-ava" aria-hidden={true}>
                {detail.name.replace(/[^A-Za-z0-9].*/, "").slice(0, 2).toUpperCase() || "?"}
              </div>
              <span className="lb-ext-dname">
                {detail.name} <span className="lb-ext-ver">{detail.version}</span>
              </span>
            </span>
            <m3e-icon-button aria-label="Close extension details" onClick={() => setDetail(null)}>
              <m3e-icon name="close" aria-hidden={true} />
            </m3e-icon-button>
          </div>
          {detail.description && <p className="lb-ext-desc">{detail.description}</p>}
          <div className="lb-ext-trow">
            <span className="lb-ext-tlabel">Enabled</span>
            <m3e-switch
              checked={detail.enabled ? "" : undefined}
              icons="selected"
              aria-label="Extension enabled"
              onClick={() => void toggleEnabled(detail.id, !detail.enabled)}
            />
          </div>
          {/* Extensions are always allowed in incognito tabs: the
              per-extension toggle was removed (it recorded UI-side
              intent only; the engine has no incognito gating either
              way). */}
          <div className="lb-ext-actions">
            {detail.optionsPath && (
              <m3e-button onClick={() => void openOptions(detail)} {...{ class: "lb-ext-optbtn" }}>
                <m3e-icon name="settings" aria-hidden={true} /> Open options page
              </m3e-button>
            )}
            <m3e-button
              onClick={() => setPendingDelete({ id: detail.id, name: detail.name })}
              {...{ class: "lb-ext-delbtn" }}
            >
              <m3e-icon name="delete" aria-hidden={true} />
              Delete extension
            </m3e-button>
          </div>
          {shownError(detail.lastError) && <p className="lb-ext-err">{shownError(detail.lastError)}</p>}
        </md-card>
      )}
    </div>
  );
}
