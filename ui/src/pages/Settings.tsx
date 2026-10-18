import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ENGINES,
  UA_PRESETS,
  type EngineId,
  type Settings,
  type SiteRule,
  type UaPresetId,
} from "../settings";
import { zlSend } from "../zeolite";
import { pushLog } from "../store";
import M3eSelect from "../M3eSelect";
import AmoSearch from "../browser/AmoSearch";

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  rules: SiteRule[];
  onRulesChange: (rules: SiteRule[]) => void;
  onOpenLogs: () => void;
  onDeleteAll: () => void;
};

const SEEDS: Array<[string, string]> = [
  ["#6750A4", "Baseline"],
  ["#006A6A", "Teal"],
  ["#4F5B92", "Slate"],
];

/* Display name for a per-site rule UA. The "Server default" wording was
   removed from Settings; the id stays functional in stored rules. */
const ruleUaName = (id: UaPresetId | undefined): string =>
  !id || id === "server-default"
    ? "default UA"
    : id === "custom"
      ? "Custom"
      : UA_PRESETS[id as Exclude<UaPresetId, "custom" | "server-default">].name;

/* Expansion panels: only the header toggles open state, so selecting an
   option inside a panel never collapses it. */
function Panel(props: { id: string; icon: string; title: string; open: boolean; toggle: () => void; children: ReactNode }) {
  return (
    <m3e-expansion-panel open={props.open ? "" : undefined} id={props.id}>
      <span slot="header" className="lb-panel-header" onClick={props.toggle}>
        <m3e-icon name={props.icon} aria-hidden={true} /> {props.title}
      </span>
      <div className="lb-panel-body">{props.children}</div>
    </m3e-expansion-panel>
  );
}

function Row(props: { label: string; icon: string; on: boolean; toggle: () => void }) {
  /* #116: the visible label names the switch and toggles it too. */
  const labelId = useId();
  return (
    <m3e-list-item>
      <div className="lb-setting-row">
        <span className="lb-setting-label" id={labelId} onClick={props.toggle}>
          <m3e-icon name={props.icon} aria-hidden={true} />
          {props.label}
        </span>
        <m3e-switch
          aria-labelledby={labelId}
          checked={props.on ? "" : undefined}
          icons="selected"
          onClick={props.toggle}
        />
      </div>
    </m3e-list-item>
  );
}

/* Text input on the M3E form field: the field owns the outline,
   floating label and focus treatment; the input itself stays native
   (M3E has no standalone text-field component). Validation is native
   constraint validation (required/pattern): the form field shows the
   `error` slot message once the control is invalid and the user has
   interacted with it (see M3E form-field docs). */
function TextInput(props: {
  label: string;
  value: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
  disabled?: boolean;
  pattern?: string;
  hint?: string;
  errorMessage?: string;
  onChange: (v: string) => void;
}) {
  const id = "lb-ti-" + props.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <m3e-form-field {...{ class: "lb-text-input" }}>
      <label slot="label" htmlFor={id}>{props.label}</label>
      <input
        id={id}
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        required={props.required}
        disabled={props.disabled}
        pattern={props.pattern}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <span slot="hint">{props.hint}</span>}
      {props.errorMessage && <span slot="error">{props.errorMessage}</span>}
    </m3e-form-field>
  );
}

