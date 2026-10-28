import { useEffect, useRef, useState } from "react";
import { zlSend, zlContentConfig } from "../zeolite";
import { engineRoutePrefix, type Settings } from "../settings";
import { clearDebugOverrides, emptyExperimental, loadDebugOverrides, saveDebugOverrides, EXPERIMENTAL_KEYS, type ExperimentalKey, type DebugOverrides } from "../debug";

/* Hidden debug menu (beta): opened with five quick clicks on the Home
   wordmark. Shows a live engine readout (/build + zl:ping) and runtime
   engine toggles that would otherwise need a redeploy - the Injector
   query-shape toggle, the https-upgrade and lazy-image page options,
   and the split content-origin mode. Config toggles write debug
   overrides (localStorage) and push zl:config to BOTH workers
   immediately; the split toggle is override-only (zlContentHref
   reads it: off = frames stay on the app origin). App-side pushes
   consult the same overrides, so the choice survives reloads and
   worker restarts until cleared. */
type Props = { open: boolean; onClose: () => void; settings: Settings };

export default function DebugMenu({ open, onClose, settings }: Props) {
  const dialogRef = useRef<HTMLElement & { show: () => void; hide: () => void } | null>(null);
  const [ov, setOv] = useState<DebugOverrides>(() => loadDebugOverrides());
  const [build, setBuild] = useState<string>("(fetching /build...)");
  /* #192: the no-override default mirrors the deployment /build
     value (ZL_QUERY_ROUTES opt-out), matching App parity. */
  const [qr, setQr] = useState<boolean>(true);
  const [ping, setPing] = useState<string>("(pinging the worker...)");
  const [experimentalAck, setExperimentalAck] = useState<string>("Not verified by this worker yet.");

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
          " | server queryRoutes " + String(b?.zlQueryRoutes === true) +
            " | content " + (b?.contentOrigin || "(same-origin)"),
        );
        setQr(b?.zlQueryRoutes === true);
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
    queryRoutes: ov.queryRoutes ?? qr,
    httpsUpgrade: ov.httpsUpgrade ?? settings.httpsUpgrade,
    imageLazy: ov.imageLazy ?? true,
    split: ov.split ?? true,
    experimental: { ...emptyExperimental(), ...ov.experimental },
  };

  /* Same shape the App settings effect sends (the parity push): the
     content-origin worker gets the identical config. */
  const push = (next: DebugOverrides) => {
    const msg = {
      type: "zl:config" as const,
      prefix: engineRoutePrefix(),
      httpsUpgrade: next.httpsUpgrade ?? settings.httpsUpgrade,
      imageLazy: next.imageLazy ?? true,
      queryRoutes: next.queryRoutes ?? qr,
      experimental: { ...emptyExperimental(), ...next.experimental },
    };
    void zlSend(msg, 8000).then((r) => {
      const e = r?.experimental as {
        requested?: Record<string, boolean>;
        effective?: Record<string, boolean>;
        status?: Record<string, string>;
      } | undefined;
      if (!r?.ok || !e?.effective) {
        setExperimentalAck("Worker did not confirm experimental flags; selections remain local only.");
      } else {
        const effective = EXPERIMENTAL_KEYS.filter(k => e.effective?.[k]);
        const activeLabels = effective.map(k =>
          k + " (" + (e.status?.[k] ?? "status unknown") + ")");
        setExperimentalAck(effective.length
          ? "Worker reports active subset: " + activeLabels.join(", ") +
            ". Other selected features may be observation-only or unavailable."
          : "Selections acknowledged. No experimental request-serving feature is active.");
      }
    });
    void zlContentConfig(msg);
  };

  const flip = (k: "queryRoutes" | "httpsUpgrade" | "imageLazy" | "split") => () => {
    const next: DebugOverrides = { ...ov, [k]: !cur[k] };
    setOv(next);
    saveDebugOverrides(next);
    /* split is override-only: zlContentHref reads it, no push */
    if (k !== "split") push(next);
  };

  const flipExperimental = (key: ExperimentalKey) => () => {
    const next: DebugOverrides = {
      ...ov, experimental: { ...cur.experimental, [key]: !cur.experimental[key] },
    };
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
          <span className="lb-setting-label">Split content origin</span>
          <m3e-switch checked={cur.split ? "" : undefined} icons="selected" onClick={flip("split")} />
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
      <m3e-divider />
      <p className="lb-muted" style={{ margin: "10px 16px 4px" }}>
        Experimental flags — choices are off by default. They do not enable unfinished
        engine features until Zeolite reports them as effective.
      </p>
      {([
        ["adaptiveTransit", "Adaptive NativeTransit", "Shadow comparison diagnostics; routing stays conservative"],
        ["hybridLocation", "Hybrid location rewriting", "Requires verified per-site source rewriting"],
        ["cspTranslation", "CSP translation", "Deny-only HTML CSP subset; never translates arbitrary origins"],
        ["virtualSW", "Virtual Service Workers", "Shipped (#477): a page register spawns an isolated guest realm on the guest-host page; guest fetch events dispatch under a 250 ms fail-closed budget"],
      ] as const).map(([key, label, detail]) => (
        <m3e-list-item key={key}>
          <div className="lb-setting-row">
            <span>
              <span className="lb-setting-label">{label}</span>
              <small style={{ display: "block", opacity: 0.75 }}>{detail}</small>
            </span>
            <m3e-switch
              aria-label={label + " experimental flag"}
              checked={cur.experimental[key] ? "" : undefined}
              icons="selected"
              onClick={flipExperimental(key)}
            />
          </div>
        </m3e-list-item>
      ))}
      <p role="status" className="lb-muted" style={{ margin: "8px 16px" }}>{experimentalAck}</p>
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
