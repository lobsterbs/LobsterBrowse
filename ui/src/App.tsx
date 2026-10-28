import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import HomePage from "./pages/Home";
const SettingsPanel = lazy(() => import("./pages/Settings"));
const LogsPage = lazy(() => import("./pages/Logs"));
import {
  engineRoutePrefix,
  loadSettings,
  saveSettings,
  loadSiteRules,
  saveSiteRules,
  resetIncognitoSid,
  incognitoSid,
  resolveUa,
  UA_PRESETS,
  type Settings,
  type SiteRule,
} from "./settings";
import * as store from "./store";
import { engineSwSource, zlContentConfig, zlContentRegister, zlGuestHost, zlRelayInit, zlSend, zlAnnounceContentOrigin, zlWispInit } from "./zeolite";
import CommandPalette, { type Command } from "./CommandPalette";
import { sjInit } from "./scramjet";
import { createPortal } from "react-dom";
import { StarsBackground } from "./components/ui/stars";
import type { Tab } from "./store";
import "./extensions.css";

const BrowserView = lazy(() => import("./pages/Browser"));

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
  const [browserMounted, setBrowserMounted] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const restored = store.loadSessionTabs();
    for (const t of restored) if (t.id >= tabSeq) tabSeq = t.id + 1;
    return restored;
  });
  const [activeId, setActiveId] = useState<number>(0);
  /* #81: Ctrl+K command palette. */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [history, setHistory] = useState<string[]>(() => store.loadHistory());
  const [cloaked, setCloaked] = useState(false);
  /* Incognito: no history recording, no session persistence while on. */
  const [incognito, setIncognito] = useState(false);
  /* P0 data-flow: while incognito is on, the technical log ring stays
     in memory only - page diagnostics must not be persisted into the
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
          ? "Incognito on"
          : "Incognito off",
        { duration: 4000 }
      );
    }
  }, [incognito]);
  /* Welcome Back: one snackbar on boot for returning profiles; the
     very first visit only sets the marker. Local-only, never sent
     server-side; storage failures behave like a first visit. */
  useEffect(() => {
    try {
      if (localStorage.getItem("lb_visited")) {
        if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
          M3eSnackbar.open("Welcome Back!", { duration: 4000 });
        }
      } else {
        localStorage.setItem("lb_visited", "1");
      }
    } catch {
      /* localStorage unavailable: behave like a first visit. */
    }
  }, []);
  /* #80: the engine worker broadcasts zl:engineUpdate (updates.ts)
     to every window client once it activates; the UI itself is a
     client of the same worker, so the update surfaces as a snackbar
     with a manual reload action. Nothing reloads on its own. */
  const lastEngineKey = useRef("");
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMsg = (ev: MessageEvent) => {
      /* #142: engine broadcasts only from the engine worker itself. */
      if (!engineSwSource(ev)) return;
      const d = ev.data as { type?: string; sha?: string | null; version?: unknown } | null;
      if (!d || d.type !== "zl:engineUpdate") return;
      const key = typeof d.sha === "string" && d.sha ? d.sha : "v:" + String(d.version ?? "");
      if (!key || key === lastEngineKey.current) return;
      lastEngineKey.current = key;
      if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
        /* duration 0 = never auto-dismiss: the notice stays until the
           user reloads (picking up the new engine) or presses Reload
           now. The old 8s timeout silently dropped the notice while
           the old worker kept serving. */
        M3eSnackbar.open("Engine updated - reload to pick it up", "Reload now", {
          actionCallback: () => window.location.reload(),
          duration: 0,
        });
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, []);
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

  /* Enhanced UI flag on <body>: theme.css scopes the frosted-glass
     search bar treatment to this class; the nav rail frosted-glass
     treatment is always on (#226). */
  useEffect(() => {
    document.body.classList.toggle("lb-fancy", settings.fancyBackground);
  }, [settings.fancyBackground]);

  /* #96: incognito gets a persistent body class so the chrome can
     carry a subtle, unmistakable identity the whole time it is on. */
  useEffect(() => {
    document.body.classList.toggle("lb-incognito", incognito);
  }, [incognito]);

  /* Zeolite #137/#168: register the embedder fetch-relay channel and
     announce the wisp transit endpoint at APP level. Any view can
     start a /zl/ navigation (Home search, view switches); when only
     the Browser view registered the channel, fetches that raced the
     mount fell back to the wisp transport and died on this
     deployment password-authed wisp ("tls handshake eof" 502s).
     A worker restart drops the engine stored port, so re-register
     on controller change. Registration is idempotent.
     The announced endpoint is the deployment endpoint from /build
     (the LobsterBrowse default; the custom-server selection was
     removed per product decision). The announce callback lives
     behind a ref that this boot effect and the controllerchange
     listener keep current. */
  const sjWispRef = useRef("");
  const wispAnnounceRef = useRef<() => void>(() => {});
  /* Injector phase 2: the query-shape state from /build (the server
     env ZL_QUERY_ROUTES is the opt-out; on by default); read per
     config-push attempt so a slow /build fetch cannot pin a stale
     value into a long retry loop. The ref starts true so a push
     before /build resolves never disables the always-on injector. */
  const queryRoutesRef = useRef(true);
  useEffect(() => {
    zlRelayInit();
    void fetch("/build", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const u = b && typeof b.sjWisp === "string" ? b.sjWisp : "";
        sjWispRef.current = u;
        wispAnnounceRef.current();
        /* #107: a provisioned content origin (ZL_CONTENT_ORIGIN on
           the server) is inert configuration until the operator
           provisions it; when present, remember it and register the
           engine worker on that origin. */
        queryRoutesRef.current = b && b.zlQueryRoutes === true;
        const co = b && typeof b.contentOrigin === "string" ? b.contentOrigin : "";
        zlAnnounceContentOrigin(co);
        if (co) zlContentRegister(co);
        /* #477 wave 3: keep the guest-host realm open on the app and
           content origins so proxied-page service-worker registrations
           can spawn their isolated guest realms. */
        zlGuestHost(co);
      })
      .catch(() => zlAnnounceContentOrigin(""));
    const re = () => {
      zlRelayInit();
      wispAnnounceRef.current();
    };
    navigator.serviceWorker?.addEventListener("controllerchange", re);
    /* The relay channel lives in service-worker memory. An idle worker
       restart drops it without a controllerchange, and relay-routed hosts
       then fall back to wisp and fail with error 35. Re-register on a
       timer; the registration itself is cached, so this is cheap. */
    const keep = window.setInterval(zlRelayInit, 15000);
    /* Zeolite #354: the timer heals within 15s; the engine also asks
       directly (zl:relayLost broadcast) when a relay fetch finds no
       channel, and we re-register at once so the wait resolves
       without falling back to wisp. */
    const onRelayLost = (ev: MessageEvent) => {
      /* #142: relay-loss broadcasts only from the engine worker. */
      if (!engineSwSource(ev)) return;
      if ((ev.data as { type?: string } | null)?.type === "zl:relayLost") re();
    };
    navigator.serviceWorker?.addEventListener("message", onRelayLost);
    return () => {
      window.clearInterval(keep);
      navigator.serviceWorker?.removeEventListener("controllerchange", re);
      navigator.serviceWorker?.removeEventListener("message", onRelayLost);
    };
  }, []);

  /* (Re-)announce the deployment WISP endpoint. The custom-server
     selection was removed per product decision (the LobsterBrowse
     server is the only supported endpoint), so the callback has no
     settings dependency; an empty /build answer still withdraws the
     endpoint and per-host wisp policy falls back to relay. */
  useEffect(() => {
    wispAnnounceRef.current = () => {
      zlWispInit(sjWispRef.current);
    };
    wispAnnounceRef.current();
  }, []);

  /* Persist the session whenever tabs change (never in incognito). */
  useEffect(() => {
    if (!incognito) store.saveSessionTabs(tabs);
  }, [tabs, incognito]);

  /* Closing the last tab returns to Home. */
  useEffect(() => {
    if (view === "browser" && tabs.length === 0) setView("home");
  }, [view, tabs.length]);

  /* Keep the browser workspace alive after its first use so tabs and
     frames retain their lifecycle, but don't load it on the initial
     Home visit. */
  useEffect(() => {
    if (view === "browser") setBrowserMounted(true);
  }, [view]);

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
      /* #123: an incognito tab never enters the reopen list; a
         reopened incognito URL would land in the normal profile. */
      if (tab && !incognito) closedTabs.current = [...closedTabs.current, tab].slice(-10);
      const next = tabs.filter((t) => t.id !== id);
      setTabs(next);
      if (id === activeId && next.length > 0) setActiveId(next[next.length - 1].id);
      if (next.length === 0) setView("home");
    },
    [tabs, activeId, incognito]
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
        /* #123: normal-session closed tabs must not be reopenable
           into the incognito profile either. */
        closedTabs.current = [];
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

  /* #93 recent sites: removal and clearing keep Home row and the
     persisted history store in lockstep. */
  /* #99: both removals are reversible, so they happen at once and the
     snackbar offers Undo (entries go back to their old positions). */
  const removeHistory = useCallback((url: string) => {
    const index = store.loadHistory().indexOf(url);
    setHistory(store.removeHistory(url));
    if (index < 0 || typeof M3eSnackbar === "undefined" || !M3eSnackbar) return;
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* keep the raw entry as the label */
    }
    M3eSnackbar.open("Removed " + host + " from recent sites", "Undo", {
      duration: 6000,
      actionCallback: () => setHistory(store.insertHistory(url, index)),
    });
  }, []);
  const clearHistoryAll = useCallback(() => {
    const before = store.loadHistory();
    setHistory(store.clearHistory());
    if (before.length === 0 || typeof M3eSnackbar === "undefined" || !M3eSnackbar) return;
    M3eSnackbar.open("Cleared recent sites", "Undo", {
      duration: 6000,
      actionCallback: () => setHistory(store.restoreHistory(before)),
    });
  }, []);

  /* 0.7 Zirconium session import: history merges into the persisted
     store, imported tabs append with fresh ids (importSessionData
     minted fresh sess tokens). Refused entirely in incognito: the
     import persists, and nothing may be written while private mode
     is on. Returns an honest result code for the Settings page. */
  const importSession = useCallback(
    (data: unknown): "ok" | "invalid" | "incognito" => {
      if (incognito) return "incognito";
      const parsed = store.importSessionData(data);
      if (!parsed) return "invalid";
      setHistory(parsed.history);
      const restored = parsed.tabs.map((t) => ({ ...t, id: tabSeq++ }));
      if (restored.length > 0) setTabs((prev) => [...prev, ...restored]);
      return "ok";
    },
    [incognito],
  );

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

  /* ---- ScramJet engine option: init the upstream controller
     worker (idempotent, ui/src/scramjet.ts) when the Proxy engine
     setting picks it. Zeolite is the default and initializes through
     its own registration path. ---- */
  useEffect(() => {
    if (settings.proxyEngine !== "scramjet") return;
    sjInit().catch((e: unknown) => console.error("scramjet init failed", e));
  }, [settings.proxyEngine]);

  /* #81: reopen the last closed tab - shared by Alt+Shift+T and
     the command palette. */
  const reopenTab = useCallback(() => {
    const last = closedTabs.current[closedTabs.current.length - 1];
    if (!last) return;
    closedTabs.current = closedTabs.current.slice(0, -1);
    setTabs((prev) => [...prev, last]);
    setActiveId(last.id);
    setView("browser");
  }, []);

  /* ---- Keyboard shortcuts (#5). Browser-reserved combos (Ctrl+T,
     Ctrl+W) are never delivered to the page, so the tab shortcuts
     live on Alt combos. AltGr is reported as ctrlKey+altKey and is
     therefore left alone. Documented in Settings. ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* #81: Ctrl+K (Cmd+K) toggles the palette. Checked before the
         Alt gate because Ctrl+K carries no altKey. */
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key.toUpperCase();
      if (e.shiftKey) {
        if (k !== "T") return;
        e.preventDefault();
        reopenTab();
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
  }, [tabs, activeId, newTab, closeTab, reopenTab]);

  /* ---- Zeolite service worker: it IS the engine (client-side
     interception, native wisp transport, in-worker rewriting). The
     legacy v3 page-cache worker is gone: it owned the "/" scope and
     kept the Zeolite worker from ever registering, so unregister it
     and drop its caches when found, then push the engine route prefix -
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
      const mkMsg = () => ({
        type: "zl:config" as const,
        prefix: engineRoutePrefix(),
        scheme: "b64u",
        /* LB#53 (Zeolite#63): refuse the plaintext ?url= embed shape
           on this deployment - initial navigations ride opaque
           zl:navHandle routes (Browser.tsx initialRoute). A worker
           predating #63 ignores the field, so the push stays
           compatible. */
        navHandles: true,
        /* Injector phase 2 (query-shape committed routes): the
           opt-in rides server configuration (/build relays
           ZL_QUERY_ROUTES) and is read per attempt so a slow /build
           fetch cannot pin a stale value into this retry loop. */
        queryRoutes: queryRoutesRef.current,
      });
      for (const d of [0, 1000, 3000, 7000, 15000, 30000]) {
        if (d) await new Promise((res) => setTimeout(res, d));
        const r = await zlSend(mkMsg(), 8000);
        if (r && r.ok) {
          /* Per-origin config parity: the content origin's worker gets
             the same push through its boot page, so both origins
             commit the same route shape (/zl/) instead of the content
             worker keeping its default prefix. Warn on no ack
             (the LB#15 lesson). */
          void zlContentConfig(mkMsg()).then((ok) => {
            if (!ok)
              store.pushLog(
                "warn",
                "content-origin zl:config did not ack; proxied routes on the content origin may keep the default prefix until the app is reloaded",
              );
          });
          return true;
        }
      }
      store.pushLog(
        "warn",
        "zeolite worker did not answer zl:config; engine routes may show the notice page until the app is reloaded",
      );
    };
    void (async () => {
      try {
        /* #68: unregister any worker that is not the engine bundle, so a
           stale registration (whatever its script) cannot hold the "/"
           scope and silently block the Zeolite SW. */
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) {
          const p = r.active || r.installing || r.waiting;
          /* #133: the ScramJet controller worker at /sj/sw.js is a
             legitimate engine worker too; unregistering it on every
             boot silently broke the ScramJet engine until the next
             reinstall. */
          if (
            p &&
            new URL(p.scriptURL).pathname !== "/zlsw/sw.js" &&
            new URL(p.scriptURL).pathname !== "/sj/sw.js"
          ) {
            await r.unregister();
          }
        }
      } catch {
        /* best effort: the Zeolite push below still runs */
      }
      await push();
      /* #204: the #66 example.com/robots.txt boot warm is gone:
         transit is relay-only on this deployment, so the pre-dial
         warmed nothing - it raced SW control on cold profiles and
         stamped example.com/robots.txt rows into every session's
         diagnostics (and the user-visible logs) on each boot. */
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
    /* #109 (bounded LB-side fix): the worker profile is global, so
       with two LobsterBrowse windows open a background window's
       jarProfile push switches the jar for every window. Re-assert
       this window's profile whenever it becomes the foreground one,
       so the window the user is actually using always browses with
       the right jar. True per-window isolation needs engine-side
       per-client jar state (tracked as Zeolite #267). */
    window.addEventListener("focus", post);
    window.addEventListener("pageshow", post);
    return () => {
      navigator.serviceWorker?.removeEventListener("controllerchange", post);
      window.removeEventListener("focus", post);
      window.removeEventListener("pageshow", post);
    };
  }, [incognito]);

  /* ---- Zeolite engine page options: HTTPS upgrade (Zeolite #53) and
     lazy images are worker-global zl:config fields that reset on
     restart, so re-send on change and on controllerchange (the
     jarProfile pattern above). ---- */
  useEffect(() => {
    const post = () => {
      const msg = {
        type: "zl:config",
        prefix: engineRoutePrefix(),
        httpsUpgrade: settings.httpsUpgrade,
        /* #76: lazy images are always on (the toggle is gone). */
        imageLazy: true,
        /* Injector phase 2: the query-shape opt-in is ephemeral worker
           state, same class as httpsUpgrade; keep it in the parity
           push. */
        queryRoutes: queryRoutesRef.current,
      };
      void zlSend(msg, 8000);
      /* Per-origin parity: the content worker rewrites and serves the
         proxied documents, so the engine page options must reach it
         too (the per-origin config gap). */
      void zlContentConfig(msg);
    };
    post();
    navigator.serviceWorker?.addEventListener("controllerchange", post);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", post);
  }, [settings.httpsUpgrade]);

  /* ---- Zeolite jar knobs (#48): SameSite policy on the engine cookie
     jar, and document-surface fingerprint spoofing on engine-routed
     pages. Both are worker-global and reset on restart, so re-send on
     change and on controllerchange (the jarProfile pattern above). The
     spoof profile is a single field - the same UA the engine sends
     on requests - and the engine derives platform, languages and the
     canvas seed from it; timezone and hardware stay native so local
     times and page layout keep working. ---- */
  useEffect(() => {
    const post = () => {
      void zlSend({ type: "zl:sameSite", policy: settings.sameSitePolicy }, 8000);
      /* #76: the fingerprint profile picker is gone from Settings;
         the default match-the-User-Agent profile is always on. */
      const profile = { userAgent: resolveUa(settings, rules, "") ?? navigator.userAgent };
      void zlSend({ type: "zl:fingerprint", profile }, 8000).then((r) => {
        /* A rejected profile must not silently read as spoofed: the
           engine answers ok:false (e.g. a custom UA it cannot derive a
           platform from) and the toggle would lie. */
        if (profile && r && r.ok === false) {
          store.pushLog("warn", "zeolite rejected the fingerprint profile: " + String(r.error ?? "unknown reason"));
        }
      });
    };
    post();
    navigator.serviceWorker?.addEventListener("controllerchange", post);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", post);
  }, [settings.sameSitePolicy, settings.uaPreset, settings.uaCustom, rules]);

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

  /* ---- Cloak favicon (#76): the tab icon must follow the cloak,
     not keep the LobsterBrowse logo. A neutral inline SVG data URL
     avoids both the logo and any network request to the cloak
     site; the original icon hrefs are restored on uncloak. ---- */
  const cloakIconHref =
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='7' fill='#9aa0a6'/></svg>",
    );
  const cloakPrevIcons = useRef<Array<string | null>>([]);
  const cloakFavicon = () => {
    const links = Array.from(
      document.head.querySelectorAll("link[rel=icon]"),
    ) as HTMLLinkElement[];
    if (cloakPrevIcons.current.length === 0) {
      cloakPrevIcons.current = links.map((l) => l.getAttribute("href"));
    }
    for (const l of links) l.setAttribute("href", cloakIconHref);
  };
  const uncloakFavicon = () => {
    const links = Array.from(
      document.head.querySelectorAll("link[rel=icon]"),
    ) as HTMLLinkElement[];
    links.forEach((l, i) => {
      const prev = cloakPrevIcons.current[i];
      if (prev === null || prev === undefined) return;
      l.setAttribute("href", prev);
    });
    cloakPrevIcons.current = [];
  };

  /* ---- Auto cloak ---- */
  useEffect(() => {
    const onVisibility = () => {
      /* #56: capture the real title only on the first hide; a second
         hide while already cloaked would clobber prevTitle with the
         cloak title and lose the real one forever. */
      if (settings.cloakEnabled && document.hidden && !cloaked) {
        prevTitle.current = document.title;
        document.title = settings.cloakTitle;
        cloakFavicon();
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
    uncloakFavicon();
  };

  const deleteAll = async () => {
    store.clearAllData();
    store.pushLog("warn", "all local data deleted");
    /* #134: clearAllData covers localStorage only; Service Worker
       caches and IndexedDB survive it. Best-effort wipe before the
       reload so a deleted session cannot rehydrate from storage. */
    try {
      if (typeof caches !== "undefined") {
        for (const k of await caches.keys()) await caches.delete(k);
      }
    } catch {
      /* best effort: the reload still lands on a clean shell */
    }
    try {
      const idb = indexedDB as unknown as {
        databases?: () => Promise<Array<{ name?: string }>>;
      };
      if (typeof idb.databases === "function") {
        for (const db of await idb.databases()) {
          if (db.name) indexedDB.deleteDatabase(db.name);
        }
      }
    } catch {
      /* best effort */
    }
    window.location.replace("/");
  };

  /* ---- Rail (#87): expansion is deliberate and user-controlled:
     the menu toggle collapses and expands it, nothing else. The
     old auto-retract (collapse on entering Browse, 6s idle
     collapse) made the rail width unpredictable; both effects
     are gone. ---- */
  const railRef = useRef<HTMLElement | null>(null);

  /* #99: clearing a site's cookies is irreversible, so it asks first.
     The palette command only sets the target; this m3e-dialog (the
     Settings pattern) confirms. Hooks stay above the cloak return. */
  const [clearSiteUrl, setClearSiteUrl] = useState<string | null>(null);
  const clearSiteRef = useRef<(HTMLElement & { show: () => Promise<void>; returnValue: string }) | null>(null);
  const clearSiteTarget = useRef<string | null>(null);
  clearSiteTarget.current = clearSiteUrl;
  useEffect(() => {
    const el = clearSiteRef.current;
    if (!el) return;
    const onClosed = () => {
      const target = clearSiteTarget.current;
      const confirmed = el.returnValue === "clear";
      el.returnValue = "";
      setClearSiteUrl(null);
      if (!confirmed || !target) return;
      /* Scoped jar clear (Zeolite #41 zl:clearJar): the active
         jar profile, one origin - cookies only, honest counts. */
      void zlSend({ type: "zl:clearJar", origin: target }).then((reply) => {
        if (typeof M3eSnackbar === "undefined" || !M3eSnackbar) return;
        if (reply && reply.ok) {
          M3eSnackbar.open("Cleared " + (reply.cookies ?? 0) + " cookies for this site", {
            duration: 4000,
          });
        } else {
          M3eSnackbar.open(
            "Clear failed: " + ((reply && reply.error) || "engine did not answer"),
            { duration: 5000 },
          );
        }
      });
    };
    el.addEventListener("closed", onClosed);
    return () => el.removeEventListener("closed", onClosed);
  }, [cloaked]);
  useEffect(() => {
    const el = clearSiteRef.current;
    if (!clearSiteUrl || !el) return;
    el.returnValue = "";
    void el.show();
  }, [clearSiteUrl]);
  let clearSiteHost = "this site";
  if (clearSiteUrl) {
    try {
      clearSiteHost = new URL(clearSiteUrl).hostname;
    } catch {
      /* keep the generic label */
    }
  }

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

  /* ---- #81 command palette actions. Browser.tsx-owned surfaces
     (extensions panel, toolbar omnibox) are reached through window
     events so App stays decoupled from Browser internals; the
     timeout lets the browser view mount before the event fires. ---- */
  const activeTab = tabs.find((t) => t.id === activeId);
  const commands: Command[] = [
    { id: "new-tab", group: "Tabs", label: "New tab", run: () => newTab() },
    {
      id: "close-tab",
      group: "Tabs",
      label: "Close tab",
      run: () => {
        if (activeTab) closeTab(activeTab.id);
      },
    },
    { id: "reopen-tab", group: "Tabs", label: "Reopen last closed tab", run: reopenTab },
    { id: "go-home", group: "Go", label: "Home", run: () => setView("home") },
    { id: "go-settings", group: "Go", label: "Settings", run: () => setView("settings") },
    { id: "go-logs", group: "Go", label: "Logs", run: () => setView("logs") },
    {
      id: "toggle-engine",
      group: "Engine",
      label:
        settings.proxyEngine === "scramjet"
          ? "Switch engine to Zeolite"
          : "Switch engine to ScramJet",
      run: () =>
        update({ proxyEngine: settings.proxyEngine === "scramjet" ? "zeolite" : "scramjet" }),
    },
    {
      id: "open-extensions",
      group: "Tools",
      label: "Open extensions",
      run: () => {
        setView("browser");
        /* The Browser chunk may not be downloaded on the first use.
           Dispatch after it is loaded and mounted, preserving the
           command-palette bridge used before code splitting. */
        void import("./pages/Browser").then(() => {
          window.setTimeout(() => window.dispatchEvent(new CustomEvent("lb-open-extensions")), 60);
        });
      },
    },
    {
      id: "focus-omnibox",
      group: "Tools",
      label: "Focus omnibox",
      run: () => {
        if (view === "browser") {
          void import("./pages/Browser").then(() => {
            window.setTimeout(() => window.dispatchEvent(new CustomEvent("lb-focus-omnibox")), 60);
          });
          return;
        }
        const el = document.getElementById("lb-search-input") as HTMLInputElement | null;
        el?.focus();
      },
    },
    {
      id: "clear-site",
      group: "Privacy",
      label: "Clear cookies for this site",
      run: () => {
        if (!activeTab?.url) return;
        setClearSiteUrl(activeTab.url);
      },
    },
  ];

  return (
    <m3e-theme color={settings.seed} scheme="dark" motion="expressive" strong-focus={true}>
      {/* Enhanced UI setting (was Home-only): the starfield is portaled
          to <body> so no view ancestor can trap the fixed layer, and it
          stays mounted in EVERY view so the frosted rail and dock always
          frost it instead of a flat surface (the in-flow rail has
          nothing else behind it in the browser view). Off = not rendered. */}
      {settings.fancyBackground &&
        createPortal(
          <div className="lb-stars-bg" aria-hidden={true}>
            <StarsBackground />
          </div>,
          document.body
        )}
      <div className="lb-shell">
        {/* Expressive wide rail: the M3E defaults are the spec
           (96dp collapsed with persistent labels, 44dp top inset);
           the menu button expands and collapses it. */}
        <m3e-nav-rail
          id="nav-rail"
          mode="auto"
          aria-label="LobsterBrowse"
          {...{ ref: railRef }}
        >
          <m3e-icon-button toggle aria-label="Expand or collapse the navigation rail">
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
          <m3e-nav-item
            id="nav-settings"
            selected={view === "settings" ? "" : undefined}
            onClick={() => setView("settings")}
          >
            <m3e-icon slot="icon" name="settings" aria-hidden={true} />Settings
          </m3e-nav-item>
        </m3e-nav-rail>

        {/* Small screens (#76): the M3E nav bar replaces the wide
            rail (CSS hides the rail and shows this bar under 600px).
            Same items and handlers as the rail. */}
        <m3e-nav-bar {...{ class: "lb-bottom-nav" }} mode="compact" aria-label="LobsterBrowse">
          <m3e-nav-item
            selected={view === "home" ? "" : undefined}
            onClick={() => setView("home")}
          >
            <m3e-icon slot="icon" name="home" aria-hidden={true} />Home
          </m3e-nav-item>
          <m3e-nav-item
            selected={view === "browser" ? "" : undefined}
            onClick={() => {
              if (tabs.length === 0) newTab();
              else setView("browser");
            }}
          >
            <m3e-icon slot="icon" name="travel_explore" aria-hidden={true} />Browse
          </m3e-nav-item>
          <m3e-nav-item
            selected={view === "settings" ? "" : undefined}
            onClick={() => setView("settings")}
          >
            <m3e-icon slot="icon" name="settings" aria-hidden={true} />Settings
          </m3e-nav-item>
        </m3e-nav-bar>


        <div className="lb-main">

          <div className="app-content">
            <div key={view} className="lb-view">
              {view === "home" && (
                <HomePage
                  settings={settings}
                  history={history}
                  incognito={incognito}
                  onNavigate={navigateTo}
                  onRemoveHistory={removeHistory}
                  onClearHistory={clearHistoryAll}
                />
              )}
              {view === "settings" && (
                <Suspense fallback={<m3e-loading-indicator variant="contained" aria-label="Loading settings" />}>
                  <SettingsPanel
                    settings={settings}
                    onChange={update}
                    rules={rules}
                    onRulesChange={updateRules}
                    onOpenLogs={() => setView("logs")}
                    onDeleteAll={deleteAll}
                    onImportSession={importSession}
                  />
                </Suspense>
              )}
              {view === "logs" && (
                <Suspense fallback={<m3e-loading-indicator variant="contained" aria-label="Loading logs" />}>
                  <LogsPage onBack={() => setView("home")} sess={tabs.find((t) => t.id === activeId)?.sess} />
                </Suspense>
              )}
            </div>
          <div className="lb-browser-host" hidden={view !== "browser"}>
            {(browserMounted || view === "browser") && (
              <Suspense fallback={<m3e-loading-indicator variant="contained" aria-label="Loading browser" />}>
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
                  onOpenSettings={() => setView("settings")}
                  onRulesChange={updateRules}
                />
              </Suspense>
            )}
          </div>
          </div>
        </div>
      </div>
      {/* #81: rendered at the root so Ctrl+K works in every view. */}
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      {/* #99: confirm before deleting cookies (irreversible). Cancel,
          Escape and the scrim all close with no action. */}
      <m3e-dialog {...{ ref: clearSiteRef }} alert="">
        <span slot="header">Clear cookies?</span>
        <p>
          Cookies stored for {clearSiteHost} in the active profile will be deleted. This cannot be undone.
        </p>
        <div slot="actions">
          <m3e-button autofocus>
            <m3e-dialog-action return-value="cancel">Cancel</m3e-dialog-action>
          </m3e-button>
          <m3e-button variant="filled">
            <m3e-dialog-action return-value="clear">Clear cookies</m3e-dialog-action>
          </m3e-button>
        </div>
      </m3e-dialog>
    </m3e-theme>
  );
}
