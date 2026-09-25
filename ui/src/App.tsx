import { useCallback, useEffect, useRef, useState } from "react";
import HomePage from "./pages/Home";
import SettingsPanel from "./pages/Settings";
import LogsPage from "./pages/Logs";
import BrowserView from "./pages/Browser";
import {
  loadSettings,
  saveSettings,
  loadSiteRules,
  saveSiteRules,
  type Settings,
  type SiteRule,
} from "./settings";
import * as store from "./store";
import type { Bookmark, Tab } from "./store";

type View = "home" | "browser" | "settings" | "logs";

let tabSeq = 1;
function freshTab(url = ""): Tab {
  return { id: tabSeq++, url, title: "", stack: url ? [url] : [], idx: url ? 0 : -1 };
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [rules, setRules] = useState<SiteRule[]>(() => loadSiteRules());
  const [view, setView] = useState<View>("home");
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const restored = store.loadSessionTabs();
    for (const t of restored) if (t.id >= tabSeq) tabSeq = t.id + 1;
    return restored;
  });
  const [activeId, setActiveId] = useState<number>(0);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => store.loadBookmarks());
  const [history, setHistory] = useState<string[]>(() => store.loadHistory());
  const [cloaked, setCloaked] = useState(false);
  const closedTabs = useRef<Tab[]>([]);
  const prevTitle = useRef(document.title);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const updateRules = useCallback((next: SiteRule[]) => {
    setRules(next);
    saveSiteRules(next);
  }, []);

  /* Persist the session whenever tabs change. */
  useEffect(() => {
    store.saveSessionTabs(tabs);
  }, [tabs]);

  /* Closing the last tab returns to Home. */
  useEffect(() => {
    if (view === "browser" && tabs.length === 0) setView("home");
  }, [view, tabs.length]);

  const newTab = useCallback((url?: string) => {
    const tab = freshTab(url ?? "");
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    setView("browser");
    store.pushLog("info", "new tab #" + tab.id + (url ? " → " + url : ""));
  }, []);

  const closeTab = useCallback(
    (id: number) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) closedTabs.current = [...closedTabs.current, tab].slice(-10);
      const next = tabs.filter((t) => t.id !== id);
      setTabs(next);
      if (id === activeId && next.length > 0) setActiveId(next[next.length - 1].id);
      if (next.length === 0) setView("home");
    },
    [tabs, activeId]
  );

  const reopenTab = useCallback(() => {
    const tab = closedTabs.current.pop();
    if (!tab) return;
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    setView("browser");
  }, []);

  const updateTab = useCallback((id: number, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const toggleBookmark = useCallback((url: string, title: string) => {
    if (!url) return;
    setBookmarks((prev) => store.toggleBookmark(prev, url, title));
  }, []);

  const addHistory = useCallback((url: string) => {
    setHistory(store.addHistory(url));
  }, []);

  /* Navigate the active proxy tab (used by Home search). */
  const navigateTo = useCallback(
    (target: string) => {
      if (tabs.length === 0) {
        newTab(target);
        return;
      }
      const active = tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1];
      const stack = [...active.stack.slice(0, active.idx + 1), target];
      setTabs((prev) =>
        prev.map((t) => (t.id === active.id ? { ...t, url: target, stack, idx: stack.length - 1, title: "" } : t))
      );
      setActiveId(active.id);
      setView("browser");
    },
    [tabs, activeId, newTab]
  );

  /* ---- Panic button ---- */
  const matchKeys = (combo: string, e: KeyboardEvent): boolean => {
    const parts = combo.split("+").map((p) => p.trim().toLowerCase());
    if (parts.length === 0) return false;
    const key = parts[parts.length - 1];
    const needCtrl = parts.includes("ctrl");
    const needShift = parts.includes("shift");
    const needAlt = parts.includes("alt");
    const needMeta = parts.includes("meta") || parts.includes("cmd");
    const pressed = e.key.toLowerCase();
    if (e.ctrlKey !== needCtrl || e.shiftKey !== needShift || e.altKey !== needAlt || e.metaKey !== needMeta) return false;
    if (key.length === 1) return pressed === key;
    return pressed === key || pressed === "escape" && key === "esc";
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      /* Panic button: checked first so it always wins. */
      if (settings.panicEnabled && settings.panicKeys && matchKeys(settings.panicKeys, e)) {
        e.preventDefault();
        store.saveSessionTabs(tabs);
        store.pushLog("warn", "panic shortcut triggered → " + settings.panicUrl);
        window.location.replace(settings.panicUrl);
        return;
      }
      if (!(e.ctrlKey || e.metaKey || e.key === "F12")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("lb-reload"));
      } else if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        const el =
          (document.querySelector(".lb-url-input") as HTMLInputElement | null) ??
          (document.querySelector("#lb-search-input") as HTMLInputElement | null);
        el?.focus();
        el?.select();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        newTab();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeId) closeTab(activeId);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        reopenTab();
      } else if (e.key === "F12") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("lb-devtools"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settings, tabs, activeId, newTab, closeTab, reopenTab]);

  /* ---- Auto cloak ---- */
  useEffect(() => {
    const onVisibility = () => {
      if (settings.cloakEnabled) {
        if (document.hidden) {
          prevTitle.current = document.title;
          document.title = settings.cloakTitle;
          setCloaked(true);
          store.pushLog("info", "auto cloak engaged");
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [settings]);

  const uncloak = () => {
    setCloaked(false);
    document.title = prevTitle.current;
  };

  const deleteAll = () => {
    store.clearAllData();
    store.pushLog("warn", "all local data deleted");
    window.location.replace("/");
  };

  if (cloaked) {
    return (
      <div className="lb-cloak">
        <iframe title="Cloak" src={settings.cloakUrl} />
        <m3e-button className="lb-cloak-return" variant="filled" onClick={uncloak}>
          Return
        </m3e-button>
      </div>
    );
  }

  return (
    <m3e-theme color={settings.seed} strong-focus={true}>
      <div className="lb-shell">
        <m3e-nav-rail id="nav-rail" mode="compact" aria-label="LobsterBrowse">
          <m3e-icon-button toggle aria-label="Toggle navigation rail">
            <m3e-icon name="menu" aria-hidden={true} />
            <m3e-icon slot="selected" name="menu_open" aria-hidden={true} />
            <m3e-nav-rail-toggle for="nav-rail" />
          </m3e-icon-button>
          <m3e-nav-item
            id="nav-home"
            selected={view === "home" ? "" : undefined}
            onClick={() => setView("home")}
          >
            <m3e-icon slot="icon" name="home" aria-hidden={true} />Home
          </m3e-nav-item>
          <m3e-tooltip for="nav-home" position="after">Home</m3e-tooltip>
          <m3e-nav-item
            id="nav-browse"
            selected={view === "browser" ? "" : undefined}
            onClick={() => {
              if (tabs.length === 0) newTab();
              else setView("browser");
            }}
          >
            <m3e-icon slot="icon" name="travel_explore" aria-hidden={true} />Browse
          </m3e-nav-item>
          <m3e-tooltip for="nav-browse" position="after">Proxy browser</m3e-tooltip>
          <m3e-nav-item
            id="nav-settings"
            selected={view === "settings" ? "" : undefined}
            onClick={() => setView("settings")}
          >
            <m3e-icon slot="icon" name="settings" aria-hidden={true} />Settings
          </m3e-nav-item>
          <m3e-tooltip for="nav-settings" position="after">Preferences — saved on this device</m3e-tooltip>
        </m3e-nav-rail>

        <div className="lb-main">
          {/* The browser view gets every pixel: no header there. */}
          {view !== "browser" && (
            <m3e-app-bar>
              <span slot="title">LobsterBrowse</span>
            </m3e-app-bar>
          )}

          <div className="app-content">
            <div key={view} className="lb-view">
              {view === "home" && (
                <HomePage
                  settings={settings}
                  bookmarks={bookmarks}
                  history={history}
                  onNavigate={navigateTo}
                />
              )}
              {view === "browser" && (
                <BrowserView
                  settings={settings}
                  rules={rules}
                  tabs={tabs}
                  activeId={activeId}
                  setActiveId={setActiveId}
                  updateTab={updateTab}
                  newTab={newTab}
                  closeTab={closeTab}
                  bookmarks={bookmarks}
                  onToggleBookmark={toggleBookmark}
                  onHistory={addHistory}
                  setView={setView}
                  onOpenLogs={() => setView("logs")}
                />
              )}
              {view === "settings" && (
                <SettingsPanel
                  settings={settings}
                  onChange={update}
                  rules={rules}
                  onRulesChange={updateRules}
                  onOpenLogs={() => setView("logs")}
                  onDeleteAll={deleteAll}
                />
              )}
              {view === "logs" && <LogsPage onBack={() => setView("home")} />}
            </div>
          </div>
        </div>
      </div>
    </m3e-theme>
  );
}
