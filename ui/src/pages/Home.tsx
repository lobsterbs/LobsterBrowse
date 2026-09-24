import { useEffect, useState } from 'react';
import { ENGINES, type EngineId, type Settings } from '../settings';

type Props = { settings: Settings; onEngineChange: (e: EngineId) => void };

/* Heuristic: a URL has a scheme, or looks like a bare domain/host
   (contains a dot, no spaces). Everything else is a search query. */
function looksLikeUrl(s: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s)) return true;
  return /^[^\s]+\.[^\s]{2,}$/.test(s) && !s.includes(" ");
}

export default function HomePage({ settings, onEngineChange }: Props) {
  const [url, setUrl] = useState("");
  const [health, setHealth] = useState<string>("checking…");

  useEffect(() => {
    // Simple curl-style probe: GET /healthz, print the HTTP status.
    // Retries quietly so a transient failure never sticks.
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      fetch("/healthz?_=" + Date.now(), { cache: "reload" })
        .then((r) => { if (!cancelled) setHealth("200 ok — server online"); return r.text(); })
        .catch(() => "err")
        .then(() => {
          if (cancelled) return;
          attempt++;
          timer = setTimeout(check, attempt < 2 ? 2000 : attempt < 4 ? 5000 : 15000);
        });
    };
    check();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  const go = (engineId?: EngineId) => {
    const q = url.trim();
    if (!q) return;
    if (!looksLikeUrl(q)) {
      const id = engineId || settings.engine;
      const target = ENGINES[id].url.replace("{q}", encodeURIComponent(q));
      if (settings.openSearchNewTab) {
        window.open(target, "_blank", "noopener,noreferrer");
      } else {
        window.location.href = target;
      }
      return;
    }
    (globalThis as any).M3eSnackbar?.open(
      "Browsing arrives with the Wisp client — the relay server is live.",
      true
    );
  };

  const searchButtons = (Object.keys(ENGINES) as EngineId[]).slice(0, 3);

  return (
    <section style={{ textAlign: "center", marginTop: 16 }}>
      <m3e-heading variant="display" size="medium" level={2}>Browse freely</m3e-heading>
      <p style={{ opacity: 0.7, marginTop: 8 }}>Private proxy with ad blocking.</p>

      <div style={{ margin: "32px 0 16px" }}>
        <m3e-search-bar clearable>
          <m3e-icon name="travel_explore" slot="leading" aria-hidden={true} />
          <input
            slot="input"
            id="url"
            aria-label="URL or search query"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") go(); }}
            placeholder={"Search " + ENGINES[settings.engine].name + " or enter a URL"}
          />
          <m3e-button slot="trailing" variant="filled" onClick={() => go()}>Go</m3e-button>
        </m3e-search-bar>
      </div>

      {/* Search buttons: quick engine one-tap search, plus per-engine actions */}
      <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginBottom: 24, flexWrap: "wrap" }}>
        <m3e-segmented-button aria-label="Search engine">
          {searchButtons.map((id) => (
            <m3e-button-segment
              key={id}
              checked={settings.engine === id ? "" : undefined}
              onClick={() => onEngineChange(id)}
            >
              {ENGINES[id].name}
            </m3e-button-segment>
          ))}
        </m3e-segmented-button>
        <m3e-button variant="tonal" onClick={() => go("brave")}>Brave</m3e-button>
        <m3e-button variant="tonal" onClick={() => go("duckduckgo")}>DuckDuckGo</m3e-button>
        <m3e-button variant="tonal" onClick={() => go("startpage")}>Startpage</m3e-button>
      </div>

      {/* Simple curl-style status line */}
      <p style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, opacity: 0.6, marginBottom: 40 }}>
        $ curl /healthz → {health}
      </p>

      <m3e-chip-set aria-label="Features">
        <m3e-chip><m3e-icon slot="icon" name="visibility_off" aria-hidden={true} />No logs</m3e-chip>
        <m3e-chip><m3e-icon slot="icon" name="shield" aria-hidden={true} />Ad blocking</m3e-chip>
        <m3e-chip><m3e-icon slot="icon" name="lan" aria-hidden={true} />TCP + UDP</m3e-chip>
      </m3e-chip-set>
    </section>
  );
}
