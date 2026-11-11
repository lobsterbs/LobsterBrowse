import { useEffect, useRef, useState, type ReactNode } from "react";
/* Settings (global redesign, user request 2026-11-07): the whole page
   is one @m3e/web surface. The page title lives in an m3e-content-pane;
   every settings sub-card is an m3e-expansion-panel whose header
   carries the headline and supporting text (the @m3e/web shape of the
   example markup), and every toggle row uses the normal m3e-switch
   (no icon-on-switch variant). While ScramJet is the current proxy
   engine, every Zeolite-only option is greyed out. The previous
   md-card components are gone; no option was lost.
   Follow-up (user request 2026-11-07): a sub option whose entire
   payload is one control renders as an inline row card, not an
   expansion panel - one switch behind a chevron is a wasted click. */
import {
  ENGINES,
  type EngineId,
  type Settings,
  type SiteRule,
} from "../settings";
import { zlSend } from "../zeolite";
import { pushLog } from "../store";
import M3eSelect from "../M3eSelect";
import AmoSearch from "../browser/AmoSearch";
import ExtManage from "../browser/ExtManage";
import { extWarnings } from "../browser/browserShared";

/* Cloaking popout: a fresh window whose address bar reads about:blank.
   The window inherits this origin, so the app and its service worker run
   normally inside the iframe; severing opener removes the window.opener
   link. Settings changes sync only after the new window reloads. */
function openInAboutBlank() {
  const w = window.open("about:blank", "_blank");
  if (!w) {
    pushLog("warn", "settings: the browser blocked the about:blank popout (popup blocker)");
    return;
  }
  w.opener = null;
  const d = w.document;
  d.title = "about:blank";
  const style = d.createElement("style");
  style.textContent = "html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{border:0;width:100%;height:100%}";
  d.head.appendChild(style);
  const frame = d.createElement("iframe");
  frame.src = window.location.origin + "/";
  d.body.appendChild(frame);
  pushLog("info", "settings: opened LobsterBrowse in an about:blank window");
}

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  rules: SiteRule[];
  onRulesChange: (rules: SiteRule[]) => void;
  onOpenLogs: () => void;
  onDeleteAll: () => void;
};

/* Wave 101 (#256): the default seed was the indigo-violet default
   every generated interface ships. The default is now derived from
   the product (a lobster red-orange); the old baseline stays as
   "Violet" for anyone attached to it. */
const SEEDS: Array<[string, string]> = [
  ["#BC4B2A", "Lobster"],
  ["#006A6A", "Teal"],
  ["#4F5B92", "Slate"],
  ["#6750A4", "Violet"],
];

const SECTION_TITLES: Record<string, string> = {
  search: "Search & browse",
  privacy: "Privacy",
  extensions: "Extensions",
  appearance: "Appearance",
  cloak: "Auto Cloak",
  advanced: "Advanced",
  about: "About",
};

/* Wave 101 (#256): each section reads as one M3 group: an icon tile
   on primary-container, a title heading and a supporting line. */
const SECTION_META: Record<string, { icon: string; sub: string }> = {
  search: { icon: "search", sub: "Engine and omnibox behavior" },
  privacy: { icon: "shield", sub: "Blocking and connection upgrades" },
  extensions: { icon: "extension", sub: "Add-ons from the catalog or local files" },
  appearance: { icon: "palette", sub: "Seed color and hero background" },
  cloak: { icon: "visibility_off", sub: "Hide the tab while you are away" },
  advanced: { icon: "tune", sub: "Engines, data and diagnostics" },
  about: { icon: "info", sub: "Versions compiled into this build" },
};

function SectionHead(props: { section: string }) {
  const meta = SECTION_META[props.section];
  return (
    <div className="lb-set-section-head">
      {meta && (
        <span className="lb-set-section-icon" aria-hidden={true}>
          <m3e-icon name={meta.icon} />
        </span>
      )}
      <span className="lb-set-section-text">
        <m3e-heading variant="title" size="small" level={3}>{SECTION_TITLES[props.section]}</m3e-heading>
        {meta && <span className="lb-set-section-sub">{meta.sub}</span>}
      </span>
    </div>
  );
}

