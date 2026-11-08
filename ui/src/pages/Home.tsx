import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ENGINES, fetchSuggestions, looksLikeUrl, normalizeUrl, searchUrl, type Settings } from "../settings";
import { pushLog } from "../store";
import { buildSuggests, SUGGEST_MIN_CHARS, type Suggestion } from "../suggest";
import { markFor } from "../engineMarks";
import DebugMenu from "./DebugMenu";

/* One suggest warning per engine: empty providers do not spam the log. */
const suggestWarned = new Set<string>();

type Props = {
  settings: Settings;
  onNavigate: (target: string) => void;
};

/* The row's leading icon (wave 77): the real brand mark of the
   engine the suggestion actually came from when we have one,
   otherwise the generic icon. */
function SugMark({ s }: { s: Suggestion }) {
  const mark = markFor(s.src);
  if (mark) {
    return (
      <svg className="lb-engine-mark" viewBox="0 0 24 24" aria-hidden={true}>
        <path d={mark} />
      </svg>
    );
  }
  return <m3e-icon name={s.icon} aria-hidden={true} />;
}

export default function HomePage({ settings, onNavigate }: Props) {
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /* The clear (X) button inside m3e-search-view empties the slotted
     input directly and fires a "clear" event; React's value tracker
     dedupes the synthetic input event, so the controlled state never
     learned the box was emptied (the X hid, the text stayed). Listen
     for the component's own clear event instead. */
  const viewRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const onClear = () => {
      setUrl("");
      setOpen(false);
      setIdx(-1);
    };
    view.addEventListener("clear", onClear);
    return () => view.removeEventListener("clear", onClear);
  }, []);
  /* Engine-queried completions, fetched through the server's /suggest
     endpoint. The request is gated on SUGGEST_MIN_CHARS: engines do
     not accept completion requests below it. */
  const [remote, setRemote] = useState<{ text: string; src: string }[]>([]);
  useEffect(() => {
    const q = url.trim();
    if (!q || q.length < SUGGEST_MIN_CHARS || looksLikeUrl(q) || !settings.suggestQueries) {
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
    engineName: ENGINES[settings.engine].name,
    search: searchUrl(settings, url),
    remote,
    searchFor: (q: string) => searchUrl(settings, q),
  });

  /* Panel visibility (wave 77): no row renders and the view's panel
     never opens until the query clears SUGGEST_MIN_CHARS
     (buildSuggests returns [] below it), and only while the input
     holds focus. The open attribute mirrors that onto the element;
     React cannot set attributes on unknown custom elements
     declaratively, so an effect does it after each render. */
  const menuOpen = open && suggestions.length > 0;
  /* Wave 78: the view also opens itself on plain input focus (and on
     the first keystroke) before any row exists; its beforetoggle is
     cancelable, so cancel the open whenever no suggestion would
     render. The panel then appears only once real rows exist. */
  const rowsRef = useRef(0);
  rowsRef.current = suggestions.length;
  useEffect(() => {
    const view = viewRef.current;
    if (view) view.toggleAttribute("open", menuOpen);
  }, [menuOpen]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const onBeforeToggle = (e: Event) => {
      if ((e as { newState?: string }).newState === "open" && rowsRef.current === 0) e.preventDefault();
    };
    view.addEventListener("beforetoggle", onBeforeToggle);
    return () => view.removeEventListener("beforetoggle", onBeforeToggle);
  }, []);

  /* Hidden debug menu (beta): five quick wordmark clicks open it. */
  const wordmarkClicks = useRef<number[]>([]);
  const [dbgOpen, setDbgOpen] = useState(false);
  const markWordmark = () => {
    const now = Date.now();
    const recent = wordmarkClicks.current.filter((t) => now - t < 2000);
    recent.push(now);
    wordmarkClicks.current = recent;
    if (recent.length >= 5) {
      wordmarkClicks.current = [];
      setDbgOpen(true);
    }
  };

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
        className="lb-ascii"
        aria-label="LobsterBrowse"
        onClick={markWordmark}
        /* #85: the wordmark font-size lives in theme.css (viewport-clamped) so the art scales down on narrow screens. */
        style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: 1.05, margin: "0 0 4px", opacity: 0.85, overflowX: "auto", whiteSpace: "pre" }}
      >{String.raw`    __          __         __            ____                             
   / /   ____  / /_  _____/ /____  _____/ __ )_________ _      __________ 
  / /   / __ \/ __ \/ ___/ __/ _ \/ ___/ __  / ___/ __ \ | /| / / ___/ _ \
 / /___/ /_/ / /_/ (__  ) /_/  __/ /  / /_/ / /  / /_/ / |/ |/ (__  )  __/
/_____/\____/_.___/____/\__/\___/_/  /_____/_/   \____/|__/|__/____/\___/ 
                                                                           `}</pre>
      <DebugMenu open={dbgOpen} onClose={() => setDbgOpen(false)} settings={settings} />
      <div className="lb-ac-wrap" style={{ margin: "32px auto 8px", maxWidth: 640, width: "100%" }}>
        <m3e-search-view mode="docked" contained {...{ ref: viewRef }}>
          {/* Wave 78: one icon only. The view ships its own default
              magnifier in the leading area; overriding the search-icon
              slot replaces it, and the old duplicated leading slots
              (closed + open) showed two icons in the closed state. */}
          <m3e-icon name="travel_explore" slot="search-icon" aria-hidden={true} />
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
          {menuOpen && (
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
                  <SugMark s={s} />
                  <span className="lb-ac-text">{s.text}</span>
                </button>
              ))}
            </div>
          )}
        </m3e-search-view>
      </div>
    </section>
  );
}
