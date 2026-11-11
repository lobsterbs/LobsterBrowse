import { useEffect, useRef, useState, type ReactNode } from "react";
/* The Settings hero card (user request 2026-11-11): the canonical M3E
   expressive shape vectors are inlined as SVG paths (SHAPE_* below),
   so the beta UI keeps its single @m3e/web provider (ui-wave80 gate). */
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

/* #250: pseudo-id of the "Custom endpoint" option in the WISP server
   select; the real custom value lives in settings.wispServer. */
const WISP_CUSTOM = "__custom__";

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
  { section: "advanced", label: "WISP server", terms: "wisp transit upstream endpoint anura mercurywork custom", panel: "p-wisp", target: "set-wisp" },
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

/* The ASCII wordmark, same art as Home.tsx (trailing spaces
   trimmed; user request 2026-11-11: the Settings hero card carries
   the real logo). */
const LB_ASCII = String.raw`    __          __         __            ____
   / /   ____  / /_  _____/ /____  _____/ __ )_________ _      __________
  / /   / __ \/ __ \/ ___/ __/ _ \/ ___/ __  / ___/ __ \ | /| / / ___/ _ \
 / /___/ /_/ / /_/ (__  ) /_/  __/ /  / /_/ / /  / /_/ / |/ |/ (__  )  __/
/_____/\____/_.___/____/\__/\___/_/  /_____/_/   \____/|__/|__/____/\___/
                                                                          `;

/* Canonical M3E expressive shape vectors (380x380 grid), from the
   community shape token set, inlined so the hero needs no second
   component library. */
