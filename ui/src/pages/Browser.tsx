/* The in-app proxy browser surface: tabs, bottom hover toolbar,
   proxied iframes and per-tab DevTools.

   Two proxy engines (settings.proxyEngine):
   - "scramjet": the tab renders the Scramjet client (full rewriting
     proxy, separate origin). Real sites work. Cross-origin frames
     cannot expose their console to DevTools, so per-tab meta info
     (title, favicon) and a META network entry are fetched via /p.
   - "document": navigation goes through the server-side document proxy
     (/p). Same-origin blob iframe with an injected devtools hook, so
     full in-page DevTools work. No URL rewriting — JS-heavy sites break.

   Tabs that receive a URL without an explicit navigation (Home search,
   restored sessions) auto-load when they become active. */

import { useEffect, useRef, useState } from "react";
import { proxyUrl, scramjetUrl, type Settings, type SiteRule } from "../settings";
import { pushLog, type Bookmark, type Tab } from "../store";
import DevTools, { emptyDt, nextEntryId, type DtState } from "./DevTools";

type View = "home" | "browser" | "settings" | "logs";

type LoadError = {
  url: string;
  status: number;
  detail: string;
  ts: number;
};

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
  const blobs = useRef<Map<number, string>>(new Map());
  /* Last URL each tab was asked to load — guards the auto-load effect
     against double navigation. */
  const lastNav = useRef<Map<number, string>>(new Map());
  const [status, setStatus] = useState<Record<number, { loading: boolean; error?: LoadError }>>({});
  const [dt, setDtState] = useState<Record<number, DtState>>({});
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  /* Real favicon per tab (blob URL, fetched through /p). */
  const [icons, setIcons] = useState<Record<number, string>>({});

  /* Dock: fully visible at first load, then smoothly shrinks and tucks
     mostly out of view; hover or focus brings it back. */
  const [dockSettled, setDockSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDockSettled(true), 1500);
    return () => clearTimeout(t);
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

  /* ---- Tab meta: real title + favicon, fetched server-side via /p so
     the user's IP is never exposed. Works in both engines. ---- */
  const fetchMeta = (tabId: number, url: string) => {
    if (!settings.proxySearch) return;
    const started = Date.now();
    fetch(proxyUrl(settings, rules, url))
      .then(async (res) => {
        addNet(tabId, { url, method: "META", status: res.status, ok: res.ok, dur: Date.now() - started });
        const ct = res.headers.get("content-type") ?? "";
        if (!res.ok || !ct.includes("html")) return;
        const html = await res.text();
        const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = tm ? tm[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() : "";
        if (title) props.updateTab(tabId, { title });
        let iconHref = "";
        for (const l of html.match(/<link[^>]+>/gi) ?? []) {
          if (/rel=["'][^"']*icon/i.test(l)) {
            const h = l.match(/href=["']([^"']+)["']/i);
            if (h) {
              iconHref = h[1];
              break;
            }
          }
        }
        let abs = "";
        try {
          abs = new URL(iconHref || "/favicon.ico", url).href;
        } catch {
          return;
        }
        const r2 = await fetch(proxyUrl(settings, rules, abs)).catch(() => null);
        if (!r2 || !r2.ok) return;
        const blob = await r2.blob();
        if (blob.size === 0 || blob.size > 400000) return;
        if (!blob.type.startsWith("image/") && !blob.type.includes("octet-stream")) return;
        setIcons((prev) => {
          const old = prev[tabId];
          if (old) URL.revokeObjectURL(old);
          return { ...prev, [tabId]: URL.createObjectURL(blob) };
        });
      })
      .catch(() => {});
  };

  /* ---- Navigation ---- */
  const load = (tab: Tab, url: string, opts?: { push?: boolean; method?: string; body?: string }) => {
    const push = opts?.push !== false;
    const method = opts?.method ?? "GET";
    lastNav.current.set(tab.id, url);
    const stack = push ? [...tab.stack.slice(0, tab.idx + 1), url] : tab.stack;
    const idx = push ? stack.length - 1 : tab.idx;
    props.updateTab(tab.id, { url, stack, idx, title: "" });

    if (!settings.proxySearch) {
      /* Direct mode: hand the URL to the real browser. */
      setStatus((prev) => ({ ...prev, [tab.id]: { loading: false } }));
      window.open(url, "_blank", "noopener,noreferrer");
      pushLog("warn", "proxy disabled — opened " + url + " directly (user IP exposed)");
      return;
    }

    fetchMeta(tab.id, url);

    if (settings.proxyEngine === "scramjet") {
      /* Full rewriting proxy: point the tab's iframe at the Scramjet
         client, which auto-navigates to the target. */
      const old = blobs.current.get(tab.id);
      if (old) {
        URL.revokeObjectURL(old);
        blobs.current.delete(tab.id);
      }
      setStatus((prev) => ({ ...prev, [tab.id]: { loading: false, error: undefined } }));
      const frame = frames.current.get(tab.id);
      const href = scramjetUrl(settings, url);
      if (frame) frame.src = href;
      pushLog("info", "scramjet nav " + url);
      return;
    }

    /* Document engine: fetch through /p and render in a blob iframe. */
    const started = Date.now();
    setStatus((prev) => ({ ...prev, [tab.id]: { loading: true } }));
    pushLog("info", method + " " + url + (opts?.body ? " (form body)" : ""));
    const href = proxyUrl(settings, rules, url);
    fetch(href, {
      method,
      body: opts?.body,
      headers: opts?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
    })
      .then(async (res) => {
        const ct = res.headers.get("content-type") ?? "";
        if (!res.ok && ct.includes("application/json")) {
          const data = (await res.json().catch(() => ({}))) as { detail?: string };
          setStatus((prev) => ({
            ...prev,
            [tab.id]: {
              loading: false,
              error: { url, status: res.status, detail: data.detail ?? "proxy fetch failed", ts: Date.now() },
            },
          }));
          pushLog("error", "proxy " + url + " → " + res.status + ": " + (data.detail ?? "failed"));
          return;
        }
        const html = await res.text();
        const blob = new Blob([html], { type: "text/html" });
        const blobUrl = URL.createObjectURL(blob);
        const old = blobs.current.get(tab.id);
        blobs.current.set(tab.id, blobUrl);
        if (old) URL.revokeObjectURL(old);
        setStatus((prev) => ({ ...prev, [tab.id]: { loading: false, error: undefined } }));
        pushLog("info", "proxy done " + url + " → " + res.status + " (" + (Date.now() - started) + " ms)");
        const frame = frames.current.get(tab.id);
        if (frame) frame.src = blobUrl;
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        setStatus((prev) => ({
          ...prev,
          [tab.id]: { loading: false, error: { url, status: 0, detail, ts: Date.now() } },
        }));
        pushLog("error", "proxy " + url + " → network error: " + detail);
      });
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

  /* ---- Hook messages from proxied pages (document engine) ---- */
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
        props.updateTab(tabId, { title });
        setStatus((prev) => ({ ...prev, [tabId as number]: { loading: false } }));
        if (tab.url) props.onHistory(tab.url);
        const w = frames.current.get(tabId)?.contentWindow;
        if (w) {
          for (const s of dtBase().scripts) {
            if (s.autorun) {
              try {
                (w as unknown as { eval: (c: string) => unknown }).eval(s.code);
              } catch (err) {
                pushLog("error", "autorun script failed: " + (err instanceof Error ? err.message : String(err)));
              }
            }
          }
        }
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
      } else if (data.lb === "submit") {
        const action = String(d.action ?? tab.url);
        const abs = (() => {
          try {
            return new URL(action, tab.url).href;
          } catch {
            return action;
          }
        })();
        const method = String(d.method ?? "GET").toUpperCase();
        const body = String(d.body ?? "");
        if (method === "GET") {
          load(tab, abs + (abs.includes("?") ? "&" : "?") + body, { push: true });
        } else {
          load(tab, abs, { push: true, method: "POST", body });
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeId, settings, rules, dt]);

  /* ---- Shortcuts from the app shell ---- */
  useEffect(() => {
    const reload = () => {
      if (active) load(active, active.url || "", { push: false });
    };
    const toggleDt = () => {
      if (!active) return;
      const id = active.id;
      setDtState((prev) => {
        const base = prev[id] ?? emptyDt();
        if (!base.open && settings.proxyEngine === "scramjet") {
          return {
            ...prev,
            [id]: {
              ...base,
              open: true,
              console: [
                ...base.console,
                {
                  id: nextEntryId(),
                  kind: "info",
                  text: "Scramjet engine: the page frame is cross-origin, so in-page console/network capture is unavailable here. Switch the proxy engine to Document fetch for full DevTools. META entries show server-side fetches for tab info.",
                  ts: Date.now(),
                },
              ],
            },
          };
        }
        return { ...prev, [id]: { ...base, open: !base.open } };
      });
    };
    window.addEventListener("lb-reload", reload);
    window.addEventListener("lb-devtools", toggleDt);
    return () => {
      window.removeEventListener("lb-reload", reload);
      window.removeEventListener("lb-devtools", toggleDt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeId, settings, rules, dt]);

  if (!active) {
    return (
      <section className="lb-view-content" style={{ textAlign: "center" }}>
        <m3e-heading variant="title" size="medium" level={2}>No tabs open</m3e-heading>
        <m3e-button variant="filled" onClick={() => props.newTab()}>
          <m3e-icon name="add" aria-hidden={true} /> New tab
        </m3e-button>
      </section>
    );
  }

  const st = status[active.id] ?? { loading: false };
  const activeDt = dtOf(active.id);
  const draft = drafts[active.id] ?? active.url;
  const go = (value: string) => {
    const q = value.trim();
    if (!q) return;
    load(active, q.startsWith("http://") || q.startsWith("https://") ? q : "https://" + q, { push: true });
    setDrafts((prev) => ({ ...prev, [active.id]: "" }));
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
      className="lb-browser"
      ref={(el) => {
        rootRef.current = el as HTMLElement | null;
      }}
    >
      {/* Tab strip */}
      <div className="lb-tabstrip" role="tablist" aria-label="Proxy tabs">
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
      </div>

      {/* Content area: one iframe per tab, inactive ones stay mounted */}
      <div className="lb-pages">
        {tabs.map((t) => (
          <div key={t.id} className={"lb-page" + (t.id === active.id ? " active" : "")}>
            {/* sandbox only in document mode (the same-origin blob needs it).
                Scramjet frames must NOT be sandboxed: their service worker
                and crossOriginIsolated (COEP) setup break under sandbox. */}
            <iframe
              title={"Proxy tab " + t.id}
              ref={(el) => {
                if (el) frames.current.set(t.id, el);
                else frames.current.delete(t.id);
              }}
              sandbox={
                settings.proxyEngine === "document"
                  ? "allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
                  : undefined
              }
            />
          </div>
        ))}

        {st.loading && (
          <div className="lb-loading" aria-busy="true">
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
          <div className="lb-empty-tab">
            <m3e-icon name="travel_explore" aria-hidden={true} />
            <p>Type a URL in the toolbar below, or search from Home.</p>
          </div>
        )}

        {st.error && (
          <div className="lb-error-page" role="alert">
            <m3e-card variant="filled">
              <span slot="header">
                <m3e-icon name="error" aria-hidden={true} /> LobsterBrowse couldn't load this page
              </span>
              <div slot="content" className="lb-error-detail">
                <div><b>URL:</b> {st.error.url}</div>
                <div><b>Engine:</b> document-fetch proxy</div>
                <div><b>Status:</b> {st.error.status === 0 ? "connection failed" : st.error.status}</div>
                <div><b>Error:</b> {st.error.detail}</div>
                <div><b>Time:</b> {new Date(st.error.ts).toLocaleString()}</div>
                <div className="lb-muted">Tab #{active.id}</div>
              </div>
              <div slot="actions" className="lb-error-actions">
                <m3e-button variant="filled" onClick={() => load(active, st.error!.url, { push: false })}>
                  <m3e-icon name="refresh" aria-hidden={true} /> Retry
                </m3e-button>
                <m3e-button onClick={() => setDt(active.id, { open: true })}>
                  <m3e-icon name="bug_report" aria-hidden={true} /> Open Dev Tools
                </m3e-button>
                <m3e-button onClick={props.onOpenLogs}>
                  <m3e-icon name="history" aria-hidden={true} /> View logs
                </m3e-button>
              </div>
            </m3e-card>
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

      {/* Bottom dock: fully visible on first load, then smoothly shrinks
          and tucks mostly out of view. Hover or focus expands it. */}
      <div className={"lb-dock" + (dockSettled ? " settled" : "")}>
        <m3e-toolbar variant="vibrant" shape="rounded" elevated className="lb-toolbar">
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
          <input
            className="lb-url-input"
            aria-label="URL or search"
            placeholder="Search or URL"
            value={draft}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [active.id]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(draft);
            }}
          />
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
    </section>
  );
}
