import { useEffect, useState, type ReactNode } from "react";
import {
  ENGINES,
  UA_PRESETS,
  type EngineId,
  type Settings,
  type SiteRule,
  type UaPresetId,
} from "../settings";
import { zlSend } from "../zeolite";

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  rules: SiteRule[];
  onRulesChange: (rules: SiteRule[]) => void;
  onOpenLogs: () => void;
  onDeleteAll: () => void;
  /* Navigate the active proxy surface in-app (used for the add-ons
     store: it must load through the engine, not the external browser). */
  onNavigate: (url: string) => void;
};

const SEEDS: Array<[string, string]> = [
  ["#E8552F", "Lobster"],
  ["#6750A4", "Baseline"],
  ["#006A6A", "Teal"],
  ["#4F5B92", "Slate"],
];

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

function Row(props: { label: string; icon: string; on: boolean; toggle: () => void; off?: boolean }) {
  return (
    <m3e-list-item>
      <div className={"lb-setting-row" + (props.off ? " lb-off" : "")}>
        <span className="lb-setting-label">
          <m3e-icon name={props.icon} aria-hidden={true} />
          {props.label}
        </span>
        <m3e-switch checked={props.on ? "" : undefined} icons="selected" onClick={props.toggle} />
      </div>
    </m3e-list-item>
  );
}

