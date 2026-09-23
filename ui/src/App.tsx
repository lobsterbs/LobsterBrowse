import { useState } from 'react';
import HomePage from './pages/Home';
import SettingsPage from './pages/Settings';

type Page = "home" | "settings";

const SEED = "#E8552F"; // lobster orange — dynamic color seed for <m3e-theme>

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [seed, setSeed] = useState(SEED);

  return (
    <m3e-theme color={seed} strong-focus={true}>
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <aside style={{ width: 260, padding: 16, borderRight: "1px solid var(--md-sys-color-outline-variant, rgba(0,0,0,0.1))" }}>
          <m3e-heading variant="headline" size="medium" level={1}>🦞 LobsterBrowse</m3e-heading>
          <m3e-nav-menu>
            <m3e-nav-menu-item onClick={() => setPage("home")}>
              <m3e-icon slot="icon" name="home" aria-hidden={true} />
              <span slot="label">Home</span>
            </m3e-nav-menu-item>
            <m3e-nav-menu-item onClick={() => setPage("settings")}>
              <m3e-icon slot="icon" name="settings" aria-hidden={true} />
              <span slot="label">Settings</span>
            </m3e-nav-menu-item>
          </m3e-nav-menu>
        </aside>
        <main style={{ flex: 1, maxWidth: 880, margin: "0 auto", padding: 24 }}>
          {page === "home" ? <HomePage /> : <SettingsPage seed={seed} onSeedChange={setSeed} />}
        </main>
      </div>
    </m3e-theme>
  );
}