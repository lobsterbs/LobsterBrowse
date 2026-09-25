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
import { pushLog, type Bookmark, type Tab } from "../store";
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
  bookmarks: Bookmark[];
  onToggleBookmark: (url: string, title: string) => void;
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
  const { settings, rules, tabs, activeId, bookmarks } = props;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const frames = useRef<Map<number, HTMLIFrameElement>>(new Map());
  /* Last URL each tab was asked to load — guards the auto-load effect
     against double navigation. */
  const lastNav = useRef<Map<number, string>>(new Map());
  const [status, setStatus] = useState<Record<number, { loading: boolean }>>({});
  const [dt, setDtState] = useState<Record<number, DtState>>({});
  const [showBookmarks, setShowBookmarks] = useState(false);
  /* Per-tab URL bar drafts; when empty the bar shows the real URL. */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  /* Toolbar autocomplete: engine-queried suggestions, debounced. */
  const [tbSugg, setTbSugg] = useState<{ text: string; url: string }[]>([]);
  const [tbSuggOpen, setTbSuggOpen] = useState(false);
  const [tbSuggIdx, setTbSuggIdx] = useState(-1);
  /* Center pill: collapsed shows the tab name; pressed, it expands in
     place into the editable URL (the name hides). */
  const [tbExpanded, setTbExpanded] = useState(false);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  /* Real favicon per tab (blob URL fetched through the engine). */
  const [icons, setIcons] = useState<Record<number, string>>({});
  const iconCache = useRef<Map<string, string>>(new Map());
  /* Frame documents that already have LobsterJet prefetch listeners. */
  const wiredDocs = useRef<WeakSet<Document>>(new WeakSet());

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

    if (!settings.proxySearch) {
      /* Direct mode: hand the URL to the real browser. */
      setStatus((prev) => ({ ...prev, [tab.id]: { loading: false } }));
      window.open(url, "_blank", "noopener,noreferrer");
      pushLog("warn", "proxy disabled — opened " + url + " directly (user IP exposed)");
      return;
    }

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
        pushLog("error", "load failed: " + (errMeta.content || "unknown error"));
        return;
      }
      if (!path.startsWith("/r/") && !path.startsWith("/lj/")) return;
      const real = decodeRoute(path);
      if (!real) return;
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
      /* LobsterJet prefetch: hovering (or keyboard-focusing) a link in
         the proxied page warms the worker cache before the click. */
      if (!wiredDocs.current.has(doc)) {
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
  }, [active?.id, tabs, settings, rules]);

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
    if (!q) {
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
  const bookmarked = bookmarks.some((b) => b.url === active.url);

  return (
    <section
      className={"lb-browser" + (props.incognito ? " incognito" : "")}
      ref={(el) => {
        rootRef.current = el as HTMLElement | null;
      }}
    >
      {/* Frosted floating tab strip: sits over the page content. Shares
          the dock's tucked state: after the idle timer it slides up
          leaving a sliver and collapses to the single active tab. */}
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
            className={"lb-tab" + (t.id === active.id ? " active" : "")}
            onClick={() => props.setActiveId(t.id)}
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
                props.closeTab(t.id);
              }}
            />
          </div>
        ))}
        <m3e-icon-button aria-label="New tab" onClick={() => props.newTab()}>
          <m3e-icon name="add" aria-hidden={true} />
        </m3e-icon-button>
        {/* Incognito mode indicator, pinned to the far right corner.
            A labeled pill, not an icon: the "incognito" glyph does not
            exist in the self-hosted Material Symbols build, so any icon
            here would render as raw ligature text. Text is unambiguous. */}
        <button
          type="button"
          id="lb-incognito-pill"
          className={"lb-incognito" + (props.incognito ? " on" : "")}
          aria-pressed={props.incognito}
          onClick={() => props.onIncognitoChange(!props.incognito)}
        >
          {props.incognito ? "Incognito on" : "Incognito"}
        </button>
        <m3e-tooltip for="lb-incognito-pill" position="below">
          {props.incognito
            ? "Incognito on: history and session are not recorded. The proxy server still sees traffic."
            : "Turn on incognito: stops history and session recording."}
        </m3e-tooltip>
      </div>

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

        {!active.url && !st.loading && (
          <div className="lb-newtab">
            <m3e-heading variant="title" size="medium" level={2}>New tab</m3e-heading>
            <m3e-search-bar clearable className="lb-newtab-search">
              <m3e-icon name="travel_explore" slot="leading" aria-hidden={true} />
              <input
                slot="input"
                aria-label="Search or URL"
                placeholder="Search or URL"
                autoComplete="off"
                onKeyDown={(e) => {
                  if (e.key === "Enter") go((e.target as HTMLInputElement).value);
                }}
                onChange={(e) => {
                  /* Smooth expansion tracks typed content, not just focus. */
                  const bar = (e.target as HTMLElement).closest(".lb-newtab-search");
                  bar?.classList.toggle("filled", !!(e.target as HTMLInputElement).value);
                }}
              />
            </m3e-search-bar>
            {bookmarks.length > 0 && (
              <div className="lb-newtab-links">
                {bookmarks.slice(0, 6).map((b) => (
                  <m3e-button key={b.url} variant="tonal" size="small" onClick={() => load(active, b.url, { push: true })}>
                    <m3e-icon name="star" aria-hidden={true} /> {b.title || b.url}
                  </m3e-button>
                ))}
              </div>
            )}
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

        {showBookmarks && (
          <div className="lb-bookmark-panel">
            <div className="lb-devtools-head">
              <span className="lb-devtools-title">
                <m3e-icon name="bookmarks" aria-hidden={true} /> Bookmarks
              </span>
              <m3e-icon-button aria-label="Close bookmarks" onClick={() => setShowBookmarks(false)}>
                <m3e-icon name="close" aria-hidden={true} />
              </m3e-icon-button>
            </div>
            {bookmarks.length === 0 && <p className="lb-muted">No bookmarks yet.</p>}
            {bookmarks.map((b) => (
              <div key={b.url} className="lb-bookmark-row">
                <button className="lb-bookmark-link" onClick={() => load(active, b.url, { push: true })}>
                  {b.title || b.url}
                </button>
                <m3e-icon-button
                  aria-label="Remove bookmark"
                  onClick={() => props.onToggleBookmark(b.url, b.title)}
                >
                  <m3e-icon name="delete" aria-hidden={true} />
                </m3e-icon-button>
              </div>
            ))}
          </div>
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
                  className="lb-tb-lock"
                  role="img"
                  aria-label={active.url.startsWith("https://") ? "Secure connection" : "Not secure"}
                  dangerouslySetInnerHTML={{ __html: active.url.startsWith("https://") ? lockSvg : noEncSvg }}
                />
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
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark this page"}
            toggle
            selected={bookmarked ? "" : undefined}
            onClick={() => props.onToggleBookmark(active.url, active.title)}
          >
            <m3e-icon name="star" aria-hidden={true} />
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
