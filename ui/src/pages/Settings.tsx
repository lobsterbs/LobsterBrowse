import { useState } from 'react';

export default function SettingsPage() {
  const [adblock, setAdblock] = useState(true);
  const [webrtcMode, setWebrtcMode] = useState<"direct" | "relay" | "disabled">("relay");
  const [udpOverWisp, setUdpOverWisp] = useState(false);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <h2 style={{ fontSize: 22 }}>Privacy</h2>

      <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Ad blocking (uBlock lists)</span>
        <m3-switch checked={adblock} onClick={() => setAdblock(!adblock)} />
      </label>

      <div>
        <p style={{ fontWeight: 600, marginBottom: 8 }}>WebRTC</p>
        {(["direct", "relay", "disabled"] as const).map((mode) => (
          <label key={mode} style={{ display: "block", marginBottom: 4 }}>
            <input
              type="radio"
              name="webrtc"
              checked={webrtcMode === mode}
              onChange={() => setWebrtcMode(mode)}
            />{" "}
            {mode === "direct" ? "Direct (leaks IP)" : mode === "relay" ? "Relay through server (recommended)" : "Disabled"}
          </label>
        ))}
      </div>

      <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>UDP over Wisp</span>
        <m3-switch checked={udpOverWisp} onClick={() => setUdpOverWisp(!udpOverWisp)} />
      </label>
    </section>
  );
}
