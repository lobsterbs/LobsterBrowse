import type { Tab } from "../store";
import { tabLabel } from "./browserShared";
import { tabStripLayout } from "./tabStripLayout";

/* Presentational compact strip. Browser owns tab state and width. */
export default function AdaptiveTabStrip(props: {
  tabs: Tab[];
  activeId: number;
  closingIds: number[];
  icons: Record<number, string>;
  width: number;
  onSelect: (id: number) => void;
  onCloseTab: (id: number) => void;
  onShowAll: () => void;
}) {
  const layout = tabStripLayout(props.tabs.map((t) => t.id), props.activeId, props.width);
  const visible = new Set(layout.visibleIds);
  return (
    <div className={"lb-dock-tabstrip " + layout.tier} role="group" aria-label="Open tabs">
      {props.tabs.filter((t) => visible.has(t.id)).map((tab) => (
        <div
          key={tab.id}
          className={"lb-dock-tab" + (tab.id === props.activeId ? " active" : "") + (props.closingIds.includes(tab.id) ? " closing" : "")}
          style={{ width: tab.id === props.activeId ? layout.activeWidth : layout.inactiveWidth }}
        >
          <button
            type="button"
            className="lb-dock-tab-select"
            data-tab-id={tab.id}
            aria-label={"Switch to " + tabLabel(tab)}
            aria-current={tab.id === props.activeId ? "page" : undefined}
            title={tabLabel(tab)}
            onClick={() => props.onSelect(tab.id)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const index = props.tabs.findIndex((t) => t.id === tab.id);
              const next = event.key === "Home" ? 0 : event.key === "End" ? props.tabs.length - 1 :
                (index + (event.key === "ArrowRight" ? 1 : -1) + props.tabs.length) % props.tabs.length;
              const id = props.tabs[next].id;
              props.onSelect(id);
              const strip = event.currentTarget.closest(".lb-dock-tabstrip");
              requestAnimationFrame(() => strip?.querySelector<HTMLButtonElement>(`[data-tab-id="${id}"]`)?.focus());
            }}
          >
            {props.icons[tab.id] ? <img className="lb-tab-favicon" src={props.icons[tab.id]} alt="" /> : <m3e-icon name="public" aria-hidden={true} />}
            <span className="lb-dock-tab-title">{tabLabel(tab)}</span>
          </button>
          <button type="button" className="lb-dock-tab-close" aria-label={"Close " + tabLabel(tab)} onClick={() => props.onCloseTab(tab.id)}>
            <m3e-icon name="close" aria-hidden={true} />
          </button>
        </div>
      ))}
      {layout.hidden > 0 && (
        <button type="button" className="lb-dock-tab-overflow" aria-label={"Show all " + props.tabs.length + " tabs (" + layout.hidden + " more)"} onClick={props.onShowAll}>
          +{layout.hidden}
        </button>
      )}
    </div>
  );
}
