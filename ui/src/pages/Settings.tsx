import { useState, type ReactNode } from "react";
import {
  ENGINES,
  UA_PRESETS,
  type EngineId,
  type Settings,
  type SiteRule,
  type UaPresetId,
} from "../settings";

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  rules: SiteRule[];
  onRulesChange: (rules: SiteRule[]) => void;
  onOpenLogs: () => void;
  onDeleteAll: () => void;
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

function Row(props: { label: string; icon: string; on: boolean; toggle: () => void }) {
  return (
    <m3e-list-item>
      <div className="lb-setting-row">
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

export default function SettingsPanel({ settings, onChange, rules, onRulesChange, onOpenLogs, onDeleteAll }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({
    search: true,
    ua: true,
    privacy: true,
    appearance: false,
    cloak: false,
    advanced: false,
  });
  const toggle = (key: string) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [ruleDomain, setRuleDomain] = useState("");
  const [ruleUa, setRuleUa] = useState<UaPresetId>("server-default");
  const [ruleAdblock, setRuleAdblock] = useState(true);

  return (
    <section className="lb-view-content" aria-label="Settings">
      <m3e-heading variant="title" size="medium" level={2}>Settings</m3e-heading>
      <p className="lb-muted" style={{ marginTop: 4 }}>
        Saved on this device only. Toggles marked server-side change how the engine fetches pages.
      </p>

      <Panel id="panel-search" icon="search" title="Search & browse" open={open.search} toggle={() => toggle("search")}>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Proxy engine</div>
          <m3e-segmented-button aria-label="Proxy engine">
            <m3e-button-segment checked={settings.proxyEngine === "lobsterjet" ? "" : undefined} onClick={() => onChange({ proxyEngine: "lobsterjet" })}>
              LobsterJet — default
            </m3e-button-segment>
            <m3e-button-segment checked={settings.proxyEngine !== "lobsterjet" ? "" : undefined} onClick={() => onChange({ proxyEngine: "scramjet" })}>
              ScramJet
            </m3e-button-segment>
          </m3e-segmented-button>
          <p className="lb-muted" style={{ marginTop: 6, fontSize: 12 }}>
            LobsterJet is the service-worker streaming engine and the project default. It is still
            pre-release: no server deployment provides it yet, so until it ships, every navigation is
            served by the ScramJet server-side rewriter on this server regardless of this choice.
            ScramJet does adblock/tracker stripping, HTTPS-only enforcement, privacy signals
            (Sec-GPC / DNT), image compression and AMP de-amping on every upstream request.
          </p>
        </div>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Search engine</div>
          <m3e-segmented-button aria-label="Search engine">
            {(Object.keys(ENGINES) as EngineId[]).map((id) => (
              <m3e-button-segment key={id} checked={settings.engine === id ? "" : undefined} onClick={() => onChange({ engine: id })}>
                {ENGINES[id].name}
              </m3e-button-segment>
            ))}
          </m3e-segmented-button>
        </div>
        <m3e-list>
          <Row label="Proxy through server (server-side)" icon="vpn_lock" on={settings.proxySearch} toggle={() => onChange({ proxySearch: !settings.proxySearch })} />
          <Row label="HTTPS-only (server-side)" icon="https" on={settings.httpsOnly} toggle={() => onChange({ httpsOnly: !settings.httpsOnly })} />
        </m3e-list>
      </Panel>

      <Panel id="panel-ua" icon="devices" title="User-Agent" open={open.ua} toggle={() => toggle("ua")}>
        <div className="lb-setting-group">
          <div className="lb-setting-label">Preset</div>
          <m3e-segmented-button aria-label="User-Agent preset">
            {(Object.keys(UA_PRESETS) as Array<Exclude<UaPresetId, "custom">>).map((id) => (
              <m3e-button-segment key={id} checked={settings.uaPreset === id ? "" : undefined} onClick={() => onChange({ uaPreset: id })}>
                {UA_PRESETS[id].name}
              </m3e-button-segment>
            ))}
            <m3e-button-segment checked={settings.uaPreset === "custom" ? "" : undefined} onClick={() => onChange({ uaPreset: "custom" })}>
              Custom
            </m3e-button-segment>
          </m3e-segmented-button>
        </div>
        {settings.uaPreset === "custom" && (
          <div className="lb-setting-group">
            <TextInput
              label="Custom User-Agent (server-side)"
              value={settings.uaCustom}
              placeholder="Mozilla/5.0 …"
              onChange={(v) => onChange({ uaCustom: v })}
            />
          </div>
        )}
      </Panel>

      <Panel id="panel-privacy" icon="lock" title="Privacy" open={open.privacy} toggle={() => toggle("privacy")}>
        <m3e-list>
          <Row label="Ad blocking (server-side)" icon="shield" on={settings.adblock} toggle={() => onChange({ adblock: !settings.adblock })} />
          <Row label="Tracker blocking (server-side)" icon="track_changes" on={settings.trackers} toggle={() => onChange({ trackers: !settings.trackers })} />
          <Row
            label="Compress JPEG images (server-side)"
            icon="compress"
            on={settings.compressImages}
            toggle={() => onChange({ compressImages: !settings.compressImages })}
          />
        </m3e-list>
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
          <div className="lb-setting-label">Custom outbound headers (server-side)</div>
          <p className="lb-muted">
            One header per line, "Name: value". Applied to every upstream request, so a profile can
            override the engine defaults. Host, Content-Length, Connection, Transfer-Encoding and
            Cookie are blocked.
          </p>
          <textarea
            className="lb-input lb-console-area"
            rows={3}
            aria-label="Custom outbound headers"
            placeholder={"Accept-Language: nb-NO,nb;q=0.9\nX-Custom-Header: anything"}
            value={settings.customHeaders}
            spellCheck={false}
            onChange={(e) => onChange({ customHeaders: e.target.value })}
          />
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
              <span className="lb-muted">Delete bookmarks, history, sessions and settings on this device?</span>
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
    </section>
  );
}
