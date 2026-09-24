import { useEffect, useState } from 'react';
import { searchUrl, type Settings } from '../settings';

type Props = { settings: Settings };

/* Heuristic: a URL has a scheme, or looks like a bare domain/host
   (contains a dot, no spaces). Everything else is a search query. */
function looksLikeUrl(s: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s)) return true;
  return /^[^\s]+\.[^\s]{2,}$/.test(s) && !s.includes(" ");
}

export default function HomePage({ settings }: Props) {
  const [url, setUrl] = useState("");
  const [health, setHealth] = useState<string>("checking…");

  useEffect(() => {
    // Simple curl-style probe: GET /healthz, print the HTTP status.
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      fetch("/healthz?_=" + Date.now(), { cache: "reload" })
        .then((r) => { if (!cancelled) setHealth(r.ok ? "200 ok — server online" : r.status + " err"); })
        .catch(() => { if (!cancelled) setHealth("connection failed — retrying"); })
        .then(() => {
          if (cancelled) return;
          attempt++;
          timer = setTimeout(check, attempt < 2 ? 2000 : attempt < 4 ? 5000 : 15000);
        });
    };
    check();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  /* Open a target — either proxied through this server (/p?url=) or direct. */
  const open = (target: string, newTab: boolean) => {
    const href = settings.proxySearch
      ? "/p?url=" + encodeURIComponent(target)
      : target;
    if (newTab) {
      window.open(href, "_blank", "noopener,noreferrer");
    } else {
      window.location.href = href;
    }
  };

  const go = () => {
    const q = url.trim();
    if (!q) return;
    if (looksLikeUrl(q)) {
      open(require$normalize(q), settings.urlNewTab);
    } else {
      open(searchUrl(settings, q), settings.openSearchNewTab);
    }
  };

  // inline to avoid extra import above
  function require$normalize(s: string): string {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    return "https://" + s;
  }

  return (
    <section style={{ textAlign: "center", marginTop: 16 }}>
      <m3e-heading variant="display" size="medium" level={2}>Browse freely</m3e-heading>
      <p style={{ opacity: 0.7, marginTop: 8 }}>Private proxy with ad blocking.</p>

      <div style={{ margin: "32px 0 8px" }}>
        <m3e-search-bar clearable>
          <m3e-icon name="travel_explore" slot="leading" aria-hidden={true} />
          <input
            slot="input"
            id="url"
            aria-label="URL or search query"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") go(); }}
            placeholder={settings.proxySearch ? "Proxied search or URL" : "Search or enter a URL"}
          />
          <m3e-button slot="trailing" variant="filled" onClick={go}>Go</m3e-button>
        </m3e-search-bar>
      </div>

      <p style={{ fontSize: 12, opacity: 0.5, marginBottom: 24 }}>
        {settings.proxySearch
          ? "Fetched through this server — your IP is hidden from the site"
          : "Opens directly in your browser"}
      </p>

      <p style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, opacity: 0.6, marginBottom: 40 }}>
        $ curl /healthz → {health}
      </p>

      {settings.showFeatureChips && (
        <m3e-chip-set aria-label="Features">
          <m3e-chip><m3e-icon slot="icon" name="visibility_off" aria-hidden={true} />No logs</m3e-chip>
          <m3e-chip><m3e-icon slot="icon" name="shield" aria-hidden={true} />Ad blocking</m3e-chip>
          <m3e-chip><m3e-icon slot="icon" name="lan" aria-hidden={true} />TCP + UDP</m3e-chip>
        </m3e-chip-set>
      )}
    </section>
  );
}
