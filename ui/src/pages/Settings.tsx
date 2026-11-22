/* Settings: a sticky frosted side navigation with one section
   visible at a time. The page keeps the component language (SetPanel
   expansion panels, SetInline row cards) and every option, anchor and
   control of the pre-redesign page; the ui-wave80 field oracle and
   the ui-wave108 anchor scan pin that. While ScramJet is the current
   proxy engine, every Zeolite-only option is greyed out. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ENGINES,
  WISP_PRESETS,
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
import { shapeWipe } from "../wipe";

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  rules: SiteRule[];
  onRulesChange: (rules: SiteRule[]) => void;
  onOpenLogs: () => void;
  onDeleteAll: () => void;
};

/* The default seed was the indigo-violet default
   every generated interface ships. The default is now derived from
   the product (a lobster red-orange); the old baseline stays as
   "Violet" for anyone attached to it. */
const SEEDS: Array<[string, string]> = [
  ["#BC4B2A", "Lobster"],
  ["#006A6A", "Teal"],
  ["#4F5B92", "Slate"],
  ["#6750A4", "Violet"],
];

/* Pseudo-id of the "Custom endpoint" option in the WISP server
   select; the real custom value lives in settings.wispServer. */
const WISP_CUSTOM = "__custom__";

/* The sections the side navigation switches between. One
   section renders at a time; the nav carries the icon and title. */
type SectionId = "search" | "privacy" | "appearance" | "extensions" | "advanced";

const SECTION_TITLES: Record<SectionId, string> = {
  search: "Search & browse",
  privacy: "Privacy",
  extensions: "Extensions",
  appearance: "Appearance",
  advanced: "Advanced",
};

/* Each section reads as one M3 group: an icon tile
   on primary-container, a title heading, and one plain supporting
   line that says what the section holds. Descriptions stay short and
   human: they explain the thing itself, never the changelog. */
const SECTION_META: Record<SectionId, { icon: string; sub: string }> = {
  search: { icon: "search", sub: "Choose your engine and its suggestions." },
  privacy: { icon: "shield", sub: "Block ads and trackers on the pages you open." },
  extensions: { icon: "extension", sub: "Add-ons: install, search and manage." },
  appearance: { icon: "palette", sub: "Set the colors and feel of the interface." },
  advanced: { icon: "tune", sub: "Engines, network and stored data." },
};

const NAV_ORDER: SectionId[] = ["search", "privacy", "appearance", "extensions", "advanced"];

/* The search index: one row per anchored setting (wave 112). The
   filter field matches on these labels and the section titles; a hit
   jumps straight to the section and focuses the setting's anchor. */
type SettingHit = { section: SectionId; label: string; anchorId: string };
const SETTING_INDEX: SettingHit[] = [
  { section: "search", label: "Search engine", anchorId: "set-search-engine" },
  { section: "search", label: "Engine search suggestions", anchorId: "set-search-suggest" },
  { section: "privacy", label: "Ad & tracker blocking", anchorId: "set-adblock" },
  { section: "appearance", label: "Theme color", anchorId: "set-theme-color" },
  { section: "extensions", label: "Manage installed", anchorId: "set-manage-ext" },
  { section: "extensions", label: "Find and install add-ons", anchorId: "set-amo" },
  { section: "extensions", label: "Import locally", anchorId: "set-import" },
  { section: "advanced", label: "Proxy engine", anchorId: "set-proxy" },
  { section: "advanced", label: "Transport engine", anchorId: "set-transport" },
  { section: "advanced", label: "WISP server", anchorId: "set-wisp" },
  { section: "advanced", label: "Data", anchorId: "set-data" },
  { section: "advanced", label: "Logs", anchorId: "set-logs" },
];

