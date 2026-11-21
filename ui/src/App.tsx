import { useCallback, useEffect, useRef, useState } from "react";
import HomePage from "./pages/Home";
import SettingsPanel from "./pages/Settings";
import LogsPage from "./pages/Logs";
import BrowserView from "./pages/Browser";
import AiPage from "./pages/Ai";
import neurologySvg from "@material-symbols/svg-400/outlined/neurology.svg?raw";
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
import { engineSwSource, zlContentConfig, zlContentOrigin, zlContentRegister, zlGuestHost, zlRelayInit, zlSend, zlAnnounceContentOrigin, zlWispAuthArm, zlWispInit } from "./zeolite";
import { parseNavTab, shellGuardCancel, shellGuardDest, type ShellNavApi, type ShellNavEvent } from "./frameNav";
import { sanitizeUrl } from "./sanitize";
import CommandPalette, { type Command } from "./CommandPalette";
import { createPopupGate } from "./browser/popupGate";
import { sjInit } from "./scramjet";
import { createPortal } from "react-dom";
import { defaultExperimental, loadDebugOverrides } from "./debug";
import type { Tab } from "./store";
import "./extensions.css";

type View = "home" | "browser" | "ai" | "settings" | "logs";

let tabSeq = 1;
/* The remote hero wallpaper (same URL as the top .lb-fx-bg layer in
   theme.css; keep the two in sync). Pre-warmed once per session: the
   hero only paints when this image is decoded, so the local
   lb-hero.jpg backplate never flashes through on a cold cache. */
const HERO_BACKDROP_URL =
  "https://images4.alphacoders.com/134/thumb-1920-1341558.png";
/* Wallpaper off (all pages paint the theme surface). Flip to true to bring the hero layer, its pre-warm fetch and the flash back. */
const HERO_BG = false;
let heroBackdropWarm: Promise<void> | null = null;
let heroBackdropSettled = false;
function heroBackdropReady(): Promise<void> {
  heroBackdropWarm ??= new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      heroBackdropSettled = true;
      resolve();
    };
    img.onerror = () => {
      heroBackdropSettled = true;
      resolve();
    };
    img.src = HERO_BACKDROP_URL;
  });
  return heroBackdropWarm;
}
/* Start the pre-warm at module scope, NOT in a mount effect: the fetch
   and decode now race the first render instead of following it. The
   browser heuristically caches the image (no Cache-Control, 3-year-old
   Last-Modified), so on a warm reload the promise usually settles
   BEFORE React commits, and the hero layer paints with the first
   frame instead of one cache round trip + decode behind it. Until the
   layer mounts, the frost reads as flat dark glass, which is exactly
   the "frosted glass takes its 100ms" symptom this removes. The cold
   path is unchanged: the layer still waits for the load, so the local
   lb-hero.jpg backplate never flashes. */
