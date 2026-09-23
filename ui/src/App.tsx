import { useState } from 'react';
import HomePage from './pages/Home';
import SettingsPage from './pages/Settings';

type Page = "home" | "settings";

export default function App() {
  const [page, setPage] = useState<Page>("home");
  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: 16 }}>

      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <h1 style={{ fontSize: 32, margin: 0 }}>&#129434; LobsterBrowse</h1>
        <nav style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <m3-filled-button onClick={() => setPage("home")}>
            {page === "home" ? "Home" : "Home"}
          </m3-filled-button>
          <m3-tonal-button onClick={() => setPage("settings")}>
            Settings
          </m3-tonal-button>
        </nav>
      </header>

      {page === "home" ? <HomePage /> : <SettingsPage />}
    </div>
  );
}