function SectionHead(props: { section: SectionId }) {
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

/* One settings sub-card = one expansion panel. The header carries the
   headline; the body carries the controls. Only the header span toggles
   open state, so using a control inside the body never collapses the
   panel. */
function SetPanel(props: {
  id: string;
  headline: string;
  sub?: string;
  open: boolean;
  toggle: () => void;
  anchorId?: string;
  children: ReactNode;
}) {
  return (
    <m3e-expansion-panel id={props.id} open={props.open ? "" : undefined}>
      <span slot="header" className="lb-setp-head" onClick={props.toggle}>
        <span className="lb-setp-headline">{props.headline}</span>
        {props.sub && <span className="lb-setp-sub">{props.sub}</span>}
      </span>
      <div className="lb-setp-body">
        {props.anchorId && <div className="lb-set-anchor" id={props.anchorId} tabIndex={-1} />}
        {props.children}
      </div>
    </m3e-expansion-panel>
  );
}

/* Single-control sub-card: a sub option
   whose entire payload is one control renders as an inline row card,
   not an expansion panel - one switch behind a chevron is a wasted
   click. The headline sits beside the control;
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
        {props.desc && <span className="lb-setting-desc">{props.desc}</span>}
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

  /* The active section. One section renders at a time; the
     sticky side navigation switches between them. */
  const [section, setSection] = useState<SectionId>("search");

  /* Settings search (wave 112): the filter field matches the index
     above; a hit switches the section and scrolls the anchor into
     view. A jump counter is needed so a hit inside the already-open
     section still fires (setSection with the same value would not
     re-render). */
  const [query, setQuery] = useState("");
  const [jumpTick, setJumpTick] = useState(0);
  const jumpRef = useRef<string | null>(null);
  const q = query.trim().toLowerCase();
  const hits =
    q === ""
      ? []
      : SETTING_INDEX.filter(
          (h) =>
            h.label.toLowerCase().includes(q) ||
            SECTION_TITLES[h.section].toLowerCase().includes(q),
        );
  const jumpTo = (h: SettingHit) => {
    jumpRef.current = h.anchorId;
    setSection(h.section);
    setJumpTick((t) => t + 1);
    setQuery("");
  };

  /* Switching categories glides the pane's scroll container back to
     the top instead of leaving the previous category's scroll offset
     on the new (possibly shorter) content. A search jump scrolls the
     anchor into view instead and focuses it. The scroll container
     lives inside the m3e-content-pane shadow root
     (.scroll-container), so the reset reaches through it;
     reduced-motion users get the instant jump from `auto`. */
  const paneRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const anchorId = jumpRef.current;
    jumpRef.current = null;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const anchor = anchorId ? document.getElementById(anchorId) : null;
    if (anchor) {
      anchor.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      anchor.focus();
      return;
    }
    const sc = paneRef.current?.shadowRoot?.querySelector<HTMLElement>(".scroll-container");
    if (!sc) return;
    sc.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }, [section, jumpTick]);

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

  /* WISP server picker. "" is the deployment default; a stored
     value that is neither empty nor a preset opens the custom input
     (it may also have been typed there directly). */
  const [wispCustom, setWispCustom] = useState(false);
  const wispSel =
    wispCustom ||
    (settings.wispServer !== "" && !WISP_PRESETS.some(([u]) => u === settings.wispServer))
      ? WISP_CUSTOM
      : settings.wispServer === ""
        ? "default"
        : settings.wispServer;

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
  /* Visible busy state for the import. The engine zl:installExt
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
      /* The manage list in this panel re-lists when an install
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

  return (
    <section className="lb-view-content lb-settings" aria-label="Settings">
      {/* The page lives in an m3e-content-pane: the shaped scroll
          surface the component provides. */}
<m3e-content-pane {...{ class: "lb-set-pane", ref: paneRef }}>
        {/* The wrapper carries the page rhythm: the pane's scroll
            container sits inside the component's shadow root, so
            the column spacing must live on the page content. */}