/* #198: settings search index. One entry per findable setting; the
   targets are the id attributes set on the inline cards, rows and
   panels below, and
   `panel` is the sub-card panel that owns the target (jumpTo opens
   it before scrolling). */
/* panel is optional: single-control sub options are inline row
   cards that are always visible, so there is no panel to open. */
type SetEntry = { section: string; label: string; terms?: string; panel?: string; target: string };
const SETTING_INDEX: SetEntry[] = [
  { section: "search", label: "Search engine", terms: "default engine google bing duckduckgo brave startpage", target: "set-search-engine" },
  { section: "search", label: "Engine search suggestions", terms: "suggest omnibox autocomplete", target: "set-search-suggest" },
  { section: "privacy", label: "Ad & tracker blocking", terms: "adblock shield ads trackers", target: "set-adblock" },
  { section: "privacy", label: "HTTPS upgrade", terms: "https ssl tls secure", target: "set-https" },
  { section: "extensions", label: "Manage installed extensions", terms: "installed enable disable options remove uninstall", panel: "p-manage-ext", target: "set-manage-ext" },
  { section: "extensions", label: "Find and install add-ons", terms: "amo extensions store addons", panel: "p-amo", target: "set-amo" },
  { section: "extensions", label: "Import locally", terms: "xpi zip package", panel: "p-import", target: "set-import" },
  { section: "appearance", label: "Theme color", terms: "seed palette color colour", panel: "p-theme-color", target: "set-theme-color" },
  { section: "appearance", label: "Enhanced UI (hero background image)", terms: "fancy background hero image photo wallpaper", panel: "p-fancy", target: "set-fancy" },
  { section: "cloak", label: "Cloak when the tab is hidden", terms: "auto cloak hide hidden", target: "set-cloak-enabled" },
  { section: "cloak", label: "Cloak destination", terms: "cloak url site", panel: "p-cloak-url", target: "set-cloak-url" },
  { section: "cloak", label: "Tab title while cloaked", terms: "cloak title name", panel: "p-cloak-url", target: "set-cloak-url" },
  { section: "cloak", label: "Open in about:blank", terms: "popout window blank", panel: "p-aboutblank", target: "set-aboutblank" },
  { section: "advanced", label: "Proxy engine", terms: "zeolite scramjet engine", panel: "p-proxy", target: "set-proxy" },
  { section: "advanced", label: "Transport engine", terms: "libcurl epoxy tls transport", panel: "p-transport", target: "set-transport" },
  { section: "advanced", label: "Data", terms: "delete cache data", target: "set-data" },
  { section: "advanced", label: "Logs", terms: "diagnostics history log", target: "set-logs" },
];

/* One settings sub-card = one expansion panel. The header carries the
   headline and supporting text; the body carries the controls. Only the
   header span toggles open state, so using a control inside the body
   never collapses the panel. */
function SetPanel(props: {
  id: string;
  headline: string;
  sub: string;
  open: boolean;
  toggle: () => void;
  anchorId?: string;
  children: ReactNode;
}) {
  return (
    <m3e-expansion-panel id={props.id} open={props.open ? "" : undefined}>
      <span slot="header" className="lb-setp-head" onClick={props.toggle}>
        <span className="lb-setp-headline">{props.headline}</span>
        <span className="lb-setp-sub">{props.sub}</span>
      </span>
      <div className="lb-setp-body">
        {props.anchorId && <div className="lb-set-anchor" id={props.anchorId} tabIndex={-1} />}
        {props.children}
      </div>
    </m3e-expansion-panel>
  );
}

/* Single-control sub-card (user request 2026-11-07): a sub option
   whose entire payload is one control renders as an inline row card,
   not an expansion panel - one switch behind a chevron is a wasted
   click. The headline and supporting text sit beside the control;
   on/toggle render the switch, children any other single control.
   Sub options with several controls or an explanatory body keep
   their panels. */
