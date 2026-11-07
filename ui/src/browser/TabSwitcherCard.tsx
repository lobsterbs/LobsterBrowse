/* Tab switcher: a modal m3e-bottom-sheet with one card per tab (live
   preview tile, favicon, title). The sheet stays mounted (its preview
   iframes must stay alive or tiles show blank frames); open/close
   rides the sheet's own show()/hide() methods with the `closing` event
   flowing back into Browser state. Presentational: tab state and
   selection stay in pages/Browser.tsx. */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { routeUrl } from "../settings";
import { zlContentHref } from "../zeolite";
import type { Tab } from "../store";
import { tabLabel } from "./browserShared";

export default function TabSwitcherCard(props: {
  tabs: Tab[];
  activeId: number;
  closingIds: number[];
  icons: Record<number, string>;
  open: boolean;
  onNewTab: () => void;
  onClose: () => void;
  onSelect: (id: number) => void;
  onCloseTab: (id: number) => void;
}) {
  /* Preview tiles load a SECOND full page instance per tab (the
     legacy b64u route), so no tile navigates until the switcher has
     been opened at least once; once shown, tiles stay mounted (they
     must stay alive or re-opening shows blank frames). */
  const [everOpened, setEverOpened] = useState(false);

  /* Live-props ref: the sheet's event listener outlives renders. */
  const live = useRef(props);
  live.current = props;
  const sheetRef = useRef<HTMLElement & { show: () => void; hide: () => void } | null>(null);

  /* The bottom sheet owns its open state (show/hide methods, per the
     @m3e/web docs). React never writes the `open` attribute; the
     component's `closing` event (Escape, scrim dismissal, swipe-down)
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
    if (props.open) {
      setEverOpened(true);
      el.show();
    } else {
      el.hide();
    }
  }, [props.open]);

  if (props.tabs.length === 0) return null;
  return (
    <m3e-bottom-sheet
      modal=""
      handle=""
      hideable=""
      handle-label="Dismiss tab switcher"
      aria-label="Tabs"
      {...{ class: "lb-tabs-sheet", ref: sheetRef }}
    >
      <div slot="header" className="lb-tabs-sheet-head">
        <span className="lb-site-ctitle">Tabs ({props.tabs.length})</span>
        <span>
          <m3e-icon-button aria-label="New tab" onClick={props.onNewTab}>
            <m3e-icon name="add" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-icon-button aria-label="Close tab switcher" onClick={props.onClose}>
            <m3e-icon name="close" aria-hidden={true} />
          </m3e-icon-button>
        </span>
      </div>
      <div className="lb-tabs-row">
        {props.tabs.map((t) => {
          const tileClass =
            "lb-tabs-tile" +
            (t.id === props.activeId ? " active" : "") +
            (props.closingIds.includes(t.id) ? " closing" : "");
          return (
            <m3e-card
              key={t.id}
              variant={t.id === props.activeId ? "filled" : "outlined"}
              {...{
                class: tileClass,
                role: "button",
                tabIndex: 0,
                "aria-label": "Switch to " + tabLabel(t),
                onClick: () => props.onSelect(t.id),
                onKeyDown: (e: KeyboardEvent) => {
                  /* #91: full button semantics: Space activates too,
                     without scrolling the row. */
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onSelect(t.id);
                  }
                },
              }}
            >
              <div slot="content" className="lb-tabs-tile-inner">
                <div className="lb-tab-preview">
                  {t.url && everOpened ? (
                    /* #107: preview tiles load the content origin in split
                       mode; a proxied document must never render same-origin
                       on the app origin. */
                    <iframe
                      src={zlContentHref(routeUrl(t.url))}
                      title={"Preview of " + tabLabel(t)}
                      loading="lazy"
                      tabIndex={-1}
                    />
                  ) : (
                    <div className="lb-tab-empty">
                      <m3e-icon name="public" aria-hidden={true} />
                    </div>
                  )}
                </div>
                <div className="lb-tabs-tile-head">
                  {props.icons[t.id] ? (
                    <img className="lb-tab-favicon" src={props.icons[t.id]} alt="" />
                  ) : (
                    <m3e-icon name="public" aria-hidden={true} />
                  )}
                  <span className="lb-tabs-title">{tabLabel(t)}</span>
                  {/* #91: a real button so closing is independently
                      keyboard-reachable; selection and closing stay
                      separate actions. */}
                  <button
                    type="button"
                    className="lb-tab-close"
                    aria-label={"Close " + tabLabel(t)}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onCloseTab(t.id);
                    }}
                  >
                    <m3e-icon name="close" aria-hidden={true} />
                  </button>
                </div>
              </div>
            </m3e-card>
          );
        })}
      </div>
    </m3e-bottom-sheet>
  );
}
