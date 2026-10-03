import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ENGINES, fetchSuggestions, looksLikeUrl, normalizeUrl, searchUrl, type Settings } from "../settings";
import { pushLog } from "../store";

type Props = {
  settings: Settings;
  history: string[];
  onNavigate: (target: string) => void;
};

type Suggestion = { icon: string; text: string; url: string; src?: string };

/* Suggestions: matching history entries, a direct URL when the input
   looks like one, and the search fallback. Rendered by the custom
   themed autocomplete (the m3e one never matched input or styling
   reliably). */
function buildSuggests(
  input: string,
  opts: { history: string[]; engineName: string; search: string; remote?: { text: string; src: string }[]; searchFor: (q: string) => string }
): Suggestion[] {
  const q = input.trim();
  if (!q) return [];
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (icon: string, text: string, url: string, src?: string) => {
    if (!seen.has(url) && out.length < 8) {
      seen.add(url);
      out.push({ icon, text, url, src });
    }
  };
  const ql = q.toLowerCase();
  for (const h of opts.history) {
    if (h.toLowerCase().includes(ql)) push("history", h, h);
  }
  if (looksLikeUrl(q)) push("language", q, normalizeUrl(q));
  for (const s of opts.remote ?? []) {
    push("search", s.text, opts.searchFor(s.text), s.src);
  }
  push("search", q + " · " + opts.engineName + " search", opts.search);
  return out;
}

export default function HomePage({ settings, history, onNavigate }: Props) {
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /* Engine-queried completions, fetched through the server's /suggest
     endpoint and merged below the local matches. */
  const [remote, setRemote] = useState<{ text: string; src: string }[]>([]);
  /* Suggest fetch in flight: shows the M3E loading indicator in the
     search bar so a slow engine is visibly working. */
  const [suggLoading, setSuggLoading] = useState(false);

  useEffect(() => {
    const q = url.trim();
    if (!q || q.length < 2 || looksLikeUrl(q) || !settings.suggestQueries) {
      setRemote([]);
      setSuggLoading(false);
      return;
    }
    const ac = new AbortController();
    setSuggLoading(true);
    const t = setTimeout(() => {
      fetchSuggestions(settings.engine, q, ac.signal).then((res) => {
        setRemote(res.items.map((text) => ({ text, src: res.source })));
        setSuggLoading(false);
        if (res.items.length === 0) {
          pushLog("warn", "home suggest: no suggestions for \"" + q + "\" (engine " + settings.engine + (res.source ? ", via " + res.source : "") + ")");
        }
      }).catch(() => setSuggLoading(false));
    }, 160);
    return () => {
      ac.abort();
      clearTimeout(t);
      setSuggLoading(false);
    };
  }, [url, settings.engine, settings.suggestQueries]);

  const suggestions = buildSuggests(url, {
    history,
    engineName: ENGINES[settings.engine].name,
    search: searchUrl(settings, url),
    remote,
    searchFor: (q: string) => searchUrl(settings, q),
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
      <m3e-heading variant="display" size="medium" level={2}>Never stop browsing</m3e-heading>
      <p className="lb-muted" style={{ marginTop: 8 }}>Browse the web through a private proxy.</p>

      <div className="lb-ac-wrap" style={{ margin: "32px auto 8px", maxWidth: 640, width: "100%" }}>
        <m3e-search-bar clearable>
          <m3e-icon name="travel_explore" slot="leading" aria-hidden={true} />
          <input
            slot="input"
            id="lb-search-input"
            ref={inputRef}
            aria-label={"Search with " + ENGINES[settings.engine].name + " or URL"}
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
            placeholder={"Search with " + ENGINES[settings.engine].name + " or URL"}
            autoComplete="off"
          />
        </m3e-search-bar>
        {suggLoading && (
          <span className="lb-sugg-load" aria-hidden={true}>
            <m3e-loading-indicator aria-label="Loading suggestions" />
          </span>
        )}
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
                {s.src && (
                  <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.65, flexShrink: 0 }}>via {s.src}</span>
                )}
              </button>
            ))}
            <div className="lb-ac-hint">Enter to open · Up/Down to browse · Esc to dismiss</div>
          </div>
        )}
      </div>

    </section>
  );
}
