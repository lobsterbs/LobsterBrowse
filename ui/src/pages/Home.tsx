import { useEffect, useRef, useState } from "react";
import { ENGINES, looksLikeUrl, normalizeUrl, searchUrl, type Settings } from "../settings";
import { buildSuggestions, type Bookmark } from "../store";

type Props = {
  settings: Settings;
  bookmarks: Bookmark[];
  history: string[];
  onNavigate: (target: string) => void;
  onOpenLogs: () => void;
};

export default function HomePage({ settings, bookmarks, history, onNavigate, onOpenLogs }: Props) {
  const [url, setUrl] = useState("");
  const [health, setHealth] = useState("checking…");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [acIndex, setAcIndex] = useState(-1);
  const [acOpen, setAcOpen] = useState(false);

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

  const suggestions = url.trim() ? buildSuggestions(url, { history, bookmarks, engineName: ENGINES[settings.engine].name }) : [];

  const go = (q0: string) => {
    const q = q0.trim();
    if (!q) return;
    onNavigate(looksLikeUrl(q) ? normalizeUrl(q) : searchUrl(settings, q));
    setUrl("");
    setAcOpen(false);
    setAcIndex(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!acOpen || suggestions.length === 0) {
      if (e.key === "Enter") go(url);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAcIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAcIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(acIndex >= 0 ? suggestions[acIndex] : url);
    } else if (e.key === "Escape") {
      setAcOpen(false);
      setAcIndex(-1);
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
            autoComplete="off"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setAcOpen(true);
              setAcIndex(-1);
            }}
            onFocus={() => setAcOpen(true)}
            onBlur={() => {
              /* small delay so option mousedown can fire first */
              setTimeout(() => setAcOpen(false), 120);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search or URL"
          />
        </m3e-search-bar>

        {acOpen && suggestions.length > 0 && (
          <div className="lb-ac" role="listbox" aria-label="Search suggestions">
            {suggestions.map((s, i) => (
              <button
                key={s}
                type="button"
                role="option"
                aria-selected={i === acIndex}
                className={"lb-ac-item" + (i === acIndex ? " active" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(s);
                }}
                onMouseEnter={() => setAcIndex(i)}
              >
                <m3e-icon name={bookmarks.some((b) => b.url === s) ? "star" : "history"} aria-hidden={true} />
                <span className="lb-ac-text">{s}</span>
              </button>
            ))}
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
