import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ENGINES, looksLikeUrl, normalizeUrl, searchUrl, type Settings } from "../settings";
import type { Bookmark } from "../store";

type Props = {
  settings: Settings;
  bookmarks: Bookmark[];
  history: string[];
  onNavigate: (target: string) => void;
  onOpenLogs: () => void;
};

type Suggestion = { icon: string; text: string; url: string };

/* Suggestions: matching bookmarks, history entries, a direct URL when
   the input looks like one, and the search fallback. Rendered by the
   custom themed autocomplete (the m3e one never matched input or
   styling reliably). */
function buildSuggests(
  input: string,
  opts: { history: string[]; bookmarks: Bookmark[]; engineName: string; search: string }
): Suggestion[] {
  const q = input.trim();
  if (!q) return [];
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (icon: string, text: string, url: string) => {
    if (!seen.has(url) && out.length < 8) {
      seen.add(url);
      out.push({ icon, text, url });
    }
  };
  const ql = q.toLowerCase();
  for (const b of opts.bookmarks) {
    if ((b.title || "").toLowerCase().includes(ql) || b.url.toLowerCase().includes(ql)) {
      push("star", b.title || b.url, b.url);
    }
  }
  for (const h of opts.history) {
    if (h.toLowerCase().includes(ql)) push("history", h, h);
  }
  if (looksLikeUrl(q)) push("language", q, normalizeUrl(q));
  push("search", q + " · " + opts.engineName + " search", opts.search);
  return out;
}

export default function HomePage({ settings, bookmarks, history, onNavigate, onOpenLogs }: Props) {
  const [url, setUrl] = useState("");
  const [health, setHealth] = useState("checking…");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* Health check: one probe with a hard timeout, a single retry, then a
     definite OK or error — never an endless "checking…". */
  useEffect(() => {
    let cancelled = false;
    let ok = false;
    const probe = () =>
      fetch("/healthz?_=" + Date.now(), { cache: "reload", signal: AbortSignal.timeout(4000) })
        .then((r) => {
          ok = r.ok;
          if (!cancelled) setHealth(r.ok ? "ok" : r.status + " error");
        })
        .catch(() => {
          ok = false;
          if (!cancelled) setHealth("connection failed");
        });
    probe().then(() => {
      if (!cancelled && !ok) setTimeout(probe, 2000);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const suggestions = buildSuggests(url, {
    history,
    bookmarks,
    engineName: ENGINES[settings.engine].name,
    search: searchUrl(settings, url),
  });

  const commit = (target: string) => {
    onNavigate(target);
    setUrl("");
    setOpen(false);
    setIdx(-1);
  };
  const go = (q0: string) => {
    const q = q0.trim();
    if (!q) return;
    commit(looksLikeUrl(q) ? normalizeUrl(q) : searchUrl(settings, q));
  };
  const pick = (s: Suggestion) => commit(s.url);

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (open && idx >= 0 && suggestions[idx]) pick(suggestions[idx]);
      else go(url);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setIdx((p) => Math.min(p + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((p) => Math.max(p - 1, -1));
    } else if (e.key === "Escape") {
      setOpen(false);
      setIdx(-1);
    }
  };

  return (
    <section className="lb-view-content lb-home">
      <m3e-heading variant="display" size="medium" level={2}>Browse freely</m3e-heading>
      <p className="lb-muted" style={{ marginTop: 8 }}>Private proxy with ad blocking.</p>

      <div className="lb-ac-wrap" style={{ margin: "32px 0 8px", maxWidth: 640 }}>
        <m3e-search-bar clearable>
          <m3e-icon name="travel_explore" slot="leading" aria-hidden={true} />
          <input
            slot="input"
            id="lb-search-input"
            ref={inputRef}
            aria-label="Search or URL"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setOpen(true);
              setIdx(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              setOpen(false);
              setIdx(-1);
            }}
            onKeyDown={onKey}
            placeholder="Search or URL"
            autoComplete="off"
          />
        </m3e-search-bar>
        {open && suggestions.length > 0 && (
          <div className="lb-ac" role="listbox" aria-label="Suggestions">
            {suggestions.map((s, i) => (
              <button
                key={s.url + i}
                type="button"
                className={"lb-ac-item" + (i === idx ? " active" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setIdx(i)}
              >
                <m3e-icon name={s.icon} aria-hidden={true} />
                <span className="lb-ac-text">{s.text}</span>
              </button>
            ))}
            <div className="lb-ac-hint">Enter to open · Up/Down to browse · Esc to dismiss</div>
          </div>
        )}
      </div>

      <p className="lb-muted" style={{ fontSize: 12, marginBottom: 24 }}>
        {settings.proxySearch
          ? "Loaded through this server inside the proxy browser."
          : "Opens directly in your browser"}
      </p>

      <p className="lb-curl" aria-live="polite">
        $ curl /healthz → {health}
        {health !== "ok" && (
          <>
            {" "}
            <m3e-button size="small" onClick={onOpenLogs}>
              <m3e-icon name="history" aria-hidden={true} /> View logs
            </m3e-button>
          </>
        )}
      </p>
    </section>
  );
}
