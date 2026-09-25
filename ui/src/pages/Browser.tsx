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
  fetchSuggestions,
  looksLikeUrl,
  normalizeUrl,
  routeUrl,
  searchUrl,
  type Settings,
  type SiteRule,
} from "../settings";
import { pushLog, type Tab } from "../store";
import DevTools, { emptyDt, nextEntryId, type DtState } from "./DevTools";

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

export default function BrowserView(props: Props) {
  const { settings, rules, tabs, activeId } = props;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const frames = useRef<Map<number, HTMLIFrameElement>>(new Map());
  /* Last URL each tab was asked to load — guards the auto-load effect
     against double navigation. */
  const lastNav = useRef<Map<number, string>>(new Map());
  const [status, setStatus] = useState<Record<number, { loading: boolean }>>({});
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

  /* ---- Navigation ---- */
  const load = (tab: Tab, url: string, opts?: { push?: boolean }) => {
    const push = opts?.push !== false;
    lastNav.current.set(tab.id, url);
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

    setStatus((prev) => ({ ...prev, [tab.id]: { loading: true } }));
    const frame = frames.current.get(tab.id);
    const href = routeUrl(settings, rules, url);
    if (frame) frame.src = href;
    pushLog("info", "engine nav " + url);
  };

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
        const stack = [...t.stack.slice(0, t.idx + 1), real];
        props.updateTab(t.id, { url: real, stack, idx: stack.length - 1 });
        if (!props.incognito) props.onHistory(real);
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
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data as { lb?: string; data?: Record<string, unknown> } | null;
      if (!data || typeof data.lb !== "string") return;
      let tabId: number | null = null;
      let tab: Tab | undefined;
      for (const t of tabs) {
        const f = frames.current.get(t.id);
        if (f && e.source === f.contentWindow) {
          tabId = t.id;
          tab = t;
          break;
        }
      }
      if (tabId === null || !tab) return;
      const d = data.data ?? {};
      const dtBase = () => dtOf(tabId as number);

      if (data.lb === "console") {
        const level = String(d.level ?? "log");
        const kind =
          level === "error" ? "error" : level === "warn" ? "warn" : level === "info" ? "info" : level === "debug" ? "debug" : "log";
        setDt(tabId, {
          console: [...dtBase().console, { id: nextEntryId(), kind, text: String(d.text ?? ""), ts: Number(d.ts ?? Date.now()) }],
        });
      } else if (data.lb === "net") {
        setDt(tabId, {
          net: [
            ...dtBase().net,
            {
              id: nextEntryId(),
              url: String(d.url ?? ""),
              method: String(d.method ?? "GET"),
              status: Number(d.status ?? 0),
              ok: d.ok === undefined ? undefined : Boolean(d.ok),
              dur: d.dur === undefined ? undefined : Number(d.dur),
              error: d.error === undefined ? undefined : String(d.error),
              ts: Number(d.ts ?? Date.now()),
            },
          ].slice(-500),
        });
      } else if (data.lb === "ready") {
        const title = String(d.title ?? "");
        if (title) props.updateTab(tabId, { title });
        setStatus((prev) => ({ ...prev, [tabId as number]: { loading: false } }));
        if (tab.url && !props.incognito) props.onHistory(tab.url);
      } else if (data.lb === "navigate") {
        const href = String(d.href ?? "");
        const abs = (() => {
          try {
            return new URL(href, tab.url).href;
          } catch {
            return href;
          }
        })();
        if (d.newTab) {
          props.newTab(abs);
        } else {
          load(tab, abs, { push: true });
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeId, settings, rules, dt]);

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
      fetchSuggestions(settings.engine, draft).then((list) => {
        if (cancelled) return;
        const items = list.map((text) => ({ text, url: searchUrl(settings, text) }));
        setTbSugg(items);
        setTbSuggOpen(items.length > 0);
        setTbSuggIdx(-1);
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
      fetchSuggestions(settings.engine, ntDraft).then((list) => {
        if (cancelled) return;
        const items = list.map((text) => ({ text, url: searchUrl(settings, text) }));
        setNtSugg(items);
        setNtSuggOpen(items.length > 0);
        setNtSuggIdx(-1);
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
        {/* Incognito toggle, pinned to the far right corner: inline
            domino-mask SVG (the ligature is missing from the
            self-hosted Material Symbols font). Toggling on suspends the
            normal session and opens one empty incognito tab (App.tsx);
            toggling off closes it and restores the session. */}
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
        <m3e-tooltip for="lb-incognito-pill" position="below">
          {props.incognito
            ? "Incognito on: history and session are not recorded. The proxy server still sees traffic."
            : "Turn on incognito: stops history and session recording."}
        </m3e-tooltip>
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
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
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
                engine {settings.proxyEngine} · route {routeUrl(settings, rules, errors[active.id].url)}
              </div>
              {[
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
                  aria-label="Search or URL"
                  placeholder="Search or URL"
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
            {/* Site info: a real M3E card (elevated) anchored above the
                lock glyph. Long cookie lists scroll inside the card. */}
            {siteInfoOpen && (
              <m3e-card variant="elevated" className="lb-site-card" aria-label="Site information">
                <div slot="header" className="lb-site-head">
                  <span
                    className={"lb-tb-lock " + (secure ? "secure" : "insecure")}
                    aria-hidden={true}
                    dangerouslySetInnerHTML={{ __html: secure ? lockSvg : noEncSvg }}
                  />
                  <span className="lb-site-ctitle">{secure ? "Https connection" : "Http connection, not secure"}</span>
                  <m3e-icon-button aria-label="Close site info" onClick={() => setSiteInfoOpen(false)}>
                    <m3e-icon name="close" aria-hidden={true} />
                  </m3e-icon-button>
                </div>
                <div slot="content" className="lb-site-body">
                  <div className="lb-site-row">
                    {uParts.scheme ? uParts.scheme + "://" + uParts.host + (uParts.port.includes("default") ? "" : ":" + uParts.port) : "No URL loaded"}
                  </div>
                  <div className="lb-site-ctitle">Site cookies ({siteCookies.length})</div>
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
                    <m3e-icon name="delete" aria-hidden={true} /> Clear site cookies
                  </m3e-button>
                  <m3e-button onClick={exportCookies}>
                    <m3e-icon name="download" aria-hidden={true} /> Export CSV
                  </m3e-button>
                </div>
              </m3e-card>
            )}
            {active.url && (
              <>
                <span
                  className="lb-tb-lock-wrap"
                  role="button"
                  tabIndex={0}
                  aria-label={secure ? "Https connection, site details" : "Not secure, site details"}
                  onClick={() => {
                    loadSiteCookies();
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
                placeholder="Search or URL"
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
        </m3e-toolbar>
        </div>
      </div>
    </section>
  );
}
