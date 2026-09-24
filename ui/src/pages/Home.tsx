import { useEffect, useState } from 'react';
import { ENGINES, type Settings } from '../settings';

type Props = { settings: Settings };

/* Heuristic: a URL has a scheme, or looks like a bare domain/host
   (contains a dot, no spaces, no slash-free weirdness). Everything
   else is treated as a search query. */
function looksLikeUrl(s: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s)) return true;
  return /^[^\s]+.[^\s]{2,}$/.test(s) && !s.includes(" ");
}

export default function HomePage({ settings }: Props) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"checking" | "online" | "offline">("checking");

  useEffect(() => {
    // Same origin: the server serves this UI, so it is awake whenever the
    // page is open. /healthz confirms it. Retries with backoff so a transient
    // failure never sticks on "Reconnecting…".
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      fetch("/healthz", { cache: "no-store", mode: "same-origin" })
        .then((r) => { if (!cancelled) setStatus(r.ok ? "online" : "offline"); })
        .catch(() => {
          if (cancelled) return;
          // Fallback: cache-busted retry in case an intermediary or
          // extension is interfering with the cached request.
          fetch("/healthz?_=" + Date.now(), { cache: "reload" })
            .then((r) => { if (!cancelled) setStatus(r.ok ? "online" : "offline"); })
            .catch(() => { if (!cancelled) setStatus("offline"); });
        })
        .finally(() => {
          if (cancelled) return;
          attempt++;
          const delay = attempt < 2 ? 2000 : attempt < 4 ? 3000 : 10000;
          timer = setTimeout(() => {
            if (!cancelled) { setStatus("checking"); check(); }
          }, delay);
        });
    };
    check();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  const statusText =
    status === "checking" ? "Connecting…" :
    status === "online" ? "Server online" : "Reconnecting…";

  const go = () => {
    const q = url.trim();
    if (!q) return;
    if (!looksLikeUrl(q)) {
      // Search query: hand off to the configured engine.
      const engine = ENGINES[settings.engine];
      const target = engine.url.replace("{q}", encodeURIComponent(q));
      (globalThis as any).M3eSnackbar?.open("Searching with " + engine.name + "…", true);
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

  const host = typeof location !== "undefined" ? location.hostname : "";

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
            placeholder={"Search with " + ENGINES[settings.engine].name + " or enter a URL"}
          />
          <m3e-button slot="trailing" variant="filled" onClick={go}>Go</m3e-button>
        </m3e-search-bar>
      </div>

      <div id="srv-status" style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center", fontSize: 13, opacity: 0.8, marginBottom: 40, minHeight: 20 }}>
        {status === "checking"
          ? <m3e-loading-indicator aria-label="Checking server status" />
          : (
            <>
              <span aria-hidden={true} style={{
                width: 8, height: 8, borderRadius: "50%", display: "inline-block",
                background: status === "online" ? "var(--md-sys-color-primary)" : "var(--md-sys-color-error)"
              }} />
              {statusText}
            </>
          )}
      </div>
      <m3e-tooltip for="srv-status" position="below">
        Live /healthz check · this page is served from {host}
      </m3e-tooltip>

      <m3e-chip-set aria-label="Features">
        <m3e-chip><m3e-icon slot="icon" name="visibility_off" aria-hidden={true} />No logs</m3e-chip>
        <m3e-chip><m3e-icon slot="icon" name="shield" aria-hidden={true} />Ad blocking</m3e-chip>
        <m3e-chip><m3e-icon slot="icon" name="lan" aria-hidden={true} />TCP + UDP</m3e-chip>
      </m3e-chip-set>
    </section>
  );
}