if (HERO_BG) heroBackdropReady();

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
  /* #259: the active view rides the URL hash (#view=<name>) so a
     reload restores it. Tabs restore from the persisted session;
     only the view needs the hash. replaceState (not location.hash)
     keeps every switch off the history stack and fires no hashchange
     scroll jump. Unknown or missing hashes stay Home. */
  const viewFromHash = (): View => {
    const m = /^#view=(home|browser|ai|settings|logs)$/.exec(window.location.hash);
    return m ? (m[1] as View) : "home";
  };
  const [view, setView] = useState<View>(viewFromHash);
  /* Hero load gate (2026-11-20 prompt item): .lb-fx-bg paints the
     remote wallpaper OVER the local lb-hero.jpg backplate, so a
     reload after a data wipe showed the old local wallpaper for the
     fetch window before the current one landed on top. The layer now
     mounts only once the remote image has loaded (or errored: a
     blocked/unreachable hotlink still reveals the documented
     backplate degrade instead of a bare surface). The state
     initializes from the settled flag, not from false: a pre-warm
     that finished before mount (warm reload) puts the hero layer in
     the very first commit, so the glass is frosted at first paint. */
  const [heroBgReady, setHeroBgReady] = useState(heroBackdropSettled);
  useEffect(() => {
    let on = true;
    if (!HERO_BG) return;
    heroBackdropReady().then(() => {
      if (on) setHeroBgReady(true);
    });
    return () => {
      on = false;
    };
  }, []);
  /* Hero flash: Settings fires a one-shot lb-flash-hero event after a
     cache clear or a wipe, and the response is a brief fullscreen
     flare of the hero image - a visible confirmation that something
     big just changed on this device. The overlay lives on <body>,
     ignores pointer events, and fades itself out. */
  const [heroFlash, setHeroFlash] = useState(false);
  useEffect(() => {
    let t = 0;
    const onFlash = () => {
      setHeroFlash(false);
      requestAnimationFrame(() => setHeroFlash(true));
      window.clearTimeout(t);
      t = window.setTimeout(() => setHeroFlash(false), 650);
    };
    window.addEventListener("lb-flash-hero", onFlash);
    return () => {
      window.removeEventListener("lb-flash-hero", onFlash);
      window.clearTimeout(t);
    };
  }, []);
  useEffect(() => {
    const h = "#view=" + view;
    if (window.location.hash !== h) window.history.replaceState(null, "", h);
  }, [view]);
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const restored = store.loadSessionTabs();
    for (const t of restored) if (t.id >= tabSeq) tabSeq = t.id + 1;
    return restored;
  });
  /* #267: restored tabs keep their persisted ids, so activeId must be
     restored alongside them: 0 matches no real tab id, and every
     props.activeId consumer (the DevTools mount effect, the Alt+W
     close shortcut, the Logs session scope) would then key off a tab
     that does not exist. The persisted save carries no active marker,
     so the last restored tab is shown, matching closeTab's and the
     incognito restore's pick-next convention. */
  const [activeId, setActiveId] = useState<number>(() => {
    const restored = store.loadSessionTabs();
    return restored.length > 0 ? restored[restored.length - 1].id : 0;
  });
  /* Latest tabs/activeId for closeTab: a close-all fires several closeTab
     calls from one render's closure, and each filtered that stale snapshot,
     so only the last close stuck. The refs are also written synchronously
     by closeTab/restoreClosedTabs so back-to-back calls compose. */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  /* #81: Ctrl+K command palette. */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /* Incognito: no history recording, no session persistence while on. */
  const [incognito, setIncognito] = useState(false);
  /* While incognito is on, nothing must land in the normal profile's
     localStorage: the log ring stays memory-only. */
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
  /* One boot snackbar for returning profiles; the first visit only
     sets the marker. Local-only; storage failures count as a first
     visit. */
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
  /* The engine worker broadcasts zl:engineUpdate (updates.ts) to
     every window client once it activates; the UI is a client of the
     same worker, so the update surfaces as a snackbar with a manual
     reload action. Nothing reloads on its own. */
  const lastEngineKey = useRef("");
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMsg = (ev: MessageEvent) => {
      /* Engine broadcasts only from the engine worker itself. */
      if (!engineSwSource(ev)) return;
      const d = ev.data as { type?: string; sha?: string | null; version?: unknown } | null;
      if (!d || d.type !== "zl:engineUpdate") return;
      const key = typeof d.sha === "string" && d.sha ? d.sha : "v:" + String(d.version ?? "");
      if (!key || key === lastEngineKey.current) return;
      lastEngineKey.current = key;
      if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
        /* duration 0 = never auto-dismiss: the notice stays until the
           user reloads or presses Reload now. The old 8s timeout
           dropped the notice while the old worker kept serving. */
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

  /* Incognito gets a persistent body class so the chrome carries a
     subtle, unmistakable identity the whole time it is on. */
  useEffect(() => {
    document.body.classList.toggle("lb-incognito", incognito);
  }, [incognito]);

  /* Register the embedder fetch-relay channel at app level: any view
     can start a /zl/ navigation, and when only the Browser view
     registered it, fetches racing the mount fell back to wisp and
     died on this password-authed deployment wisp ("tls handshake
     eof" 502s). The channel lives in worker memory, so re-register
     on controller change; registration is idempotent. */
  /* Injector phase 2: the query-shape state from /build (the server
     env ZL_QUERY_ROUTES is the opt-out; on by default); read per
     config-push attempt so a slow /build fetch cannot pin a stale
     value into a long retry loop. The ref starts true so a push
     before /build resolves never disables the always-on injector. */
  const queryRoutesRef = useRef(true);
  /* Trusted-egress credential arming + the access-password gate.
     The ref holds the armed credentials so controllerchange can
     re-arm after a worker restart (the engine keeps them
     memory-only). */
  const wispAuthRef = useRef<{ endpoint: string; username: string; password: string } | null>(null);
  /* #250: the deployment's own wisp endpoint (the /build sjWisp
     value), kept in a ref so an override can be withdrawn back to it
     mid-session without a reload. */
  const sjWispRef = useRef("");
  /* #250: the effective wisp endpoint: the Settings override
     (Settings > Advanced > WISP server) when it is a wss:// URL,
     otherwise the deployment default. loadSettings already drops
     stored junk on load; the shape check also covers mid-typing
     edits, which persist through update() unvalidated. */
  const effectiveWisp = () => {
    const c = loadSettings().wispServer.trim();
    return /^wss:\/\/\S+$/.test(c) ? c : sjWispRef.current;
  };
  const [accessGateOpen, setAccessGateOpen] = useState(false);
  const [accessErr, setAccessErr] = useState("");
  const accessGateRef = useRef<(HTMLElement & { show: () => Promise<void>; returnValue: string }) | null>(null);
  const accessPwRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    zlRelayInit();
    void fetch("/build", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const u = b && typeof b.sjWisp === "string" ? b.sjWisp : "";
        if (u) {
          sjWispRef.current = u;
          /* #250: the stored override wins over the deployment
             default from the first boot push on. */
          const w = effectiveWisp();
          if (w) zlWispInit(w);
        }
        /* A provisioned content origin (ZL_CONTENT_ORIGIN on the
           server) is inert until the operator provisions it; when
           present, remember it and register the engine worker on
           that origin. */
        queryRoutesRef.current = b && b.zlQueryRoutes === true;
        /* Arm the trusted-egress wisp credentials when the deployment
           provisions them. A 403 means the access gate is up and
           this visitor has not passed it; the small dialog offers
           the one-time unlock. */
        if (b && b.wispAuth === true) {
          void fetch("/wispauth", { cache: "no-store" })
            .then(async (r) => {
              if (r.status === 403) {
                setAccessGateOpen(true);
                return null;
              }
              return r.ok ? ((await r.json()) as { endpoint: string; username: string; password: string }) : null;
            })
            .then((c) => {
              if (!c || !c.endpoint) return;
              wispAuthRef.current = c;
              void zlWispAuthArm(c);
            })
            .catch(() => {});
        }
        const co = b && typeof b.contentOrigin === "string" ? b.contentOrigin : "";
        zlAnnounceContentOrigin(co);
        if (co) zlContentRegister(co);
        /* Keep the guest-host realm open on the app and content
           origins so proxied-page SW registrations can spawn their
           isolated guest realms. */
        zlGuestHost(co);
        /* Cold content origin: the Render service sleeps, so the first
           real registration pays the whole dyno boot. Warm it at app
           boot with fire-and-forget prefetches of the engine worker
           script and the build manifest; opaque no-cors responses are
           fine, the goal is only to have the service awake. */
        if (co) {
          void fetch(co + "/zlsw/sw.js", { mode: "no-cors", cache: "no-store" }).catch(() => {});
          void fetch(co + "/build", { mode: "no-cors", cache: "no-store" }).catch(() => {});
        }
      })
      .catch(() => zlAnnounceContentOrigin(""));
    const re = () => {
      zlRelayInit();
      /* #250: re-read the stored override on every heal so a worker
         restart never resurrects a withdrawn endpoint. */
      const w = effectiveWisp();
      if (w) zlWispInit(w);
      /* A worker restart drops the memory-only wisp credentials;
         re-arm with the same creds. */
      if (wispAuthRef.current) void zlWispAuthArm(wispAuthRef.current);
    };
    navigator.serviceWorker?.addEventListener("controllerchange", re);
    /* The relay channel lives in service-worker memory. An idle worker
       restart drops it without a controllerchange, and relay-routed hosts
       then fall back to wisp and fail with error 35. Re-register on a
       timer; the registration itself is cached, so this is cheap. */
    const keep = window.setInterval(zlRelayInit, 15000);
    /* The timer heals within 15s; the engine also asks directly
       (zl:relayLost broadcast) when a relay fetch finds no channel,
       and we re-register at once so the wait resolves without
       falling back to wisp. */
    const onRelayLost = (ev: MessageEvent) => {
      /* Relay-loss broadcasts only from the engine worker. */
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

  /* #250: a mid-session edit re-pushes at once. Clearing the override
     re-pushes the deployment default (the worker keeps the last
     registered endpoint until told otherwise). Worker restarts are
     covered by the boot effect's controllerchange handler, which
     re-reads the stored setting through effectiveWisp. Honest limit:
     on split-origin deployments the content-origin worker keeps the
     deployment endpoint - the /zlsw-register boot page relays only
     zl:config messages, so a content-side override would need a
     boot-page relay extension (not in this pass). */
  useEffect(() => {
    const w = effectiveWisp();
    if (w) zlWispInit(w);
  }, [settings.wispServer]);

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

  const closeTab = useCallback((id: number) => {
    const cur = tabsRef.current;
    const tab = cur.find((t) => t.id === id);
    if (!tab) return;
    closedTabs.current = [...closedTabs.current, tab].slice(-10);
    const next = cur.filter((t) => t.id !== id);
    tabsRef.current = next;
    setTabs(next);
    if (id === activeIdRef.current && next.length > 0) {
      activeIdRef.current = next[next.length - 1].id;
      setActiveId(activeIdRef.current);
    }
    if (next.length === 0) setView("home");
  }, []);
  /* Undo for "Close all": put the given tabs back by id (the closed stack
     keeps the last 10), without moving the active tab. Pages reload. */
  const restoreClosedTabs = useCallback((ids: number[]) => {
    const back = closedTabs.current.filter((t) => ids.includes(t.id));
    if (back.length === 0) return;
    closedTabs.current = closedTabs.current.filter((t) => !ids.includes(t.id));
    const next = [...tabsRef.current, ...back];
    tabsRef.current = next;
    setTabs(next);
  }, []);

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
        /* Fresh cookie jar per incognito window: the server-side
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

  /* ScramJet engine option: the upstream controller worker
     (idempotent, ui/src/scramjet.ts) inits when the Proxy engine
     setting picks it; Zeolite registers through its own path. */
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

  /* Keyboard shortcuts. Ctrl+T/Ctrl+W are browser-reserved and
     never reach the page, so the tab shortcuts ride Alt combos.
     AltGr reports as ctrlKey+altKey and is left alone. */
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

  /* A target=_top activation inside a proxied frame must not commit
     the top document on the content origin: the first-party worker
     partition there cannot decode the embedded realm's keyed route
     and serves the SPA shell, losing the session. The engine hands
     the destination over with a bounded ack; ack first so a silent
     host keeps its native fallback, then navigate the active tab -
     the sender is a frame of this window, and a click-driven
     activation can only come from the visible tab. */
  useEffect(() => {
    const onFrameNav = (ev: MessageEvent) => {
      const d = ev.data as { lb?: string; data?: unknown } | null;
      if (!d || d.lb !== "navigateTab") return;
      const co = zlContentOrigin();
      if (ev.origin !== location.origin && !(co && ev.origin === co)) return;
      const req = parseNavTab(d.data);
      if (!req) return;
      if (req.ack && ev.source) {
        try {
          (ev.source as Window).postMessage(
            { lb: "navigateTabAck", nonce: req.ack },
            ev.origin,
          );
        } catch {
          /* the frame is gone; the engine's ack bound falls back */
        }
      }
      navigateTo(req.href);
    };
    window.addEventListener("message", onFrameNav);
    return () => window.removeEventListener("message", onFrameNav);
  }, [navigateTo]);

  /* Shell-side navigation guard (the engine lockdown follow-up,
     mounted at the app root so every view is covered, not just the
     browser page): the engine worker recapture only answers
     fetch-driven shell navigations whose FetchEvent carries the
     source client, and the ESTS-style pane breakout assigns
     top.location directly, so the shell guards its own window too.
     The Navigation API sees every cross-document top navigation
     before commit: a script-initiated push or replace is cancelled
     and its destination reopens as an in-app tab, exactly like the
     worker zlescape recapture. User navigations, reloads, hash
     moves and history traverses are userInitiated, reload/traverse
     or same-document and always pass. The live ref keeps the
     listener registered once for the whole app run. */
  const navGuard = useRef({ tabs, activeId, newTab });
  navGuard.current = { tabs, activeId, newTab };
  useEffect(() => {
    const navapi = (window as unknown as { navigation?: ShellNavApi }).navigation;
    if (!navapi) return;
    /* Scripted recaptures are burst-capped so a looping page cannot
       mint a tab storm through the guard either (LB#260). */
    const gate = createPopupGate(5, 10000, 30);
    const onNavigate = (ev: ShellNavEvent) => {
      if (!shellGuardCancel(ev)) return;
      ev.preventDefault();
      const raw = ev.destination.url;
      const G = navGuard.current;
      const known = G.tabs.find((t) => t.id === G.activeId)?.url ?? null;
      const real = shellGuardDest(raw, known, location.origin);
      if (real) {
        if (!gate.allow(true, Date.now())) {
          if (gate.denied() === 1) store.pushLog("warn", "shell guard: scripted navigation burst capped: " + sanitizeUrl(raw));
          return;
        }
        G.newTab(real);
        store.pushLog("info", "shell navigate guard recaptured to a new tab: " + sanitizeUrl(real));
      } else {
        store.pushLog("warn", "shell navigate guard blocked a navigation without recapture: " + sanitizeUrl(raw));
      }
    };
    navapi.addEventListener("navigate", onNavigate);
    return () => navapi.removeEventListener("navigate", onNavigate);
  }, []);

  /* The Zeolite service worker IS the engine (client-side
     interception, native wisp transport, in-worker rewriting). The
     legacy v3 page-cache worker owned the "/" scope and kept the
     Zeolite worker from ever registering, so unregister it and drop
     its caches when found. The route prefix is worker runtime state
     that resets to /j/ on every restart, so the push below runs on
     every boot. */
  useEffect(() => {
    /* The first zl:config can land on a still-installing worker and
       be dropped; a null reply means the engine never got the route
       prefix. Retry with backoff (a cold free-tier worker can take
       tens of seconds to evaluate its bundle) and only trust an
       explicit ok ack - the engine replies { ok: true }.
       Mid-session restarts need no re-push: since Zeolite#17 the
       worker persists the route shape and restores it before the
       first fetch. */
    const push = async () => {
      const mkMsg = () => ({
        type: "zl:config" as const,
        prefix: engineRoutePrefix(),
        scheme: "b64u",
        /* Refuse the plaintext ?url= embed shape on this deployment -
           initial navigations ride opaque zl:navHandle routes
           (Browser.tsx initialRoute). A worker predating Zeolite#63
           ignores the field, so the push stays compatible. */
        navHandles: true,
        /* Query-shape committed routes: the opt-in rides server
           configuration (/build relays ZL_QUERY_ROUTES) and is read
           per attempt so a slow /build fetch cannot pin a stale value
           into this retry loop. The hidden debug menu can override
           the choice at runtime; the override wins when set. */
        queryRoutes: loadDebugOverrides().queryRoutes ?? queryRoutesRef.current,
        experimental: { ...defaultExperimental(), ...loadDebugOverrides().experimental },
      });
      for (const d of [0, 1000, 3000, 7000, 15000, 30000]) {
        if (d) await new Promise((res) => setTimeout(res, d));
        const r = await zlSend(mkMsg(), 8000);
        if (r && r.ok) {
          /* Config parity: the content origin's worker gets the same
             push through its boot page, so both origins commit the
             same route shape instead of the content worker keeping
             its default prefix. Warn on a missing ack. */
          /* LB#260: only a deployment with a provisioned content
             origin (/build contentOrigin) can ack the parity push;
             zlContentConfig always answers false when there is
             none, so the warn fired on every boot as pure noise. */
          if (zlContentOrigin()) {
            void zlContentConfig(mkMsg()).then((ok) => {
              if (!ok)
                store.pushLog(
                  "warn",
                  "content-origin zl:config did not ack; proxied routes on the content origin may keep the default prefix until the app is reloaded",
                );
            });
          }
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
        /* Unregister any worker that is not the engine bundle: a
           stale registration, whatever its script, must not hold the
           "/" scope and silently block the Zeolite SW. */
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) {
          const p = r.active || r.installing || r.waiting;
          if (p && new URL(p.scriptURL).pathname !== "/zlsw/sw.js") {
            await r.unregister();
          }
        }
      } catch {
        /* best effort: the Zeolite push below still runs */
      }
      await push();
      /* The example.com/robots.txt boot warm is gone: transit is
         relay-only on this deployment, so the pre-dial warmed
         nothing and just stamped robots.txt rows into every
         session's diagnostics on each boot. */
    })();
  }, []);

  /* Zeolite adblock + per-site rules: the engine evaluates
       /rules.json client-side, so keep the toggle in sync with the
       Ad & tracker blocking setting. Per-site rules (rules chip,
       Settings host switches, UA preset) ride along as a zl:rules
       push built from the loadSiteRules() store Settings reads;
       adblock can only disable per site, the global setting still
       wins. The worker resets both on restart, so re-send on boot
       and on change. */
  useEffect(() => {
    /* Controllerchange re-push, same pattern as the effects below -
       the worker resets adblock and the rules on restart, so a
       mid-session restart must re-send both, not just the next
       settings edit. */
    const post = () => {
      void zlSend({ type: "zl:adblock", enabled: settings.adblock }, 8000);
      void zlSend(
        {
          type: "zl:rules",
          /* Hosts without a rule get the resolved global UA
             (resolveUa with no rule hit). */
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

  /* Incognito jar: the zl:jarProfile push makes requests and
       document.cookie use a session profile that never touches
       IndexedDB and dies when incognito ends. The SW resets the
       profile on restart, so re-send on the toggle and on
       controllerchange; a restart mid-incognito can briefly admit
       cookies into the default jar (docs/cookies.md). */
  useEffect(() => {
    const post = () => {
      void zlSend({ type: "zl:jarProfile", profile: incognito ? incognitoSid() : null }, 8000);
    };
    post();
    navigator.serviceWorker?.addEventListener("controllerchange", post);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", post);
  }, [incognito]);

  /* Engine page options (HTTPS upgrade, lazy images) are worker-global
     zl:config fields that reset on restart; re-send on change and on
     controllerchange like the jarProfile above. */
  useEffect(() => {
    const post = () => {
      const msg = {
        type: "zl:config",
        prefix: engineRoutePrefix(),
        httpsUpgrade: loadDebugOverrides().httpsUpgrade ?? settings.httpsUpgrade,
        /* #76: lazy images are always on (the toggle is gone);
           the hidden debug menu (beta) can override this. */
        imageLazy: loadDebugOverrides().imageLazy ?? true,
        /* The query-shape opt-in is ephemeral worker state, same
           class as httpsUpgrade; keep it in the parity push. The
           hidden debug menu can override the choice at runtime; the
           override wins when set. */
        queryRoutes: loadDebugOverrides().queryRoutes ?? queryRoutesRef.current,
        experimental: { ...defaultExperimental(), ...loadDebugOverrides().experimental },
      };
      void zlSend(msg, 8000);
      /* The content worker rewrites and serves the proxied
         documents, so the engine page options must reach it too. */
      void zlContentConfig(msg);
    };
    post();
    navigator.serviceWorker?.addEventListener("controllerchange", post);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", post);
  }, [settings.httpsUpgrade]);

  /* Jar knobs: SameSite policy on the engine cookie jar and
     document-surface fingerprint spoofing. Worker-global, reset on
     restart, re-sent like the jarProfile above. The spoof profile is
     one field - the same UA the engine sends on requests - and the
     engine derives platform, languages and the canvas seed from it;
     timezone and hardware stay native so pages keep laying out
     sanely. */
  useEffect(() => {
    const post = () => {
      void zlSend({ type: "zl:sameSite", policy: settings.sameSitePolicy }, 8000);
      /* The fingerprint profile picker is gone from Settings; the
         default match-the-User-Agent profile is always on. */
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

  /* Transport engine: push the persisted choice (zl:transport). The
     engine switches on the NEXT transport init, not mid-session, and
     resets to the deployment default on restart; re-send on change
     and on controllerchange like the jarProfile above. */
  useEffect(() => {
    const post = () => {
      void zlSend({ type: "zl:transport", engine: settings.transport }, 8000);
    };
    post();
    navigator.serviceWorker?.addEventListener("controllerchange", post);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", post);
  }, [settings.transport]);

  const deleteAll = () => {
    store.clearAllData();
    store.pushLog("warn", "all local data deleted");
    window.location.replace("/");
  };

  /* #81 command palette actions. Browser.tsx-owned surfaces
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
        window.setTimeout(() => window.dispatchEvent(new CustomEvent("lb-open-extensions")), 60);
      },
    },
    {
      id: "focus-omnibox",
      group: "Tools",
      label: "Focus omnibox",
      run: () => {
        if (view === "browser") {
          window.dispatchEvent(new CustomEvent("lb-focus-omnibox"));
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
      confirm: "Press Enter again to clear this site's cookies",
      run: () => {
        if (!activeTab?.url) return;
        /* Scoped jar clear (Zeolite #41 zl:clearJar): the active
           jar profile, one origin - cookies only, honest counts. */
        void zlSend({ type: "zl:clearJar", origin: activeTab.url }).then((reply) => {
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
      },
    },
  ];

  /* Show the access gate once the 403 landed. */
  useEffect(() => {
    if (!accessGateOpen) return;
    const el = accessGateRef.current;
    if (el) void el.show();
  }, [accessGateOpen]);

  const submitAccessPassword = async () => {
    const pw = accessPwRef.current?.value ?? "";
    try {
      const r = await fetch("/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (r.ok) {
        location.reload();
        return;
      }
      setAccessErr("Wrong password.");
    } catch {
      setAccessErr("Network error.");
    }
  };

  return (
    <m3e-theme color={settings.seed} scheme="dark" motion="expressive" strong-focus={true}>
      {/* The home hero background is portaled to
          <body> so no view ancestor can trap the fixed layer.
          It renders always on home and AI (#261 removed Settings:
          a work surface wants a quiet background): the rail and
          dock frost what is really adjacent to them.
          #245: the liquid-metal ribbon shader was removed fully
          and replaced by the static photographic hero image
          (ui/public/lb-hero.jpg, painted by the .lb-fx-bg rule in
          theme.css). Away from those views = not rendered. */}
      {HERO_BG && (view === "home" || view === "ai") && heroBgReady &&
        createPortal(
          <div className="lb-fx-bg" aria-hidden={true} />,
          document.body
        )}
      {HERO_BG && heroFlash &&
        createPortal(
          <div className="lb-fx-flash" aria-hidden={true} />,
          document.body
        )}
      <div className="lb-shell">
        {/* Compact-only rail: the M3E defaults are the spec
           (48dp collapsed with icons only, 44dp top inset); the
           hamburger expansion was removed with the mode="auto"
           machinery. */}
        <m3e-nav-rail
          id="nav-rail"
          aria-label="LobsterBrowse"
        >
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
            id="nav-ai"
            selected={view === "ai" ? "" : undefined}
            onClick={() => setView("ai")}
          >
            <span slot="icon" className="lb-ai-nav-ic" aria-hidden={true} dangerouslySetInnerHTML={{ __html: neurologySvg }} />AI
          </m3e-nav-item>
          <m3e-nav-item
            id="nav-settings"
            selected={view === "settings" ? "" : undefined}
            onClick={() => setView("settings")}
          >
            <m3e-icon slot="icon" name="settings" aria-hidden={true} />Settings
          </m3e-nav-item>
          {/* #262: view names on the collapsed rail. m3e-tooltip
             accepts above/below/before/after only and silently
             resets anything else to below, so the side position is
             "after" (inline after = right in LTR); "right" is
             exactly the bug that put them over the next button. */}
          <m3e-tooltip for="nav-home" position="after">Home</m3e-tooltip>
          <m3e-tooltip for="nav-browse" position="after">Browse</m3e-tooltip>
          <m3e-tooltip for="nav-ai" position="after">AI</m3e-tooltip>
          <m3e-tooltip for="nav-settings" position="after">Settings</m3e-tooltip>
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
            selected={view === "ai" ? "" : undefined}
            onClick={() => setView("ai")}
          >
            <span slot="icon" className="lb-ai-nav-ic" aria-hidden={true} dangerouslySetInnerHTML={{ __html: neurologySvg }} />AI
          </m3e-nav-item>
          <m3e-nav-item
            selected={view === "settings" ? "" : undefined}
            onClick={() => setView("settings")}
          >
            <m3e-icon slot="icon" name="settings" aria-hidden={true} />Settings
          </m3e-nav-item>
        </m3e-nav-bar>


        <div className="lb-main">

          <div className="app-content" data-view={view}>
            {/* Tab keep-alive: the Browse view stays mounted (hidden,
                its iframe alive) whenever tabs exist, so a running or
                downloading tab keeps running while the user visits
                Settings, Home or Logs; returning shows the intact
                frame. The other views remount per switch as before. */}
            {tabs.length > 0 && (
              <div className="lb-view" hidden={view === "browser" ? undefined : true}>
                <BrowserView
                  settings={settings}
                  rules={rules}
                  tabs={tabs}
                  activeId={activeId}
                  setActiveId={setActiveId}
                  updateTab={updateTab}
                  newTab={newTab}
                  closeTab={closeTab}
                  restoreClosedTabs={restoreClosedTabs}
                  incognito={incognito}
                  onIncognitoChange={toggleIncognito}
                  onOpenLogs={() => setView("logs")}
                  onOpenSettings={() => setView("settings")}
                  onRulesChange={updateRules}
                />
              </div>
            )}
            {view !== "browser" && (
              <div key={view} className="lb-view">
              {view === "home" && (
                <HomePage settings={settings} onNavigate={navigateTo} />
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
              {view === "ai" && <AiPage />}
              {view === "logs" && (
                <LogsPage onBack={() => setView("home")} sess={tabs.find((t) => t.id === activeId)?.sess} />
              )}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* #81: rendered at the root so Ctrl+K works in every view. */}
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      {/* Access-password gate for the trusted-egress credential
          arming: a correct password sets the lb_access cookie and
          reloads so the boot arming retry runs. */}
      {accessGateOpen && (
        <m3e-dialog {...{ ref: accessGateRef }} alert="">
          <span slot="header">Access password</span>
          <p>
            This deployment gates its trusted-egress wisp credentials behind an access password.
          </p>
          <input
            ref={accessPwRef}
            type="password"
            aria-label="Access password"
            style={{ width: "100%", boxSizing: "border-box", marginTop: "8px" }}
          />
          {accessErr ? (
            <p style={{ color: "var(--md-sys-color-error, #f2b8b5)", margin: "4px 0 0" }}>{accessErr}</p>
          ) : null}
          <div slot="actions">
            <m3e-button variant="filled" onClick={() => void submitAccessPassword()}>
              Unlock
            </m3e-button>
          </div>
        </m3e-dialog>
      )}
    </m3e-theme>
  );
}
