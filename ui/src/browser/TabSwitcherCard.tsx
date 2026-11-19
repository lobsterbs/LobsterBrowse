/* Tab switcher: a modal m3e-bottom-sheet with one row per tab:
   favicon (inside a frosted m3e-avatar), site title, close X (user
   request 2026-11-07; the preview windows are gone - a second page
   instance per tab was weight, not information). The sheet header is
   a basic m3e-app-bar: back button, title, and a Close-all action
   with a two-step confirm. The sheet stays
   mounted; open/close rides the sheet's own show()/hide() methods
   with the `closing` event flowing back into Browser state.
   Presentational: tab state and selection stay in pages/Browser.tsx. */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
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
  onCloseAll?: () => void;
}) {
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
  /* #260: layout effect so the sheet cannot lag the state commit
     on a wedged main thread (see DevTools). */
  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    if (props.open) el.show();
    else el.hide();
  }, [props.open]);

  /* Close-all is a destructive bulk action, so it carries a
     two-step confirm in place: the first press arms the button
     (the label turns into the real warning), the second press
     fires. The arm is transient: it disarms itself after 4s, when
     the sheet closes, or on unmount, so a stray armed button never
     waits for the next visit. */
  const [closeAllArmed, setCloseAllArmed] = useState(false);
  const disarmTimer = useRef<number | null>(null);
  const clearDisarm = () => {
    if (disarmTimer.current !== null) {
      window.clearTimeout(disarmTimer.current);
      disarmTimer.current = null;
    }
  };
  useEffect(() => {
    if (!props.open) setCloseAllArmed(false);
  }, [props.open]);
  useEffect(() => clearDisarm, []);
  const pressCloseAll = () => {
    if (!props.onCloseAll) return;
    if (closeAllArmed) {
      clearDisarm();
      setCloseAllArmed(false);
      props.onCloseAll();
    } else {
      setCloseAllArmed(true);
      clearDisarm();
      disarmTimer.current = window.setTimeout(() => setCloseAllArmed(false), 4000);
    }
  };
  const closableCount = props.tabs.filter((t) => t.id !== props.activeId).length;

  if (props.tabs.length === 0) return null;
  return (
    <m3e-bottom-sheet
      detents="fit"
      modal=""
      handle=""
      hideable=""
      handle-label="Dismiss tab switcher"
      aria-label="Tabs"
      {...{ class: "lb-tabs-sheet", ref: sheetRef }}
    >
      <m3e-app-bar slot="header" size="small" {...{ class: "lb-sheet-bar" }}>
        <m3e-icon-button slot="leading" aria-label="Back" onClick={props.onClose}>
          <m3e-icon name="arrow_back" aria-hidden={true} />
        </m3e-icon-button>
        <span slot="title">Tabs</span>
        {props.onCloseAll && closableCount > 0 && (
          <m3e-button
            slot="trailing"
            {...{ class: "lb-tabs-closeall" + (closeAllArmed ? " armed" : "") }}
            aria-label={closeAllArmed ? "Confirm: close every other tab" : "Close every other tab"}
            onClick={pressCloseAll}
          >
            {closeAllArmed ? "Tap again to confirm" : "Close all"}
          </m3e-button>
        )}
      </m3e-app-bar>
      <div className="lb-tabs-row">
        {props.tabs.map((t) => {
          const rowClass =
            "lb-tab-row" +
            (t.id === props.activeId ? " active" : "") +
            (props.closingIds.includes(t.id) ? " closing" : "");
          return (
            <div
              key={t.id}
              className={rowClass}
              role="button"
              tabIndex={0}
              aria-current={t.id === props.activeId ? "true" : undefined}
              aria-label={"Switch to " + tabLabel(t)}
              onClick={() => props.onSelect(t.id)}
              onKeyDown={(e: KeyboardEvent) => {
                /* #91: full button semantics: Space activates too,
                   without scrolling the list. */
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  props.onSelect(t.id);
                }
              }}
            >
              {/* The favicon sits inside a frosted m3e-avatar: the
                  translucent avatar surface blurs the sheet content
                  behind it. */}
              <m3e-avatar {...{ class: "lb-tab-avatar" }} aria-hidden={true}>
                {props.icons[t.id] ? (
                  <img src={props.icons[t.id]} alt="" />
                ) : (
                  <m3e-icon name="public" aria-hidden={true} />
                )}
              </m3e-avatar>
              <span className="lb-tabs-title">{tabLabel(t)}</span>
              {/* #91/#233: a real icon button so closing is
                  independently keyboard-reachable; selection and
                  closing stay separate actions, and the X is always
                  visible. */}
              <m3e-icon-button
                aria-label={"Close " + tabLabel(t)}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onCloseTab(t.id);
                }}
              >
                <m3e-icon name="close" aria-hidden={true} />
              </m3e-icon-button>
            </div>
          );
        })}
      </div>
    </m3e-bottom-sheet>
  );
}
