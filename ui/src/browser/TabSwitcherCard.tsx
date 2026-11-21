/* Tab switcher: a modal m3e-bottom-sheet with one row per tab:
   favicon (inside a frosted m3e-avatar), site title, close X (user
   request 2026-11-07; the preview windows are gone - a second page
   instance per tab was weight, not information). The sheet header is
   a basic m3e-app-bar: back button, title, and a Close-all action
   (immediate; Browser shows an Undo snackbar). The sheet stays
   mounted; open/close rides the sheet's own show()/hide() methods
   with the `closing` event flowing back into Browser state.
   Presentational: tab state and selection stay in pages/Browser.tsx. */
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
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

  const closableCount = props.tabs.filter((t) => t.id !== props.activeId).length;

  /* Swipe a row sideways to close it (touch and pen). One non-visual
     m3e-swipe-gesture per row reports phases: the row follows the finger
     on update, a committed swipe closes the tab, a cancel springs back.
     The click the lift would fire is swallowed for a moment. */
  const swipedAt = useRef(0);
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const onGesture = (ev: Event) => {
      const g = ev.currentTarget as HTMLElement;
      const d = (ev as CustomEvent<{ phase: string; translationX: number; direction: string }>).detail;
      const id = Number(g.dataset.tab);
      const row = document.getElementById("lb-tab-row-" + id);
      if (!row) return;
      if (d.phase === "update") {
        row.style.transition = "none";
        row.style.transform = "translateX(" + d.translationX + "px)";
        row.style.opacity = String(Math.max(0.2, 1 - Math.abs(d.translationX) / 300));
      } else {
        row.style.transition = "transform 250ms cubic-bezier(0.2, 0, 0, 1), opacity 250ms";
        row.style.transform = "";
        row.style.opacity = "";
        if (d.phase === "end") {
          swipedAt.current = Date.now();
          live.current.onCloseTab(id);
        }
      }
    };
    const gestures = el.querySelectorAll<HTMLElement>("m3e-swipe-gesture");
    gestures.forEach((g) => g.addEventListener("gesture", onGesture));
    return () => gestures.forEach((g) => g.removeEventListener("gesture", onGesture));
  }, [props.tabs]);

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
            {...{ class: "lb-tabs-closeall" }}
            aria-label="Close every other tab"
            onClick={props.onCloseAll}
          >
            Close all
          </m3e-button>
        )}
      </m3e-app-bar>
      <div className="lb-tabs-row">
        {props.tabs.map((t) => {
          /* shortcut: swipe closes any row, including the active tab (same as its X). */
          const rowClass =
            "lb-tab-row" +
            (t.id === props.activeId ? " active" : "") +
            (props.closingIds.includes(t.id) ? " closing" : "");
          return (
            <div
              key={t.id}
              id={"lb-tab-row-" + t.id}
              className={rowClass}
              role="button"
              tabIndex={0}
              aria-current={t.id === props.activeId ? "true" : undefined}
              aria-label={"Switch to " + tabLabel(t)}
              onClick={() => {
                if (Date.now() - swipedAt.current < 400) return;
                props.onSelect(t.id);
              }}
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
              <m3e-shape name="9-sided-cookie" {...{ class: "lb-tab-shape" }} aria-hidden={true}>
                {props.icons[t.id] ? (
                  <img className="lb-tab-shape-icon" src={props.icons[t.id]} alt="" />
                ) : (
                  <m3e-icon name="public" aria-hidden={true} {...{ class: "lb-tab-shape-icon" }} />
                )}
              </m3e-shape>
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
        {props.tabs.map((t) => (
          <m3e-swipe-gesture
            key={t.id}
            for={"lb-tab-row-" + t.id}
            data-tab={t.id}
            directions="left right"
            pointer-types="touch pen"
            min-displacement="48"
            min-velocity="0.1"
          />
        ))}
      </div>
    </m3e-bottom-sheet>
  );
}