<div className="lb-set-page">
          {/* The classical app top bar: the same basic
              m3e-app-bar the Logs page and the AI history sheet use,
              title only. */}
          <m3e-app-bar size="small" {...{ class: "lb-sheet-bar lb-set-bar" }}>
            <span slot="title">Settings</span>
          </m3e-app-bar>

          {/* Settings search (wave 112): a compact filter in the pane
              header. Matches list one jump button per setting; an
              empty field renders nothing extra (the card rail is the
              browse path). */}
          <div className="lb-set-search">
            <m3e-icon name="search" aria-hidden={true} />
            <input
              type="search"
              className="lb-set-search-input"
              aria-label="Search settings"
              placeholder="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {q !== "" && (
            <div className="lb-set-hits" aria-label="Matching settings">
              {hits.length === 0 && <p className="lb-set-hits-empty">No setting matches.</p>}
              {hits.map((h) => (
                <button key={h.anchorId} type="button" className="lb-set-hit" onClick={() => jumpTo(h)}>
                  <span>{h.label}</span>
                  <span className="lb-set-hit-sec">{SECTION_TITLES[h.section]}</span>
                </button>
              ))}
            </div>
          )}

          {/* Narrow screens (wave 112): the card rail collapses into
              this dropdown; the five category chips stopped fitting a
              phone's width. CSS swaps the two surfaces at 720px. */}
          <div className="lb-set-nav-drop">
            <M3eSelect
              label="Settings sections"
              value={section}
              options={NAV_ORDER.map((id) => [id, SECTION_TITLES[id]] as [string, string])}
              onChange={(v) => setSection(v as SectionId)}
            />
          </div>

          {/* The sticky frosted side rail. One section is
              visible at a time; the active item carries the M3 pill
              and aria-current. */}
          <nav className="lb-set-nav" aria-label="Settings sections">
            {NAV_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                className={"lb-set-nav-item" + (section === id ? " active" : "")}
                aria-current={section === id ? "true" : undefined}
                onClick={() => setSection(id)}
              >
                {/* Android Settings sub-card, ported: the icon sits
                    inside a real m3e-shape (the expressive 4-sided
                    cookie), then the category name with one plain
                    line under it saying what the section holds. */}
                <m3e-shape name={section === id ? "sunny" : "4-sided-cookie"} aria-hidden={true}>
                  <m3e-icon name={SECTION_META[id].icon} />
                </m3e-shape>
                <span className="lb-set-nav-txt">
                  <span className="lb-set-nav-title">{SECTION_TITLES[id]}</span>
                  <span className="lb-set-nav-sub">{SECTION_META[id].sub}</span>
                </span>
              </button>
            ))}
          </nav>

          <div className="lb-set-section">
            {section === "search" && (
              <>
            <SectionHead section="search" />
            <SetInline anchorId="set-search-engine" label="Search engine" desc="The engine the address bar searches with.">
              {/* Six long engine names cannot share one
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
              desc="Completions from the engine while you type."
              on={settings.suggestQueries}
              toggle={() => onChange({ suggestQueries: !settings.suggestQueries })}
            />
              </>
            )}
            {section === "privacy" && (
              <>
            <SectionHead section="privacy" />
            <SetInline
              anchorId="set-adblock"
              label="Ad & tracker blocking"
              desc="Filters known ad and tracker hosts."
              on={settings.adblock}
              toggle={() => onChange({ adblock: !settings.adblock })}
              disabled={zlOff}
            />
            {zlOff && zlNote}
              </>
            )}
            {section === "appearance" && (
              <>
            <SectionHead section="appearance" />
            {/* Theme hero card (wave 112): recoloring the app is the
                one appearance control people return to, so it sits in
                plain sight at the top of the section, not behind a
                panel toggle. Same controls as before: the color input
                and the seed chips. */}
            <div className="lb-set-hero">
              <div className="lb-set-anchor" id="set-theme-color" tabIndex={-1} />
              <div className="lb-set-hero-txt">
                <span className="lb-set-hero-title">Theme color</span>
                <span className="lb-set-hero-sub">The palette grows from this seed.</span>
              </div>
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
                    <m3e-chip key={hex} selected={settings.seed === hex ? "" : undefined} onClick={(e) => settings.seed !== hex && shapeWipe(e.currentTarget.getBoundingClientRect(), () => onChange({ seed: hex }), hex)}>
                      {/* A colored swatch in the chip's icon slot (the
                         plain m3e-chip exposes no avatar slot) so every
                         seed option shows its color. */}
                      <span slot="icon" className="lb-seed-dot" style={{ background: hex }} />
                      {name}
                    </m3e-chip>
                  ))}
                </m3e-chip-set>
              </div>
            </div>
              </>
            )}
            {section === "extensions" && (
              <>
            <SectionHead section="extensions" />
            <SetPanel
              id="p-manage-ext"
              headline="Manage installed"
              sub="Turn add-ons on or off, or remove them."
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
              sub="Search the Firefox add-on catalog."
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
              sub="Install an add-on from a file on this device."
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
                Allowed: manifest.json, scripts, styles, JSON and images. No binaries. A broken package only puts that add-on in an error state.
              </p>
            </SetPanel>
              </>
            )}
            {section === "advanced" && (
              <>
            <SectionHead section="advanced" />
            <SetPanel
              id="p-proxy"
              headline="Proxy engine"
              sub="How pages are fetched and rewritten."
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
                ScramJet rewrites pages client-side through its own worker. Engine options like adblock and fingerprint spoof are Zeolite-only. Applied on the next navigation.
              </p>
            </SetPanel>
            <SetPanel
              id="p-transport"
              headline="Transport engine"
              sub="The network client the engine uses underneath."
              anchorId="set-transport"
              open={!!openP["p-transport"]}
              toggle={() => toggleP("p-transport")}
            >
              <div className="lb-seg-wrap">
                <m3e-segmented-button aria-label="Transport engine" disabled={zlOff ? true : undefined}>
                  <m3e-button-segment disabled={zlOff ? true : undefined} checked={settings.transport !== "epoxy" ? "" : undefined} onClick={() => onChange({ transport: "libcurl" })}>
                    libcurl
                  </m3e-button-segment>
                  <m3e-button-segment disabled={zlOff ? true : undefined} checked={settings.transport === "epoxy" ? "" : undefined} onClick={() => onChange({ transport: "epoxy" })}>
                    epoxy (default)
                  </m3e-button-segment>
                </m3e-segmented-button>
              </div>
              {zlOff && zlNote}
              <p className="lb-muted" style={{ marginTop: 6 }}>
                epoxy shows sites a different TLS fingerprint; that is its purpose. Switch back to libcurl if a site misbehaves under it. Applied on the next engine load.
              </p>
            </SetPanel>
            <SetPanel
              id="p-wisp"
              headline="WISP server"
              sub="Route engine traffic through a WISP transit server."
              anchorId="set-wisp"
              open={!!openP["p-wisp"]}
              toggle={() => toggleP("p-wisp")}
            >
              <p className="lb-muted">Engine sessions end their TLS inside your browser: a WISP server relays the encrypted bytes and sees destination hosts, timing and sizes, never the cleartext. It is still shared infrastructure with no SLA; pick one you trust.</p>
              {zlOff && zlNote}
              <div className={zlOff ? "lb-zl-guard" : undefined}>
                <M3eSelect
                  label="WISP server"
                  value={wispSel}
                  options={[
                    ["default", "Deployment default"],
                    ...WISP_PRESETS,
                    [WISP_CUSTOM, "Custom endpoint"],
                  ]}
                  onChange={(v) => {
                    if (v === WISP_CUSTOM) {
                      setWispCustom(true);
                      return;
                    }
                    setWispCustom(false);
                    onChange({ wispServer: v === "default" ? "" : v });
                  }}
                />
                {wispSel === WISP_CUSTOM && (
                  <TextInput
                    label="Custom WISP endpoint"
                    value={settings.wispServer}
                    placeholder="wss://your-server.example/wisp/"
                    hint="Must start with wss://"
                    onChange={(v) => onChange({ wispServer: v })}
                  />
                )}
              </div>
            </SetPanel>
            <SetInline anchorId="set-data" danger label="Data" desc="Clear the page cache or wipe this device's data.">
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
                          window.dispatchEvent(new CustomEvent("lb-flash-hero"));
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
                      window.dispatchEvent(new CustomEvent("lb-flash-hero"));
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
            <SetInline anchorId="set-logs" label="Logs" desc="Every load failure and page message, kept to inspect.">
              {/* Diagnostic mode is always on (the toggle was removed on
                  purpose): every failed resource, page console message and
                  proxy intervention (CSP/SRI stripping) is logged in full to
                  the app log and DevTools. */}
              <m3e-button onClick={onOpenLogs}>
                <m3e-icon name="history" aria-hidden={true} /> Open Logs
              </m3e-button>
            </SetInline>
              </>
            )}
          </div>
        </div>
      </m3e-content-pane>
    </section>
  );
}