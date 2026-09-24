/* The in-app proxy browser surface: tabs, bottom hover toolbar,
   same-origin proxied iframes and per-tab DevTools.

   Architecture: navigation goes through the server-side document proxy
   (/p). The fetched HTML is rendered in a same-origin blob iframe, so
   the tab keeps a live DOM (state preserved while switching tabs) and
   DevTools can reach the real page context. The server injects the
   devtools hook into every proxied document; link clicks and form
   submissions are captured and routed back through the proxy. */

import { useEffect, useRef, useState } from "react";
import { proxyUrl, type Settings, type SiteRule } from "../settings";
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

export default function BrowserView(props: Props) {
  const { settings, rules, tabs, activeId, bookmarks } = props;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const frames = useRef<Map<number, HTMLIFrameElement>>(new Map());
  const blobs = useRef<Map<number, string>>(new Map());
  const [status, setStatus] = useState<Record<number, { loading: boolean; error?: LoadError }>>({});
  const [dt, setDtState] = useState<Record<number, DtState>>({});
  const [pinned, setPinned] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const setDt = (id: number, patch: Partial<DtState>) => {
    setDtState((prev) => {
      const base = prev[id] ?? emptyDt();
      return { ...prev, [id]: { ...base, ...patch } };
    });
  };
  const dtOf = (id: number): DtState => dt[id] ?? emptyDt();

  /* ---- Navigation through the document proxy ---- */
  const load = (tab: Tab, url: string, opts?: { push?: boolean; method?: string; body?: string }) => {
    const push = opts?.push !== false;
    const method = opts?.method ?? "GET";
    const started = Date.now();
    setStatus((prev) => ({ ...prev, [tab.id]: { loading: true } }));
    const stack = push ? [...tab.stack.slice(0, tab.idx + 1), url] : tab.stack;
    const idx = push ? stack.length - 1 : tab.idx;
    props.updateTab(tab.id, { url, stack, idx, title: "" });

    const href = settings.proxySearch
      ? proxyUrl(settings, rules, url)
      : url;
    if (!settings.proxySearch) {
      /* Direct mode: hand the URL to the real browser. */
      setStatus((prev) => ({ ...prev, [tab.id]: { loading: false } }));
      window.open(url, "_blank", "noopener,noreferrer");
      pushLog("warn", "proxy disabled — opened " + url + " directly (user IP exposed)");
      return;
    }

    pushLog("info", method + " " + url + (opts?.body ? " (form body)" : ""));
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
        props.updateTab(tabId, { title });
        setStatus((prev) => ({ ...prev, [tabId as number]: { loading: false } }));
        if (tab.url) props.onHistory(tab.url);
        const w = frames.current.get(tabId)?.contentWindow;
        if (w) {
          for (const s of dtBase().scripts) {
            if (s.autorun) {
              try {
                w.eval(s.code);
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
      if (active) setDt(active.id, { open: !dtOf(active.id).open });
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
    <section className="lb-browser">
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
            <m3e-icon name="public" aria-hidden={true} />
            <span className="lb-tab-title">{t.title || t.url || "New tab"}</span>
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
            <iframe
              title={"Proxy tab " + t.id}
              ref={(el) => {
                if (el) frames.current.set(t.id, el);
                else frames.current.delete(t.id);
              }}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
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

        <div className="lb-watermark">LobsterBrowse</div>
      </div>

      {/* Bottom toolbar: mostly hidden, expands on hover, pinned stays open */}
      <div className={"lb-dock" + (pinned ? " pinned" : "")}>
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
            aria-label="View bookmarks"
            toggle
            selected={showBookmarks ? "" : undefined}
            onClick={() => setShowBookmarks(!showBookmarks)}
          >
            <m3e-icon name="bookmarks" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-icon-button
            aria-label="Pin toolbar"
            toggle
            selected={pinned ? "" : undefined}
            onClick={() => setPinned(!pinned)}
          >
            <m3e-icon name="push_pin" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-icon-button aria-label="New tab" onClick={() => props.newTab()}>
            <m3e-icon name="tab" aria-hidden={true} />
          </m3e-icon-button>
        </m3e-toolbar>
      </div>
    </section>
  );
}
