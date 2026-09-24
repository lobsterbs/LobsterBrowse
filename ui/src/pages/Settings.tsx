import { useState } from 'react';
import { ENGINES, type EngineId, type Settings } from '../settings';

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
};

const SEEDS: Array<[string, string]> = [
  ["#E8552F", "Lobster"],
  ["#6750A4", "Baseline"],
  ["#006A6A", "Teal"],
  ["#4F5B92", "Slate"],
];

export default function SettingsPanel({ settings, onChange }: Props) {
  const [privacyOpen, setPrivacyOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(true);

  const row = (label: string, icon: string, on: boolean, toggle: () => void) => (
    <m3e-list-item>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, width: "100%" }}>
        <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <m3e-icon name={icon} aria-hidden={true} />
          {label}
        </span>
        <m3e-switch checked={on ? "" : undefined} icons="selected" onClick={toggle} />
      </div>
    </m3e-list-item>
  );

  return (
    <section style={{ marginTop: 16 }} aria-label="Settings">
      <m3e-heading variant="title" size="medium" level={2}>Settings</m3e-heading>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 4 }}>
        Saved on this device only — never sent to the server.
      </p>

      <m3e-expansion-panel
        open={searchOpen ? "" : undefined}
        onClick={() => setSearchOpen(!searchOpen)}
      >
        <span slot="header"><m3e-icon name="search" aria-hidden={true} /> Search &amp; browse</span>
        <div style={{ padding: "12px 16px" }}>
          <div style={{ marginBottom: 8 }}>Search engine</div>
          <m3e-segmented-button aria-label="Search engine">
            {(Object.keys(ENGINES) as EngineId[]).map((id) => (
              <m3e-button-segment
                key={id}
                checked={settings.engine === id ? "" : undefined}
                onClick={() => onChange({ engine: id })}
              >
                {ENGINES[id].name}
              </m3e-button-segment>
            ))}
          </m3e-segmented-button>
          <div style={{ marginTop: 8 }}>
            {row("Proxy through server", "vpn_lock", settings.proxySearch, () => onChange({ proxySearch: !settings.proxySearch }))}
            {row("SafeSearch", "family_restroom", settings.safeSearch, () => onChange({ safeSearch: !settings.safeSearch }))}
            {row("Open searches in new tab", "open_in_new", settings.openSearchNewTab, () => onChange({ openSearchNewTab: !settings.openSearchNewTab }))}
            {row("Open URLs in new tab", "tab", settings.urlNewTab, () => onChange({ urlNewTab: !settings.urlNewTab }))}
          </div>
        </div>
      </m3e-expansion-panel>

      <m3e-expansion-panel
        open={privacyOpen ? "" : undefined}
        onClick={() => setPrivacyOpen(!privacyOpen)}
      >
        <span slot="header"><m3e-icon name="lock" aria-hidden={true} /> Privacy</span>
        <m3e-list>
          {row("Ad blocking", "shield", settings.adblock, () => onChange({ adblock: !settings.adblock }))}
          {row("Tracker blocking", "track_changes", settings.trackers, () => onChange({ trackers: !settings.trackers }))}
          {row("Browser spoofing", "person_off", settings.spoofUa, () => onChange({ spoofUa: !settings.spoofUa }))}
          {row("Strip referrers", "link_off", settings.stripReferrer, () => onChange({ stripReferrer: !settings.stripReferrer }))}
        </m3e-list>
      </m3e-expansion-panel>

      <m3e-expansion-panel>
        <span slot="header"><m3e-icon name="lan" aria-hidden={true} /> Connection</span>
        <m3e-list>
          {row("UDP over Wisp", "swap_vert", settings.udp, () => onChange({ udp: !settings.udp }))}
          {row("HTTPS-only", "https", settings.httpsOnly, () => onChange({ httpsOnly: !settings.httpsOnly }))}
        </m3e-list>
        <m3e-divider />
        <div style={{ padding: "12px 16px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <m3e-icon name="p2p" aria-hidden={true} /> WebRTC
          </div>
          <m3e-segmented-button aria-label="WebRTC mode">
            {(["direct", "relay", "disabled"] as const).map((m) => (
              <m3e-button-segment
                key={m}
                checked={settings.webrtc === m ? "" : undefined}
                onClick={() => onChange({ webrtc: m })}
              >
                {m}
              </m3e-button-segment>
            ))}
          </m3e-segmented-button>
        </div>
      </m3e-expansion-panel>

      <m3e-expansion-panel>
        <span slot="header"><m3e-icon name="palette" aria-hidden={true} /> Appearance</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "12px 16px", flexWrap: "wrap" }}>
          <input
            type="color"
            aria-label="Theme color"
            value={settings.seed}
            onChange={(e) => onChange({ seed: e.target.value })}
            style={{ width: 40, height: 32, border: "none", background: "none", cursor: "pointer" }}
          />
          <m3e-chip-set>
            {SEEDS.map(([hex, name]) => (
              <m3e-chip
                key={hex}
                selected={settings.seed === hex ? "" : undefined}
                onClick={() => onChange({ seed: hex })}
              >
                {name}
              </m3e-chip>
            ))}
          </m3e-chip-set>
        </div>
        <div style={{ padding: "0 16px 12px" }}>
          {row("Show feature chips", "chip", settings.showFeatureChips, () => onChange({ showFeatureChips: !settings.showFeatureChips }))}
        </div>
      </m3e-expansion-panel>
    </section>
  );
}