const SHAPE_CLOVER8 = "M189.999977 27.090641C192.760031 25.625032 195.52007 24.159427 198.280124 22.69383C240.222396 0.422161 291.952165 23.251636 303.766555 69.247278C304.24244 71.100082 304.718363 72.95289 305.194283 74.805683C308.182261 75.720989 311.170258 76.636302 314.158236 77.551605C359.56436 91.460805 379.999962 144.182165 355.830138 185.060019C354.856517 186.706669 353.882919 188.353327 352.909306 189.999977C354.37489 192.760016 355.840512 195.52007 357.306115 198.280086C379.577782 240.222358 356.748317 291.952138 310.752691 303.766555C308.899872 304.24244 307.047068 304.718363 305.194283 305.194283C304.278935 308.182261 303.363637 311.170258 302.448384 314.158236C288.539183 359.564387 235.817816 380 194.939935 355.830165C193.29327 354.856563 191.646616 353.882942 189.999954 352.909344C187.239908 354.374928 184.479854 355.84055 181.719811 357.306115C139.777555 379.577809 88.047801 356.748317 76.233388 310.752691C75.75748 308.899872 75.281568 307.047068 74.805652 305.194264C71.817667 304.278935 68.829681 303.363637 65.841696 302.448346C20.435607 288.539115 0.000021 235.817755 24.169816 194.939886C25.143418 193.293255 26.117024 191.646616 27.090631 189.999977C25.625019 187.239908 24.159401 184.479854 22.693788 181.719789C0.422138 139.777555 23.251594 88.047813 69.247206 76.233388C71.100037 75.75748 72.952879 75.281557 74.805706 74.805645C75.721012 71.817667 76.636318 68.829681 77.551616 65.841707C91.46084 20.435581 144.182211 0 185.060087 24.169843C186.706711 25.143441 188.353346 26.117043 189.999977 27.090641Z";
const SHAPE_CLOVER4 = "M190 37.289229C191.834184 35.878946 193.66833 34.468668 195.502533 33.058385C238.497576 0.000008 299.342226 3.957985 337.69213 42.307881C376.041996 80.657801 380 141.502435 346.941596 184.497486C345.531317 186.331655 344.121046 188.165835 342.710752 190C344.121027 191.834184 345.531317 193.66833 346.941581 195.502533C379.999962 238.497565 376.041996 299.342226 337.69213 337.69213C299.342226 376.042034 238.497576 380 195.502514 346.941634C193.66833 345.531317 191.834184 344.121084 190 342.710752C188.165816 344.121046 186.331632 345.53134 184.497448 346.941596C141.502386 380 80.657774 376.041996 42.30787 337.69213C3.957982 299.342226 0.000008 238.497576 33.058377 195.502552C34.468662 193.668357 35.878946 191.834184 37.289233 190C35.878943 188.165789 34.46866 186.331609 33.058377 184.497421C0 141.502367 3.957976 80.657766 42.307875 42.307864C80.657774 3.957968 141.502386 0 184.497421 33.05837C186.331609 34.468656 188.165816 35.878943 190 37.289229Z";
const SHAPE_SUNNY = "M378.823976 190C378.823976 196.819366 376.471928 203.638732 371.767832 209.158726C362.152312 220.441963 352.536792 231.725216 342.92131 243.008442C338.889681 247.739328 336.453201 253.621462 335.958779 259.817514C334.779506 274.595129 333.600237 289.372785 332.420975 304.150423C331.267151 318.609442 319.785466 330.091131 305.326428 331.244936C290.548787 332.424213 275.771168 333.603482 260.993515 334.782736C254.797513 335.277192 248.915352 337.713676 244.184443 341.745286C232.901202 351.360806 221.617961 360.976303 210.334731 370.591808C199.294762 380 183.057237 380 172.01726 370.591808C160.734034 360.976303 149.450793 351.360806 138.167574 341.745286C133.436685 337.713676 127.554532 335.277177 121.358495 334.782736C106.580869 333.603482 91.803239 332.424213 77.025605 331.244936C62.566567 330.091131 51.084909 318.609465 49.93105 304.150442C48.751796 289.372785 47.572512 274.595129 46.393236 259.817491C45.898792 253.621447 43.462321 247.739301 39.430698 243.008404C29.815207 231.725178 20.199706 220.441952 10.584214 209.158711C1.176016 198.118765 1.176016 181.881213 10.584227 170.841255C20.199728 159.558025 29.815229 148.274795 39.430721 136.991566C43.462356 132.260687 45.898817 126.37853 46.393273 120.182497C47.572542 105.404848 48.751807 90.627203 49.931084 75.849558C51.084931 61.390524 62.56659 49.908866 77.025616 48.755026C91.803261 47.575757 106.580918 46.396489 121.358548 45.217232C127.5546 44.722789 133.436742 42.286307 138.167631 38.254672C149.450861 28.639192 160.734057 19.023689 172.017275 9.408211C183.057248 0 199.294785 0 210.33475 9.408198C221.617976 19.023713 232.90124 28.639215 244.184466 38.254718C248.915367 42.286341 254.797513 44.722823 260.993538 45.217268C275.771206 46.396545 290.548836 47.575814 305.326466 48.755068C319.785504 49.908915 331.267204 61.390585 332.421021 75.849634C333.600252 90.62726 334.779517 105.404871 335.958779 120.182486C336.453216 126.378519 338.889681 132.260687 342.92131 136.991577C352.53683 148.274807 362.152323 159.558037 371.767832 170.841266C376.471928 176.361253 378.823976 183.180634 378.823976 190Z";

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
    (settings.wispServer !== "" && !WISP_PRESETS.some(([, u]) => u === settings.wispServer))
      ? WISP_CUSTOM
      : settings.wispServer === ""
        ? "default"
        : settings.wispServer;

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
          <div className="lb-set-title">
            <m3e-heading variant="title" size="medium" level={2}>Settings</m3e-heading>
            <p className="lb-set-title-sub">Everything stays on this device. Changes apply immediately.</p>
          </div>

          {/* About hero (user request 2026-11-11): an MT3E card at the
              very top with the ASCII wordmark, the version (number and
              codename) and the running proxy engine. Background shapes
              are the canonical md-shape vectors, placed after the
              expressive-profile hero; decorative and aria-hidden. */}
          <div {...{ class: "lb-about-hero" }}>
            {/* Shapes render first as the background layer, content on
                top: the expressive-profile hero. Large 8-leaf-clover
                spilling off the top-right corner, 4-leaf-clover along the
                bottom, small sunny on the right edge; container colors at
                full strength, clipped by the card. */}
            <div className="lb-about-hero-shapes" aria-hidden={true}>
              <svg viewBox="0 0 380 380" aria-hidden={true} {...{ class: "lb-hero-shape lb-hero-shape-a" }}><path d={SHAPE_CLOVER8} /></svg>
              <svg viewBox="0 0 380 380" aria-hidden={true} {...{ class: "lb-hero-shape lb-hero-shape-b" }}><path d={SHAPE_CLOVER4} /></svg>
              <svg viewBox="0 0 380 380" aria-hidden={true} {...{ class: "lb-hero-shape lb-hero-shape-c" }}><path d={SHAPE_SUNNY} /></svg>
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
