import { useEffect, useRef, useState } from "react";
import { zlSend, zlContentConfig } from "../zeolite";
import { engineRoutePrefix, type Settings } from "../settings";
import { clearDebugOverrides, loadDebugOverrides, saveDebugOverrides, type DebugOverrides } from "../debug";

/* Hidden debug menu (beta): opened with five quick clicks on the Home
   wordmark. Shows a live engine readout (/build + zl:ping) and runtime
   engine toggles that would otherwise need a redeploy - the Injector
   query-shape opt-in, the https-upgrade and lazy-image page options.
   Toggles write debug overrides (localStorage) and push zl:config to
   BOTH workers immediately; App-side pushes consult the same
   overrides, so the choice survives reloads and worker restarts
   until cleared. */
type Props = { open: boolean; onClose: () => void; settings: Settings };

export default function DebugMenu({ open, onClose, settings }: Props) {
  const dialogRef = useRef<HTMLElement & { show: () => void; hide: () => void } | null>(null);
  const [ov, setOv] = useState<DebugOverrides>(() => loadDebugOverrides());
  const [build, setBuild] = useState<string>("(fetching /build...)");
  const [ping, setPing] = useState<string>("(pinging the worker...)");

  /* m3e-dialog opens/closes imperatively (the Settings.tsx pattern):
     React state mirrors it, the `closed` event (button, Escape,
     backdrop) resets it. */
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onClosed = () => onClose();
    el.addEventListener("closed", onClosed);
    return () => el.removeEventListener("closed", onClosed);
  }, [onClose]);
  useEffect(() => {
    if (open) dialogRef.current?.show();
  }, [open]);

  /* Readout refreshes every time the menu opens. */
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const r = await fetch("/build?cb=" + Date.now(), { cache: "no-store" });
        const b = await r.json();
        setBuild(
          "lb " + (b?.lb ?? "?") +
          " | build " + (b?.buildShort ?? "?") +
          " | zlsw " + (b?.zlswSha ?? "?") +
          " | server queryRoutes " + String(b?.zlQueryRoutes === true),
        );
      } catch {
        setBuild("(/build fetch failed)");
      }
    })();
    void zlSend({ type: "zl:ping" }, 6000).then((p) => {
      setPing(
        p && p.ok
          ? "zl " + (p.version ?? "?") +
            " | prefix " + (p.prefix ?? "?") +
            " | scheme " + (p.scheme ?? "?") +
            " | queryRoutes " + String(p.queryRoutes === true) +
            " | httpsUpgrade " + String(p.httpsUpgrade === true) +
            " | imageLazy " + String(p.imageLazy === true) +
            (p.degraded ? " | DEGRADED" : "")
          : "(zl:ping failed)",
      );
    });
  }, [open]);

  /* The effective values: a debug override wins over the stored
     setting, which wins over the built-in default. */
  const cur = {
    queryRoutes: ov.queryRoutes ?? false,
    httpsUpgrade: ov.httpsUpgrade ?? settings.httpsUpgrade,
    imageLazy: ov.imageLazy ?? true,
  };

  /* Same shape the App settings effect sends (the parity push): the
     content-origin worker gets the identical config. */
  const push = (next: DebugOverrides) => {
    const msg = {
      type: "zl:config" as const,
      prefix: engineRoutePrefix(),
      httpsUpgrade: next.httpsUpgrade ?? settings.httpsUpgrade,
      imageLazy: next.imageLazy ?? true,
      queryRoutes: next.queryRoutes ?? false,
    };
    void zlSend(msg, 8000);
    void zlContentConfig(msg);
  };

  const flip = (k: "queryRoutes" | "httpsUpgrade" | "imageLazy") => () => {
    const next: DebugOverrides = { ...ov, [k]: !cur[k] };
    setOv(next);
    saveDebugOverrides(next);
    push(next);
  };

  const reset = () => {
    clearDebugOverrides();
    setOv({});
    push({});
  };

  return (
    <m3e-dialog {...{ ref: dialogRef }} alert="" dismissible="" close-label="Close">
      <span slot="header">Debug</span>
      <p style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
        {build + "\n" + ping}
      </p>
      <m3e-list-item>
        <div className="lb-setting-row">
          <span className="lb-setting-label">Query-shape routes (Injector)</span>
          <m3e-switch checked={cur.queryRoutes ? "" : undefined} icons="selected" onClick={flip("queryRoutes")} />
        </div>
      </m3e-list-item>
      <m3e-list-item>
        <div className="lb-setting-row">
          <span className="lb-setting-label">HTTPS upgrade</span>
          <m3e-switch checked={cur.httpsUpgrade ? "" : undefined} icons="selected" onClick={flip("httpsUpgrade")} />
        </div>
      </m3e-list-item>
      <m3e-list-item>
        <div className="lb-setting-row">
          <span className="lb-setting-label">Lazy images</span>
          <m3e-switch checked={cur.imageLazy ? "" : undefined} icons="selected" onClick={flip("imageLazy")} />
        </div>
      </m3e-list-item>
      <div slot="actions">
        <m3e-button autofocus onClick={() => dialogRef.current?.hide()}>
          Close
        </m3e-button>
        <m3e-button variant="filled" onClick={reset}>
          Clear overrides
        </m3e-button>
      </div>
    </m3e-dialog>
  );
}
