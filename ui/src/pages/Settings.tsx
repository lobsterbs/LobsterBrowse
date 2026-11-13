import { useEffect, useRef, useState, type ReactNode } from "react";
/* The Settings hero card (user request 2026-11-11): the background
   shapes are real m3e-shape elements (registered by @m3e/web/all), so
   the beta UI keeps its single @m3e/web provider (ui-wave80 gate). */
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

/* #250: pseudo-id of the "Custom endpoint" option in the WISP server
   select; the real custom value lives in settings.wispServer. */
const WISP_CUSTOM = "__custom__";

const SECTION_TITLES: Record<string, string> = {
  search: "Search & browse",
  privacy: "Privacy",
  extensions: "Extensions",
  appearance: "Appearance",
  advanced: "Advanced",
};

/* Wave 101 (#256): each section reads as one M3 group: an icon tile
   on primary-container, a title heading and a supporting line. */
const SECTION_META: Record<string, { icon: string; sub: string }> = {
  search: { icon: "search", sub: "Engine and omnibox behavior" },
  privacy: { icon: "shield", sub: "Blocking and connection upgrades" },
  extensions: { icon: "extension", sub: "Add-ons from the catalog or local files" },
  appearance: { icon: "palette", sub: "Seed color and hero background" },
  advanced: { icon: "tune", sub: "Engines, data and diagnostics" },
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

/* The ASCII wordmark, same art as Home.tsx (trailing spaces
   trimmed; user request 2026-11-11: the Settings hero card carries
   the real logo). */
const LB_ASCII = String.raw`    __          __         __            ____
   / /   ____  / /_  _____/ /____  _____/ __ )_________ _      __________
  / /   / __ \/ __ \/ ___/ __/ _ \/ ___/ __  / ___/ __ \ | /| / / ___/ _ \
 / /___/ /_/ / /_/ (__  ) /_/  __/ /  / /_/ / /  / /_/ / |/ |/ (__  )  __/
/_____/\____/_.___/____/\__/\___/_/  /_____/_/   \____/|__/|__/____/\___/
                                                                          `;

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

  /* #250: WISP server picker. "" is the deployment default; a stored
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
        } else {
          pushLog("warn", "settings: /build returned an unexpected body");
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        pushLog("error", "settings: /build fetch failed: " + msg);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* About hero (user request 2026-11-11): /build's lb field carries
     "number codename" (e.g. "0.8.0 Tungsten"); split once for the
     hero card's number and text versions. */
  const lbVersion = build?.lb ?? "";
  const vSplit = lbVersion.indexOf(" ");
  const versionNum = vSplit > 0 ? lbVersion.slice(0, vSplit) : lbVersion;
  const versionName = vSplit > 0 ? lbVersion.slice(vSplit + 1) : "";
  const engineName = settings.proxyEngine === "scramjet" ? "ScramJet" : "Zeolite";
  return (
    <section className="lb-view-content" aria-label="Settings">
      {/* The page lives in an m3e-content-pane: the shaped scroll
          surface the component provides. */}
      <m3e-content-pane {...{ class: "lb-set-pane" }}>
        {/* The wrapper carries the page rhythm: the pane's scroll
            container sits inside the component's shadow root, so
            the column spacing must live on the page content. */}
        <div className="lb-set-page">
          {/* The classical app top bar (issue #269): the same basic
              m3e-app-bar the Logs page and the AI history sheet use,
              title only. */}
          <m3e-app-bar size="small" {...{ class: "lb-sheet-bar lb-set-bar" }}>
            <span slot="title">Settings</span>
          </m3e-app-bar>

          {/* About hero (user request 2026-11-11): a real m3e-card filled
              surface at the very top with the ASCII wordmark, the version
              (number and codename) and the running proxy engine. The
              background shapes are real m3e-shape elements (registered by
              @m3e/web/all), decorative and aria-hidden; the card clips. */}
          <m3e-card variant="filled" {...{ class: "lb-about-hero" }}>
            <div className="lb-about-hero-shapes" aria-hidden={true}>
              {/* Shapes render first as the background layer, content on
                  top: one large clover spilling off the top-right corner,
                  a sunny anchored at the bottom, a small clover on the
                  right edge. Size and container color ride the component's
                  own --m3e-shape-* tokens (theme.css). */}
              <m3e-shape name="8-leaf-clover" {...{ class: "lb-hero-shape lb-hero-shape-a" }} />
              <m3e-shape name="sunny" {...{ class: "lb-hero-shape lb-hero-shape-b" }} />
              <m3e-shape name="4-leaf-clover" {...{ class: "lb-hero-shape lb-hero-shape-c" }} />
            </div>
            <pre className="lb-about-hero-logo" aria-label="LobsterBrowse">{LB_ASCII}</pre>
            <div className="lb-about-hero-meta">
              <span className="lb-hero-version">
                <span className="lb-hero-version-num">{build ? versionNum : "unknown"}</span>
                {versionName ? <span className="lb-hero-version-name">{versionName}</span> : null}
              </span>
              <span className="lb-hero-engine">
                <span className="lb-hero-engine-label">Engine</span>
                {engineName}
              </span>
            </div>
          </m3e-card>

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
              <SetPanel
                id="p-wisp"
                headline="WISP server"
                sub="Upstream transit endpoint override"
                anchorId="set-wisp"
                open={!!openP["p-wisp"]}
                toggle={() => toggleP("p-wisp")}
              >
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
                  <p className="lb-muted">
                    A WISP server terminates the upstream TLS for proxied traffic: a third-party endpoint can see
                    and modify everything you load. Use only servers you trust. Deployment default keeps transit on
                    this deployment&apos;s own endpoint.
                  </p>
                </div>
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

        </div>
      </m3e-content-pane>
    </section>
  );
}