function SetInline(props: {
  anchorId?: string;
  label: string;
  desc?: string;
  on?: boolean;
  toggle?: () => void;
  disabled?: boolean;
  danger?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={"lb-set-inline" + (props.danger ? " lb-set-danger" : "") + (props.disabled ? " lb-zl-off" : "")}
      id={props.anchorId}
      tabIndex={props.anchorId ? -1 : undefined}
      aria-disabled={props.disabled ? "true" : undefined}
    >
      <span className="lb-setting-text">
        <span className="lb-setting-label">{props.label}</span>
        {props.desc ? <span className="lb-setting-desc">{props.desc}</span> : null}
      </span>
      {props.on !== undefined ? (
        <m3e-switch
          checked={props.on ? "" : undefined}
          disabled={props.disabled ? true : undefined}
          onClick={props.disabled ? undefined : props.toggle}
        />
      ) : (
        props.children
      )}
    </div>
  );
}

/* Toggle row: the setting title, then the NORMAL m3e-switch (no icon
   variant). `disabled` greyes the whole row out (Zeolite-only options
   while ScramJet is the current engine). */
function Row(props: { id?: string; label: string; on: boolean; toggle: () => void; disabled?: boolean }) {
  return (
    <div
      className={"lb-setting-row" + (props.disabled ? " lb-zl-off" : "")}
      id={props.id}
      tabIndex={props.id ? -1 : undefined}
      aria-disabled={props.disabled ? "true" : undefined}
    >
      <span className="lb-setting-label">{props.label}</span>
      <m3e-switch
        checked={props.on ? "" : undefined}
        disabled={props.disabled ? true : undefined}
        onClick={props.disabled ? undefined : props.toggle}
      />
    </div>
  );
}

/* Text input on the M3E form field: the field owns the outline,
   floating label and focus treatment; the input itself stays native
   (M3E has no standalone text-field component). Validation is native
   constraint validation (required/pattern): the form field shows the
   `error` slot message once the control is invalid and the user has
   interacted with it (see M3E form-field docs). */
function TextInput(props: {
  label: string;
  value: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
  disabled?: boolean;
  pattern?: string;
  hint?: string;
  errorMessage?: string;
  onChange: (v: string) => void;
}) {
  const id = "lb-ti-" + props.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <m3e-form-field {...{ class: "lb-text-input" }}>
      <label slot="label" htmlFor={id}>{props.label}</label>
      <input
        id={id}
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        required={props.required}
        disabled={props.disabled}
        pattern={props.pattern}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <span slot="hint">{props.hint}</span>}
      {props.errorMessage && <span slot="error">{props.errorMessage}</span>}
    </m3e-form-field>
  );
}

