/* The in-app proxy browser surface: tabs, frosted floating tab strip,
   bottom hover toolbar, proxied iframes and per-tab DevTools.

   Single native engine: every navigation goes to /r/<base64url of the
   target>, which the server rewrites (URL-bearing attributes, CSS urls)
   and re-injects with a shim that routes runtime fetch/XHR and element
   assignments. Frames are same-origin, so the UI polls each frame for
   its real URL, title and favicon, and DevTools get full console and
   network capture.

   Tabs that receive a URL without an explicit navigation (Home search,
   restored sessions) auto-load when they become active. */

import { useEffect, useRef, useState } from "react";
import lockSvg from "@material-symbols/svg-400/outlined/lock.svg?raw";
import noEncSvg from "@material-symbols/svg-400/outlined/no_encryption.svg?raw";
import dominoMaskSvg from "@material-symbols/svg-400/outlined/domino_mask.svg?raw";
import {
  decodeRoute,
  ENGINES,
  fetchSuggestions,
  looksLikeUrl,
  normalizeUrl,
  routeUrl,
  searchUrl,
  type Settings,
  type SiteRule,
} from "../settings";
import { zlSend } from "../zeolite";
import { pushLog, type Tab } from "../store";
import DevTools, { emptyDt, nextEntryId, type DtState, type ResFailEntry } from "./DevTools";

type View = "home" | "browser" | "settings" | "logs";

type Props = {
  settings: Settings;
  rules: SiteRule[];
  tabs: Tab[];
  activeId: number;
  setActiveId: (id: number) => void;
  updateTab: (id: number, patch: Partial<Tab>) => void;
  newTab: (url?: string) => void;
  closeTab: (id: number) => void;
  onHistory: (url: string) => void;
  /* Incognito session: no history recording, no session persistence. */
  incognito: boolean;
  onIncognitoChange: (v: boolean) => void;
  setView: (v: View) => void;
  onOpenLogs: () => void;
};

/* Short label for a tab: its real title, or the bare hostname. */
function tabLabel(t: Tab): string {
  if (t.title) return t.title;
  if (!t.url) return "New tab";
  try {
    return new URL(t.url).hostname.replace(/^www\./, "");
  } catch {
    return t.url;
  }
}

/* Redact obviously sensitive query parameters before a URL enters any
   diagnostic surface (DevTools, error page, logs). */
function redactUrl(u: string): string {
  return String(u).replace(
    /([?&])(token|access_token|api_key|apikey|password|secret|authorization|session)=[^&]*/gi,
    "$1$2=[redacted]",
  );
}

/* Installed-extension summary from the engine control plane. */
type ExtInfo = {
  id: string;
  name: string;
  version: string;
  state: string;
  enabled: boolean;
  lastError: string | null;
};

/* Full detail surface from zl:extInfo (one extension). */
type ExtDetail = {
  id: string;
  name: string;
  version: string;
  description: string;
  state: string;
  enabled: boolean;
  lastError: string | null;
  permissions: string[];
  hostPermissions: string[];
  contentScripts: number;
  optionsPath: string | null;
};

