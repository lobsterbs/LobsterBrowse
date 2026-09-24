import { useState } from 'react';
import HomePage from './pages/Home';
import SettingsPanel from './pages/Settings';

const SEED = "#E8552F"; // lobster orange

export default function App() {
  const [seed, setSeed] = useState(SEED);
  const [showSettings, setShowSettings] = useState(false);

  return (
    <m3e-theme color={seed} strong-focus={true}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "32px 24px 48px" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 48 }}>
          <m3e-heading variant="title" size="large" level={1}>🦞 LobsterBrowse</m3e-heading>
          <m3e-icon-button aria-label="Settings" onClick={() => setShowSettings(!showSettings)}>
            <m3e-icon name="settings" aria-hidden={true} />
          </m3e-icon-button>
        </header>
        <HomePage />
        {showSettings && <SettingsPanel seed={seed} onSeedChange={setSeed} />}
        <footer style={{ marginTop: 48, opacity: 0.5, fontSize: 13, textAlign: "center" }}>
          Free · Private · No logs
        </footer>
      </div>
    </m3e-theme>
  );
}
