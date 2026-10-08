import { useCallback, useEffect, useRef, useState } from "react";
import HomePage from "./pages/Home";
import SettingsPanel from "./pages/Settings";
import LogsPage from "./pages/Logs";
import BrowserView from "./pages/Browser";
import {
  engineRoutePrefix,
  loadSettings,
  saveSettings,
  loadSiteRules,
  saveSiteRules,
  resetIncognitoSid,
  incognitoSid,
  resolveUa,
  type Settings,
  type SiteRule,
} from "./settings";
import * as store from "./store";
import { zlSend } from "./zeolite";
import type { Tab } from "./store";
/* Rail spacing lives in its own sheet so it cleanly overrides the
   base theme rules (loaded earlier, same specificity, later wins). */
import "./rail.css";
import "./extensions.css";

type View = "home" | "browser" | "settings" | "logs";

let tabSeq = 1;
function freshTab(url = ""): Tab {
  return {
    id: tabSeq++,
    url,
    title: "",
    stack: url ? [url] : [],
    idx: url ? 0 : -1,
    /* Server-side log session token (see store.ts Tab.sess). */
    sess: crypto.randomUUID(),
  };
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
  const [history, setHistory] = useState<string[]>(() => store.loadHistory());
  const [cloaked, setCloaked] = useState(false);
  /* Incognito: no history recording, no session persistence while on. */
  const [incognito, setIncognito] = useState(false);
  /* P0 data-flow: while incognito is on, the technical log ring stays
     in memory only — page diagnostics must not be persisted into the
     normal profile's localStorage. */
  useEffect(() => {
    store.setIncognitoLogging(incognito);
  }, [incognito]);
  /* Announce incognito flips with a real M3E snackbar, so the mode is
     obvious even if the tab strip is tucked away. */
  const firstIncognitoRun = useRef(true);
  useEffect(() => {
    if (firstIncognitoRun.current) {
      firstIncognitoRun.current = false;
      return;
    }
    if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
      M3eSnackbar.open(
        incognito
          ? "Incognito on — history and session are not recorded"
          : "Incognito off — history and session resume",
        { duration: 4000 }
      );
    }
  }, [incognito]);
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

  /* Persist the session whenever tabs change (never in incognito). */
  useEffect(() => {
    if (!incognito) store.saveSessionTabs(tabs);
  }, [tabs, incognito]);

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

  const updateTab = useCallback((id: number, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  /* Incognito session swap: turning incognito on suspends the whole
     normal session (stashed in a ref, not persisted) and drops you on
     one fresh empty incognito tab; turning it off closes the incognito
     tabs and restores the suspended session exactly as it was. */
  const suspendedTabs = useRef<Tab[] | null>(null);
  const toggleIncognito = useCallback(
    (v: boolean) => {
      setIncognito(v);
      if (v) {
        /* Fresh cookie jar per incognito window (#1): the server-side
           session client is keyed by sid, so a new sid = an empty jar. */
        resetIncognitoSid();
        suspendedTabs.current = tabs;
        const t = freshTab();
        setTabs([t]);
        setActiveId(t.id);
        setView("browser");
        store.pushLog("info", "incognito session started, " + tabs.length + " tabs suspended");
      } else {
        const restore = suspendedTabs.current ?? [];
        suspendedTabs.current = null;
        setTabs(restore);
        setActiveId(restore.length > 0 ? restore[restore.length - 1].id : 0);
        if (restore.length === 0 && tabs.length === 0) setView("home");
        store.pushLog("info", "incognito session closed, " + restore.length + " tabs restored");
      }
    },
    [tabs]
  );

  const addHistory = useCallback((url: string) => {
    if (incognito) return;
    setHistory(store.addHistory(url));
  }, [incognito]);

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

  /* ---- Keyboard shortcuts (#5). Browser-reserved combos (Ctrl+T,
     Ctrl+W) are never delivered to the page, so the tab shortcuts
     live on Alt combos. AltGr is reported as ctrlKey+altKey and is
     therefore left alone. Documented in Settings. ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key.toUpperCase();
      if (e.shiftKey) {
        if (k !== "T") return;
        e.preventDefault();
        const last = closedTabs.current[closedTabs.current.length - 1];
        if (!last) return;
        closedTabs.current = closedTabs.current.slice(0, -1);
        setTabs((prev) => [...prev, last]);
        setActiveId(last.id);
        setView("browser");
        return;
      }
      if (k === "T") {
        e.preventDefault();
        newTab();
      } else if (k === "W") {
        const active = tabs.find((t) => t.id === activeId);
        if (active) {
          e.preventDefault();
          closeTab(active.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, activeId, newTab, closeTab]);

  /* ---- Zeolite service worker: it IS the engine (client-side
     interception, native wisp transport, in-worker rewriting). The
     legacy v3 page-cache worker is gone: it owned the "/" scope and
     kept the Zeolite worker from ever registering, so unregister it
     and drop its caches when found, then push the engine route prefix —
     the prefix is runtime state in the worker and resets to /j/ on
     every worker restart, so this runs on every boot. ---- */
  useEffect(() => {
    /* LB#15: the first zl:config can land on a still-installing
       worker and be silently dropped; a null reply means the engine
       never got the route prefix. Retry with backoff (a cold
       free-tier worker can take tens of seconds to evaluate its
       bundle) and only trust an explicit ok ack - the engine
       replies { ok: true }. Mid-session restarts need no re-push:
       since Zeolite#17 the worker persists the route shape and
       restores it before the first fetch. */
    const push = async () => {
      const msg = {
        type: "zl:config",
        prefix: engineRoutePrefix(),
        scheme: "b64u",
        /* LB#53 (Zeolite#63): refuse the plaintext ?url= embed shape
           on this deployment - initial navigations ride opaque
           zl:navHandle routes (Browser.tsx initialRoute). A worker
           predating #63 ignores the field, so the push stays
           compatible. */
        navHandles: true,
      };
      for (const d of [0, 1000, 3000, 7000, 15000, 30000]) {
        if (d) await new Promise((res) => setTimeout(res, d));
        const r = await zlSend(msg, 8000);
        if (r && r.ok) return true;
      }
      store.pushLog(
        "warn",
        "zeolite worker did not answer zl:config; engine routes may show the notice page until the app is reloaded",
      );
    };
    void (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) {
          const p = r.active || r.installing || r.waiting;
          if (p && new URL(p.scriptURL).pathname === "/lobsterjet.js") {
            await r.unregister();
          }
        }
        if ("caches" in window) {
          await caches.delete("lobsterjet-v3");
          await caches.delete("lobsterjet-decentraleyes-v1");
        }
      } catch {
        /* best effort: the Zeolite push below still runs */
      }
      await push();
      /* #66: pre-dial the wisp transport at app boot instead of
         billing the first entry navigation. The worker's wisp client
         initializes lazily on the first upstream fetch, so mint a
         route to a tiny well-known destination and fetch it HEAD
         through the engine while the user is still on Home. Best
         effort: any failure logs once and is ignored. */
      try {
        const mint = await zlSend({ type: "zl:mint", dest: "https://example.com/robots.txt" }, 8000);
        if (mint && mint.ok && typeof mint.route === "string") {
          const resp = await fetch(mint.route, { method: "HEAD", cache: "no-store" });
          store.pushLog("info", "wisp warm: HEAD example.com/robots.txt -> HTTP " + resp.status);
        } else {
          store.pushLog("warn", "wisp warm skipped: engine did not mint a route");
        }
      } catch (err) {
        store.pushLog("warn", "wisp warm failed: " + String(err));
      }
    })();
  }, []);

  /* ---- Zeolite adblock + per-site rules: the engine's /rules.json
       (the migrated ad/tracker host lists) is evaluated client-side in
       its worker; keep the toggle in sync with the Ad & tracker
       blocking setting. The per-site rules (rules chip / Settings:
       host-scoped adblock switch, UA preset) ride along as a zl:rules
       push built from the same loadSiteRules() store the Settings and
       lock-card UI read, so the engine applies them per target host
       with the same semantics (adblock can only disable per site; the
       global setting still wins). The
       worker resets both on restart, so re-send on boot and on
       change. ---- */
  useEffect(() => {
    /* #60: same controllerchange re-push pattern as the jarProfile /
       sameSite / transport effects below - the worker resets adblock
       and the rules on restart, so a mid-session restart must
       re-send both, not just the next settings edit. */
    const post = () => {
      void zlSend({ type: "zl:adblock", enabled: settings.adblock }, 8000);
      void zlSend(
        {
          type: "zl:rules",
          /* Global UA default: hosts without a rule get the resolved
             global UA (resolveUa with no rule hit). */
          ua: resolveUa(settings, rules, "") ?? undefined,
          rules: rules.map((r) => ({
            host: r.domain,
            adblock: r.adblock === false ? false : undefined,
            ua: r.uaPreset ? resolveUa(settings, rules, r.domain) ?? undefined : undefined,
          })),
        },
        8000,
      );
    };
    post();
    navigator.serviceWorker?.addEventListener("controllerchange", post);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", post);
  }, [settings, rules]);

  /* ---- Zeolite incognito jar: while incognito is on, the engine's
       cookie jar must be a throwaway (the zl:jarProfile push):
       requests and document.cookie reads/writes
       use a session profile that never touches IndexedDB and dies the
       moment incognito ends. The SW resets the profile to default on
       restart, so re-send on the incognito toggle and on
       controllerchange (a restart mid-incognito can briefly admit
       cookies into the default jar until this re-push lands; known,
       documented in docs/cookies.md). ---- */
  useEffect(() => {
    const post = () => {
      void zlSend({ type: "zl:jarProfile", profile: incognito ? incognitoSid() : null }, 8000);
    };
    post();
    navigator.serviceWorker?.addEventListener("controllerchange", post);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", post);
  }, [incognito]);

  /* ---- Zeolite jar knobs (#48): SameSite policy on the engine cookie
     jar, and document-surface fingerprint spoofing on engine-routed
     pages. Both are worker-global and reset on restart, so re-send on
     change and on controllerchange (the jarProfile pattern above). The
     spoof profile is a single field — the same UA the engine sends
     on requests — and the engine derives platform, languages and the
     canvas seed from it; timezone and hardware stay native so local
     times and page layout keep working. ---- */
  useEffect(() => {
    const post = () => {
      void zlSend({ type: "zl:sameSite", policy: settings.sameSitePolicy }, 8000);
      const profile = settings.fingerprintSpoof
        ? { userAgent: resolveUa(settings, rules, "") ?? navigator.userAgent }
        : null;
      void zlSend({ type: "zl:fingerprint", profile }, 8000).then((r) => {
        /* A rejected profile must not silently read as spoofed: the
           engine answers ok:false (e.g. a custom UA it cannot derive a
           platform from) and the toggle would lie. */
        if (settings.fingerprintSpoof && r && r.ok === false) {
          store.pushLog("warn", "zeolite rejected the fingerprint profile: " + String(r.error ?? "unknown reason"));
        }
      });
    };
    post();
    navigator.serviceWorker?.addEventListener("controllerchange", post);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", post);
  }, [settings.fingerprintSpoof, settings.sameSitePolicy, settings.uaPreset, settings.uaCustom]);

  /* ---- Zeolite transport engine (#54): push the persisted choice
     (zl:transport). The engine switches on the NEXT transport init,
     not mid-session, and resets to the deployment default on worker
     restart, so re-send on change and on controllerchange (the
     jarProfile pattern above). ---- */
  useEffect(() => {
    const post = () => {
      void zlSend({ type: "zl:transport", engine: settings.transport }, 8000);
    };
    post();
    navigator.serviceWorker?.addEventListener("controllerchange", post);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", post);
  }, [settings.transport]);

  /* ---- Auto cloak ---- */
  useEffect(() => {
    const onVisibility = () => {
      /* #56: capture the real title only on the first hide; a second
         hide while already cloaked would clobber prevTitle with the
         cloak title and lose the real one forever. */
      if (settings.cloakEnabled && document.hidden && !cloaked) {
        prevTitle.current = document.title;
        document.title = settings.cloakTitle;
        setCloaked(true);
        store.pushLog("info", "auto cloak engaged");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [settings, cloaked]);

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
        <m3e-button
          {...{
            ref: (el: any) => {
              if (el) el.classList.add("lb-cloak-return");
            },
          }}
          variant="filled"
          onClick={uncloak}
        >
          Return
        </m3e-button>
      </div>
    );
  }

  /* m3e-theme's density is a Number attribute on the M3E side (Lit
     converts it with Number()): the app setting is the string
     "normal" | "compact", so it must be mapped to the numeric M3E
     density scale before it reaches the element. Passing "normal"
     made Number("normal") = NaN and the theme emitted
     --md-sys-density-scale: NaN, which poisoned every
     DensityToken.calc() in the density-aware components (#27). */
  return (
    <m3e-theme color={settings.seed} scheme="dark" strong-focus={true} density={settings.density === "compact" ? "-1" : undefined}>
      <div className="lb-shell">
        {/* The rail is always fully visible in every view: no hiding,
           no sliver, no click-to-toggle. */}
        <m3e-nav-rail
          id="nav-rail"
          mode="compact"
          aria-label="LobsterBrowse"
        >
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
              <span slot="title" className="lb-app-title">LobsterBrowse <span className="lb-preview-badge">Preview</span></span>
            </m3e-app-bar>
          )}

          <div className="app-content">
            <div key={view} className="lb-view">
              {view === "home" && (
                <HomePage
                  settings={settings}
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
                  onHistory={addHistory}
                  incognito={incognito}
                  onIncognitoChange={toggleIncognito}
                  onOpenLogs={() => setView("logs")}
                  onRulesChange={updateRules}
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
              {view === "logs" && (
                <LogsPage onBack={() => setView("home")} sess={tabs.find((t) => t.id === activeId)?.sess} />
              )}
            </div>
          </div>
        </div>
      </div>
    </m3e-theme>
  );
}