function TextInput(props: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <label className="lb-text-input">
      <span className="lb-muted">{props.label}</span>
      <input
        className="lb-input"
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

export default function SettingsPanel({ settings, onChange, rules, onRulesChange, onOpenLogs, onDeleteAll, onNavigate }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({
    search: true,
    ua: true,
    privacy: true,
    appearance: false,
    extensions: false,
    cloak: false,
    advanced: false,
  });
  const toggle = (key: string) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [ruleDomain, setRuleDomain] = useState("");
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
    lobsterjet: string;
    build: string;
    buildShort: string;
  } | null>(null);
  const [buildError, setBuildError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/build")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              ok: boolean;
              lb?: string;
              zeolite?: string;
              lobsterjet?: string;
              build?: string;
              buildShort?: string;
            }>)
          : null,
      )
      .then((d) => {
        if (cancelled) return;
        if (d && d.ok && d.lb) {
          setBuild({
            lb: String(d.lb),
            zeolite: String(d.zeolite ?? "unknown"),
            lobsterjet: String(d.lobsterjet ?? "unknown"),
            build: String(d.build ?? "unknown"),
            buildShort: String(d.buildShort ?? "unknown"),
          });
        } else {
          setBuildError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setBuildError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="lb-view-content" aria-label="Settings">
      <m3e-heading variant="title" size="medium" level={2}>Settings</m3e-heading>
      <p className="lb-muted" style={{ marginTop: 4 }}>
        Saved on this device only. Toggles marked server-side change how the engine fetches pages.
      </p>

      <Panel id="panel-search" icon="search" title="Search & browse" open={open.search} toggle={() => toggle("search")}>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Proxy engine</div>
          <div className="lb-seg-wrap">
          <m3e-segmented-button aria-label="Proxy engine">
            <m3e-button-segment checked={settings.proxyEngine === "lobsterjet" ? "" : undefined} onClick={() => onChange({ proxyEngine: "lobsterjet" })}>
              Zeolite — default
            </m3e-button-segment>
            <m3e-button-segment checked={settings.proxyEngine !== "lobsterjet" ? "" : undefined} onClick={() => onChange({ proxyEngine: "scramjet" })}>
              ScramJet
            </m3e-button-segment>
          </m3e-segmented-button>
          </div>
          <p className="lb-muted" style={{ marginTop: 6, fontSize: 12 }}>
            Zeolite is the project default: a service worker that caches proxied pages on your
            device (cache-first, 10-minute freshness, network fallback), so repeat visits load
            without touching the server. When the worker is not installed the same /lj/ routes are
            served by the ScramJet server-side rewriter. ScramJet does adblock/tracker stripping,
            HTTPS-only enforcement, privacy signals (Sec-GPC / DNT), image compression and AMP
            de-amping on every upstream request.
          </p>
        </div>
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
          <Row label="HTTPS-only (server-side)" icon="https" on={settings.httpsOnly} toggle={() => onChange({ httpsOnly: !settings.httpsOnly })} />
          <Row label="Engine search suggestions" icon="manage_search" on={settings.suggestQueries} toggle={() => onChange({ suggestQueries: !settings.suggestQueries })} />
        </m3e-list>
      </Panel>

      <Panel id="panel-ua" icon="devices" title="User-Agent" open={open.ua} toggle={() => toggle("ua")}>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Preset</div>
          {/* Dropdown: the preset list outgrew segmented buttons (seven
              entries wrap badly and never fit the panel). */}
          <select
            className="lb-select"
            aria-label="User-Agent preset"
            value={settings.uaPreset}
            onChange={(e) => onChange({ uaPreset: e.target.value as UaPresetId })}
          >
            {(Object.keys(UA_PRESETS) as Array<Exclude<UaPresetId, "custom">>).map((id) => (
              <option key={id} value={id}>{UA_PRESETS[id].name}</option>
            ))}
            <option value="custom">Custom</option>
          </select>
          {settings.uaPreset === "custom" && settings.uaCustom.trim() && (
            <span className="lb-ua-active">Custom User-Agent active</span>
          )}
        </div>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Custom User-Agent (server-side)</div>
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
          <Row label="Ad & tracker blocking (server-side)" icon="shield" on={settings.adblock} toggle={() => onChange({ adblock: !settings.adblock })} />
          <Row label="Decentraleyes: local CDN libraries" icon="offline_bolt" on={settings.decentraleyes} off={settings.proxyEngine !== "lobsterjet"} toggle={() => onChange({ decentraleyes: !settings.decentraleyes })} />
        </m3e-list>
      </Panel>

      <Panel id="panel-extensions" icon="extension" title="Extensions" open={open.extensions} toggle={() => toggle("extensions")}>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Get extensions</div>
          {/* The store loads INSIDE LobsterBrowse, through the active
             proxy engine, exactly like any other site. */}
          <m3e-button onClick={() => onNavigate("https://addons.mozilla.org/")}>
            <m3e-icon name="storefront" aria-hidden={true} /> Browse the Mozilla add-ons store
          </m3e-button>
          <p className="lb-muted" style={{ fontSize: 12, marginTop: 4 }}>
            The store opens in a proxied tab. Downloads land in your Downloads folder as .xpi; import that file below.
          </p>
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
          <div className="lb-setting-label">Theme color</div>
          <div className="lb-seed-row">
            <input
              type="color"
              aria-label="Theme color"
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
            you return, the cloak covers LobsterBrowse until you click "Return". Browsers do not let a
            page re-render while hidden — this is the strongest behavior a normal web page can offer.
          </p>
        </div>
      </Panel>

      <Panel id="panel-advanced" icon="settings_applications" title="Advanced" open={open.advanced} toggle={() => toggle("advanced")}>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Zeolite cache</div>
          <p className="lb-muted">
            Cached proxied pages and local libraries live on this device in the service worker
            cache. Clearing drops every entry; pages reload from the server on the next visit.
          </p>
          <div className={settings.proxyEngine !== "lobsterjet" ? "lb-off" : ""}>
          <m3e-button
            onClick={() => {
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
            <m3e-icon name="delete" aria-hidden={true} /> Clear Zeolite cache
          </m3e-button>
          </div>
          {settings.proxyEngine !== "lobsterjet" && (
            <p className="lb-muted" style={{ fontSize: 12 }}>
              Cache options apply when Zeolite is the proxy engine.
            </p>
          )}
        </div>
        <m3e-divider />
        <div className="lb-setting-group">
          <div className="lb-setting-label">Technical logs</div>
          <m3e-button onClick={onOpenLogs}>
            <m3e-icon name="history" aria-hidden={true} /> Open Logs
          </m3e-button>
        </div>
        <m3e-divider />
        <div className="lb-setting-group">
          <div className="lb-setting-label">Per-site rules</div>
          <p className="lb-muted">
            Overrides apply per domain: User-Agent preset and ad/tracker blocking for that site.
          </p>
          {rules.length > 0 && (
            <div className="lb-rule-list">
              {rules.map((r) => (
                <div key={r.domain} className="lb-rule-row">
                  <code>{r.domain}</code>
                  <span className="lb-muted">{r.uaPreset ?? "default UA"} · adblock {r.adblock === false ? "off" : "on"}</span>
                  <m3e-icon-button aria-label="Remove rule" onClick={() => onRulesChange(rules.filter((x) => x.domain !== r.domain))}>
                    <m3e-icon name="delete" aria-hidden={true} />
                  </m3e-icon-button>
                </div>
              ))}
            </div>
          )}
          <div className="lb-seed-row">
            <input
              className="lb-input"
              type="text"
              placeholder="example.com"
              aria-label="Site domain"
              value={ruleDomain}
              onChange={(e) => setRuleDomain(e.target.value)}
            />
            <select className="lb-select" aria-label="User-Agent for site" value={ruleUa} onChange={(e) => setRuleUa(e.target.value as UaPresetId)}>
              <option value="server-default">Default UA</option>
              {(Object.keys(UA_PRESETS) as Array<Exclude<UaPresetId, "custom">>).map((id) => (
                <option key={id} value={id}>{UA_PRESETS[id].name}</option>
              ))}
            </select>
            <m3e-switch checked={ruleAdblock ? "" : undefined} icons="selected" aria-label="Ad blocking for site" onClick={() => setRuleAdblock(!ruleAdblock)} />
            <m3e-button
              onClick={() => {
                const domain = ruleDomain.trim().replace(/^https?:\/\//, "").split("/")[0];
                if (!domain) return;
                const next = rules.filter((r) => r.domain !== domain);
                next.push({ domain, uaPreset: ruleUa, adblock: ruleAdblock });
                onRulesChange(next);
                setRuleDomain("");
              }}
            >
              Add
            </m3e-button>
          </div>
        </div>
        <m3e-divider />
        <div className="lb-setting-group">
          <div className="lb-setting-label">Data</div>
          {confirmDelete ? (
            <div className="lb-seed-row">
              <span className="lb-muted">Delete history, sessions and settings on this device?</span>
              <m3e-button variant="filled" onClick={onDeleteAll}>Yes, delete</m3e-button>
              <m3e-button onClick={() => setConfirmDelete(false)}>Cancel</m3e-button>
            </div>
          ) : (
            <m3e-button onClick={() => setConfirmDelete(true)}>
              <m3e-icon name="delete_forever" aria-hidden={true} /> Delete all data
            </m3e-button>
          )}
        </div>
      </Panel>

      <div className="lb-setting-group lb-about">
        <div className="lb-setting-label">About</div>
        {build ? (
          <div className="lb-build" title={"Build " + build.build}>
            <div className="lb-build-row"><span>LobsterBrowse</span><span>{build.lb}</span></div>
            <div className="lb-build-row"><span>Zeolite</span><span>{build.zeolite}</span></div>
            <div className="lb-build-row"><span>LobsterJet</span><span>{build.lobsterjet}</span></div>
            <div className="lb-build-row"><span>Build</span><span>{build.buildShort}</span></div>
          </div>
        ) : buildError ? (
          <p className="lb-muted" style={{ fontSize: 12 }}>Build information unavailable on this deployment.</p>
        ) : (
          <p className="lb-muted" style={{ fontSize: 12 }}>Loading build information...</p>
        )}
      </div>
    </section>
  );
}
