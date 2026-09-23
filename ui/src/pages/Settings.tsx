import { useState } from 'react';

type Props = { seed: string; onSeedChange: (s: string) => void };

const FILTER_LISTS = ["EasyList", "EasyPrivacy", "uBlock filters", "Peter Lowe"];

export default function SettingsPage({ seed, onSeedChange }: Props) {
  const [adblock, setAdblock] = useState(true);
  const [webrtcMode, setWebrtcMode] = useState<"direct" | "relay" | "disabled">("relay");
  const [udpOverWisp, setUdpOverWisp] = useState(false);
  const [spoofUa, setSpoofUa] = useState(true);
  const [localCdn, setLocalCdn] = useState(true);
  const [quotaGb, setQuotaGb] = useState(2);
  const [activeLists, setActiveLists] = useState<string[]>(FILTER_LISTS);

  const toggleList = (name: string) => {
    setActiveLists((xs) => xs.includes(name) ? xs.filter((x) => x !== name) : [...xs, name]);
  };

  return (
    <m3e-content-pane>
      <m3e-heading variant="display" size="large" level={1}>Settings</m3e-heading>

      <m3e-heading variant="headline" size="medium" level={2}>Privacy</m3e-heading>
      <m3e-list>
        <m3e-list-item>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
            <span>Ad blocking (uBlock lists)</span>
            <m3e-switch checked={adblock ? "" : undefined} icons="selected" onClick={() => setAdblock(!adblock)} />
          </div>
        </m3e-list-item>
        <m3e-list-item>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
            <span>Browser spoofing (headers, webdriver)</span>
            <m3e-switch checked={spoofUa ? "" : undefined} icons="selected" onClick={() => setSpoofUa(!spoofUa)} />
          </div>
        </m3e-list-item>
        <m3e-list-item>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
            <span>Local CDN (Decentraleyes)</span>
            <m3e-switch checked={localCdn ? "" : undefined} icons="selected" onClick={() => setLocalCdn(!localCdn)} />
          </div>
        </m3e-list-item>
        <m3e-list-item>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
            <span>UDP over Wisp</span>
            <m3e-switch checked={udpOverWisp ? "" : undefined} icons="selected" onClick={() => setUdpOverWisp(!udpOverWisp)} />
          </div>
        </m3e-list-item>
      </m3e-list>

      <m3e-divider />

      <m3e-heading variant="headline" size="medium" level={2}>WebRTC</m3e-heading>
      <m3e-radio-group>
        <label style={{ display: "flex", gap: 8 }}><m3e-radio value="direct" checked={webrtcMode === "direct" ? "" : undefined} onClick={() => setWebrtcMode("direct")} /> Direct (leaks IP)</label>
        <label style={{ display: "flex", gap: 8 }}><m3e-radio value="relay" checked={webrtcMode === "relay" ? "" : undefined} onClick={() => setWebrtcMode("relay")} /> Relay through server (recommended)</label>
        <label style={{ display: "flex", gap: 8 }}><m3e-radio value="disabled" checked={webrtcMode === "disabled" ? "" : undefined} onClick={() => setWebrtcMode("disabled")} /> Disabled</label>
      </m3e-radio-group>

      <m3e-divider />

      <m3e-heading variant="headline" size="medium" level={2}>Filter lists</m3e-heading>
      <m3e-chip-set>
        {FILTER_LISTS.map((name) => (
          <m3e-chip key={name} variant={activeLists.includes(name) && adblock ? "elevated" : "outlined"} onClick={() => toggleList(name)}>{name}</m3e-chip>
        ))}
      </m3e-chip-set>

      <m3e-divider />

      <m3e-heading variant="headline" size="medium" level={2}>Appearance</m3e-heading>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <m3e-form-field variant="outlined">
          <label slot="label" htmlFor="seed">Dynamic color seed</label>
          <input id="seed" type="color" value={seed} onChange={(e: any) => onSeedChange(e.target.value)} style={{ width: 64, height: 40, padding: 4 }} />
        </m3e-form-field>
        <m3e-chip-set>
          <m3e-chip variant="elevated" onClick={() => onSeedChange("#E8552F")}>Lobster</m3e-chip>
          <m3e-chip onClick={() => onSeedChange("#6750A4")}>Baseline</m3e-chip>
          <m3e-chip onClick={() => onSeedChange("#2E7D32")}>Forest</m3e-chip>
        </m3e-chip-set>
      </div>

      <m3e-divider />

      <m3e-heading variant="headline" size="medium" level={2}>Free-tier daily quota</m3e-heading>
      <m3e-slider min="0" max="10" step="1">
        <m3e-slider-thumb value={String(quotaGb)} />
      </m3e-slider>
      <p style={{ opacity: 0.8 }}>{quotaGb} GB / day (relay media counts double)</p>
    </m3e-content-pane>
  );
}