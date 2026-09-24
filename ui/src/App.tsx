import { useState } from 'react';
import HomePage from './pages/Home';
import SettingsPanel from './pages/Settings';

const SEED = "#E8552F"; // lobster orange

type View = "home" | "settings";

export default function App() {
  const [seed, setSeed] = useState(SEED);
  const [view, setView] = useState<View>("home");

  return (
    <m3e-theme color={seed} strong-focus={true}>
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <m3e-nav-rail id="nav-rail" mode="auto" aria-label="LobsterBrowse">
          <m3e-icon-button toggle aria-label="Toggle navigation rail">
            <m3e-icon name="menu" aria-hidden={true} />
            <m3e-icon slot="selected" name="menu_open" aria-hidden={true} />
            <m3e-nav-rail-toggle for="nav-rail" />
          </m3e-icon-button>
          <m3e-nav-item
            selected={view === "home" ? "" : undefined}
            onClick={() => setView("home")}
          >
            <m3e-icon slot="icon" name="home" aria-hidden={true} />Home
          </m3e-nav-item>
          <m3e-nav-item
            selected={view === "settings" ? "" : undefined}
            onClick={() => setView("settings")}
          >
            <m3e-icon slot="icon" name="settings" aria-hidden={true} />Settings
          </m3e-nav-item>
        </m3e-nav-rail>

        <div style={{ flex: 1, maxWidth: 640, margin: "0 auto", padding: "32px 24px 48px", width: "100%" }}>
          <m3e-heading variant="title" size="large" level={1}>🦞 LobsterBrowse</m3e-heading>
          {view === "home"
            ? <HomePage />
            : <SettingsPanel seed={seed} onSeedChange={setSeed} />}
          <footer style={{ marginTop: 48, opacity: 0.5, fontSize: 13, textAlign: "center" }}>
            Free · Private · No logs
          </footer>
        </div>
      </div>
    </m3e-theme>
  );
}
