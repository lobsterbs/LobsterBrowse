import { useState } from 'react';
import HomePage from './pages/Home';
import SettingsPanel from './pages/Settings';
import { loadSettings, saveSettings, type Settings, type EngineId } from './settings';

type View = "home" | "settings";

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [view, setView] = useState<View>("home");

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  };

  return (
    <m3e-theme color={settings.seed} strong-focus={true}>
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <m3e-nav-rail id="nav-rail" mode="auto" aria-label="LobsterBrowse">
          <m3e-icon-button toggle aria-label="Toggle navigation rail">
            <m3e-icon name="menu" aria-hidden={true} />
            <m3e-icon slot="selected" name="menu_open" aria-hidden={true} />
            <m3e-nav-rail-toggle for="nav-rail" />
          </m3e-icon-button>
          <m3e-nav-item
            id="nav-home"
            selected={view === "home" ? "" : undefined}
            onClick={() => setView("home")}
          >
            <m3e-icon slot="icon" name="home" aria-hidden={true} />Home
          </m3e-nav-item>
          <m3e-tooltip for="nav-home" position="after">Browse</m3e-tooltip>
          <m3e-nav-item
            id="nav-settings"
            selected={view === "settings" ? "" : undefined}
            onClick={() => setView("settings")}
          >
            <m3e-icon slot="icon" name="settings" aria-hidden={true} />Settings
          </m3e-nav-item>
          <m3e-tooltip for="nav-settings" position="after">Preferences — saved on this device</m3e-tooltip>
        </m3e-nav-rail>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", width: "100%" }}>
          <m3e-app-bar>
            <m3e-avatar slot="leading" aria-hidden={true}>🦞</m3e-avatar>
            <span slot="title">LobsterBrowse</span>
            <span slot="subtitle">Free · Private · No logs</span>
          </m3e-app-bar>

          <div style={{ maxWidth: 640, margin: "0 auto", padding: "24px 24px 48px", width: "100%" }}>
            {view === "home"
              ? <HomePage settings={settings} onEngineChange={(e: EngineId) => update({ engine: e })} />
              : <SettingsPanel settings={settings} onChange={update} />}
          </div>
        </div>
      </div>
    </m3e-theme>
  );
}