export default function BrowserView(props: Props) {
  const { settings, rules, tabs, activeId } = props;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const frames = useRef<Map<number, HTMLIFrameElement>>(new Map());
  /* Last URL each tab was asked to load â guards the auto-load effect
     against double navigation. */
  const lastNav = useRef<Map<number, string>>(new Map());
  /* Per-tab navigation generation: every load() bumps it, so results
     from an older navigation (a slow "ready", a late poll callback, a
     certificate lookup for a page we already left) can be detected and
     dropped. navId is the short human-readable diagnostic ID
     (NAV-XXXX) shown on the error page. */
  const navGen = useRef<Map<number, number>>(new Map());
  const navId = useRef<Map<number, string>>(new Map());
  const [status, setStatus] = useState<Record<number, { loading: boolean; nav?: string }>>({});
  const [dt, setDtState] = useState<Record<number, DtState>>({});
  /* Per-tab URL bar drafts; when empty the bar shows the real URL. */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  /* Toolbar autocomplete: engine-queried suggestions, debounced. */
  const [tbSugg, setTbSugg] = useState<{ text: string; url: string }[]>([]);
  const [tbSuggOpen, setTbSuggOpen] = useState(false);
  const [tbSuggIdx, setTbSuggIdx] = useState(-1);
  /* New tab search autocomplete: same engine-queried suggestions
     as the toolbar pill, plus its own keyboard navigation. */
  const [ntSugg, setNtSugg] = useState<{ text: string; url: string }[]>([]);
  const [ntSuggOpen, setNtSuggOpen] = useState(false);
  const [ntSuggIdx, setNtSuggIdx] = useState(-1);
  const [ntDraft, setNtDraft] = useState("");
  /* Center pill: collapsed shows the tab name; pressed, it expands in
     place into the editable URL (the name hides). */
  const [tbExpanded, setTbExpanded] = useState(false);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  /* Real favicon per tab (blob URL fetched through the engine). */
  const [icons, setIcons] = useState<Record<number, string>>({});
  const iconCache = useRef<Map<string, string>>(new Map());
  /* Frame documents that already have LobsterJet prefetch listeners. */
  const wiredDocs = useRef<WeakSet<Document>>(new WeakSet());
  /* Last lb-diag content seen per tab: the proxy rewriter reports how
     many CSP meta tags and SRI integrity attributes it stripped; log
     each distinct report once, not on every poll tick. */
  const lastDiag = useRef<Map<number, string>>(new Map());
  /* Tab-hover live preview: which tab, anchored at which screen x. */
  const [preview, setPreview] = useState<{ id: number; x: number } | null>(null);
  const previewTimer = useRef<number | null>(null);
  /* Tabs muted from the hover preview; re-asserted on every poll tick. */
  const [mutedTabs, setMutedTabs] = useState<Set<number>>(new Set());
  /* Tabs animating closed; the real close lands after the collapse. */
  const [closingIds, setClosingIds] = useState<number[]>([]);
  /* Site info card: open state plus the cookies the page can read. */
  const [siteInfoOpen, setSiteInfoOpen] = useState(false);
  const [siteCookies, setSiteCookies] = useState<string[]>([]);
  /* Extensions panel: asks the service worker for the installed list
     (Zeolite zl:listExt control message). The worker controlling the
     page wins; otherwise the vendored worker at /zlsw/sw.js is
     registered and used as a control plane (no page control). */
  const [extPanelOpen, setExtPanelOpen] = useState(false);
  const [extBusy, setExtBusy] = useState(false);
  const [extList, setExtList] = useState<ExtInfo[] | null>(null);
  /* Last registration/reply failure, shown verbatim in the panel. */
  const [extError, setExtError] = useState<string | null>(null);
  /* Extension detail card: the manifest surface from zl:extInfo. */
  const [extDetail, setExtDetail] = useState<ExtDetail | null>(null);
  const [extDetailError, setExtDetailError] = useState<string | null>(null);
  /* Per-extension incognito grants. UI-side only for now: the engine
     has no incognito concept yet, so this records the user's intent
     (and is enforced once the engine grows incognito tabs). */
  const [extIncognito, setExtIncognito] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("lobsterbrowse-ext-incognito") ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const saveExtIncognito = (next: Record<string, boolean>) => {
    setExtIncognito(next);
    try {
      localStorage.setItem("lobsterbrowse-ext-incognito", JSON.stringify(next));
    } catch {
      /* storage unavailable (private mode quirks) */
    }
  };
  const openExtDetail = async (id: string) => {
    setExtDetailError(null);
    setExtDetail(null);
    const rep = await zlSend({ type: "zl:extInfo", extId: id }, 6000);
    if (rep && rep.ok && rep.extension) {
      setExtDetail(rep.extension as ExtDetail);
    } else {
      setExtDetailError(
        rep && rep.error ? String(rep.error) : "the worker did not answer zl:extInfo",
      );
    }
  };
  const toggleExtEnabled = async (id: string, on: boolean) => {
    const rep = await zlSend({ type: "zl:extEnable", extId: id, enabled: on }, 6000);
    if (!rep || !rep.ok) {
      setExtDetailError(
        rep && rep.error ? String(rep.error) : "the worker did not answer zl:extEnable",
      );
      return;
    }
    /* Mirror the new state locally and refresh list + detail. */
    loadExtensions();
    setExtDetail((d) => (d && d.id === id ? { ...d, enabled: on } : d));
  };
  const toggleExtIncognito = (id: string, on: boolean) =>
    saveExtIncognito({ ...extIncognito, [id]: on });
  const openExtOptions = (d: ExtDetail) => {
    if (d.optionsPath) window.open("/zl-ext/" + d.id + "/" + d.optionsPath, "_blank");
  };
  const loadExtensions = async () => {
    setExtError(null);
    setExtDetail(null);
    setExtDetailError(null);
    if (!("serviceWorker" in navigator)) {
      setExtBusy(false);
      setExtList(null);
      setExtError("this browser has no service worker support");
      return;
    }
    /* The shared zeolite.ts plumbing registers the vendored worker
       (root scope; it passes through every non-engine path) and
       talks to it as a control plane when nothing controls the page. */
    setExtBusy(true);
    const rep = await zlSend({ type: "zl:listExt" }, 5000);
    setExtBusy(false);
    if (!rep) {
      setExtList(null);
      setExtError("the Zeolite service worker could not be registered or reached on this origin");
      return;
    }
    if (!rep.ok) {
      setExtList(null);
      setExtError(rep.error ? String(rep.error) : "zl:listExt failed");
      return;
    }
    setExtList(Array.isArray(rep.extensions) ? (rep.extensions as ExtInfo[]) : []);
  };
  /* Load errors surfaced from the server's meta[lb-load-error]. */
  const [errors, setErrors] = useState<Record<number, { url: string; message: string }>>({});
  /* New tab search: smooth width expansion is state-driven, not a
     classList mutation on the m3e host (React can wipe those). */
  const [ntTyped, setNtTyped] = useState(false);

  /* Dock: tucks out of view when the app is idle; reappears on any
     pointer/keyboard activity in the app, on hovering the visible
     sliver, or on focusing the URL field. The transform lives on a
     plain wrapper div (.lb-dock-pill): applying it to the m3e-toolbar
     host did nothing (custom element host display), which left the
     bar frozen in place covering page content. */
  const [dockTucked, setDockTucked] = useState(false);
  const dockHoverRef = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const hideSoon = () => {
    if (!settings.autoHideChrome) return;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!dockHoverRef.current) setDockTucked(true);
      else hideSoon();
    }, 3500);
  };
  useEffect(() => {
    const onActivity = () => {
      setDockTucked(false);
      hideSoon();
    };
    window.addEventListener("pointermove", onActivity);
    window.addEventListener("keydown", onActivity);
    hideSoon();
    return () => {
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("keydown", onActivity);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!settings.autoHideChrome) {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      setDockTucked(false);
    }
  }, [settings.autoHideChrome]);

  /* Fullscreen for the browser area. */
  const rootRef = useRef<HTMLElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rootRef.current?.requestFullscreen?.().catch(() => {});
  };

  const setDt = (id: number, patch: Partial<DtState>) => {
    setDtState((prev) => {
      const base = prev[id] ?? emptyDt();
      return { ...prev, [id]: { ...base, ...patch } };
    });
  };
  const dtOf = (id: number): DtState => dt[id] ?? emptyDt();
  const addNet = (id: number, entry: { url: string; method: string; status: number; ok?: boolean; dur?: number; error?: string }) => {
    setDtState((prev) => {
      const base = prev[id] ?? emptyDt();
      return { ...prev, [id]: { ...base, net: [...base.net, { id: nextEntryId(), ts: Date.now(), ...entry }] } };
    });
  };

  /* ---- Favicon: read from the same-origin frame document, fetch the
     icon through the engine, cache per icon URL. ---- */
  const loadFavicon = (tabId: number, url: string, doc: Document) => {
    let href = "";
    const link = doc.querySelector<HTMLLinkElement>("link[rel~='icon']");
    const attr = link ? link.getAttribute("href") || "" : "";
    if (attr) {
      if (attr.startsWith("/r/") || attr.startsWith("/lj/")) {
        href = attr;
      } else {
        try {
          href = routeUrl(settings, rules, new URL(attr, url).href);
        } catch {
          href = "";
        }
      }
    }
    if (!href) {
      try {
        href = routeUrl(settings, rules, new URL(url).origin + "/favicon.ico");
      } catch {
        return;
      }
    }
    const setIcon = (obj: string) =>
      setIcons((prev) => (prev[tabId] === obj ? prev : { ...prev, [tabId]: obj }));
    const cached = iconCache.current.get(href);
    if (cached !== undefined) {
      if (cached) setIcon(cached);
      return;
    }
    fetch(href)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!blob || blob.size === 0 || blob.size > 400000) {
          iconCache.current.set(href, "");
          return;
        }
        const obj = URL.createObjectURL(blob);
        iconCache.current.set(href, obj);
        setIcon(obj);
      })
      .catch(() => {
        iconCache.current.set(href, "");
      });
  };
  /* Blob URL lifecycle: the cache dedupes per icon URL and stays
     bounded; eviction revokes only URLs no tab is still using, and
     everything left is revoked when the browser view unmounts. */
  const iconsRef = useRef<Record<number, string>>({});
  iconsRef.current = icons;
  useEffect(() => {
    const cache = iconCache.current;
    if (cache.size <= 64) return;
    const inUse = new Set(Object.values(iconsRef.current));
    const evict = cache.size - 64;
    let i = 0;
    for (const [k, v] of Array.from(cache.entries())) {
      if (i >= evict) break;
      cache.delete(k);
      i++;
      if (v && !inUse.has(v)) URL.revokeObjectURL(v);
    }
  }, [icons]);
  useEffect(
    () => () => {
      for (const v of iconCache.current.values()) if (v) URL.revokeObjectURL(v);
      iconCache.current.clear();
    },
    [],
  );

  /* ---- Navigation ---- */
  const load = (tab: Tab, url: string, opts?: { push?: boolean }) => {
    const push = opts?.push !== false;
    lastNav.current.set(tab.id, url);
    /* New navigation generation: older generations' results are stale. */
    const gen = (navGen.current.get(tab.id) ?? 0) + 1;
    navGen.current.set(tab.id, gen);
    const nid = "NAV-" + gen.toString(16).toUpperCase().padStart(4, "0").slice(-4);
    navId.current.set(tab.id, nid);
    const stack = push ? [...tab.stack.slice(0, tab.idx + 1), url] : tab.stack;
    const idx = push ? stack.length - 1 : tab.idx;
    props.updateTab(tab.id, { url, stack, idx, title: "" });
    setDrafts((prev) => {
      const n = { ...prev };
      delete n[tab.id];
      return n;
    });
    setIcons((prev) => {
      const n = { ...prev };
      delete n[tab.id];
      return n;
    });
    setErrors((prev) => {
      if (!prev[tab.id]) return prev;
      const n = { ...prev };
      delete n[tab.id];
      return n;
    });

    setStatus((prev) => ({ ...prev, [tab.id]: { loading: true, nav: nid } }));
    const frame = frames.current.get(tab.id);
    /* 74.9: incognito tabs route through the engine's separate cookie
       jar (lb_inc=1) so their cookies never mix into the shared one. */
    const href = routeUrl(settings, rules, url, props.incognito);
    if (frame) frame.src = href;
    pushLog("info", "engine nav " + url + " (" + nid + ")");
  };
  /* Stable handle to the current load(): the mount-once message
     listener calls this instead of capturing a render-time closure. */
  const loadRef = useRef(load);
  loadRef.current = load;

  /* ---- Auto-load: a tab whose URL was set without a navigation
     (Home search, restored session, newTab(url)) starts loading as
     soon as it becomes the active tab. ---- */
  useEffect(() => {
    const t = active;
    if (!t || !t.url) return;
    if (lastNav.current.get(t.id) === t.url) return;
    load(t, t.url, { push: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.url, settings, rules]);

  /* ---- Same-origin poll: real URL, title and favicon of the active
     frame, read directly from the frame document. JS-driven URL
     changes (pushState) sync back into the toolbar and tab. ---- */
  useEffect(() => {
    const iv = setInterval(() => {
      const t = active;
      if (!t || !t.url) return;
      const f = frames.current.get(t.id);
      if (!f) return;
      let doc: Document | null = null;
      let path = "";
      try {
        doc = f.contentDocument;
        path = f.contentWindow ? f.contentWindow.location.pathname : "";
      } catch {
        return;
      }
      if (!doc) return;
      /* Detailed error page: the server renders meta[lb-load-error]
         at the same /r/ path; surface it and stop the spinner. */
      const errMeta = doc.querySelector<HTMLMetaElement>('meta[name="lb-load-error"]');
      if (errMeta) {
        setStatus((prev) => ({ ...prev, [t.id]: { loading: false } }));
        const msg = errMeta.content || "unknown error";
        setErrors((prev) =>
          prev[t.id] && prev[t.id].message === msg && prev[t.id].url === t.url
            ? prev
            : { ...prev, [t.id]: { url: t.url, message: msg } }
        );
        pushLog("error", "load failed: " + msg);
        return;
      }
      /* 74.7 CSP/SRI diagnostics: the rewriter strips CSP meta tags and
         integrity attributes from proxied documents and reports the
         counts in meta[lb-diag]. Surface each report once in DevTools
         as a diagnostic failure entry. */
      const diagMeta = doc.querySelector<HTMLMetaElement>('meta[name="lb-diag"]');
      if (diagMeta) {
        const content = diagMeta.content || "";
        if (lastDiag.current.get(t.id) !== content) {
          lastDiag.current.set(t.id, content);
          const m = /csp=(\d+);sri=(\d+)/.exec(content);
          if (m) {
            const csp = Number(m[1]) || 0;
            const sri = Number(m[2]) || 0;
            if (csp > 0 || sri > 0) {
              const mk = (kind: string, reason: string, n: number): ResFailEntry => ({
                id: nextEntryId(),
                url: redactUrl(t.url || ""),
                kind,
                reason,
                status: 0,
                note: n + " stripped by the proxy rewriter (page would otherwise break inside the iframe)",
                nav: navId.current.get(t.id),
                ts: Date.now(),
              });
              setDtState((prev) => {
                const base = prev[t.id] ?? emptyDt();
                const fails = [...base.fails];
                if (csp > 0) fails.push(mk("csp-meta", "CSP_STRIPPED", csp));
                if (sri > 0) fails.push(mk("sri-integrity", "SRI_STRIPPED", sri));
                /* Own the proxy's own interventions in the page console:
                   entries explicitly prefixed as engine-caused, so a
                   broken page is never silently blamed on the site. */
                const bits: string[] = [];
                if (csp > 0) bits.push(csp + " CSP meta tag(s)");
                if (sri > 0) bits.push(sri + " integrity attribute(s)");
                const ctext =
                  "[LobsterBrowse engine] This proxy stripped " +
                  bits.join(" and ") +
                  " from the page. SRI hashes and CSP rules no longer match rewritten content; the rewriter removes them so the page loads at all. If the page misbehaves, this is the proxy's doing, not the website's.";
                const console_ = [
                  ...base.console,
                  { id: nextEntryId(), kind: "warn" as const, text: ctext, ts: Date.now() },
                ].slice(-500);
                return { ...prev, [t.id]: { ...base, fails: fails.slice(-200), console: console_ } };
              });
              pushLog("info", "rewrite diag: csp stripped=" + csp + " sri stripped=" + sri);
            }
          }
        }
      }
      if (!path.startsWith("/r/") && !path.startsWith("/lj/")) return;
      const real = decodeRoute(path);
      if (!real) return;
      setErrors((prev) => {
        if (!prev[t.id]) return prev;
        const n = { ...prev };
        delete n[t.id];
        return n;
      });
      if (real !== t.url) {
        /* History semantics: a URL change seen by polling is NOT always
           a new navigation. If the page used history.back()/forward()
           (popstate), the polled URL matches an adjacent stack entry:
           move the index, do not append. AâBâC + back stays AâBâC at
           index 1, never AâBâCâB. Only a genuinely new URL (pushState,
           replaceState to a different path) pushes a fresh entry. */
        const stack = t.stack;
        const idx = t.idx;
        let patch: Partial<Tab>;
        if (idx > 0 && stack[idx - 1] === real) {
          patch = { url: real, idx: idx - 1 };
        } else if (idx < stack.length - 1 && stack[idx + 1] === real) {
          patch = { url: real, idx: idx + 1 };
        } else {
          patch = { url: real, stack: [...stack.slice(0, idx + 1), real], idx };
          if (!props.incognito) props.onHistory(real);
        }
        props.updateTab(t.id, patch);
        pushLog("info", "url sync " + real);
      }
      const title = (doc.title || "").trim();
      if (title && title !== t.title) props.updateTab(t.id, { title });
      setStatus((prev) => {
        const cur = prev[t.id];
        return cur && cur.loading ? { ...prev, [t.id]: { loading: false } } : prev;
      });
      loadFavicon(t.id, real, doc);
      /* Re-assert muted tabs: pages keep creating new media elements. */
      for (const mid of mutedTabs) {
        const mf = frames.current.get(mid);
        try {
          const els = mf && mf.contentDocument ? mf.contentDocument.querySelectorAll("audio,video") : [];
          els.forEach((el) => {
            (el as HTMLMediaElement).muted = true;
          });
        } catch {
          /* frame went cross-origin; nothing to do */
        }
      }
      /* LobsterJet prefetch: hovering (or keyboard-focusing) a link in
         the proxied page warms the worker cache before the click. */
      if (settings.prefetchLinks && !wiredDocs.current.has(doc)) {
        wiredDocs.current.add(doc);
        const prefix = settings.proxyEngine === "lobsterjet" ? "/lj/" : "/r/";
        const prefetch = (el: EventTarget | null) => {
          const target = el as Element | null;
          const a = target && target.closest ? (target.closest("a[href]") as HTMLAnchorElement | null) : null;
          if (!a) return;
          const href = a.getAttribute("href") || "";
          if (!href.startsWith(prefix)) return;
          if (a.getAttribute("target") === "_blank" || a.hasAttribute("download")) return;
          fetch(href).catch(() => {});
        };
        doc.addEventListener("pointerover", (e) => prefetch(e.target), { passive: true });
        doc.addEventListener("focusin", (e) => prefetch(e.target), true);
      }
    }, 1200);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, tabs, settings, rules, mutedTabs]);

  /* ---- Hook messages from proxied pages ---- */
  /* ---- Hook messages from proxied pages ----
     ONE listener, registered once on mount. The old effect depended on
     [tabs, activeId, settings, rules, dt], so every state change tore
     the listener down and re-registered it (churn + dropped-message
     races). Everything the handler needs now comes from a `live` ref
     refreshed on every render, so the listener identity never changes
     and never reads stale render-time state. */
  const live = useRef({
    tabs,
    dt,
    incognito: props.incognito,
    onHistory: props.onHistory,
    newTab: props.newTab,
    updateTab: props.updateTab,
  });
  live.current = {
    tabs,
    dt,
    incognito: props.incognito,
    onHistory: props.onHistory,
    newTab: props.newTab,
    updateTab: props.updateTab,
  };
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      /* Sender + origin validation: proxied frames are same-origin by
         architecture (that is what gives DevTools its page access), so
         a message from any other origin is not one of ours. */
      if (e.origin !== window.location.origin) return;
      const data = e.data as { lb?: string; data?: Record<string, unknown> } | null;
      /* Schema validation: {lb: string, data?: object}. Anything else
         (including unknown lb types) is dropped. */
      if (!data || typeof data.lb !== "string" || data.lb.length > 32) return;
      if (data.data !== undefined && typeof data.data !== "object") return;
      const L = live.current;
      let tabId: number | null = null;
      let tab: Tab | undefined;
      for (const t of L.tabs) {
        const f = frames.current.get(t.id);
        if (f && e.source === f.contentWindow) {
          tabId = t.id;
          tab = t;
          break;
        }
      }
      if (tabId === null || !tab) return;
      const d = data.data ?? {};
      const dtBase = () => L.dt[tabId as number] ?? emptyDt();
      /* Maximum string lengths: a hostile or broken page must not be
         able to stuff megabytes into DevTools state. */
      const cap = (v: unknown, n: number) => String(v ?? "").slice(0, n);

      if (data.lb === "console") {
        const level = String(d.level ?? "log");
        const kind: "error" | "warn" | "info" | "debug" | "log" =
          level === "error" ? "error" : level === "warn" ? "warn" : level === "info" ? "info" : level === "debug" ? "debug" : "log";
        setDt(tabId, {
          console: [...dtBase().console, { id: nextEntryId(), kind, text: cap(d.text, 4000), ts: Number(d.ts ?? Date.now()) }].slice(-500),
        });
      } else if (data.lb === "net") {
        setDt(tabId, {
          net: [
            ...dtBase().net,
            {
              id: nextEntryId(),
              url: cap(d.url, 2000),
              method: cap(d.method, 10) || "GET",
              status: Number(d.status ?? 0),
              ok: d.ok === undefined ? undefined : Boolean(d.ok),
              dur: d.dur === undefined ? undefined : Number(d.dur),
              error: d.error === undefined ? undefined : cap(d.error, 500),
              ts: Number(d.ts ?? Date.now()),
            },
          ].slice(-500),
        });
      } else if (data.lb === "resfail") {
        /* Resource-failure diagnostics: what failed, where, why. */
        const entry: ResFailEntry = {
          id: nextEntryId(),
          url: redactUrl(cap(d.url, 2000)),
          kind: cap(d.kind, 40) || "unknown",
          reason: cap(d.reason, 60) || "UNKNOWN",
          status: d.status === undefined ? undefined : Number(d.status) || 0,
          note: d.note === undefined ? undefined : cap(d.note, 400),
          /* 74.4 failure chain: which navigation this failure belongs
             to, same NAV-XXXX id the error page shows. */
          nav: navId.current.get(tabId as number),
          ts: Number(d.ts ?? Date.now()) || Date.now(),
        };
        setDtState((prev) => {
          const base = prev[tabId as number] ?? emptyDt();
          return { ...prev, [tabId as number]: { ...base, fails: [...base.fails, entry].slice(-200) } };
        });
      } else if (data.lb === "ready") {
        /* Stale-navigation guard: a ready that arrives after a newer
           load() started must not update the tab (title/status). */
        if (lastNav.current.get(tabId) !== tab.url) return;
        const title = cap(d.title, 300);
        if (title) L.updateTab(tabId, { title });
        setStatus((prev) => ({ ...prev, [tabId as number]: { loading: false, nav: prev[tabId as number]?.nav } }));
        if (tab.url && !L.incognito) L.onHistory(tab.url);
      } else if (data.lb === "navigate") {
        const href = cap(d.href, 2000);
        if (!href) return;
        const abs = (() => {
          try {
            return new URL(href, tab.url).href;
          } catch {
            return "";
          }
        })();
        /* Scheme validation: only http(s) navigations. javascript:,
           data:, blob:, file: and friends are rejected outright â a
           proxied page must not script the browser surface. */
        if (!abs || !/^https?:/i.test(abs)) return;
        if (d.newTab) {
          L.newTab(abs);
        } else {
          loadRef.current(tab, abs, { push: true });
        }
      } else if (data.lb === "nav") {
        /* Event-driven SPA navigation (74.6): the page hook reports
           pushState/replaceState/popstate/hashchange the instant they
           happen, so the toolbar and tab stack update without waiting
           for the 1.2s poll (which stays as a fallback for favicon,
           error-meta, mute and title). Same history semantics as the
           poll: a change to an adjacent stack entry moves the index
           (back/forward), a genuinely new URL pushes. */
        const real = cap(d.url, 2000);
        if (!real || !/^https?:/i.test(real)) return;
        if (real !== tab.url) {
          const stack = tab.stack;
          const idx = tab.idx;
          let patch: Partial<Tab>;
          if (idx > 0 && stack[idx - 1] === real) {
            patch = { url: real, idx: idx - 1 };
          } else if (idx < stack.length - 1 && stack[idx + 1] === real) {
            patch = { url: real, idx: idx + 1 };
          } else {
            patch = { url: real, stack: [...stack.slice(0, idx + 1), real], idx };
            if (!L.incognito) L.onHistory(real);
          }
          L.updateTab(tabId, patch);
          pushLog("info", "url sync " + real);
        }
        setStatus((prev) => {
          const cur = prev[tabId as number];
          return cur && cur.loading ? { ...prev, [tabId as number]: { loading: false } } : prev;
        });
      }
      /* Unknown data.lb values are ignored by design. */
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draft = active ? (drafts[active.id] ?? active.url) : "";
  /* Query the search engine for completions of the current draft.
     Debounced 160ms; must run before the empty-tab early return so the
     hook order never changes between renders. */
  useEffect(() => {
    const q = draft.trim();
    if (!q || !settings.suggestQueries) {
      setTbSugg([]);
      setTbSuggOpen(false);
      setTbSuggIdx(-1);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fetchSuggestions(settings.engine, draft)
        .then((list) => {
          if (cancelled) return;
          const items = list.map((text) => ({ text, url: searchUrl(settings, text) }));
          setTbSugg(items);
          setTbSuggOpen(items.length > 0);
          setTbSuggIdx(-1);
          /* Diagnostics: the suggest endpoint is server-proxied and can
             fail per engine; a zero count in the app log pinpoints
             whether the box is empty because of the network or the
             setting. */
          pushLog("info", "suggest [" + settings.engine + "] '" + draft.slice(0, 40) + "' -> " + items.length);
        })
        .catch((err) => {
          if (!cancelled) pushLog("error", "suggest failed: " + String(err).slice(0, 120));
        });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, settings.engine]);

  /* New tab search: engine-queried completions of the draft,
     debounced like the toolbar ones, before the early return. */
  useEffect(() => {
    const q = ntDraft.trim();
    if (!q || !settings.suggestQueries) {
      setNtSugg([]);
      setNtSuggOpen(false);
      setNtSuggIdx(-1);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fetchSuggestions(settings.engine, ntDraft)
        .then((list) => {
          if (cancelled) return;
          const items = list.map((text) => ({ text, url: searchUrl(settings, text) }));
          setNtSugg(items);
          setNtSuggOpen(items.length > 0);
          setNtSuggIdx(-1);
          pushLog("info", "suggest [" + settings.engine + "] '" + ntDraft.slice(0, 40) + "' -> " + items.length);
        })
        .catch((err) => {
          if (!cancelled) pushLog("error", "suggest failed: " + String(err).slice(0, 120));
        });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ntDraft, settings.engine]);

  /* Expanding the center pill focuses (and selects) the URL text. */
  useEffect(() => {
    if (tbExpanded) urlInputRef.current?.select();
  }, [tbExpanded]);

  if (!active) {
    /* App sends us back to Home when the last tab closes. */
    return null;
  }

  const st = status[active.id] ?? { loading: false };
  const activeDt = dtOf(active.id);

  const go = (value: string) => {
    const q = value.trim();
    if (!q) return;
    load(active, looksLikeUrl(q) ? normalizeUrl(q) : searchUrl(settings, q), { push: true });
  };

  const back = () => {
    if (active.idx > 0) {
      const url = active.stack[active.idx - 1];
      props.updateTab(active.id, { idx: active.idx - 1, url });
      load(active, url, { push: false });
    }
  };
  const forward = () => {
    if (active.idx < active.stack.length - 1) {
      const url = active.stack[active.idx + 1];
      props.updateTab(active.id, { idx: active.idx + 1, url });
      load(active, url, { push: false });
    }
  };
  /* Smooth close: the tab collapses first (.closing), the real close
     (and the siblings sliding over) lands after the animation. */
  const closeTabSmooth = (id: number) => {
    if (closingIds.includes(id)) return;
    setClosingIds((prev) => [...prev, id]);
    window.setTimeout(() => {
      setClosingIds((prev) => prev.filter((x) => x !== id));
      /* Full per-tab state cleanup: status, DevTools, drafts, icons,
         errors, mute set, navigation bookkeeping and the frame handle.
         (The favicon blob URL itself is shared through iconCache, so
         it is only revoked when no tab uses it anymore.) */
      frames.current.delete(id);
      lastNav.current.delete(id);
      navGen.current.delete(id);
      navId.current.delete(id);
      setMutedTabs((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
      const drop = <T extends Record<number, unknown>>(prev: T): T => {
        if (!(id in prev)) return prev;
        const n = { ...prev };
        delete n[id];
        return n;
      };
      setStatus(drop);
      setDrafts(drop);
      setIcons(drop);
      setErrors(drop);
      setDtState((prev) => {
        if (!prev[id]) return prev;
        const n = { ...prev };
        delete n[id];
        return n;
      });
      props.closeTab(id);
    }, 240);
  };

  /* Hover preview mute: the poll tick re-asserts it every second. */
  const toggleMute = (id: number) => {
    setMutedTabs((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  /* ---- Lock popup: connection facts + cookies of the active site. ---- */
  const secure = !!active.url && active.url.startsWith("https://");
  let uParts = { scheme: "", host: "", port: "" };
  try {
    const u = new URL(active.url);
    uParts = {
      scheme: u.protocol.replace(":", ""),
      host: u.hostname,
      port: u.port || (u.protocol === "https:" ? "443 (default)" : "80 (default)"),
    };
  } catch {
    /* not a URL yet */
  }
  /* TLS certificate details for the site card. The server checks the
     host's public CT-log record (crt.sh), so this works even though
     the browser never makes a direct TLS connection to the site. */
  const [siteCert, setSiteCert] = useState<
    { issuer: string; notAfter: string; days: number } | null | "checking" | "error"
  >(null);
  const loadSiteCert = (host: string) => {
    if (!host) return;
    /* Navigation-generation guard: if the tab navigates while the CT
       lookup is in flight, the stale answer is dropped. */
    const tabId = active.id;
    const gen = navGen.current.get(tabId);
    setSiteCert("checking");
    fetch("/cert?host=" + encodeURIComponent(host))
      .then((r) => r.json() as Promise<{ ok: boolean; issuer?: string; notAfter?: string; days?: number }>)
      .then((d) => {
        if (navGen.current.get(tabId) !== gen) return;
        if (d && d.ok && d.issuer) {
          setSiteCert({ issuer: d.issuer, notAfter: d.notAfter ?? "", days: d.days ?? 0 });
        } else {
          setSiteCert("error");
        }
      })
      .catch(() => {
        if (navGen.current.get(tabId) !== gen) return;
        setSiteCert("error");
      });
  };
  const loadSiteCookies = () => {
    const f = frames.current.get(active.id);
    let jar: string[] = [];
    try {
      const doc = f ? f.contentDocument : null;
      jar = doc && doc.cookie ? doc.cookie.split(";").map((c) => c.trim()).filter(Boolean) : [];
    } catch {
      jar = [];
    }
    setSiteCookies(jar);
  };
  /* Expire every cookie the page can see, on the host and every
     parent domain, so nothing survives. */
  const clearSiteCookies = () => {
    const f = frames.current.get(active.id);
    try {
      const doc = f ? f.contentDocument : null;
      if (!doc) return;
      const host = new URL(active.url).hostname;
      const domains = [host, ...host.split(".").map((_, i) => host.split(".").slice(i).join(".")).slice(1)];
      const names = doc.cookie.split(";").map((c) => c.trim().split("=")[0]).filter(Boolean);
      for (const n of names) {
        for (const d of domains) {
          doc.cookie = n + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/" + (d !== host ? ";domain=" + d : "");
        }
      }
      setSiteCookies(doc.cookie.split(";").map((c) => c.trim()).filter(Boolean));
      pushLog("info", "cleared " + names.length + " site cookie(s) for " + host);
    } catch {
      /* frame not reachable */
    }
  };
  const exportCookies = () => {
    let domain = "";
    try {
      domain = new URL(active.url).hostname;
    } catch {
      /* keep empty */
    }
    const rows = [["name", "value", "domain"]].concat(
      siteCookies.map((c) => {
        const i = c.indexOf("=");
        return [i === -1 ? c : c.slice(0, i), i === -1 ? "" : c.slice(i + 1), domain];
      })
    );
    const csv = rows.map((r) => r.map((x) => '"' + x.replace(/"/g, '""') + '"').join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "lobsterbrowse-cookies.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      className={"lb-browser" + (props.incognito ? " incognito" : "")}
      ref={(el) => {
        rootRef.current = el as HTMLElement | null;
      }}
    >
      {/* Frosted floating tab strip: sits over the page content. Shares
          the dock's tucked state: after the idle timer it slides up
          leaving a sliver; the real tabs keep their shape and positions
          (just mostly off-screen), no fake single-tab collapse. */}
      <div
        className={
          "lb-tabstrip" +
          (dockTucked ? " tucked" : "") +
          (tabs.length >= 6 ? " compact" : "") +
          (tabs.length >= 10 ? " tight" : "")
        }
        role="tablist"
        aria-label="Proxy tabs"
      >
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === active.id}
            className={"lb-tab" + (t.id === active.id ? " active" : "") + (closingIds.includes(t.id) ? " closing" : "")}
            onClick={() => props.setActiveId(t.id)}
            onMouseEnter={(e) => {
              const x = (e.currentTarget as HTMLElement).getBoundingClientRect().left;
              if (previewTimer.current) window.clearTimeout(previewTimer.current);
              previewTimer.current = window.setTimeout(() => setPreview({ id: t.id, x }), 350);
            }}
            onMouseLeave={() => {
              if (previewTimer.current) window.clearTimeout(previewTimer.current);
              previewTimer.current = window.setTimeout(() => setPreview(null), 150);
            }}
          >
            {icons[t.id] ? (
              <img className="lb-tab-favicon" src={icons[t.id]} alt="" />
            ) : (
              <m3e-icon name="public" aria-hidden={true} />
            )}
            <span className="lb-tab-title">{tabLabel(t)}</span>
            <m3e-icon
              name="close"
              aria-hidden={true}
              className="lb-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTabSmooth(t.id);
              }}
            />
          </div>
        ))}
        <m3e-icon-button aria-label="New tab" onClick={() => props.newTab()}>
          <m3e-icon name="add" aria-hidden={true} />
        </m3e-icon-button>
      </div>

      {/* Tab hover preview: live (scriptless) render of the hovered
          tab below the strip, with a mute toggle for playing audio.
          No allow-scripts: the preview never runs the page's JS, so it
          can never double audio or side effects. */}
      {preview &&
        (() => {
          const pt = tabs.find((x) => x.id === preview.id);
          if (!pt || !pt.url) return null;
          const muted = mutedTabs.has(pt.id);
          return (
            <div
              className="lb-tab-preview"
              style={{ left: preview.x }}
              onMouseEnter={() => {
                if (previewTimer.current) window.clearTimeout(previewTimer.current);
              }}
              onMouseLeave={() => {
                previewTimer.current = window.setTimeout(() => setPreview(null), 150);
              }}
            >
              <div className="lb-tab-preview-bar">
                <span className="lb-tab-preview-title">{tabLabel(pt)}</span>
                <button
                  type="button"
                  className={"lb-tab-preview-mute" + (muted ? " muted" : "")}
                  aria-pressed={muted}
                  aria-label={muted ? "Unmute tab" : "Mute tab"}
                  onClick={() => toggleMute(pt.id)}
                >
                  <m3e-icon name={muted ? "volume_off" : "volume_up"} aria-hidden={true} />
                </button>
              </div>
              <div className="lb-tab-preview-clip">
                <iframe
                  className="lb-tab-preview-frame"
                  title={"Preview of tab " + pt.id}
                  src={routeUrl(settings, rules, pt.url)}
                  sandbox="allow-same-origin"
                />
              </div>
            </div>
          );
        })()}

      {/* Content area: one same-origin engine iframe per tab, inactive ones stay mounted */}
      <div className="lb-pages">
        {tabs.map((t) => (
          <div key={t.id} className={"lb-page" + (t.id === active.id ? " active" : "")}>
            <iframe
              title={"Proxy tab " + t.id}
              ref={(el) => {
                if (el) frames.current.set(t.id, el);
                else frames.current.delete(t.id);
              }}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation"
              /* Cross-origin frames (LobsterJet) can't be polled; the
                 load event is the only reliable "done" signal there. */
              onLoad={() =>
                setStatus((prev) => {
                  const cur = prev[t.id];
                  return cur && cur.loading ? { ...prev, [t.id]: { loading: false } } : prev;
                })
              }
            />
          </div>
        ))}

        {st.loading && (
          <div className="lb-loading" aria-busy="true">
            <m3e-loading-indicator variant="contained" aria-label="Loading page" />
            <m3e-skeleton animation="wave" shape="rounded" className="lb-skel">
              <div style={{ width: "45%", height: 28 }} />
              <div style={{ width: "92%", height: 14 }} />
              <div style={{ width: "88%", height: 14 }} />
              <div style={{ width: "60%", height: 180, marginTop: 8 }} />
              <div style={{ width: "92%", height: 14 }} />
              <div style={{ width: "75%", height: 14 }} />
            </m3e-skeleton>
          </div>
        )}

        {errors[active.id] && (
          <div className="lb-error" role="alertdialog" aria-label="Page failed to load">
            <m3e-heading variant="title" size="medium" level={2}>This page could not be loaded</m3e-heading>
            <p className="lb-error-url">{errors[active.id].url}</p>
            <p className="lb-error-msg">{errors[active.id].message}</p>
            <div className="lb-error-logs">
              <div className="lb-error-logs-title">Technical log</div>
              <div className="lb-error-logline">
                engine {settings.proxyEngine} Â· route {routeUrl(settings, rules, errors[active.id].url)}
              </div>
              <div className="lb-error-logline">
                navigation {status[active.id]?.nav ?? navId.current.get(active.id) ?? "unknown"}
              </div>
              {activeDt.fails.length > 0 && (
                <div className="lb-error-logline">
                  resource failures: {activeDt.fails.length} (
                  {Object.entries(
                    activeDt.fails.reduce<Record<string, number>>((a, f) => {
                      a[f.kind] = (a[f.kind] ?? 0) + 1;
                      return a;
                    }, {}),
                  )
                    .map(([k, n]) => n + " Ã " + k)
                    .join(", ")}
                  )
                </div>
              )}
              {[
                ...activeDt.fails.slice(-10).map((f) => "fail: [" + f.kind + "] " + (f.status ? f.status + " " : "") + f.url + " â " + f.reason + (f.note ? " (" + f.note + ")" : "")),
                ...activeDt.console.filter((e) => e.kind === "error").slice(-5).map((e) => "console: " + e.text),
                ...activeDt.net.slice(-10).map((n) => n.method + " " + n.status + " " + n.url),
              ].map((line, i) => (
                <div key={i} className="lb-error-logline">{line}</div>
              ))}
            </div>
            <m3e-button
              variant="filled"
              onClick={() => {
                const target = errors[active.id].url;
                setErrors((prev) => {
                  const n = { ...prev };
                  delete n[active.id];
                  return n;
                });
                load(active, target, { push: false });
              }}
            >
              <m3e-icon name="refresh" aria-hidden={true} /> Try again
            </m3e-button>
          </div>
        )}

        {!active.url && !st.loading && !errors[active.id] && (
          <div className="lb-newtab">
            <m3e-heading variant="display" size="medium" level={2}>LobsterBrowse</m3e-heading>
            <div className={"lb-nt-search" + (ntTyped ? " filled" : "")}>
              <m3e-search-bar clearable className="lb-newtab-search">
                <m3e-icon name="travel_explore" slot="leading" aria-hidden={true} />
                <input
                  slot="input"
                  aria-label={"Search with " + ENGINES[settings.engine].name + " or URL"}
                  placeholder={"Search with " + ENGINES[settings.engine].name + " or URL"}
                  autoComplete="off"
                  value={ntDraft}
                  spellCheck={false}
                  onBlur={() => setNtSuggOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const pick =
                        ntSuggOpen && ntSuggIdx >= 0
                          ? ntSugg[ntSuggIdx]?.url
                          : (e.target as HTMLInputElement).value;
                      setNtSuggOpen(false);
                      if (pick) go(pick);
                    } else if (e.key === "ArrowDown" && ntSuggOpen) {
                      e.preventDefault();
                      setNtSuggIdx((p) => Math.min(p + 1, ntSugg.length - 1));
                    } else if (e.key === "ArrowUp" && ntSuggOpen) {
                      e.preventDefault();
                      setNtSuggIdx((p) => Math.max(p - 1, -1));
                    } else if (e.key === "Escape") {
                      setNtSuggOpen(false);
                    }
                  }}
                  onChange={(e) => {
                    /* Smooth expansion tracks typed content, not just focus. */
                    setNtTyped(!!(e.target as HTMLInputElement).value);
                    setNtDraft((e.target as HTMLInputElement).value);
                  }}
                />
              </m3e-search-bar>
              {ntSuggOpen && (
                <div className="lb-nt-ac" role="listbox" aria-label="Suggestions">
                  {ntSugg.map((it, i) => (
                    <button
                      key={it.url}
                      type="button"
                      role="option"
                      aria-selected={i === ntSuggIdx}
                      className={"lb-nt-ac-item" + (i === ntSuggIdx ? " active" : "")}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setNtSuggOpen(false);
                        go(it.url);
                      }}
                    >
                      <m3e-icon name="search" aria-hidden={true} />
                      <span className="lb-nt-ac-text">{it.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeDt.open && (
          <DevTools
            tab={active}
            dt={activeDt}
            setDt={(patch) => setDt(active.id, patch)}
            frame={() => frames.current.get(active.id) ?? null}
            onClose={() => setDt(active.id, { open: false })}
            onOpenLogs={props.onOpenLogs}
          />
        )}

      </div>

      {/* Bottom dock: tucks out of view when idle; hover the visible
          sliver, focus the URL field, or move the pointer / type to
          bring it back. */}
      <div
        className={"lb-dock" + (dockTucked ? " tucked" : "")}
        onMouseEnter={() => (dockHoverRef.current = true)}
        onMouseLeave={() => {
          dockHoverRef.current = false;
          hideSoon();
        }}
      >
        <div className="lb-dock-pill">
          <m3e-toolbar variant="standard" shape="rounded" className="lb-toolbar">
          <m3e-icon-button aria-label="Home" onClick={() => props.setView("home")}>
            <m3e-icon name="home" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-icon-button aria-label="Back" onClick={back}>
            <m3e-icon name="arrow_back" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-icon-button aria-label="Forward" onClick={forward}>
            <m3e-icon name="arrow_forward" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-icon-button
            aria-label="Reload"
            onClick={() => (active.url ? load(active, active.url, { push: false }) : undefined)}
          >
            <m3e-icon name="refresh" aria-hidden={true} />
          </m3e-icon-button>
          {/* The pill centers itself with auto margins; no spacers. */}
          {/* Center pill: lock + favicon + tab name. Pressed, it expands
              in place into the editable URL (the name hides). */}
          <span className={"lb-tb-pill" + (tbExpanded || !active.url ? " expanded" : "")}>
            {tbSuggOpen && (
              <div className="lb-tb-ac" role="listbox" aria-label="Suggestions">
                {tbSugg.map((it, i) => (
                  <button
                    key={it.url}
                    type="button"
                    role="option"
                    aria-selected={i === tbSuggIdx}
                    className={"lb-tb-ac-item" + (i === tbSuggIdx ? " active" : "")}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setTbSuggOpen(false);
                      setTbExpanded(false);
                      setDrafts((prev) => ({ ...prev, [active.id]: "" }));
                      go(it.url);
                    }}
                  >
                    <m3e-icon name="search" aria-hidden={true} />
                    <span className="lb-tb-ac-text">{it.text}</span>
                  </button>
                ))}
              </div>
            )}
            {active.url && (
              <>
                <span
                  className="lb-tb-lock-wrap"
                  role="button"
                  tabIndex={0}
                  aria-label={secure ? "https connection, site details" : "Not secure, site details"}
                  onClick={() => {
                    loadSiteCookies();
                    if (secure && uParts.host && !siteInfoOpen) loadSiteCert(uParts.host);
                    setSiteInfoOpen((v) => !v);
                  }}
                >
                  <span
                    className={"lb-tb-lock " + (secure ? "secure" : "insecure")}
                    aria-hidden={true}
                    dangerouslySetInnerHTML={{ __html: secure ? lockSvg : noEncSvg }}
                  />
                </span>
                {icons[active.id] ? (
                  <img className="lb-tb-favicon" src={icons[active.id]} alt="" />
                ) : (
                  <m3e-icon name="public" aria-hidden={true} />
                )}
              </>
            )}
            {tbExpanded || !active.url ? (
              <input
                ref={urlInputRef}
                className="lb-url-input"
                aria-label="URL or search"
                placeholder={"Search with " + ENGINES[settings.engine].name + " or URL"}
                value={draft}
                spellCheck={false}
                onChange={(e) => {
                  setDrafts((prev) => ({ ...prev, [active.id]: e.target.value }));
                  setTbSuggIdx(-1);
                }}
                onFocus={() => setTbSuggOpen(tbSugg.length > 0)}
                onBlur={() => {
                  setTbSuggOpen(false);
                  setTbExpanded(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const pick = tbSuggOpen && tbSuggIdx >= 0 ? tbSugg[tbSuggIdx]?.url : draft;
                    setTbSuggOpen(false);
                    setTbExpanded(false);
                    if (pick) go(pick);
                  } else if (e.key === "ArrowDown" && tbSuggOpen) {
                    e.preventDefault();
                    setTbSuggIdx((p) => Math.min(p + 1, tbSugg.length - 1));
                  } else if (e.key === "ArrowUp" && tbSuggOpen) {
                    e.preventDefault();
                    setTbSuggIdx((p) => Math.max(p - 1, -1));
                  } else if (e.key === "Escape") {
                    setTbSuggOpen(false);
                    setTbExpanded(false);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="lb-tb-name"
                aria-label={"Show URL of " + tabLabel(active)}
                onClick={() => setTbExpanded(true)}
              >
                {tabLabel(active)}
              </button>
            )}
          </span>
          <m3e-icon-button
            aria-label="Developer tools"
            toggle
            selected={activeDt.open ? "" : undefined}
            onClick={() => setDt(active.id, { open: !activeDt.open })}
          >
            <m3e-icon name="bug_report" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-icon-button
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            toggle
            selected={fullscreen ? "" : undefined}
            onClick={toggleFullscreen}
          >
            <m3e-icon name={fullscreen ? "fullscreen_exit" : "fullscreen"} aria-hidden={true} />
          </m3e-icon-button>
          <m3e-icon-button
            aria-label="Extensions"
            toggle
            selected={extPanelOpen ? "" : undefined}
            onClick={() => {
              const next = !extPanelOpen;
              setExtPanelOpen(next);
              if (next) loadExtensions();
            }}
          >
            <m3e-icon name="extension" aria-hidden={true} />
          </m3e-icon-button>
          {/* Incognito toggle: a regular 40x40 icon button inside the
              toolbar, same slot as the other toggles. Toggling on
              suspends the normal session and opens one empty
              incognito tab (App.tsx); toggling off closes it and
              restores the session. The domino mask is an inline SVG
              (no font glyph exists), sized by CSS. */}
          <button
            type="button"
            id="lb-incognito-pill"
            className={"lb-incognito" + (props.incognito ? " on" : "")}
            aria-pressed={props.incognito}
            aria-label={props.incognito ? "Turn off incognito" : "Turn on incognito"}
            onClick={() => props.onIncognitoChange(!props.incognito)}
          >
            <span className="lb-incognito-ic" dangerouslySetInnerHTML={{ __html: dominoMaskSvg }} />
          </button>
          <m3e-tooltip for="lb-incognito-pill" position="above">
            {props.incognito
              ? "Incognito on: history and session are not recorded. The proxy server still sees traffic."
              : "Turn on incognito: stops history and session recording."}
          </m3e-tooltip>
        </m3e-toolbar>
          {/* Site info: a real M3E card (elevated) anchored above the
              toolbar (outside the identity pill, so opening it can
              never inflate the pill or the toolbar). Long cookie
              lists scroll inside the card. */}
          {siteInfoOpen && (
              <m3e-card variant="elevated" className="lb-site-card" aria-label="Site information">
                <div slot="header" className="lb-site-head">
                  <span
                    className={"lb-tb-lock " + (secure ? "secure" : "insecure")}
                    aria-hidden={true}
                    dangerouslySetInnerHTML={{ __html: secure ? lockSvg : noEncSvg }}
                  />
                  <span className="lb-site-ctitle">{secure ? "https connection" : "http connection, not secure"}</span>
                  <m3e-icon-button aria-label="Close site info" onClick={() => setSiteInfoOpen(false)}>
                    <m3e-icon name="close" aria-hidden={true} />
                  </m3e-icon-button>
                </div>
                <div slot="content" className="lb-site-body">
                  <div className="lb-site-row">
                    {uParts.scheme ? uParts.scheme + "://" + uParts.host + (uParts.port.includes("default") ? "" : ":" + uParts.port) : "No URL loaded"}
                  </div>
                  {secure && (
                    <>
                      <div className="lb-site-ctitle">Public certificate record</div>
                      {siteCert === null && <div className="lb-site-row">Press the lock again to check the certificate.</div>}
                      {siteCert === "checking" && <div className="lb-site-row">Checking certificate record...</div>}
                      {siteCert === "error" && <div className="lb-site-row">Certificate data unavailable (no public CT-log record or lookup failed).</div>}
                      {siteCert && siteCert !== "checking" && siteCert !== "error" && (
                        <div className="lb-site-row">
                          Issuer: {siteCert.issuer}
                          <br />
                          Valid until {siteCert.notAfter} ({siteCert.days} days left)
                          <br />
                          <span className="lb-muted">Source: Certificate Transparency logs (crt.sh / Cert Spotter). This is the public record for the host, not the certificate this session actually negotiated.</span>
                        </div>
                      )}
                    </>
                  )}
                  <div className="lb-site-ctitle">Page-readable cookies ({siteCookies.length})</div>
                  {siteCookies.length > 0 && (
                    <div className="lb-site-cookies">
                      {siteCookies.slice(0, 12).map((c) => (
                        <div key={c} className="lb-site-cookie">{c}</div>
                      ))}
                    </div>
                  )}
                  <p className="lb-site-note">
                    Only cookies the page itself can read. HttpOnly cookies live on the proxy server side.
                  </p>
                </div>
                <div slot="actions" className="lb-site-actions">
                  <m3e-button onClick={clearSiteCookies}>
                    <m3e-icon name="delete" aria-hidden={true} /> Clear page-readable cookies
                  </m3e-button>
                  <m3e-button onClick={exportCookies}>
                    <m3e-icon name="download" aria-hidden={true} /> Export CSV
                  </m3e-button>
                </div>
              </m3e-card>
            )}
        </div>
      </div>

      {extPanelOpen && (
        <div className="lb-ext-panel" role="dialog" aria-label="Extensions">
          <div className="lb-ext-head">
            <span className="lb-ext-title">Extensions</span>
            <span>
              <m3e-icon-button aria-label="Refresh extensions" onClick={() => loadExtensions()}>
                <m3e-icon name="refresh" aria-hidden={true} />
              </m3e-icon-button>
              <m3e-icon-button aria-label="Close extensions" onClick={() => setExtPanelOpen(false)}>
                <m3e-icon name="close" aria-hidden={true} />
              </m3e-icon-button>
            </span>
          </div>
          {extList === null ? (
            <p className="lb-ext-note">
              {extBusy
                ? "Querying the engine service worker..."
                : extError
                  ? "Engine extensions unavailable: " + extError
                  : "Engine extensions unavailable. No Zeolite service worker on this origin."}
            </p>
          ) : extList.length === 0 ? (
            <p className="lb-ext-note">No extensions installed.</p>
          ) : (
            <div className="lb-ext-list">
              {extList.map((e) => (
                <div
                  key={e.id}
                  className={"lb-ext-item" + (extDetail && extDetail.id === e.id ? " sel" : "")}
                  title={e.lastError ?? ""}
                  role="button"
                  tabIndex={0}
                  onClick={() => openExtDetail(e.id)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") openExtDetail(e.id);
                  }}
                >
                  <span className="lb-ext-name">{e.name}</span>
                  <span className="lb-ext-ver">{e.version}</span>
                  <span className={"lb-ext-state" + (e.enabled ? "" : " off")}>
                    {e.enabled ? e.state : "disabled"}
                  </span>
                </div>
              ))}
            </div>
          )}
          {extDetailError && <p className="lb-ext-err">{extDetailError}</p>}
          {extDetail && (
            <div className="lb-ext-detail">
              <div className="lb-ext-dhead">
                <span className="lb-ext-dname">
                  {extDetail.name} <span className="lb-ext-ver">{extDetail.version}</span>
                </span>
                <m3e-icon-button aria-label="Close extension details" onClick={() => setExtDetail(null)}>
                  <m3e-icon name="close" aria-hidden={true} />
                </m3e-icon-button>
              </div>
              {extDetail.description && <p className="lb-ext-desc">{extDetail.description}</p>}
              <div className="lb-ext-trow">
                <span className="lb-ext-tlabel">Enabled</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={extDetail.enabled}
                  className={"lb-ext-switch" + (extDetail.enabled ? " on" : "")}
                  onClick={() => toggleExtEnabled(extDetail.id, !extDetail.enabled)}
                >
                  <span className="lb-ext-knob" />
                </button>
              </div>
              <div className="lb-ext-trow">
                <span className="lb-ext-tlabel">Allow in incognito tabs</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!extIncognito[extDetail.id]}
                  className={"lb-ext-switch" + (extIncognito[extDetail.id] ? " on" : "")}
                  onClick={() => toggleExtIncognito(extDetail.id, !extIncognito[extDetail.id])}
                >
                  <span className="lb-ext-knob" />
                </button>
              </div>
              {(extDetail.permissions.length > 0 || extDetail.hostPermissions.length > 0) && (
                <div className="lb-ext-perms">
                  {[...extDetail.permissions, ...extDetail.hostPermissions].slice(0, 12).map((p) => (
                    <code key={p}>{p}</code>
                  ))}
                </div>
              )}
              {extDetail.contentScripts > 0 && (
                <p className="lb-ext-desc">
                  {extDetail.contentScripts} content script{extDetail.contentScripts === 1 ? "" : "s"} registered.
                </p>
              )}
              {extDetail.optionsPath && (
                <m3e-button className="lb-ext-optbtn" onClick={() => openExtOptions(extDetail)}>
                  <m3e-icon name="settings" aria-hidden={true} /> Open options page
                </m3e-button>
              )}
              {extDetail.lastError && <p className="lb-ext-err">{extDetail.lastError}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
