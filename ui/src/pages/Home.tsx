import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ENGINES, fetchSuggestions, looksLikeUrl, normalizeUrl, searchUrl, type Settings } from "../settings";
import { pushLog } from "../store";

/* One suggest warning per engine: empty providers do not spam the log. */
const suggestWarned = new Set<string>();

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
  /* Rank engine suggestions by relevance to the query: prefix hits
     first, then substring matches, then word-start matches, then
     the rest - the most probable completions lead the list. */
  const rel = (t: string): number => {
    const tl = t.toLowerCase();
    if (tl.startsWith(ql)) return 0;
    if (tl.includes(ql)) return 1;
    if (tl.includes(" " + ql)) return 2;
    return 3;
  };
  for (const s of [...(opts.remote ?? [])].sort((a, b) => rel(a.text) - rel(b.text))) {
    push("search", s.text, opts.searchFor(s.text), s.src);
  }
  push("search", q + " · " + opts.engineName + " search", opts.search);
  return out;
}

/* Damped-spring animation for the suggestion card (real spring
   physics: stiffness 170 / damping 22 integrated per frame - CSS
   easings are not springs). The card slides down out of the search
   bar on open and springs back before it unmounts. */
function useSpringCard(open: boolean): { visible: boolean; progress: number } {
  const [state, setState] = useState({ visible: false, progress: 0 });
  const s = useRef({ x: 0, v: 0 });
  useEffect(() => {
    if (open && !state.visible) setState({ visible: true, progress: s.current.x });
    if (!open && state.visible && s.current.x <= 0.01) setState({ visible: false, progress: 0 });
    let raf = 0;
    let last = 0;
    const target = open ? 1 : 0;
    const step = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
      last = now;
      const a = 170 * (target - s.current.x) - 22 * s.current.v;
      s.current.v += a * dt;
      s.current.x += s.current.v * dt;
      if (!open && s.current.x < 0.01 && s.current.v < 0.05) {
        s.current = { x: 0, v: 0 };
        setState({ visible: false, progress: 0 });
        return;
      }
      if (open && s.current.x > 0.999 && Math.abs(s.current.v) < 0.01) {
        s.current = { x: 1, v: 0 };
        setState({ visible: true, progress: 1 });
        return;
      }
      setState({ visible: true, progress: s.current.x });
      raf = requestAnimationFrame(step);
    };
    if (state.visible || open) raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [open]);
  return state;
}

export default function HomePage({ settings, history, onNavigate }: Props) {
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /* Engine-queried completions, fetched through the server's /suggest
     endpoint and merged below the local matches. */
  const [remote, setRemote] = useState<{ text: string; src: string }[]>([]);
  useEffect(() => {
    const q = url.trim();
    if (!q || q.length < 2 || looksLikeUrl(q) || !settings.suggestQueries) {
      setRemote([]);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      fetchSuggestions(settings.engine, q, ac.signal).then((res) => {
        setRemote(res.items.map((text) => ({ text, src: res.source })));
        if (res.items.length === 0 && !suggestWarned.has(settings.engine)) {
          suggestWarned.add(settings.engine);
          pushLog("warn", "home suggest: no suggestions (engine " + settings.engine + (res.source ? ", via " + res.source : "") + ") - further warnings for this engine suppressed");
        }
      }).catch(() => {
        /* a failed suggest fetch keeps the previous list */
      });
    }, 160);
    return () => {
      ac.abort();
      clearTimeout(t);
    };
  }, [url, settings.engine, settings.suggestQueries]);

  const suggestions = buildSuggests(url, {
    history,
    engineName: ENGINES[settings.engine].name,
    search: searchUrl(settings, url),
    remote,
    searchFor: (q: string) => searchUrl(settings, q),
  });

  /* The card springs in and out; while it animates out, clicks pass
     through (pointerEvents gated on progress below). */
  const spring = useSpringCard(open && suggestions.length > 0);

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
      <pre
        aria-label="LobsterBrowse"
        style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, lineHeight: 1.05, margin: "0 0 4px", opacity: 0.85, overflowX: "auto", whiteSpace: "pre" }}
      >{String.raw`    __          __         __            ____                             
   / /   ____  / /_  _____/ /____  _____/ __ )_________ _      __________ 
  / /   / __ \/ __ \/ ___/ __/ _ \/ ___/ __  / ___/ __ \ | /| / / ___/ _ \
 / /___/ /_/ / /_/ (__  ) /_/  __/ /  / /_/ / /  / /_/ / |/ |/ (__  )  __/
/_____/\____/_.___/____/\__/\___/_/  /_____/_/   \____/|__/|__/____/\___/ 
                                                                           `}</pre>
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
        {spring.visible && suggestions.length > 0 && (
          <div
            className="lb-ac"
            role="listbox"
            aria-label="Suggestions"
            style={{
              opacity: spring.progress,
              transform: "translateY(" + (1 - spring.progress) * -10 + "px)",
              pointerEvents: spring.progress > 0.5 ? "auto" : "none",
            }}
          >
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
