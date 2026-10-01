/* Tab switcher card: live preview tiles over engine frames, scaled
   down; the card stays mounted in the dock (its iframes must stay
   alive or tiles show blank frames). Presentational: tab state and
   selection stay in pages/Browser.tsx. */
import { routeUrl } from "../settings";
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
  if (props.tabs.length === 0) return null;
  return (
    <m3e-card variant="elevated" aria-label="Tab switcher" {...{ class: "lb-tabs-card" + (props.open ? " open" : "") }}>
      <div slot="header" className="lb-site-head">
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
      <div slot="content" className="lb-tabs-row">
        {props.tabs.map((t) => (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            className={"lb-tabs-tile" + (t.id === props.activeId ? " active" : "") + (props.closingIds.includes(t.id) ? " closing" : "")}
            aria-label={"Switch to " + tabLabel(t)}
            onClick={() => props.onSelect(t.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onSelect(t.id);
            }}
          >
            <div className="lb-tab-preview">
              {t.url ? (
                <iframe
                  src={routeUrl(t.url)}
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
              <m3e-icon
                name="close"
                aria-hidden={true}
                className="lb-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onCloseTab(t.id);
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </m3e-card>
  );
}