export default function SettingsPanel({ settings, onChange, onOpenLogs, onDeleteAll }: Props) {
  /* Sub-card open state: independent panels (no accordion wrapper),
     several open at once. All panels start closed; the single-control
     sub options are inline row cards now, so nothing needs a head
     start. */
  const [openP, setOpenP] = useState<Record<string, boolean>>({});
  const toggleP = (id: string) => setOpenP((prev) => ({ ...prev, [id]: !prev[id] }));

  /* ScramJet is the current engine: every Zeolite-only option greyes
     out. The options keep their stored values and come back when the
     proxy engine returns to Zeolite. */
  const zlOff = settings.proxyEngine === "scramjet";
  const zlNote = (
    <div className="lb-zl-banner" role="note">
      <m3e-icon name="info" aria-hidden={true} />
      <span>
        Zeolite engine only - inactive while ScramJet is the current engine (Advanced &gt; Proxy engine).
      </span>
    </div>
  );

  /* #198: searchable Settings - all local, no persistence change. */
  const [q, setQ] = useState("");
  const [chipSection, setChipSection] = useState("all");
  const handleQuery = (v: string) => {
    setQ(v);
    setChipSection("all");
  };
  const needle = q.trim().toLowerCase();
  const hits = needle
    ? SETTING_INDEX.filter((e) =>
        (e.label + " " + (e.terms ?? "") + " " + SECTION_TITLES[e.section]).toLowerCase().includes(needle),
      )
    : [];
  const resultSections = ["all", ...Array.from(new Set(hits.map((h) => h.section)))];
  const shownHits = chipSection === "all" ? hits : hits.filter((h) => h.section === chipSection);
  const jumpTo = (entry: SetEntry) => {
    const panel = entry.panel;
    if (panel) setOpenP((prev) => ({ ...prev, [panel]: true }));
    setQ("");
    /* Let the panel expand before scrolling. */
    setTimeout(() => {
      const el = document.getElementById(entry.target);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus({ preventScroll: true });
    }, 120);
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  /* m3e-dialog opens/closes imperatively (show/hide methods, per the
     M3E dialog docs). React state mirrors it: opening sets the flag,
     and the dialog's `closed` event (fired for button, Escape, and
     backdrop dismissals alike) resets it, so the dialog can never get
     stuck open after a non-React dismissal. */
  const deleteDialogRef = useRef<HTMLElement & { show: () => void; hide: () => void } | null>(null);
  useEffect(() => {
    const el = deleteDialogRef.current;
    if (!el) return;
    const onClosed = () => setConfirmDelete(false);
    el.addEventListener("closed", onClosed);
    return () => el.removeEventListener("closed", onClosed);
  }, []);
  useEffect(() => {
    if (confirmDelete) deleteDialogRef.current?.show();
  }, [confirmDelete]);

  /* Extension import: one action, Import package (.xpi/.zip). The file
     bytes are handed to the engine worker, which owns the package
     parser and registration. Import results report through the
     snackbar (the inline status line and the other transient status
     cards are gone). */
  /* #262: visible busy state for the import. The engine zl:installExt
     call is one-shot (no progress events), so the progress is honestly
     indeterminate, never a fake percentage. */
  const [extImporting, setExtImporting] = useState(false);
  const importZip = async (file: File) => {
    if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
      M3eSnackbar.open("Importing " + file.name + "...", { duration: 3000 });
    }
    setExtImporting(true);
    try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const rep = await zlSend({ type: "zl:installExt", bytes }, 20000);
    const warnings = extWarnings(rep);
    if (rep && rep.ok) {
      if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
        M3eSnackbar.open("Installed " + String(rep.id) + (warnings.length ? " (warnings: " + warnings.join(", ") + ")" : ""), { duration: 5000 });
      }
      /* #230: the manage list in this panel re-lists when an install
         lands. */
      window.dispatchEvent(new CustomEvent("lb-ext-changed"));
    } else {
      const msg = rep && rep.error ? "Import failed: " + String(rep.error) : "Import failed: the Zeolite service worker could not be reached on this origin.";
      pushLog("error", "extension import: " + msg);
      if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
        M3eSnackbar.open(msg, { duration: 7000 });
      }
    }
    } finally {
      setExtImporting(false);
    }
  };

  /* About / Build: one authoritative source. The /build endpoint on
     the deployed server reports the versions compiled into that exact
     build plus its deployment git commit, so the UI never claims a
     version the deployed build does not have. */
  const [build, setBuild] = useState<{
    lb: string;
    zeolite: string;
    scramjet: string;
    build: string;
    buildShort: string;
  } | null>(null);
  const [buildError, setBuildError] = useState(false);
  const [buildErrorDetail, setBuildErrorDetail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    /* Cache-busted: some edge caches serve a stale /build despite
       no-store, which previously left the About pills stuck on
       "Loading". Failures now log to the client log (visible on the
       Logs page) with the actual reason instead of failing silently. */
    fetch("/build?t=" + Date.now(), { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json() as Promise<{
          ok: boolean;
          lb?: string;
          zeolite?: string;
          scramjet?: string;
          zlswSha?: string;
          build?: string;
          buildShort?: string;
        }>;
      })
      .then((d) => {
        if (cancelled) return;
        if (d && d.ok && d.lb) {
          setBuild({
            lb: String(d.lb),
            zeolite: String(d.zeolite ?? "unknown"),
            scramjet: String(d.scramjet ?? "unknown"),
            build: String(d.build ?? "unknown"),
            buildShort: String(d.buildShort ?? "unknown"),
          });
          setBuildErrorDetail(null);
        } else {
          setBuildError(true);
          setBuildErrorDetail("endpoint returned " + JSON.stringify(d).slice(0, 120));
          pushLog("warn", "settings: /build returned an unexpected body");
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setBuildError(true);
        setBuildErrorDetail(msg);
        pushLog("error", "settings: /build fetch failed: " + msg);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="lb-view-content" aria-label="Settings">
      {/* The page lives in an m3e-content-pane: the shaped scroll
          surface the component provides. */}
      <m3e-content-pane {...{ class: "lb-set-pane" }}>
        {/* The wrapper carries the page rhythm: the pane's scroll
            container sits inside the component's shadow root, so
            the column spacing must live on the page content. */}
        <div className="lb-set-page">
          <div className="lb-set-title">
            <m3e-heading variant="title" size="medium" level={2}>Settings</m3e-heading>
            <p className="lb-set-title-sub">Everything stays on this device. Changes apply immediately.</p>
          </div>

          {/* #198: search-first Settings. A query swaps the panels for
              a flat result list; picking a result expands the owning
              panel, clears the query and scrolls the row into view. */}
          <div className="lb-set-search">
            <TextInput label="Search settings" value={q} onChange={handleQuery} />
          </div>
          {q.trim() ? (
            <div className="lb-set-results">
              {resultSections.length > 1 && (
                <m3e-chip-set {...{ class: "lb-set-chips" }}>
                  {resultSections.map((s2) => (
                      <m3e-chip
                        key={"f-" + s2}
                        selected={chipSection === s2 ? "" : undefined}
                        onClick={() => setChipSection(chipSection === s2 ? "all" : s2)}
                      >
                        {s2 === "all" ? "All" : SECTION_TITLES[s2]}
                      </m3e-chip>
                  ))}
                </m3e-chip-set>
              )}
              {shownHits.length === 0 ? (
                <p className="lb-set-noresult">No settings match &quot;{q.trim()}&quot;.</p>
              ) : (
                shownHits.map((h) => (
                  <m3e-card key={"c-" + h.label} variant="filled" {...{ class: "lb-set-result" }}>
                    <button type="button" className="lb-set-result-btn" onClick={() => jumpTo(h)}>
                      <span>{h.label}</span>
                      <span className="lb-set-result-section">{SECTION_TITLES[h.section]}</span>
                    </button>
                  </m3e-card>
                ))
              )}
            </div>
          ) : (
            <>
              <SectionHead section="search" />
              <SetInline
                anchorId="set-search-engine"
                label="Search engine"
                desc="The engine the omnibox, Home and new tabs search with"
              >
                {/* #237: six long engine names cannot share one
                    segmented row; a dropdown select is the M3E control
                    for this cardinality. */}
                <M3eSelect
                  label="Search engine"
                  value={settings.engine}
                  options={(Object.keys(ENGINES) as EngineId[]).map((id) => [id, ENGINES[id].name])}
                  onChange={(v) => onChange({ engine: v as EngineId })}
                />
              </SetInline>
              <SetInline
                anchorId="set-search-suggest"
                label="Engine search suggestions"
                desc="Completions from the search engine while you type"
                on={settings.suggestQueries}
                toggle={() => onChange({ suggestQueries: !settings.suggestQueries })}
              />

              <SectionHead section="appearance" />
              <SetPanel
                id="p-theme-color"
                headline="Theme color"
                sub="The seed color the whole UI palette derives from"
                anchorId="set-theme-color"
                open={!!openP["p-theme-color"]}
                toggle={() => toggleP("p-theme-color")}
              >
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
                        {/* Wave 89: a colored swatch in the chip's icon slot
                           (the plain m3e-chip exposes no avatar slot) so
                           every seed option shows its color (user report
                           2026-11-08). */}
                        <span slot="icon" className="lb-seed-dot" style={{ background: hex }} />
                        {name}
                      </m3e-chip>
                    ))}
                  </m3e-chip-set>
                </div>
              </SetPanel>
              <SetPanel
                id="p-fancy"
                headline="Enhanced UI (hero background image)"
                sub="The photographic hero background on Home and AI"
                open={!!openP["p-fancy"]}
                toggle={() => toggleP("p-fancy")}
              >
                <Row
                  id="set-fancy"
                  label="Enhanced UI (hero background image)"
                  on={settings.fancyBackground}
                  toggle={() => onChange({ fancyBackground: !settings.fancyBackground })}
                />
                <p className="lb-muted">
                  Replaces the flat background with the photographic hero image (the Half-Life wallpaper,
                  wave 92 #245; extended to AI and Settings in wave 96; #261 removed it from Settings) on Home and AI. Off keeps the plain flat background.
                </p>
              </SetPanel>

              <SectionHead section="privacy" />
              <SetInline
                anchorId="set-adblock"
                label="Ad & tracker blocking"
                desc="Block ads and trackers at the engine level"
                on={settings.adblock}
                toggle={() => onChange({ adblock: !settings.adblock })}
                disabled={zlOff}
              />
              {zlOff && zlNote}
              <SetInline
                anchorId="set-https"
                label="HTTPS upgrade"
                desc="Rewrite http page links to https before they are fetched"
                on={settings.httpsUpgrade}
                toggle={() => onChange({ httpsUpgrade: !settings.httpsUpgrade })}
                disabled={zlOff}
              />
              {zlOff && zlNote}
              <p className="lb-muted">
                No silent fallback: a target that fails over https shows the error page instead of quietly downgrading.
              </p>

              <SectionHead section="extensions" />
              <SetPanel
                id="p-manage-ext"
                headline="Manage installed"
                sub="Enable, disable, configure or remove installed add-ons"
                anchorId="set-manage-ext"
                open={!!openP["p-manage-ext"]}
                toggle={() => toggleP("p-manage-ext")}
              >
                {zlOff && zlNote}
                <div className={zlOff ? "lb-zl-guard" : undefined}>
                  {/* #230: the extension configuration UI moved here from
                      the toolbar extension card; the toolbar card now
                      launches the extension UI directly. */}
                  <ExtManage />
                </div>
              </SetPanel>
              <SetPanel
                id="p-amo"
                headline="Find and install add-ons"
                sub="Search the Mozilla add-on catalog and install from it"
                anchorId="set-amo"
                open={!!openP["p-amo"]}
                toggle={() => toggleP("p-amo")}
              >
                {zlOff && zlNote}
                <div className={zlOff ? "lb-zl-guard" : undefined}>
                  {/* AMO web pages are blocked from this deployment's
                      egress; the public API is not, so search and install
                      run over the API instead of the store site. */}
                  <AmoSearch />
                </div>
              </SetPanel>
              <SetPanel
                id="p-import"
                headline="Import locally"
                sub="Install a packed extension from a .xpi or .zip file"
                anchorId="set-import"
                open={!!openP["p-import"]}
                toggle={() => toggleP("p-import")}
              >
                {zlOff && zlNote}
                {/* Exactly one import action: our button triggers the
                    picker; the input itself stays hidden. */}
                <label className="lb-import-row">
                  <input
                    type="file"
                    accept=".xpi,.zip"
                    className="lb-import-file"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) importZip(f);
                      e.target.value = "";
                    }}
                  />
                  <m3e-button disabled={zlOff ? true : undefined} onClick={(e) => (e.currentTarget.parentElement?.querySelector<HTMLInputElement>(".lb-import-file")?.click())}>
                    <m3e-icon name="archive" aria-hidden={true} /> Import package (.xpi / .zip)
                  </m3e-button>
                </label>
                {extImporting && (
                  <div className="lb-import-progress">
                    <m3e-linear-progress-indicator mode="indeterminate" aria-label="Importing extension" />
                  </div>
                )}
                <p className="lb-muted" style={{ marginTop: 4 }}>
                  Allowed files: manifest.json (required), .js scripts, .css, .html, .json, and images
                  (.png, .svg, .webp, .jpg, .ico). No native code (no binaries, no .exe/.dll/.so).
                  The engine validates the manifest and permission grants; a bad package only lands that
                  extension in an error state.
                </p>
              </SetPanel>

              <SectionHead section="cloak" />
              <SetInline
                anchorId="set-cloak-enabled"
                label="Cloak when the tab is hidden"
                desc="Change the tab title and stage a harmless site while the tab is hidden"
                on={settings.cloakEnabled}
                toggle={() => onChange({ cloakEnabled: !settings.cloakEnabled })}
              />
              <SetPanel
                id="p-cloak-url"
                headline="Cloak destination"
                sub="Which site is staged and which title the tab shows while cloaked"
                anchorId="set-cloak-url"
                open={!!openP["p-cloak-url"]}
                toggle={() => toggleP("p-cloak-url")}
              >
                <TextInput label="Cloak destination" value={settings.cloakUrl} onChange={(v) => onChange({ cloakUrl: v })} />
                <TextInput label="Tab title while cloaked" value={settings.cloakTitle} onChange={(v) => onChange({ cloakTitle: v })} />
                <p className="lb-muted">
                  When you switch away from this tab, the tab title changes and a harmless site is staged. When
                  you return, the cloak covers LobsterBrowse Preview until you click "Return". Browsers do not let a
                  page re-render while hidden - this is the strongest behavior a normal web page can offer.
                </p>
              </SetPanel>
              <SetPanel
                id="p-aboutblank"
                headline="Open in about:blank"
                sub="Pop the app out into a window whose address bar reads about:blank"
                anchorId="set-aboutblank"
                open={!!openP["p-aboutblank"]}
                toggle={() => toggleP("p-aboutblank")}
              >
                <m3e-button onClick={openInAboutBlank}>
                  <m3e-icon name="crop_square" aria-hidden={true} /> Open in about:blank
                </m3e-button>
                <p className="lb-muted">
                  Opens a new window whose address bar reads about:blank, with LobsterBrowse loaded inside
                  it. The new window has no connection back to this one and starts from a fresh view of
                  the app (settings sync there only after a reload).
                </p>
              </SetPanel>

              <SectionHead section="advanced" />
              <SetPanel
                id="p-proxy"
                headline="Proxy engine"
                sub="Zeolite (rewriter proxy) or ScramJet (client-side rewrite)"
                anchorId="set-proxy"
                open={!!openP["p-proxy"]}
                toggle={() => toggleP("p-proxy")}
              >
                <div className="lb-seg-wrap">
                  <m3e-segmented-button aria-label="Proxy engine">
                    <m3e-button-segment checked={settings.proxyEngine !== "scramjet" ? "" : undefined} onClick={() => onChange({ proxyEngine: "zeolite" })}>
                      Zeolite (default)
                    </m3e-button-segment>
                    <m3e-button-segment checked={settings.proxyEngine === "scramjet" ? "" : undefined} onClick={() => onChange({ proxyEngine: "scramjet" })}>
                      ScramJet
                    </m3e-button-segment>
                  </m3e-segmented-button>
                </div>
                <p className="lb-muted" style={{ marginTop: 6 }}>
                  ScramJet is the upstream MercuryWorkshop engine, client-side rewriting through its own /sj/ worker. Engine options like adblock, fingerprint spoof and lazy images are Zeolite-only and grey out above while ScramJet is the current engine. Applied on the next navigation.
                </p>
              </SetPanel>
              <SetPanel
                id="p-transport"
                headline="Transport engine"
                sub="How the Zeolite engine terminates TLS upstream"
                anchorId="set-transport"
                open={!!openP["p-transport"]}
                toggle={() => toggleP("p-transport")}
              >
                <div className="lb-seg-wrap">
                  <m3e-segmented-button aria-label="Transport engine" disabled={zlOff ? true : undefined}>
                    <m3e-button-segment disabled={zlOff ? true : undefined} checked={settings.transport !== "epoxy" ? "" : undefined} onClick={() => onChange({ transport: "libcurl" })}>
                      libcurl (default)
                    </m3e-button-segment>
                    <m3e-button-segment disabled={zlOff ? true : undefined} checked={settings.transport === "epoxy" ? "" : undefined} onClick={() => onChange({ transport: "epoxy" })}>
                      epoxy (experimental)
                    </m3e-button-segment>
                  </m3e-segmented-button>
                </div>
                {zlOff && zlNote}
                <p className="lb-muted" style={{ marginTop: 6 }}>
                  epoxy terminates TLS with rustls instead of libcurl&apos;s mbedTLS, so the TLS fingerprint sites see changes - that is its purpose. Experimental: keep libcurl if a site misbehaves. WebSockets and cookie capture are supported on both engines. Applied when the engine next loads; no mid-session swap.
                </p>
              </SetPanel>
              <SetInline
                anchorId="set-data"
                danger
                label="Data"
                desc="Clear the proxied page cache, or delete every stored session and setting"
              >
                <m3e-button onClick={() => setConfirmDelete(true)}>
                  <m3e-icon name="delete" aria-hidden={true} /> Manage data
                </m3e-button>
                {/* Real modal: m3e-dialog owns the scrim, focus trap, Escape
                    handling and alertdialog semantics (alert attribute). */}
                <m3e-dialog
                  {...{ ref: deleteDialogRef }}
                  alert=""
                  dismissible=""
                  close-label="Cancel"
                >
                  <span slot="header">Manage data</span>
                  <p>Clear the Zeolite page cache, or delete all data on this device?</p>
                  <div slot="actions">
                    <m3e-button autofocus onClick={() => deleteDialogRef.current?.hide()}>Cancel</m3e-button>
                    <m3e-button
                      onClick={() => {
                        deleteDialogRef.current?.hide();
                        (async () => {
                          try {
                            const keys = await caches.keys();
                            await Promise.all(keys.map((k) => caches.delete(k)));
                            if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
                              M3eSnackbar.open("Zeolite cache cleared", { duration: 3000 });
                            }
                          } catch {
                            /* caches unavailable */
                          }
                        })();
                      }}
                    >
                      Clear cache
                    </m3e-button>
                    <m3e-button
                      variant="filled"
                      onClick={() => {
                        onDeleteAll();
                        deleteDialogRef.current?.hide();
                        if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
                          M3eSnackbar.open("All data deleted on this device", { duration: 3000 });
                        }
                      }}
                    >
                      Delete all data
                    </m3e-button>
                  </div>
                </m3e-dialog>
              </SetInline>
              <SetInline
                anchorId="set-logs"
                label="Logs"
                desc="App-level diagnostics and console history"
              >
                {/* Diagnostic mode is always on (the toggle was removed on
                    purpose): every failed resource, page console message and
                    proxy intervention (CSP/SRI stripping) is logged in full to
                    the app log and DevTools. */}
                <m3e-button onClick={onOpenLogs}>
                  <m3e-icon name="history" aria-hidden={true} /> Open Logs
                </m3e-button>
              </SetInline>

              <SectionHead section="about" />
              <SetPanel
                id="p-about"
                headline="About"
                sub="Versions compiled into this exact build"
                open={!!openP["p-about"]}
                toggle={() => toggleP("p-about")}
              >
                {/* Clawd naps here, above the build pills (user request
                    2026-11-04). Vendored local asset, no external
                    dependency. */}
                <img className="lb-clawd" src="/clawd-sleep.gif" alt="Clawd sleeping" title="Shh. Clawd is sleeping." />
                {/* The pills always render (unknown while loading or on
                    failure), so the About section never looks empty. */}
                <div className="lb-build" title={build ? "Build " + build.build : "Build information unavailable"}>
                  <span className="lb-build-chip"><span className="lb-build-name">LobsterBrowse Preview</span><span className="lb-build-val">{build ? build.lb : "unknown"}</span></span>
                  <span className="lb-build-chip"><span className="lb-build-name">Zeolite</span><span className="lb-build-val">{build ? build.zeolite : "unknown"}</span></span>
                  <span className="lb-build-chip"><span className="lb-build-name">ScramJet</span><span className="lb-build-val">{build ? build.scramjet : "unknown"}</span></span>
                  <span className="lb-build-chip"><span className="lb-build-name">Build</span><span className="lb-build-val">{build ? build.buildShort : "unknown"}</span></span>
                </div>
                {buildError && (
                  <p className="lb-muted">
                    Build information unavailable on this deployment.
                    {buildErrorDetail ? " Reason: " + buildErrorDetail : ""}
                  </p>
                )}
                {!build && !buildError && (
                  <p className="lb-muted">Loading build information...</p>
                )}
              </SetPanel>
            </>
          )}
        </div>
      </m3e-content-pane>
    </section>
  );
}