export default function SettingsPanel({ settings, onChange, rules, onRulesChange, onOpenLogs, onDeleteAll }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({
    /* #90: only Search & browse starts expanded; the accordion
       keeps its multi-open behavior. */
    search: true,
    ua: false,
    privacy: false,
    appearance: false,
    extensions: false,
    cloak: false,
    advanced: false,
  });
  const toggle = (key: string) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  const [confirmDelete, setConfirmDelete] = useState(false);
  /* m3e-dialog opens/closes imperatively (show/hide methods, per the
     M3E dialog docs). React state mirrors it: opening sets the flag,
     and the dialog's `closed` event (fired for button, Escape, and
     backdrop dismissals alike) resets it, so the dialog can never get
     stuck open after a non-React dismissal. */
  const deleteDialogRef = useRef<HTMLElement & { show: () => void; hide: () => void } | null>(null);
  useEffect(() => {
    const el = deleteDialogRef.current;
    if (!el) return;
    const onClosed = () => setConfirmDelete(false);
    el.addEventListener("closed", onClosed);
    return () => el.removeEventListener("closed", onClosed);
  }, []);
  useEffect(() => {
    if (confirmDelete) deleteDialogRef.current?.show();
  }, [confirmDelete]);

  const [ruleDomain, setRuleDomain] = useState("");
  /* Per-site rule domains: accept an optional scheme+path and strip
     them, but the stored key itself must be a bare host. Anything
     else is invalid and blocks the Add action. */
  const ruleDomainCandidate = ruleDomain.trim().replace(/^https?:\/\//i, "").split("/")[0];
  const ruleDomainInvalid =
    ruleDomain.trim() !== "" &&
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(ruleDomainCandidate);
  const [ruleUa, setRuleUa] = useState<UaPresetId>("server-default");
  const [ruleAdblock, setRuleAdblock] = useState(true);

  /* Custom User-Agent draft + a light validator. Real sites only need
     a syntactically sane string with at least one product/version
     token; the Mozilla/5.0 prefix is a warning, not a failure. */
  const [uaDraft, setUaDraft] = useState(settings.uaCustom);
  const parseUa = (v: string): { ok: boolean; message: string } => {
    const s = v.trim();
    if (!s) return { ok: false, message: "Enter a User-Agent string." };
    if (/[\x00-\x1f]/.test(s)) return { ok: false, message: "Control characters are not allowed." };
    if (s.length > 512) return { ok: false, message: "Too long (max 512 characters)." };
    if (!/[A-Za-z0-9-]+\/[0-9A-Za-z.+*-]+/.test(s))
      return { ok: false, message: "No product/version token found (e.g. Chrome/124.0.0.0)." };
    if (!s.startsWith("Mozilla/5.0"))
      return { ok: true, message: "Valid, but it does not start with Mozilla/5.0; some sites may misbehave." };
    return { ok: true, message: "Valid User-Agent string." };
  };

  /* Extension import: one action, Import package (.xpi/.zip). The file
     bytes are handed to the engine worker, which owns the package
     parser and registration. */
  const [extImport, setExtImport] = useState<{ status: string; busy: boolean }>({ status: "", busy: false });
  const importZip = async (file: File) => {
    setExtImport({ status: "Importing " + file.name + "...", busy: true });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const rep = await zlSend({ type: "zl:installExt", bytes }, 20000);
    setExtImport({
      status:
        rep && rep.ok
          ? "Installed " + String(rep.id) + (Array.isArray(rep.warnings) && rep.warnings.length ? " (warnings: " + rep.warnings.join(", ") + ")" : "")
          : rep && rep.error
            ? "Import failed: " + String(rep.error)
            : "Import failed: the Zeolite service worker could not be reached on this origin.",
      busy: false,
    });
  };

  /* About / Build: one authoritative source. The /build endpoint on
     the deployed server reports the versions compiled into that exact
     build plus its deployment git commit, so the UI never claims a
     version the deployed build does not have. */
  const [build, setBuild] = useState<{
    lb: string;
    zeolite: string;
    scramjet: string;
    build: string;
    buildShort: string;
  } | null>(null);
  const [buildError, setBuildError] = useState(false);
  const [buildErrorDetail, setBuildErrorDetail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    /* Cache-busted: some edge caches serve a stale /build despite
       no-store, which previously left the About pills stuck on
       "Loading". Failures now log to the client log (visible on the
       Logs page) with the actual reason instead of failing silently. */
    fetch("/build?t=" + Date.now(), { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json() as Promise<{
          ok: boolean;
          lb?: string;
          zeolite?: string;
          scramjet?: string;
          zlswSha?: string;
          build?: string;
          buildShort?: string;
        }>;
      })
      .then((d) => {
        if (cancelled) return;
        if (d && d.ok && d.lb) {
          setBuild({
            lb: String(d.lb),
            zeolite: String(d.zeolite ?? "unknown"),
            scramjet: String(d.scramjet ?? "unknown"),
            build: String(d.build ?? "unknown"),
            buildShort: String(d.buildShort ?? "unknown"),
          });
          setBuildErrorDetail(null);
        } else {
          setBuildError(true);
          setBuildErrorDetail("endpoint returned " + JSON.stringify(d).slice(0, 120));
          pushLog("warn", "settings: /build returned an unexpected body");
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setBuildError(true);
        setBuildErrorDetail(msg);
        pushLog("error", "settings: /build fetch failed: " + msg);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="lb-view-content" aria-label="Settings">
      <m3e-heading variant="title" size="medium" level={2}>Settings</m3e-heading>

      {/* Real M3E accordion coordinating the panels. multi keeps the
          current behavior (several panels open at once); without it
          the accordion would collapse all but one. */}
      <m3e-accordion multi>
      <Panel id="panel-search" icon="search" title="Search & browse" open={open.search} toggle={() => toggle("search")}>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Search engine</div>
          <div className="lb-seg-wrap">
          <m3e-segmented-button aria-label="Search engine">
            {(Object.keys(ENGINES) as EngineId[]).map((id) => (
              <m3e-button-segment key={id} checked={settings.engine === id ? "" : undefined} onClick={() => onChange({ engine: id })}>
                {ENGINES[id].name}
              </m3e-button-segment>
            ))}
          </m3e-segmented-button>
          </div>
        </div>
        <m3e-list>
          <Row label="Engine search suggestions" icon="manage_search" on={settings.suggestQueries} toggle={() => onChange({ suggestQueries: !settings.suggestQueries })} />
        </m3e-list>
      </Panel>

      <Panel id="panel-ua" icon="devices" title="User-Agent" open={open.ua} toggle={() => toggle("ua")}>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Preset</div>
          {/* Dropdown: the preset list outgrew segmented buttons (seven
              entries wrap badly and never fit the panel). */}
          <M3eSelect
            label="User-Agent preset"
            value={settings.uaPreset}
            options={[
              ...(Object.keys(UA_PRESETS) as UaPresetId[])
                .filter((id): id is Exclude<UaPresetId, "custom" | "server-default"> => id !== "server-default")
                .map((id) => [id, UA_PRESETS[id].name] as [string, string]),
              ["custom", "Custom"],
            ]}
            onChange={(v) => onChange({ uaPreset: v as UaPresetId })}
          />
          {settings.uaPreset === "custom" && settings.uaCustom.trim() && (
            <span className="lb-ua-active">Custom User-Agent active</span>
          )}
        </div>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Custom User-Agent</div>
          <TextInput
            label="Manual User-Agent string"
            value={uaDraft}
            placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64) ..."
            onChange={setUaDraft}
          />
          {uaDraft.trim() && (
            <p className={"lb-muted" + (parseUa(uaDraft).ok ? "" : " lb-ua-bad")}>{parseUa(uaDraft).message}</p>
          )}
          <m3e-button
            disabled={parseUa(uaDraft).ok === false ? true : undefined}
            onClick={() => {
              onChange({ uaCustom: uaDraft.trim(), uaPreset: "custom" });
            }}
          >
            <m3e-icon name="check" aria-hidden={true} /> Save and use
          </m3e-button>
        </div>
      </Panel>

      <Panel id="panel-privacy" icon="lock" title="Privacy" open={open.privacy} toggle={() => toggle("privacy")}>
        <m3e-list>
          <Row label="Ad & tracker blocking" icon="shield" on={settings.adblock} toggle={() => onChange({ adblock: !settings.adblock })} />
          <Row label="HTTPS upgrade" icon="https" on={settings.httpsUpgrade} toggle={() => onChange({ httpsUpgrade: !settings.httpsUpgrade })} />
        </m3e-list>
        <p className="lb-muted" style={{ fontSize: 12 }}>
          HTTPS upgrade rewrites http page links to https before they are fetched. No silent fallback: a target that fails over https shows the error page instead of quietly downgrading.
        </p>
      </Panel>

      <Panel id="panel-extensions" icon="extension" title="Extensions" open={open.extensions} toggle={() => toggle("extensions")}>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Find and install add-ons</div>
          {/* AMO web pages are blocked from this deployment's egress;
             the public API is not, so search and install run over the
             API instead of the store site. */}
          <AmoSearch />
        </div>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Import locally</div>
          {/* Exactly one import action: our button triggers the picker;
             the input itself stays hidden. */}
          <label className="lb-import-row">
            <input
              type="file"
              accept=".xpi,.zip"
              className="lb-import-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importZip(f);
                e.target.value = "";
              }}
            />
            <m3e-button onClick={(e) => (e.currentTarget.parentElement?.querySelector<HTMLInputElement>(".lb-import-file")?.click())}>
              <m3e-icon name="archive" aria-hidden={true} /> Import package (.xpi / .zip)
            </m3e-button>
          </label>
          <p className="lb-muted" style={{ fontSize: 12, marginTop: 4 }}>
            Allowed files: manifest.json (required), .js scripts, .css, .html, .json, and images
            (.png, .svg, .webp, .jpg, .ico). No native code (no binaries, no .exe/.dll/.so).
            The engine validates the manifest and permission grants; a bad package only lands that
            extension in an error state.
          </p>
          {extImport.status && <p className="lb-muted" style={{ fontSize: 12 }}>{extImport.status}</p>}
        </div>
      </Panel>

      <Panel id="panel-appearance" icon="palette" title="Appearance" open={open.appearance} toggle={() => toggle("appearance")}>
        <div className="lb-setting-group">
          {/* #102: a visible, associated label for the colour input. */}
          <label htmlFor="lb-theme-color" className="lb-setting-label" style={{ display: "block" }}>
            Theme color
          </label>
          <div className="lb-seed-row">
            <input
              id="lb-theme-color"
              type="color"
              value={settings.seed}
              onChange={(e) => onChange({ seed: e.target.value })}
              className="lb-color-input"
            />
            <m3e-chip-set>
              {SEEDS.map(([hex, name]) => (
                <m3e-chip key={hex} selected={settings.seed === hex ? "" : undefined} onClick={() => onChange({ seed: hex })}>
                  {name}
                </m3e-chip>
              ))}
            </m3e-chip-set>
          </div>
        </div>
        <m3e-divider />
        <div className="lb-setting-group">
          <div className="lb-setting-label">Background</div>
          <m3e-list>
            <Row label="Enhanced UI (animated background)" icon="stars" on={settings.fancyBackground} toggle={() => onChange({ fancyBackground: !settings.fancyBackground })} />
          </m3e-list>
          <p className="lb-muted" style={{ fontSize: 12 }}>
            Replaces the Home page's plain background with an animated starfield (CSS star layers with pointer parallax).
            Off keeps the plain flat background.
          </p>
        </div>
      </Panel>

      <Panel id="panel-cloak" icon="visibility_off" title="Auto Cloak" open={open.cloak} toggle={() => toggle("cloak")}>
        <m3e-list>
          <Row label="Cloak when the tab is hidden" icon="hide_image" on={settings.cloakEnabled} toggle={() => onChange({ cloakEnabled: !settings.cloakEnabled })} />
        </m3e-list>
        <div className="lb-setting-group">
          <TextInput label="Cloak destination" value={settings.cloakUrl} onChange={(v) => onChange({ cloakUrl: v })} />
          <TextInput label="Tab title while cloaked" value={settings.cloakTitle} onChange={(v) => onChange({ cloakTitle: v })} />
          <p className="lb-muted">
            When you switch away from this tab, the tab title changes and a harmless site is staged. When
            you return, the cloak covers LobsterBrowse Preview until you click "Return". Browsers do not let a
            page re-render while hidden — this is the strongest behavior a normal web page can offer.
          </p>
        </div>
      </Panel>

      <Panel id="panel-advanced" icon="settings_applications" title="Advanced" open={open.advanced} toggle={() => toggle("advanced")}>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Proxy engine</div>
          <div className="lb-seg-wrap">
          <m3e-segmented-button aria-label="Proxy engine">
            <m3e-button-segment checked={settings.proxyEngine !== "scramjet" ? "" : undefined} onClick={() => onChange({ proxyEngine: "zeolite" })}>
              Zeolite (default)
            </m3e-button-segment>
            <m3e-button-segment checked={settings.proxyEngine === "scramjet" ? "" : undefined} onClick={() => onChange({ proxyEngine: "scramjet" })}>
              ScramJet
            </m3e-button-segment>
          </m3e-segmented-button>
          </div>
          <p className="lb-muted" style={{ marginTop: 6, fontSize: 12 }}>
            ScramJet is the upstream MercuryWorkshop engine, client-side rewriting through its own /sj/ worker. Engine options like adblock, fingerprint spoof and lazy images are Zeolite-only. Applied on the next navigation.
          </p>
        </div>
        <m3e-divider />
        <div className="lb-setting-group">
          <div className="lb-setting-label">Transport engine</div>
          <div className="lb-seg-wrap">
          <m3e-segmented-button aria-label="Transport engine">
            <m3e-button-segment checked={settings.transport !== "epoxy" ? "" : undefined} onClick={() => onChange({ transport: "libcurl" })}>
              libcurl (default)
            </m3e-button-segment>
            <m3e-button-segment checked={settings.transport === "epoxy" ? "" : undefined} onClick={() => onChange({ transport: "epoxy" })}>
              epoxy (experimental)
            </m3e-button-segment>
          </m3e-segmented-button>
          </div>
          <p className="lb-muted" style={{ marginTop: 6, fontSize: 12 }}>
            epoxy terminates TLS with rustls instead of libcurl's mbedTLS, so the TLS fingerprint sites see changes — that is its purpose. Experimental: keep libcurl if a site misbehaves. WebSockets and cookie capture are supported on both engines. Applied when the engine next loads; no mid-session swap.
          </p>
        </div>
        <m3e-divider />
        <div className="lb-setting-group">
          <div className="lb-setting-label">Data</div>
          <p className="lb-muted">
            One place for destructive actions: clear the proxied page cache on
            this device, or delete every stored history, session and setting.
          </p>
          <m3e-button onClick={() => setConfirmDelete(true)}>
            <m3e-icon name="delete" aria-hidden={true} /> Manage data
          </m3e-button>
          {/* Real modal: m3e-dialog owns the scrim, focus trap, Escape
              handling and alertdialog semantics (alert attribute). */}
          <m3e-dialog
            {...{ ref: deleteDialogRef }}
            alert=""
            dismissible=""
            close-label="Cancel"
          >
            <span slot="header">Manage data</span>
            <p>Clear the Zeolite page cache, or delete all data on this device?</p>
            <div slot="actions">
              <m3e-button autofocus onClick={() => deleteDialogRef.current?.hide()}>Cancel</m3e-button>
              <m3e-button
                onClick={() => {
                  deleteDialogRef.current?.hide();
                  (async () => {
                    try {
                      const keys = await caches.keys();
                      await Promise.all(keys.map((k) => caches.delete(k)));
                      if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
                        M3eSnackbar.open("Zeolite cache cleared", { duration: 3000 });
                      }
                    } catch {
                      /* caches unavailable */
                    }
                  })();
                }}
              >
                Clear cache
              </m3e-button>
              <m3e-button
                variant="filled"
                onClick={() => {
                  onDeleteAll();
                  deleteDialogRef.current?.hide();
                }}
              >
                Delete all data
              </m3e-button>
            </div>
          </m3e-dialog>
        </div>

        <m3e-divider />
        <div className="lb-setting-group">
          <div className="lb-setting-label">Technical logs</div>
          <m3e-list>
            <Row label="Diagnostic mode (log every failure verbosely)" icon="bug_report" on={settings.diagnostics} toggle={() => onChange({ diagnostics: !settings.diagnostics })} />
          </m3e-list>
          <p className="lb-muted" style={{ fontSize: 12 }}>
            While on, every failed resource, page console message and proxy intervention (CSP/SRI
            stripping) is logged in full to the app log and DevTools. Expect noise: that is the point.
          </p>
          <m3e-button onClick={onOpenLogs}>
            <m3e-icon name="history" aria-hidden={true} /> Open Logs
          </m3e-button>
        </div>

      </Panel>
      </m3e-accordion>

      <div className="lb-setting-group lb-about">
        <div className="lb-setting-label">About</div>
        {/* The pills always render (unknown while loading or on
            failure), so the About section never looks empty. */}
        <div className="lb-build" title={build ? "Build " + build.build : "Build information unavailable"}>
          <span className="lb-build-chip"><span className="lb-build-name">LobsterBrowse Preview</span><span className="lb-build-val">{build ? build.lb : "unknown"}</span></span>
          <span className="lb-build-chip"><span className="lb-build-name">Zeolite</span><span className="lb-build-val">{build ? build.zeolite : "unknown"}</span></span>
          <span className="lb-build-chip"><span className="lb-build-name">ScramJet</span><span className="lb-build-val">{build ? build.scramjet : "unknown"}</span></span>
          <span className="lb-build-chip"><span className="lb-build-name">Build</span><span className="lb-build-val">{build ? build.buildShort : "unknown"}</span></span>
        </div>
        {buildError && (
          <p className="lb-muted" style={{ fontSize: 12 }}>
            Build information unavailable on this deployment.
            {buildErrorDetail ? " Reason: " + buildErrorDetail : ""}
          </p>
        )}
        {!build && !buildError && (
          <p className="lb-muted" style={{ fontSize: 12 }}>Loading build information...</p>
        )}
      </div>
    </section>
  );
}
