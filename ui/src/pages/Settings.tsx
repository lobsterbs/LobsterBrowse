import { useState } from 'react';

type Props = { seed: string; onSeedChange: (s: string) => void };

export default function SettingsPanel({ seed, onSeedChange }: Props) {
  const [adblock, setAdblock] = useState(true);
  const [spoofUa, setSpoofUa] = useState(true);
  const [udp, setUdp] = useState(false);
  const [webrtc, setWebrtc] = useState<"direct" | "relay" | "disabled">("relay");

  const row = (label: string, on: boolean, toggle: () => void) => (
    <m3e-list-item>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, width: "100%" }}>
        <span>{label}</span>
        <m3e-switch checked={on ? "" : undefined} icons="selected" onClick={toggle} />
      </div>
    </m3e-list-item>
  );

  return (
    <m3e-card variant="outlined" style={{ marginTop: 32 }}>
      <m3e-heading slot="header" variant="title" size="medium">Settings</m3e-heading>
      <div slot="content">
        <m3e-list>
          {row("Ad blocking", adblock, () => setAdblock(!adblock))}
          {row("Browser spoofing", spoofUa, () => setSpoofUa(!spoofUa))}
          {row("UDP over Wisp", udp, () => setUdp(!udp))}
        </m3e-list>
        <m3e-divider />
        <div style={{ marginTop: 12 }}>
          {(["direct", "relay", "disabled"] as const).map((m) => (
            <label key={m} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0" }}>
              <m3e-radio value={m} checked={webrtc === m ? "" : undefined} onClick={() => setWebrtc(m)} />
              WebRTC: {m === "relay" ? "relay (recommended)" : m}
            </label>
          ))}
        </div>
        <m3e-divider />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          <input
            type="color"
            aria-label="Theme color"
            value={seed}
            onChange={(e) => onSeedChange(e.target.value)}
            style={{ width: 40, height: 32, border: "none", background: "none", cursor: "pointer" }}
          />
          <m3e-chip onClick={() => onSeedChange("#E8552F")}>Lobster</m3e-chip>
          <m3e-chip onClick={() => onSeedChange("#6750A4")}>Baseline</m3e-chip>
        </div>
      </div>
    </m3e-card>
  );
}
