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
  const acRef = useRef<HTMLElement | null>(null);
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

  /* Grab the autocomplete element once it is mounted. */
  useEffect(() => {
    acRef.current = document.querySelector<HTMLElement>("m3e-autocomplete[for='lb-search-input']");
  }, []);

  /* Populate the autocomplete with suggestions imperatively — the M3E
     component owns its slotted options, so React must not re-render them. */
  useEffect(() => {
    const ac = acRef.current;
    if (!ac) return;
    const suggestions = buildSuggestions(url, {
      history,
      bookmarks,
      engineName: ENGINES[settings.engine].name,
    });
    while (ac.firstChild) ac.removeChild(ac.firstChild);
    for (const s of suggestions) {
      const opt = document.createElement("m3e-option");
      opt.textContent = s;
      ac.appendChild(opt);
    }
    (ac as unknown as { hideNoData: boolean }).hideNoData = suggestions.length === 0;
  }, [url, history, bookmarks, settings.engine]);

  /* When an option is selected, commit it as the search target. */
  useEffect(() => {
    const ac = acRef.current;
    if (!ac) return;
    const onChange = () => {
      const v = inputRef.current?.value ?? "";
      if (v) go(v);
    };
    ac.addEventListener("change", onChange);
    return () => ac.removeEventListener("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const go = (q0: string) => {
    const q = q0.trim();
    if (!q) return;
    onNavigate(looksLikeUrl(q) ? normalizeUrl(q) : searchUrl(settings, q));
    setUrl("");
  };

  return (
    <section className="lb-view-content lb-home">
      <m3e-heading variant="display" size="medium" level={2}>Browse freely</m3e-heading>
      <p className="lb-muted" style={{ marginTop: 8 }}>Private proxy with ad blocking.</p>

      <div style={{ margin: "32px 0 8px", maxWidth: 640 }}>
        <m3e-search-bar clearable>
          <m3e-icon name="travel_explore" slot="leading" aria-hidden={true} />
          <input
            slot="input"
            id="lb-search-input"
            ref={inputRef}
            aria-label="Search or URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(url);
            }}
            placeholder="Search or URL"
          />
        </m3e-search-bar>
        <m3e-autocomplete
          for="lb-search-input"
          filter="none"
          hide-no-data={true}
          aria-label="Search suggestions"
        />
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
