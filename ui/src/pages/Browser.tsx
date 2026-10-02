/* The in-app proxy browser surface: tabs, frosted floating tab strip,
   bottom hover toolbar, proxied iframes and per-tab DevTools.

   Zeolite is the only engine: every navigation goes to
   /zl/<base64url of the target>, which the Zeolite service worker
   intercepts (native wisp transport, in-worker rewriting of
   URL-bearing attributes and CSS urls, runtime fetch/XHR and element
   assignment routing). Frames are same-origin, so the UI polls each
   frame for its real URL, title and favicon, and DevTools get full
   console and network capture.

   Tabs that receive a URL without an explicit navigation (Home search,
   restored sessions) auto-load when they become active. */

import { useEffect, useRef, useState } from "react";
import lockSvg from "@material-symbols/svg-400/outlined/lock.svg?raw";
import noEncSvg from "@material-symbols/svg-400/outlined/no_encryption.svg?raw";
import dominoMaskSvg from "@material-symbols/svg-400/outlined/domino_mask.svg?raw";
import tabSvg from "@material-symbols/svg-400/outlined/tab.svg?raw";
import {
  decodeRoute,
  engineRoutePrefix,
  ENGINES,
  fetchSuggestions,
  looksLikeUrl,
  normalizeUrl,
  routeUrl,
  searchUrl,
  UA_PRESETS,
  type Settings,
  type SiteRule,
  type UaPresetId,
} from "../settings";
import { zlSend } from "../zeolite";
import { pushLog, type Tab } from "../store";
/* Central diagnostics sanitizer: every untrusted page string that
   enters DevTools state or the app log passes through these (P0
   secret-leak fix). Replaces the old local redactUrl. */
import { sanitizeText, sanitizeUrl } from "../sanitize";
import DevTools, { emptyDt, nextEntryId, reasonText, type DtState, type ResFailEntry } from "./DevTools";
/* Extracted browser feature panels (ui/src/browser/): all state stays
   in this page; the components are presentational. */
import { DL_FILE_RE, fmtBytes, tabLabel } from "../browser/browserShared";
import TabSwitcherCard from "../browser/TabSwitcherCard";
import DownloadsCard from "../browser/DownloadsCard";
import XpiPrompt from "../browser/XpiPrompt";
import ExtensionsPanel, { type ExtDetail, type ExtInfo } from "../browser/ExtensionsPanel";
import M3eSelect from "../M3eSelect";

type Props = {
  settings: Settings;
  rules: SiteRule[];
  tabs: Tab[];
  activeId: number;
  setActiveId: (id: number) => void;
  updateTab: (id: number, patch: Partial<Tab>) => void;
  newTab: (url?: string) => void;
  closeTab: (id: number) => void;
  onHistory: (url: string) => void;
  /* Incognito session: no history recording, no session persistence. */
  incognito: boolean;
  onIncognitoChange: (v: boolean) => void;
  onOpenLogs: () => void;
  /* Per-site rule edits from the toolbar chip (#10): the same store
     the Settings editor writes. */
  onRulesChange: (rules: SiteRule[]) => void;
};

/* ---- Downloads (UI-side manager) ----
   Proxied pages fetch through the engine, so every download is
   relayed by our server but SAVED on the user's device. Captured
   a[download] links (and obvious file links) are streamed by the app
   with visible progress instead of a silent browser download. */
type DlItem = {
  id: number;
  name: string;
  url: string;
  size: number;
  got: number;
  status: "active" | "done" | "error" | "cancelled";
  error?: string;
};

/* User-Agent options for the per-site rules chip (#10): the global
   presets only. A custom UA stays a global setting; resolveUa reads
   the custom string from the global settings, not per-site. */
const UA_RULE_OPTIONS: Array<[string, string]> = [
  ["", "Use global setting"],
  ...(Object.keys(UA_PRESETS) as Exclude<UaPresetId, "custom">[]).map((id): [string, string] => [id, UA_PRESETS[id].name]),
];

/* Minimal File System Access surface used by the streaming download
   path. Declared locally (structural, no global augmentation) so it
   compiles even where the API is absent at runtime. */
type FileSystemWritableFileStreamLike = {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
};
type SavePickerFn = (options?: { suggestedName?: string }) => Promise<{
  createWritable(): Promise<FileSystemWritableFileStreamLike>;
}>;

export default function BrowserView(props: Props) {
  const { settings, rules, tabs, activeId } = props;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const frames = useRef<Map<number, HTMLIFrameElement>>(new Map());
  /* Last URL each tab was asked to load — guards the auto-load effect
     against double navigation. */
  const lastNav = useRef<Map<number, string>>(new Map());
  /* Per-tab navigation generation: every load() bumps it, so results
     from an older navigation (a slow "ready", a late poll callback, a
     certificate lookup for a page we already left) can be detected and
     dropped. navId is the short human-readable diagnostic ID
     (NAV-XXXX) shown on the error page. */
  const navGen = useRef<Map<number, number>>(new Map());
  const navId = useRef<Map<number, string>>(new Map());
  const [status, setStatus] = useState<Record<number, { loading: boolean; nav?: string }>>({});
  const [dt, setDtState] = useState<Record<number, DtState>>({});
  /* Per-tab URL bar drafts; when empty the bar shows the real URL. */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  /* Toolbar autocomplete: engine-queried suggestions, debounced. */
  const [tbSugg, setTbSugg] = useState<{ text: string; url: string; src?: string }[]>([]);
  const [tbSuggOpen, setTbSuggOpen] = useState(false);
  const [tbSuggIdx, setTbSuggIdx] = useState(-1);
  /* Center pill: collapsed shows the tab name; pressed, it expands in
     place into the editable URL (the name hides). */
  const [tbExpanded, setTbExpanded] = useState(false);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  /* Real favicon per tab (blob URL fetched through the engine). */
  const [icons, setIcons] = useState<Record<number, string>>({});
  const iconCache = useRef<Map<string, string>>(new Map());
  /* Frame documents that already have engine prefetch listeners. */
  const wiredDocs = useRef<WeakSet<Document>>(new WeakSet());
  /* Last lb-diag content seen per tab: the proxy rewriter reports how
     many CSP meta tags and SRI integrity attributes it stripped; log
     each distinct report once, not on every poll tick. */
  const lastDiag = useRef<Map<number, string>>(new Map());
  /* URLs already recovered from an escaped navigation, per tab+URL. */
  const lastEscape = useRef<Set<string>>(new Set());
  /* Consecutive poll ticks a frame has spent stuck on about:blank
     (Zeolite #31: engine bootstrap never attached). */
  const blankPolls = useRef<Map<number, number>>(new Map());
  /* Tabs animating closed; the real close lands after the collapse. */
  const [closingIds, setClosingIds] = useState<number[]>([]);
  /* Site info card: open state plus the cookies the page can read. */
  const [siteInfoOpen, setSiteInfoOpen] = useState(false);
  /* Compaction 1: tabs also surface from the toolbar. A tab-count
     button opens the tab switcher card (previews, switch, close). */
  const [tabsOpen, setTabsOpen] = useState(false);
  /* Tab button and incognito toggle are real m3e-icon-buttons with
     toggle semantics; React 18 cannot set boolean custom-element
     attributes correctly, so the selected attribute is managed from a
     ref effect instead of JSX props. */
  const tabsBtnRef = useRef<HTMLElement | null>(null);
  const incognitoBtnRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    tabsBtnRef.current?.toggleAttribute("selected", tabsOpen);
  }, [tabsOpen]);
  useEffect(() => {
    incognitoBtnRef.current?.toggleAttribute("selected", !!props.incognito);
  }, [props.incognito]);
  /* The tab switcher card stays mounted all the time (its preview
     iframes must stay alive or tiles show blank frames, not pages);
     the .open class animates and gates interaction instead. */
  /* ---- Downloads ---- */
  const [downloads, setDownloads] = useState<DlItem[]>([]);
  const [dlOpen, setDlOpen] = useState(false);
  const dlSeq = useRef(1);
  /* Frame documents that already carry the download click capture. */
  const dlWired = useRef<WeakSet<Document>>(new WeakSet());
  /* A finished .xpi download waiting for the install prompt. The
     bytes are held here so Install needs no second fetch. */
  const [xpiPrompt, setXpiPrompt] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  /* Cancellation: every active download owns an AbortController. The
     sink is disk streaming via the File System Access API when the
     context allows it, and capped in-memory Blob assembly otherwise;
     both paths honor the cancel button. */
  const dlAbort = useRef<Map<number, AbortController>>(new Map());
  const MAX_DL_BYTES = 1024 * 1024 * 1024; // 1 GiB in-memory ceiling
  const cancelDownload = (id: number) => {
    dlAbort.current.get(id)?.abort();
    dlAbort.current.delete(id);
  };
  const startDownload = (href: string, name: string, engId?: number) => {
    const id = dlSeq.current++;
    /* Engine handoff (#46): when the download came from the engine's
       zl:downloadOp (an extension's downloads.download()), report
       state back over zl:downloadState so the engine's registry and
       the extension's downloads.onChanged stay truthful — otherwise
       the engine-side entry stays "active" forever. Fire-and-forget:
       a report for an already-finished id is answered ok:false and
       dropped, and zlSend never throws. Progress reports are
       throttled to one per second per download. */
    let lastRep = 0;
    const reportEng = (
      status: "active" | "done" | "error" | "cancelled",
      extra?: { received?: number; size?: number; error?: string },
    ) => {
      if (engId === undefined) return;
      void zlSend({ type: "zl:downloadState", id: engId, status, ...extra }, 8000);
    };
    /* Engine-routed hrefs (/zl/, plus legacy /r/ and /lj/ that the
       server bounces) are fetched as-is; anything else goes through
       routeUrl so it rides the engine like a navigation. */
    const target =
      href.startsWith("/r/") || href.startsWith("/lj/") || href.startsWith("/zl/")
      ? href
      : routeUrl(href);
    setDownloads((prev) => [...prev, { id, name, url: href, size: 0, got: 0, status: "active" }]);
    pushLog("info", "download start " + name);
    /* Ask for notification permission once, on the first download. */
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        const p = Notification.requestPermission() as unknown;
        if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => {});
      }
    } catch {
      /* notifications unavailable */
    }
    (async () => {
      const ac = new AbortController();
      dlAbort.current.set(id, ac);
      /* Streaming sink state lives outside the try so the catch can
         discard a partial streamed file. */
      let writable: FileSystemWritableFileStreamLike | null = null;
      let streaming = false;
      const fail = (msg: string) => {
        dlAbort.current.delete(id);
        pushLog("error", "download failed " + name + ": " + msg);
        reportEng("error", { error: msg.slice(0, 120) });
        setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, status: "error", error: msg.slice(0, 120) } : d)));
      };
      try {
        const res = await fetch(target, { signal: ac.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const size = Number(res.headers.get("content-length")) || 0;
        setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, size } : d)));
        /* Filename from Content-Disposition (#11): the engine route
           forwards it (main.rs stream passthrough); the download
           attribute and the URL basename remain the fallbacks. */
        const cd = res.headers.get("content-disposition") || "";
        const cdm = /filename\*=(?:UTF-8|utf-8)''([^;\s]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
        if (cdm) {
          let cdName = "";
          try { cdName = decodeURIComponent(cdm[1]); } catch { cdName = cdm[1]; }
          cdName = cdName.trim().slice(0, 120);
          if (cdName) {
            name = cdName;
            setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, name } : d)));
          }
        }
        /* Streaming sink (P0 download architecture): when the File
           System Access API is available the bytes go straight to a
           user-chosen file on disk — no Blob, no RAM ceiling. The
           picker needs transient user activation which the parent UI
           may not have (the click happened inside the proxied frame),
           so any picker failure other than the user dismissing the
           dialog falls back to the capped in-memory Blob path below.
           A user dismissal is an honest cancel, not a failure. */
        const picker: SavePickerFn | undefined = (window as unknown as { showSaveFilePicker?: SavePickerFn }).showSaveFilePicker;
        if (res.body && typeof picker === "function") {
          try {
            const handle = await picker({ suggestedName: name.slice(0, 120) });
            writable = await handle.createWritable();
            streaming = true;
          } catch (e) {
            const en = (e as { name?: string })?.name ?? "";
            if (en === "AbortError") {
              /* User dismissed the save dialog: cancelled, no fallback
                 fetch, no fake failure. */
              ac.abort();
              pushLog("info", "download cancelled at save dialog " + name);
              reportEng("cancelled");
              setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, status: "cancelled" } : d)));
              return;
            }
            writable = null;
            streaming = false;
          }
        }
        const chunks: BlobPart[] = [];
        let total = 0;
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              if (streaming && writable) {
                /* Straight to disk: memory use is O(1) regardless of
                   file size. */
                await writable.write(value);
              } else {
                /* In-memory fallback: each reader chunk is a fresh
                   buffer per the streams spec, so pushing `value`
                   directly avoids the old full-slice copy that doubled
                   peak memory. The MAX_DL_BYTES cap is the honest
                   ceiling of this design: past it we cancel and report
                   instead of exhausting device memory. */
                chunks.push(value);
              }
              total += value.byteLength;
              if (!streaming && total > MAX_DL_BYTES) {
                ac.abort();
                fail("larger than " + fmtBytes(MAX_DL_BYTES) + " — cancelled to protect device memory (this browser/context cannot stream downloads to disk)");
                return;
              }
              setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, got: total } : d)));
              if (Date.now() - lastRep > 1000) {
                lastRep = Date.now();
                reportEng("active", { received: total, size });
              }
            }
          }
          if (streaming && writable) {
            await writable.close();
          }
        } else {
          chunks.push(await res.blob());
        }
        if (streaming) {
          /* The file is already on disk; no blob anchor round trip. */
          dlAbort.current.delete(id);
          setDownloads((prev) =>
            prev.map((d) => (d.id === id ? { ...d, size: d.size || total, got: total, status: "done" } : d)),
          );
          reportEng("done", { received: total, size: size || total });
          pushLog("info", "download streamed to disk " + name + " (" + fmtBytes(total) + ")");
          try {
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              new Notification("LobsterBrowse Preview download complete", { body: name });
            }
          } catch {
            /* notifications unavailable */
          }
          if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
            M3eSnackbar.open("Saved " + name, { duration: 4000 });
          }
          window.setTimeout(() => {
            setDownloads((prev) => prev.filter((d) => d.id !== id));
          }, 4000);
          return;
        }
        const blob = new Blob(chunks);
        dlAbort.current.delete(id);
        setDownloads((prev) =>
          prev.map((d) => (d.id === id ? { ...d, size: d.size || blob.size, got: blob.size, status: "done" } : d)),
        );
        reportEng("done", { received: blob.size, size: size || blob.size });
        /* XPI packages from the add-ons store: ask before anything
           happens. Install goes straight into the engine (the same
           zl:installExt path the Settings import uses); Save file
           falls back to the normal blob download. */
        if (/\.xpi$/i.test(name)) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          setXpiPrompt({ name, bytes });
          pushLog("info", "xpi ready: " + name + " (" + fmtBytes(bytes.length) + ")");
          return;
        }
        /* Saved on the user's device via a blob anchor click. */
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = name;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
        pushLog("info", "download done " + name + " (" + fmtBytes(blob.size) + ")");
        /* Notification (system when permitted, snackbar always), then
           the entry goes away a few seconds after completion. */
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("LobsterBrowse Preview download complete", { body: name });
          }
        } catch {
          /* notifications unavailable */
        }
        if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
          M3eSnackbar.open("Downloaded " + name, { duration: 4000 });
        }
        window.setTimeout(() => {
          setDownloads((prev) => prev.filter((d) => d.id !== id));
        }, 4000);
      } catch (err) {
        dlAbort.current.delete(id);
        if (writable) {
          /* Discard the partial streamed file instead of leaving a
             broken half-download on disk. */
          try { await writable.abort?.(); } catch { /* already closed */ }
        }
        if (ac.signal.aborted) {
          /* User cancel, save-dialog dismissal or the size-cap abort:
             an honest "cancelled" state, not a fake failure. */
          pushLog("info", "download cancelled " + name);
          reportEng("cancelled");
          setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, status: "cancelled" } : d)));
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        pushLog("error", "download failed " + name + ": " + msg);
        reportEng("error", { error: msg.slice(0, 120) });
        setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, status: "error", error: msg.slice(0, 120) } : d)));
      }
    })();
  };
  /* Install a downloaded .xpi into the engine, or save it as a file. */
  const installXpi = async (p: { name: string; bytes: Uint8Array }) => {
    setXpiPrompt(null);
    pushLog("info", "xpi install " + p.name);
    const rep = await zlSend({ type: "zl:installExt", bytes: p.bytes }, 20000);
    if (rep && rep.ok) {
      pushLog("info", "xpi installed " + String(rep.id));
      if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
        M3eSnackbar.open("Extension installed", { duration: 4000 });
      }
      loadExtensions();
    } else {
      const msg = rep && rep.error ? String(rep.error) : "the engine worker could not be reached";
      pushLog("error", "xpi install failed: " + msg);
      if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
        M3eSnackbar.open("Install failed: " + msg, { duration: 5000 });
      }
    }
  };
  const saveXpi = (p: { name: string; bytes: Uint8Array }) => {
    setXpiPrompt(null);
    const blob = new Blob([p.bytes.slice().buffer as ArrayBuffer]);
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = p.name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
    pushLog("info", "xpi saved " + p.name);
  };
  /* ---- Engine download handoff (#46): an extension calling
     downloads.download() hands the save to the UI — the engine
     broadcasts zl:downloadOp to its window clients and owns nothing
     after that. Feed it into the same transfer machinery the
     a[download] capture uses. ponytail: the broadcast reaches every
     LB window (clients.matchAll), so two open windows would both save;
     elect a single receiver if that ever bites. State flows back over
     zl:downloadState so the engine's registry and the extension's
     downloads.onChanged stay truthful. ---- */
  const startDlRef = useRef(startDownload);
  startDlRef.current = startDownload;
  useEffect(() => {
    const onSwMsg = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; op?: { op?: string; url?: string; filename?: string; id?: number } };
      /* Trust boundary: the engine relays extension-supplied values. */
      if (!d || d.type !== "zl:downloadOp" || !d.op || d.op.op !== "download" || typeof d.op.url !== "string" || !d.op.url) return;
      let name = typeof d.op.filename === "string" ? d.op.filename.trim() : "";
      if (!name) {
        try {
          name = decodeURIComponent(new URL(d.op.url, location.origin).pathname.split("/").filter(Boolean).pop() ?? "");
        } catch {
          name = "";
        }
      }
      /* The numeric id keys the engine's download state; thread it so
         progress and completion can flow back (zl:downloadState). */
      startDlRef.current(d.op.url, name.slice(0, 120) || "download", typeof d.op.id === "number" ? d.op.id : undefined);
    };
    navigator.serviceWorker?.addEventListener("message", onSwMsg);
    return () => navigator.serviceWorker?.removeEventListener("message", onSwMsg);
  }, []);
  const [siteCookies, setSiteCookies] = useState<string[]>([]);
  /* Extensions panel: asks the service worker for the installed list
     (Zeolite zl:listExt control message). The worker controlling the
     page wins; otherwise the vendored worker at /zlsw/sw.js is
     registered and used as a control plane (no page control). */
  const [extPanelOpen, setExtPanelOpen] = useState(false);
  const [extBusy, setExtBusy] = useState(false);
  const [extList, setExtList] = useState<ExtInfo[] | null>(null);
  /* Last registration/reply failure, shown verbatim in the panel. */
  const [extError, setExtError] = useState<string | null>(null);
  /* Extension detail card: the manifest surface from zl:extInfo. */
  const [extDetail, setExtDetail] = useState<ExtDetail | null>(null);
  const [extDetailError, setExtDetailError] = useState<string | null>(null);
  /* Per-extension incognito grants. UI-side only for now: the engine
     has no incognito concept yet, so this records the user's intent
     (and is enforced once the engine grows incognito tabs). */
  const [extIncognito, setExtIncognito] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("lobsterbrowse-ext-incognito") ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const saveExtIncognito = (next: Record<string, boolean>) => {
    setExtIncognito(next);
    /* Incognito data-flow: while the browser session is incognito, the
       toggle applies only to this session. Persisting it would leak
       which extensions the user toggled during incognito into the
       normal profile's localStorage. */
    if (props.incognito) return;
    try {
      localStorage.setItem("lobsterbrowse-ext-incognito", JSON.stringify(next));
    } catch {
      /* storage unavailable (private mode quirks) */
    }
  };
  const openExtDetail = async (id: string) => {
    setExtDetailError(null);
    setExtDetail(null);
    const rep = await zlSend({ type: "zl:extInfo", extId: id }, 6000);
    if (rep && rep.ok && rep.extension) {
      setExtDetail(rep.extension as ExtDetail);
    } else {
      setExtDetailError(
        rep && rep.error ? String(rep.error) : "the worker did not answer zl:extInfo",
      );
    }
  };
  const toggleExtEnabled = async (id: string, on: boolean) => {
    const rep = await zlSend({ type: "zl:extEnable", extId: id, enabled: on }, 6000);
    if (!rep || !rep.ok) {
      setExtDetailError(
        rep && rep.error ? String(rep.error) : "the worker did not answer zl:extEnable",
      );
      return;
    }
    /* Mirror the new state locally and refresh list + detail. */
    loadExtensions();
    setExtDetail((d) => (d && d.id === id ? { ...d, enabled: on } : d));
  };
  const toggleExtIncognito = (id: string, on: boolean) =>
    saveExtIncognito({ ...extIncognito, [id]: on });
  /* Options pages live at /zl-ext/<id>/<path> inside the engine
     worker, which today serves only web-accessible resources, so an
     options page (never WAR-listed) 404s with "zeolite: extension
     resource not found". Probe first and fail honestly in the panel
     instead of opening a dead tab; the same URL lights up unchanged
     when the engine starts serving extension pages. */
  const openExtOptions = async (d: ExtDetail) => {
    if (!d.optionsPath) return;
    const p = "/zl-ext/" + d.id + "/" + d.optionsPath;
    try {
      const r = await fetch(p);
      if (!r.ok) {
        setExtDetailError(
          "Options page not served by the engine: only web-accessible extension resources are (HTTP " + r.status + ")."
        );
        return;
      }
    } catch {
      setExtDetailError("Options page unavailable: no engine worker on this origin.");
      return;
    }
    pushLog("info", "ext options open " + p);
    window.open(p, "_blank");
  };
  const loadExtensions = async () => {
    setExtError(null);
    setExtDetail(null);
    setExtDetailError(null);
    if (!("serviceWorker" in navigator)) {
      setExtBusy(false);
      setExtList(null);
      setExtError("this browser has no service worker support");
      return;
    }
    /* The shared zeolite.ts plumbing registers the vendored worker
       (root scope; it passes through every non-engine path) and
       talks to it as a control plane when nothing controls the page. */
    setExtBusy(true);
    const rep = await zlSend({ type: "zl:listExt" }, 5000);
    setExtBusy(false);
    if (!rep) {
      setExtList(null);
      setExtError("the Zeolite service worker could not be registered or reached on this origin");
      return;
    }
    if (!rep.ok) {
      setExtList(null);
      setExtError(rep.error ? String(rep.error) : "zl:listExt failed");
      return;
    }
    setExtList(Array.isArray(rep.extensions) ? (rep.extensions as ExtInfo[]) : []);
  };
  /* Load errors surfaced from the server's meta[lb-load-error]. */
  const [errors, setErrors] = useState<Record<number, { url: string; message: string }>>({});

  /* Compact browse pass: with density "compact" the collapsed pill
     shows the site host instead of the page title, and the idle dock
     tucks sooner. Rollback for the whole pass: Settings > Density >
     Normal. */
  const compact = settings.density === "compact";
  /* Dock: tucks out of view when the app is idle; reappears on any
     pointer/keyboard activity in the app, on hovering the visible
     sliver, or on focusing the URL field. The transform lives on a
     plain wrapper div (.lb-dock-pill): applying it to the m3e-toolbar
     host did nothing (custom element host display), which left the
     bar frozen in place covering page content. */
  const [dockTucked, setDockTucked] = useState(false);
  const dockHoverRef = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const hideSoon = () => {
    if (!settings.autoHideChrome) return;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!dockHoverRef.current) setDockTucked(true);
      else hideSoon();
    }, compact ? 2200 : 3500);
  };
  useEffect(() => {
    const onActivity = () => {
      setDockTucked(false);
      hideSoon();
    };
    window.addEventListener("pointermove", onActivity);
    window.addEventListener("keydown", onActivity);
    hideSoon();
    return () => {
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("keydown", onActivity);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!settings.autoHideChrome) {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      setDockTucked(false);
    }
  }, [settings.autoHideChrome]);

  /* Fullscreen for the browser area. */
  const rootRef = useRef<HTMLElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rootRef.current?.requestFullscreen?.().catch(() => {});
  };

  const setDt = (id: number, patch: Partial<DtState>) => {
    setDtState((prev) => {
      const base = prev[id] ?? emptyDt();
      return { ...prev, [id]: { ...base, ...patch } };
    });
  };
  const dtOf = (id: number): DtState => dt[id] ?? emptyDt();
  const addNet = (id: number, entry: { url: string; method: string; status: number; ok?: boolean; dur?: number; error?: string }) => {
    setDtState((prev) => {
      const base = prev[id] ?? emptyDt();
      return { ...prev, [id]: { ...base, net: [...base.net, { id: nextEntryId(), ts: Date.now(), ...entry }] } };
    });
  };

  /* ---- Favicon: read from the same-origin frame document, fetch the
     icon through the engine, cache per icon URL. ---- */
  const loadFavicon = (tabId: number, url: string, doc: Document) => {
    let href = "";
    const link = doc.querySelector<HTMLLinkElement>("link[rel~='icon']");
    const attr = link ? link.getAttribute("href") || "" : "";
    if (attr) {
      if (
        attr.startsWith("/r/") || attr.startsWith("/lj/") || attr.startsWith("/zl/")
      ) {
        href = attr;
      } else {
        try {
          href = routeUrl(new URL(attr, url).href);
        } catch {
          href = "";
        }
      }
    }
    if (!href) {
      try {
        href = routeUrl(new URL(url).origin + "/favicon.ico");
      } catch {
        return;
      }
    }
    const setIcon = (obj: string) =>
      setIcons((prev) => (prev[tabId] === obj ? prev : { ...prev, [tabId]: obj }));
    const cached = iconCache.current.get(href);
    if (cached !== undefined) {
      if (cached) setIcon(cached);
      return;
    }
    fetch(href)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!blob || blob.size === 0 || blob.size > 400000) {
          iconCache.current.set(href, "");
          return;
        }
        const obj = URL.createObjectURL(blob);
        iconCache.current.set(href, obj);
        setIcon(obj);
      })
      .catch(() => {
        iconCache.current.set(href, "");
      });
  };
  /* Blob URL lifecycle: the cache dedupes per icon URL and stays
     bounded; eviction revokes only URLs no tab is still using, and
     everything left is revoked when the browser view unmounts. */
  const iconsRef = useRef<Record<number, string>>({});
  iconsRef.current = icons;
  useEffect(() => {
    const cache = iconCache.current;
    if (cache.size <= 64) return;
    const inUse = new Set(Object.values(iconsRef.current));
    const evict = cache.size - 64;
    let i = 0;
    for (const [k, v] of Array.from(cache.entries())) {
      if (i >= evict) break;
      cache.delete(k);
      i++;
      if (v && !inUse.has(v)) URL.revokeObjectURL(v);
    }
  }, [icons]);
  useEffect(
    () => () => {
      for (const v of iconCache.current.values()) if (v) URL.revokeObjectURL(v);
      iconCache.current.clear();
    },
    [],
  );

  /* ---- Navigation ---- */
  const load = (tab: Tab, url: string, opts?: { push?: boolean }) => {
    const push = opts?.push !== false;
    lastNav.current.set(tab.id, url);
    /* New navigation generation: older generations' results are stale. */
    const gen = (navGen.current.get(tab.id) ?? 0) + 1;
    navGen.current.set(tab.id, gen);
    const nid = "NAV-" + gen.toString(16).toUpperCase().padStart(4, "0").slice(-4);
    navId.current.set(tab.id, nid);
    const stack = push ? [...tab.stack.slice(0, tab.idx + 1), url] : tab.stack;
    const idx = push ? stack.length - 1 : tab.idx;
    props.updateTab(tab.id, { url, stack, idx, title: "" });
    /* Navigating away collapses the pill back to name mode (an empty
     * tab keeps it expanded via the empty-tab effect). */
    setTbExpanded(false);
    setDrafts((prev) => {
      const n = { ...prev };
      delete n[tab.id];
      return n;
    });
    setIcons((prev) => {
      const n = { ...prev };
      delete n[tab.id];
      return n;
    });
    setErrors((prev) => {
      if (!prev[tab.id]) return prev;
      const n = { ...prev };
      delete n[tab.id];
      return n;
    });

    setStatus((prev) => ({ ...prev, [tab.id]: { loading: true, nav: nid } }));
    const frame = frames.current.get(tab.id);
    /* 74.9: incognito tabs ride the engine's throwaway jar profile
       (zl:jarProfile) so their cookies never mix into the default
       one. */
    const href = routeUrl(url);
    if (frame) frame.src = href;
    pushLog("info", "engine nav " + url + " (" + nid + ")");
  };
  /* Stable handle to the current load(): the mount-once message
     listener calls this instead of capturing a render-time closure. */
  const loadRef = useRef(load);
  loadRef.current = load;

  /* ---- Auto-load: a tab whose URL was set without a navigation
     (Home search, restored session, newTab(url)) starts loading as
     soon as it becomes the active tab. ---- */
  useEffect(() => {
    const t = active;
    if (!t || !t.url) return;
    if (lastNav.current.get(t.id) === t.url) return;
    load(t, t.url, { push: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.url, settings, rules]);

  /* ---- Same-origin poll: real URL, title and favicon of the active
     frame, read directly from the frame document. JS-driven URL
     changes (pushState) sync back into the toolbar and tab. ---- */
  useEffect(() => {
    const iv = setInterval(() => {
      const t = active;
      if (!t || !t.url) return;
      const f = frames.current.get(t.id);
      if (!f) return;
      let doc: Document | null = null;
      let path = "";
      try {
        doc = f.contentDocument;
        path = f.contentWindow ? f.contentWindow.location.pathname : "";
      } catch {
        return;
      }
      if (!doc) return;
      /* Zeolite #31: a page whose engine bootstrap never attaches
         leaves the frame on about:blank with no error meta to
         find; without this check the escaped-navigation recovery
         below would reroute it to a bogus <site>/blank URL. Give
         the pending navigation four 1200ms ticks to commit, then
         surface a real error instead of a silent white frame. */
      if (f.contentWindow!.location.protocol === "about:") {
        const n = (blankPolls.current.get(t.id) || 0) + 1;
        blankPolls.current.set(t.id, n);
        if (n >= 4) {
          const msg = "The page was left on a blank document (engine bootstrap did not attach).";
          setStatus((prev) => {
            const cur = prev[t.id];
            return cur && cur.loading ? { ...prev, [t.id]: { loading: false } } : prev;
          });
          setErrors((prev) =>
            prev[t.id] && prev[t.id].message === msg && prev[t.id].url === t.url
              ? prev
              : { ...prev, [t.id]: { url: t.url, message: msg } }
          );
          if (n === 4) pushLog("error", "blank frame stuck: " + sanitizeUrl(t.url));
        }
        return;
      }
      blankPolls.current.delete(t.id);
      /* Detailed error page: the engine serves the honest error card
         at the same /zl/ path; surface it and stop the spinner. */
      const errMeta = doc.querySelector<HTMLMetaElement>('meta[name="lb-load-error"]');
      if (errMeta) {
        setStatus((prev) => ({ ...prev, [t.id]: { loading: false } }));
        const msg = errMeta.content || "unknown error";
        setErrors((prev) =>
          prev[t.id] && prev[t.id].message === msg && prev[t.id].url === t.url
            ? prev
            : { ...prev, [t.id]: { url: t.url, message: msg } }
        );
        pushLog("error", "load failed: " + msg);
        /* The error must also surface in the DevTools console, not just
           the error overlay. */
        setDtState((prev) => {
          const base = prev[t.id] ?? emptyDt();
          return {
            ...prev,
            [t.id]: {
              ...base,
              console: [
                ...base.console,
                {
                  id: nextEntryId(),
                  kind: "error" as const,
                  text: "[LobsterBrowse] load failed: " + msg + " (" + sanitizeUrl(t.url) + ")",
                  ts: Date.now(),
                },
              ].slice(-500),
            },
          };
        });
        return;
      }
      /* 74.7 CSP/SRI diagnostics: the rewriter strips CSP meta tags and
         integrity attributes from proxied documents and reports the
         counts in meta[lb-diag]. Surface each report once in DevTools
         as a diagnostic failure entry. */
      const diagMeta = doc.querySelector<HTMLMetaElement>('meta[name="lb-diag"]');
      if (diagMeta) {
        const content = diagMeta.content || "";
        if (lastDiag.current.get(t.id) !== content) {
          lastDiag.current.set(t.id, content);
          const m = /csp=(\d+);sri=(\d+)/.exec(content);
          if (m) {
            const csp = Number(m[1]) || 0;
            const sri = Number(m[2]) || 0;
            if (csp > 0 || sri > 0) {
              const mk = (kind: string, reason: string, n: number): ResFailEntry => ({
                id: nextEntryId(),
                url: sanitizeUrl(t.url || ""),
                kind,
                reason,
                status: 0,
                note: n + " stripped by the proxy rewriter (page would otherwise break inside the iframe)",
                nav: navId.current.get(t.id),
                ts: Date.now(),
              });
              /* CSP/SRI stripping is EXPECTED proxy behavior on every
                 rewritten page, not a site failure. The scary FAIL
                 entries only appear in diagnostic mode; the console
                 warning always explains the intervention. */
              const wantFails = settings.diagnostics;
              setDtState((prev) => {
                const base = prev[t.id] ?? emptyDt();
                const fails = [...base.fails];
                if (wantFails && csp > 0) fails.push(mk("csp-meta", "CSP_STRIPPED", csp));
                if (wantFails && sri > 0) fails.push(mk("sri-integrity", "SRI_STRIPPED", sri));
                /* Own the proxy's own interventions in the page console:
                   entries explicitly prefixed as engine-caused, so a
                   broken page is never silently blamed on the site. */
                const bits: string[] = [];
                if (csp > 0) bits.push(csp + " CSP meta tag(s)");
                if (sri > 0) bits.push(sri + " integrity attribute(s)");
                const ctext =
                  "[LobsterBrowse Preview engine] This proxy stripped " +
                  bits.join(" and ") +
                  " from the page. SRI hashes and CSP rules no longer match rewritten content; the rewriter removes them so the page loads at all. If the page misbehaves, this is the proxy's doing, not the website's.";
                const console_ = [
                  ...base.console,
                  { id: nextEntryId(), kind: "warn" as const, text: ctext, ts: Date.now() },
                ].slice(-500);
                return { ...prev, [t.id]: { ...base, fails: fails.slice(-200), console: console_ } };
              });
              pushLog("info", "rewrite diag: csp stripped=" + csp + " sri stripped=" + sri);
            }
          }
        }
      }
      /* Escaped-navigation recovery: challenge pages (Anubis etc.) get
         no shim on their intermediate hosts, so their JS sometimes
         "solves" the challenge by navigating the frame to a bare app
         path, which the SPA fallback answers with index.html — the
         user sees our app shell pretending to be the site. Detect a
         frame sitting on a non-route app path while the tab has a real
         URL, reconstruct the intended target and reload it through the
         engine. Each distinct URL is recovered once per tab (lastEscape
         guard), so a site that genuinely 404s into the fallback does
         not loop. */
      const appPrefixes = [
        "/zlsw", "/libcurl", "/zl-ext", "/zl-cs", "/suggest", "/cert",
        "/logs", "/build", "/wisp", "/favicon",
      ];
      const isAppPath = appPrefixes.some((p) => path === p || path.startsWith(p + "/"));
      if (
        !path.startsWith("/r/") &&
        !path.startsWith("/lj/") &&
        !path.startsWith("/zl/")
      ) {
        if (!t.url || path === "/" || isAppPath) return;
        try {
          const loc = f.contentWindow!.location;
          const intended = new URL(loc.pathname + loc.search, t.url).href;
          if (!intended.startsWith("http")) return;
          const key = t.id + "|" + intended;
          if (lastEscape.current.has(key)) return;
          lastEscape.current.add(key);
          pushLog(
            "warn",
            "escaped navigation recovered: " + loc.pathname + " -> " + intended
          );
          f.src = routeUrl(intended);
        } catch {
          /* cross-origin or gone: nothing to recover */
        }
        return;
      }
      const real = decodeRoute(path);
      if (!real) return;
      setErrors((prev) => {
        if (!prev[t.id]) return prev;
        const n = { ...prev };
        delete n[t.id];
        return n;
      });
      if (real !== t.url) {
        /* History semantics: a URL change seen by polling is NOT always
           a new navigation. If the page used history.back()/forward()
           (popstate), the polled URL matches an adjacent stack entry:
           move the index, do not append. A→B→C + back stays A→B→C at
           index 1, never A→B→C→B. Only a genuinely new URL (pushState,
           replaceState to a different path) pushes a fresh entry. */
        const stack = t.stack;
        const idx = t.idx;
        let patch: Partial<Tab>;
        if (idx > 0 && stack[idx - 1] === real) {
          patch = { url: real, idx: idx - 1 };
        } else if (idx < stack.length - 1 && stack[idx + 1] === real) {
          patch = { url: real, idx: idx + 1 };
        } else {
          patch = { url: real, stack: [...stack.slice(0, idx + 1), real], idx: idx + 1 };
          if (!props.incognito) props.onHistory(real);
        }
        props.updateTab(t.id, patch);
        pushLog("info", "url sync " + sanitizeUrl(real));
      }
      const title = (doc.title || "").trim();
      if (title && title !== t.title) props.updateTab(t.id, { title });
      setStatus((prev) => {
        const cur = prev[t.id];
        return cur && cur.loading ? { ...prev, [t.id]: { loading: false } } : prev;
      });
      loadFavicon(t.id, real, doc);
      /* Engine prefetch: hovering (or keyboard-focusing) a link in
         the proxied page warms the worker cache before the click. */
      if (settings.prefetchLinks && !wiredDocs.current.has(doc)) {
        wiredDocs.current.add(doc);
        const prefix = engineRoutePrefix();
        const prefetch = (el: EventTarget | null) => {
          const target = el as Element | null;
          const a = target && target.closest ? (target.closest("a[href]") as HTMLAnchorElement | null) : null;
          if (!a) return;
          const href = a.getAttribute("href") || "";
          if (!href.startsWith(prefix)) return;
          if (a.getAttribute("target") === "_blank" || a.hasAttribute("download")) return;
          fetch(href).catch(() => {});
        };
        doc.addEventListener("pointerover", (e) => prefetch(e.target), { passive: true });
        doc.addEventListener("focusin", (e) => prefetch(e.target), true);
      }
      /* Download interception (always on, independent of the
         prefetch setting): capture-phase click handler on a[download]
         links and obvious file links, so the app can stream them with
         visible progress. */
      if (!dlWired.current.has(doc)) {
        dlWired.current.add(doc);
        doc.addEventListener(
          "click",
          (e) => {
            const el = e.target as Element | null;
            const a = el && el.closest ? (el.closest("a[href]") as HTMLAnchorElement | null) : null;
            if (!a) return;
            const attr = a.getAttribute("download");
            const href = a.getAttribute("href") || "";
            if (!href || href.startsWith("javascript:") || href.startsWith("blob:") || href.startsWith("data:")) return;
            let original = href;
            try {
              const dec = decodeRoute(href);
              if (dec) original = dec;
            } catch {
              /* not an engine route; keep the raw href */
            }
            if (!attr && !DL_FILE_RE.test(original)) return;
            e.preventDefault();
            e.stopPropagation();
            let name = (attr || "").trim();
            if (!name) {
              try {
                const abs = new URL(original, t.url).href;
                name = decodeURIComponent(new URL(abs).pathname.split("/").filter(Boolean).pop() || "download");
              } catch {
                name = "download";
              }
            }
            startDownload(href, name.slice(0, 120));
          },
          true,
        );
      }
    }, 1200);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, tabs, settings, rules]);

  /* ---- Hook messages from proxied pages ---- */
  /* ---- Hook messages from proxied pages ----
     ONE listener, registered once on mount. The old effect depended on
     [tabs, activeId, settings, rules, dt], so every state change tore
     the listener down and re-registered it (churn + dropped-message
     races). Everything the handler needs now comes from a `live` ref
     refreshed on every render, so the listener identity never changes
     and never reads stale render-time state. */
  const live = useRef({
    tabs,
    dt,
    settings,
    incognito: props.incognito,
    onHistory: props.onHistory,
    newTab: props.newTab,
    updateTab: props.updateTab,
  });
  live.current = {
    tabs,
    dt,
    settings,
    incognito: props.incognito,
    onHistory: props.onHistory,
    newTab: props.newTab,
    updateTab: props.updateTab,
  };
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      /* Sender + origin validation: proxied frames are same-origin by
         architecture (that is what gives DevTools its page access), so
         a message from any other origin is not one of ours. */
      if (e.origin !== window.location.origin) return;
      const data = e.data as { lb?: string; data?: Record<string, unknown> } | null;
      /* Schema validation: {lb: string, data?: object}. Anything else
         (including unknown lb types) is dropped. */
      if (!data || typeof data.lb !== "string" || data.lb.length > 32) return;
      const process = (
        ev: { lb?: string; data?: Record<string, unknown> },
        source: MessageEventSource | null,
      ) => {
      if (ev.data !== undefined && typeof ev.data !== "object") return;
      const L = live.current;
      let tabId: number | null = null;
      let tab: Tab | undefined;
      for (const t of L.tabs) {
        const f = frames.current.get(t.id);
        if (f && source === f.contentWindow) {
          tabId = t.id;
          tab = t;
          break;
        }
      }
      if (tabId === null || !tab) return;
      const d = ev.data ?? {};
      const dtBase = () => L.dt[tabId as number] ?? emptyDt();
      /* Maximum string lengths: a hostile or broken page must not be
         able to stuff megabytes into DevTools state. */
      const cap = (v: unknown, n: number) => String(v ?? "").slice(0, n);

      if (ev.lb === "console") {
        const level = String(d.level ?? "log");
        const kind: "error" | "warn" | "info" | "debug" | "log" =
          level === "error" ? "error" : level === "warn" ? "warn" : level === "info" ? "info" : level === "debug" ? "debug" : "log";
        /* Diagnostic mode: every page console message lands in the app
           log too, with the tab id, so failures are traceable without
           opening DevTools. */
        if (L.settings.diagnostics) {
          pushLog(kind === "error" || kind === "warn" ? "error" : "info",
            "console[" + tabId + "] " + kind + ": " + sanitizeText(cap(d.text, 300)));
        }
        setDt(tabId, {
          console: [...dtBase().console, { id: nextEntryId(), kind, text: sanitizeText(cap(d.text, 4000)), ts: Number(d.ts ?? Date.now()) }].slice(-500),
        });
      } else if (ev.lb === "net") {
        setDt(tabId, {
          net: [
            ...dtBase().net,
            {
              id: nextEntryId(),
              url: sanitizeUrl(cap(d.url, 2000)),
              method: cap(d.method, 10) || "GET",
              status: Number(d.status ?? 0),
              ok: d.ok === undefined ? undefined : Boolean(d.ok),
              dur: d.dur === undefined ? undefined : Number(d.dur),
              error: d.error === undefined ? undefined : sanitizeText(cap(d.error, 500)),
              ts: Number(d.ts ?? Date.now()),
            },
          ].slice(-500),
        });
      } else if (ev.lb === "resfail") {
        /* Resource-failure diagnostics: what failed, where, why. */
        const entry: ResFailEntry = {
          id: nextEntryId(),
          url: sanitizeUrl(cap(d.url, 2000)),
          kind: cap(d.kind, 40) || "unknown",
          reason: cap(d.reason, 60) || "UNKNOWN",
          status: d.status === undefined ? undefined : Number(d.status) || 0,
          note: d.note === undefined ? undefined : sanitizeText(cap(d.note, 400)),
          /* 74.4 failure chain: which navigation this failure belongs
             to, same NAV-XXXX id the error page shows. */
          nav: navId.current.get(tabId as number),
          ts: Number(d.ts ?? Date.now()) || Date.now(),
        };
        /* Diagnostic mode: every failure goes to the app log with the
           full reason and note, not just the DevTools counter. */
        if (L.settings.diagnostics) {
          pushLog("error",
            "resfail[" + tabId + "] " + entry.kind + " " + entry.reason +
            (entry.status !== undefined ? " HTTP " + entry.status : "") +
            " " + entry.url +
            (entry.note ? " (" + entry.note + ")" : ""));
        }
        setDtState((prev) => {
          const base = prev[tabId as number] ?? emptyDt();
          return {
            ...prev,
            [tabId as number]: {
              ...base,
              fails: [...base.fails, entry].slice(-200),
              console: [
                ...base.console,
                {
                  id: nextEntryId(),
                  kind: "error" as const,
                  text:
                    "[LobsterBrowse] failed to load " + entry.kind + ": " + entry.url +
                    " (" + reasonText(entry.reason) +
                    (entry.status !== undefined ? ", HTTP " + entry.status : "") + ")",
                  ts: Date.now(),
                },
              ].slice(-500),
            },
          };
        });
      } else if (ev.lb === "ready") {
        /* Stale-navigation guard: a ready that arrives after a newer
           load() started must not update the tab (title/status). */
        if (lastNav.current.get(tabId) !== tab.url) return;
        const title = cap(d.title, 300);
        if (title) L.updateTab(tabId, { title });
        setStatus((prev) => ({ ...prev, [tabId as number]: { loading: false, nav: prev[tabId as number]?.nav } }));
        if (tab.url && !L.incognito) L.onHistory(tab.url);
      } else if (ev.lb === "navigate") {
        const href = cap(d.href, 2000);
        if (!href) return;
        const abs = (() => {
          try {
            return new URL(href, tab.url).href;
          } catch {
            return "";
          }
        })();
        /* Scheme validation: only http(s) navigations. javascript:,
           data:, blob:, file: and friends are rejected outright — a
           proxied page must not script the browser surface. */
        if (!abs || !/^https?:/i.test(abs)) return;
        if (d.newTab) {
          L.newTab(abs);
        } else {
          loadRef.current(tab, abs, { push: true });
        }
      } else if (ev.lb === "nav") {
        /* Event-driven SPA navigation (74.6): the page hook reports
           pushState/replaceState/popstate/hashchange the instant they
           happen, so the toolbar and tab stack update without waiting
           for the 1.2s poll (which stays as a fallback for favicon,
           error-meta, mute and title). Same history semantics as the
           poll: a change to an adjacent stack entry moves the index
           (back/forward), a genuinely new URL pushes. */
        const real = cap(d.url, 2000);
        if (!real || !/^https?:/i.test(real)) return;
        if (real !== tab.url) {
          const stack = tab.stack;
          const idx = tab.idx;
          let patch: Partial<Tab>;
          if (idx > 0 && stack[idx - 1] === real) {
            patch = { url: real, idx: idx - 1 };
          } else if (idx < stack.length - 1 && stack[idx + 1] === real) {
            patch = { url: real, idx: idx + 1 };
          } else {
            patch = { url: real, stack: [...stack.slice(0, idx + 1), real], idx: idx + 1 };
            if (!L.incognito) L.onHistory(real);
          }
          L.updateTab(tabId, patch);
          pushLog("info", "url sync " + sanitizeUrl(real));
        }
        setStatus((prev) => {
          const cur = prev[tabId as number];
          return cur && cur.loading ? { ...prev, [tabId as number]: { loading: false } } : prev;
        });
      }
      /* Unknown data.lb values are ignored by design. */
      };
      /* Single events keep the original shape; the shim's batched
         diagnostics arrive as {lb:"batch", data:{events:[...]}} so a
         busy page costs one React update per flush window, not one per
         console line. Batch size is capped defensively. */
      if (data.lb === "batch") {
        const evs = (data.data as { events?: unknown } | undefined)?.events;
        if (!Array.isArray(evs)) return;
        for (const item of evs.slice(0, 100)) {
          if (item && typeof item === "object" && typeof (item as { lb?: unknown }).lb === "string") {
            process(item as { lb?: string; data?: Record<string, unknown> }, e.source);
          }
        }
      } else {
        process(data, e.source);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draft = active ? (drafts[active.id] ?? active.url) : "";
  /* Query the search engine for completions of the current draft.
     Debounced 160ms; must run before the empty-tab early return so the
     hook order never changes between renders. */
  useEffect(() => {
    const q = draft.trim();
    /* Min length 2: single characters are noise and cost a round trip
       per keystroke for no useful completion. */
    /* tbExpanded + looksLikeUrl gates: with a page loaded, draft
       falls back to the page URL, and engines answer URL-shaped
       text with junk, which popped a phantom dropdown over the
       COLLAPSED pill and burned a suggest round trip on every
       navigation. Home already gates looksLikeUrl; match it. */
    if (!q || q.length < 2 || !settings.suggestQueries || !tbExpanded || looksLikeUrl(q)) {
      setTbSugg([]);
      setTbSuggOpen(false);
      setTbSuggIdx(-1);
      return;
    }
    /* AbortController: a superseded keystroke cancels its in-flight
       request instead of only ignoring the late answer. Site-generated
       AbortErrors are normal cancellations and land in the same
       swallow path; nothing here reports FETCH_FAILURE. */
    const ac = new AbortController();
    const t = setTimeout(() => {
      fetchSuggestions(settings.engine, draft, ac.signal, active.sess)
        .then((res) => {
          const items = res.items.map((text) => ({ text, url: searchUrl(settings, text), src: res.source }));
          setTbSugg(items);
          setTbSuggOpen(items.length > 0);
          setTbSuggIdx(-1);
          /* Diagnostics: the suggest endpoint is server-proxied and can
             fail per engine; a zero count in the app log pinpoints
             whether the box is empty because of the network or the
             setting. */
          pushLog("info", "suggest [" + settings.engine + "] '" + draft.slice(0, 40) + "' -> " + items.length + (res.source ? " via " + res.source : ""));
        })
        .catch(() => {
          /* aborted or failed; no diagnostic for aborts by design */
        });
    }, 160);
    return () => {
      ac.abort();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, settings.engine, settings.suggestQueries, tbExpanded]);

  /* Compaction 4: an empty tab IS the new-tab search. The in-page hero
     with its own search bar is gone; the toolbar pill expands and
     takes focus instead, so there is exactly one search surface. */
  useEffect(() => {
    if (active?.url) return;
    setTbExpanded(true);
    const t = window.setTimeout(() => urlInputRef.current?.focus(), 80);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.url]);

  /* Expanding the center pill focuses (and selects) the URL text. */
  useEffect(() => {
    if (tbExpanded) urlInputRef.current?.select();
  }, [tbExpanded]);

  /* TLS certificate state: declared above the !active early return —
     a useState below a conditional return changes the hook count
     between renders and crashes React. */
  const [siteCert, setSiteCert] = useState<
    { issuer: string; notAfter: string; days: number } | null | "checking" | "error"
  >(null);

  if (!active) {
    /* App sends us back to Home when the last tab closes. */
    return null;
  }

  const st = status[active.id] ?? { loading: false };
  const activeDt = dtOf(active.id);

  const go = (value: string) => {
    const q = value.trim();
    if (!q) return;
    load(active, looksLikeUrl(q) ? normalizeUrl(q) : searchUrl(settings, q), { push: true });
  };

  const back = () => {
    if (active.idx > 0) {
      const url = active.stack[active.idx - 1];
      props.updateTab(active.id, { idx: active.idx - 1, url });
      load(active, url, { push: false });
    }
  };
  const forward = () => {
    if (active.idx < active.stack.length - 1) {
      const url = active.stack[active.idx + 1];
      props.updateTab(active.id, { idx: active.idx + 1, url });
      load(active, url, { push: false });
    }
  };
  /* Smooth close: the tab collapses first (.closing), the real close
     (and the siblings sliding over) lands after the animation. */
  const closeTabSmooth = (id: number) => {
    if (closingIds.includes(id)) return;
    setClosingIds((prev) => [...prev, id]);
    window.setTimeout(() => {
      setClosingIds((prev) => prev.filter((x) => x !== id));
      /* Full per-tab state cleanup: status, DevTools, drafts, icons,
         errors, mute set, navigation bookkeeping and the frame handle.
         (The favicon blob URL itself is shared through iconCache, so
         it is only revoked when no tab uses it anymore.) */
      frames.current.delete(id);
      lastNav.current.delete(id);
      navGen.current.delete(id);
      navId.current.delete(id);
      blankPolls.current.delete(id);
      lastDiag.current.delete(id);
      for (const k of lastEscape.current) {
        if (k.startsWith(id + "|")) lastEscape.current.delete(k);
      }
      const drop = <T extends Record<number, unknown>>(prev: T): T => {
        if (!(id in prev)) return prev;
        const n = { ...prev };
        delete n[id];
        return n;
      };
      setStatus(drop);
      setDrafts(drop);
      setIcons(drop);
      setErrors(drop);
      setDtState((prev) => {
        if (!prev[id]) return prev;
        const n = { ...prev };
        delete n[id];
        return n;
      });
      props.closeTab(id);
    }, 240);
  };

  /* ---- Lock popup: connection facts + cookies of the active site. ---- */
  const secure = !!active.url && active.url.startsWith("https://");
  let uParts = { scheme: "", host: "", port: "" };
  try {
    const u = new URL(active.url);
    uParts = {
      scheme: u.protocol.replace(":", ""),
      host: u.hostname,
      port: u.port || (u.protocol === "https:" ? "443 (default)" : "80 (default)"),
    };
  } catch {
    /* not a URL yet */
  }
  /* ---- Per-site rules chip (#10) ---- */
  const activeRule = rules.find((r) => r.domain === uParts.host);
  /* Effective ad-block: global unless this site's rule disables it
     (same semantics as the zl:rules push). */
  const ruleAdBlock = settings.adblock && activeRule?.adblock !== false;
  const ruleUa: UaPresetId | "" = activeRule?.uaPreset ?? "";
  const setRuleAdblock = (on: boolean) => {
    const host = uParts.host;
    if (!host) return;
    const i = rules.findIndex((r) => r.domain === host);
    if (on) {
      /* Remove the override: the site falls back to the global setting. */
      if (i < 0) return;
      const r = { ...rules[i] };
      delete r.adblock;
      const next = [...rules];
      if (Object.keys(r).every((k) => k === "domain" || r[k as keyof SiteRule] === undefined)) next.splice(i, 1);
      else next[i] = r;
      props.onRulesChange(next);
    } else {
      if (i >= 0) props.onRulesChange(rules.map((r) => (r.domain === host ? { ...r, adblock: false } : r)));
      else props.onRulesChange([...rules, { domain: host, adblock: false }]);
    }
  };
  const setRuleUa = (preset: UaPresetId | "") => {
    const host = uParts.host;
    if (!host) return;
    const i = rules.findIndex((r) => r.domain === host);
    if (preset === "") {
      if (i < 0) return;
      const r = { ...rules[i] };
      delete r.uaPreset;
      const next = [...rules];
      if (Object.keys(r).every((k) => k === "domain" || r[k as keyof SiteRule] === undefined)) next.splice(i, 1);
      else next[i] = r;
      props.onRulesChange(next);
      return;
    }
    if (i >= 0) props.onRulesChange(rules.map((r) => (r.domain === host ? { ...r, uaPreset: preset } : r)));
    else props.onRulesChange([...rules, { domain: host, uaPreset: preset }]);
  };
  /* TLS certificate details for the site card. The server checks the
     host's public CT-log record (crt.sh), so this works even though
     the browser never makes a direct TLS connection to the site. */
  const loadSiteCert = (host: string) => {
    if (!host) return;
    /* Navigation-generation guard: if the tab navigates while the CT
       lookup is in flight, the stale answer is dropped. */
    const tabId = active.id;
    const gen = navGen.current.get(tabId);
    setSiteCert("checking");
    fetch("/cert?host=" + encodeURIComponent(host) + "&lb_sess=" + encodeURIComponent(active.sess))
      .then((r) => r.json() as Promise<{ ok: boolean; issuer?: string; notAfter?: string; days?: number }>)
      .then((d) => {
        if (navGen.current.get(tabId) !== gen) return;
        if (d && d.ok && d.issuer) {
          setSiteCert({ issuer: d.issuer, notAfter: d.notAfter ?? "", days: d.days ?? 0 });
        } else {
          setSiteCert("error");
        }
      })
      .catch(() => {
        if (navGen.current.get(tabId) !== gen) return;
        setSiteCert("error");
      });
  };
  const loadSiteCookies = () => {
    const f = frames.current.get(active.id);
    let jar: string[] = [];
    try {
      const doc = f ? f.contentDocument : null;
      jar = doc && doc.cookie ? doc.cookie.split(";").map((c) => c.trim()).filter(Boolean) : [];
    } catch {
      jar = [];
    }
    setSiteCookies(jar);
  };
  /* Expire every cookie the page can see, on the host and every
     parent domain, so nothing survives. */
  const clearSiteCookies = () => {
    const f = frames.current.get(active.id);
    try {
      const doc = f ? f.contentDocument : null;
      if (!doc) return;
      const host = new URL(active.url).hostname;
      const domains = [host, ...host.split(".").map((_, i) => host.split(".").slice(i).join(".")).slice(1)];
      const names = doc.cookie.split(";").map((c) => c.trim().split("=")[0]).filter(Boolean);
      for (const n of names) {
        for (const d of domains) {
          doc.cookie = n + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/" + (d !== host ? ";domain=" + d : "");
        }
      }
      setSiteCookies(doc.cookie.split(";").map((c) => c.trim()).filter(Boolean));
      pushLog("info", "cleared " + names.length + " site cookie(s) for " + host);
    } catch {
      /* frame not reachable */
    }
  };
  const exportCookies = () => {
    let domain = "";
    try {
      domain = new URL(active.url).hostname;
    } catch {
      /* keep empty */
    }
    const rows = [["name", "value", "domain"]].concat(
      siteCookies.map((c) => {
        const i = c.indexOf("=");
        return [i === -1 ? c : c.slice(0, i), i === -1 ? "" : c.slice(i + 1), domain];
      })
    );
    const csv = rows.map((r) => r.map((x) => '"' + x.replace(/"/g, '""') + '"').join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "lobsterbrowse-cookies.csv";
    a.click();
    /* Revoke late: an immediate revoke can abort the download before
       the browser takes ownership of the blob (seen on Firefox). */
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  return (
    <section
      className={"lb-browser" + (props.incognito ? " incognito" : "")}
      ref={(el) => {
        rootRef.current = el as HTMLElement | null;
      }}
    >
      {/* Compaction 1 (final): the floating tab strip is GONE. Tabs
          live in the toolbar only: the tab-count button opens the tab
          list card; the + button creates a tab. */}

      {/* Content area: one same-origin engine iframe per tab, inactive ones stay mounted */}
      <div className="lb-pages">
        {tabs.map((t) => (
          <div key={t.id} className={"lb-page" + (t.id === active.id ? " active" : "")}>
            <iframe
              title={"Proxy tab " + t.id}
              allow="clipboard-read; clipboard-write"
              ref={(el) => {
                if (el) frames.current.set(t.id, el);
                else frames.current.delete(t.id);
              }}
              /* No sandbox attribute: engine frames are same-origin by
                 design, so the old allow-same-origin + allow-scripts
                 sandbox provided no real isolation (that exact pair is
                 what triggers the "can escape its sandboxing" console
                 warning) while adding navigation/download quirks.
                 Hostile page scripts are contained by the engine's
                 navguard instead. */
              /* Cross-origin frames can't be polled; the
                 load event is the only reliable "done" signal there. */
              onLoad={() =>
                setStatus((prev) => {
                  const cur = prev[t.id];
                  return cur && cur.loading ? { ...prev, [t.id]: { loading: false } } : prev;
                })
              }
            />
          </div>
        ))}

        {st.loading && (
          <div className="lb-loading" aria-busy="true">
            <m3e-circular-progress-indicator indeterminate={true} aria-label="Loading page" {...{ style: { marginTop: "4vh", width: 56, height: 56 } }} />
          </div>
        )}

        {errors[active.id] && (
          <div className="lb-error" role="alertdialog" aria-label="Page failed to load">
            <m3e-heading variant="title" size="medium" level={2}>This page could not be loaded</m3e-heading>
            <p className="lb-error-url">{errors[active.id].url}</p>
            <p className="lb-error-msg">{errors[active.id].message}</p>
            <div className="lb-error-logs">
              <div className="lb-error-logs-title">Technical log</div>
              <div className="lb-error-logline">
                engine zeolite · route {routeUrl(errors[active.id].url)}
              </div>
              <div className="lb-error-logline">
                navigation {status[active.id]?.nav ?? navId.current.get(active.id) ?? "unknown"}
              </div>
              {activeDt.fails.length > 0 && (
                <div className="lb-error-logline">
                  resource failures: {activeDt.fails.length} (
                  {Object.entries(
                    activeDt.fails.reduce<Record<string, number>>((a, f) => {
                      a[f.kind] = (a[f.kind] ?? 0) + 1;
                      return a;
                    }, {}),
                  )
                    .map(([k, n]) => n + " × " + k)
                    .join(", ")}
                  )
                </div>
              )}
              {[
                ...activeDt.fails.slice(-10).map((f) => "fail: [" + f.kind + "] " + (f.status ? f.status + " " : "") + f.url + " — " + f.reason + (f.note ? " (" + f.note + ")" : "")),
                ...activeDt.console.filter((e) => e.kind === "error").slice(-5).map((e) => "console: " + e.text),
                ...activeDt.net.slice(-10).map((n) => n.method + " " + n.status + " " + n.url),
              ].map((line, i) => (
                <div key={i} className="lb-error-logline">{line}</div>
              ))}
            </div>
            <m3e-button
              variant="filled"
              onClick={() => {
                const target = errors[active.id].url;
                setErrors((prev) => {
                  const n = { ...prev };
                  delete n[active.id];
                  return n;
                });
                load(active, target, { push: false });
              }}
            >
              <m3e-icon name="refresh" aria-hidden={true} /> Try again
            </m3e-button>
          </div>
        )}

        {/* Compaction 4: the in-page new-tab hero is gone. An empty
            tab expands and focuses the toolbar pill instead (see the
            empty-tab effect), so there is exactly one search surface. */}

        {activeDt.open && (
          <DevTools
            tab={active}
            dt={activeDt}
            setDt={(patch) => setDt(active.id, patch)}
            frame={() => frames.current.get(active.id) ?? null}
            onClose={() => setDt(active.id, { open: false })}
            onOpenLogs={props.onOpenLogs}
            sess={active.sess}
          />
        )}

      </div>

      {/* Bottom dock: tucks out of view when idle; hover the visible
          sliver, focus the URL field, or move the pointer / type to
          bring it back. */}
      <div
        className={"lb-dock" + (dockTucked ? " tucked" : "") + (tabsOpen ? " tabs-open" : "")}
        onMouseEnter={() => (dockHoverRef.current = true)}
        onMouseLeave={() => {
          dockHoverRef.current = false;
          hideSoon();
        }}
      >
        {/* Tab switcher: its own surface while the toolbar slides
            away (.lb-dock.tabs-open). Horizontal row of live preview
            tiles (scriptless engine frames, scaled 0.25), not a list.
            Extracted to browser/TabSwitcherCard; state stays here. */}
        <TabSwitcherCard
          tabs={tabs}
          activeId={active.id}
          closingIds={closingIds}
          icons={icons}
          open={tabsOpen}
          onNewTab={() => { props.newTab(); setTabsOpen(false); }}
          onClose={() => setTabsOpen(false)}
          onSelect={(id) => { props.setActiveId(id); setTabsOpen(false); }}
          onCloseTab={closeTabSmooth}
        />
        <div className="lb-dock-pill">
          <m3e-toolbar variant="standard" shape="rounded" {...{ class: "lb-toolbar" }}>
          {/* Compaction 1: tabs live in the toolbar too. The count
              button opens the tab list card (same anchoring pattern
              as the site info card). Real m3e-icon-button with toggle
              semantics: geometry, hover/pressed/focus/selected states
              come from the component like every other toolbar control. */}
          <m3e-icon-button
            id="lb-tabs-pill"
            toggle
            aria-label={"Open tab list (" + tabs.length + " tabs)"}
            onClick={() => {
              setTabsOpen((v) => !v);
              setSiteInfoOpen(false);
              setDlOpen(false);
            }}
            {...{ ref: tabsBtnRef }}
          >
            <span className="lb-tabs-ic" aria-hidden={true} dangerouslySetInnerHTML={{ __html: tabSvg }} />
          </m3e-icon-button>
          <m3e-tooltip for="lb-tabs-pill" position="above">Tabs</m3e-tooltip>
          <m3e-icon-button id="lb-newtab-btn" aria-label="New tab" onClick={() => props.newTab()}>
            <m3e-icon name="add" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-tooltip for="lb-newtab-btn" position="above">New tab</m3e-tooltip>
          <m3e-icon-button id="lb-back-btn" aria-label="Back" onClick={back}>
            <m3e-icon name="arrow_back" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-tooltip for="lb-back-btn" position="above">Back</m3e-tooltip>
          <m3e-icon-button id="lb-forward-btn" aria-label="Forward" onClick={forward}>
            <m3e-icon name="arrow_forward" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-tooltip for="lb-forward-btn" position="above">Forward</m3e-tooltip>
          <m3e-icon-button
            id="lb-reload-btn"
            aria-label="Reload"
            onClick={() => (active.url ? load(active, active.url, { push: false }) : undefined)}
          >
            <m3e-icon name="refresh" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-tooltip for="lb-reload-btn" position="above">Reload</m3e-tooltip>
          {/* The pill centers itself with auto margins; no spacers. */}
          {/* Center pill: lock + favicon + tab name. Pressed, it expands
              in place into the editable URL (the name hides). */}
          <span className={"lb-tb-pill" + (tbExpanded || !active.url ? " expanded" : "")}>
            {tbSuggOpen && (
              <div className="lb-tb-ac" role="listbox" aria-label="Suggestions">
                {tbSugg.map((it, i) => (
                  <button
                    key={it.url}
                    type="button"
                    role="option"
                    aria-selected={i === tbSuggIdx}
                    className={"lb-tb-ac-item" + (i === tbSuggIdx ? " active" : "")}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setTbSuggOpen(false);
                      setTbExpanded(false);
                      go(it.url);
                    }}
                  >
                    <m3e-icon name="search" aria-hidden={true} />
                    <span className="lb-tb-ac-text">{it.text}</span>
                    {it.src && (
                      <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.65, flexShrink: 0 }}>via {it.src}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {active.url && (
              <>
                <span
                  className="lb-tb-lock-wrap"
                  role="button"
                  tabIndex={0}
                  aria-label={secure ? "https connection, site details" : "Not secure, site details"}
                  onClick={() => {
                    loadSiteCookies();
                    if (secure && uParts.host && !siteInfoOpen) loadSiteCert(uParts.host);
                    setSiteInfoOpen((v) => !v);
                    setTabsOpen(false);
                    setDlOpen(false);
                  }}
                >
                  <span
                    className={"lb-tb-lock " + (secure ? "secure" : "insecure")}
                    aria-hidden={true}
                    dangerouslySetInnerHTML={{ __html: secure ? lockSvg : noEncSvg }}
                  />
                </span>
                {icons[active.id] ? (
                  <img className="lb-tb-favicon" src={icons[active.id]} alt="" />
                ) : (
                  <m3e-icon name="public" aria-hidden={true} />
                )}
              </>
            )}
            {tbExpanded || !active.url ? (
              <input
                ref={urlInputRef}
                className="lb-url-input"
                aria-label="URL or search"
                placeholder={"Search with " + ENGINES[settings.engine].name + " or URL"}
                value={draft}
                spellCheck={false}
                onChange={(e) => {
                  setDrafts((prev) => ({ ...prev, [active.id]: e.target.value }));
                  setTbSuggIdx(-1);
                }}
                onFocus={() => setTbSuggOpen(tbSugg.length > 0)}
                onBlur={() => {
                  setTbSuggOpen(false);
                  setTbExpanded(false);
                  setDrafts((prev) => {
                    if (!(active.id in prev)) return prev;
                    const next = { ...prev };
                    delete next[active.id];
                    return next;
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const pick = tbSuggOpen && tbSuggIdx >= 0 ? tbSugg[tbSuggIdx]?.url : draft;
                    setTbSuggOpen(false);
                    setTbExpanded(false);
                    if (pick) go(pick);
                  } else if (e.key === "ArrowDown" && tbSuggOpen) {
                    e.preventDefault();
                    setTbSuggIdx((p) => Math.min(p + 1, tbSugg.length - 1));
                  } else if (e.key === "ArrowUp" && tbSuggOpen) {
                    e.preventDefault();
                    setTbSuggIdx((p) => Math.max(p - 1, -1));
                  } else if (e.key === "Escape") {
                    setTbSuggOpen(false);
                    setTbExpanded(false);
                    setDrafts((prev) => {
                      if (!(active.id in prev)) return prev;
                      const next = { ...prev };
                      delete next[active.id];
                      return next;
                    });
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="lb-tb-name"
                aria-label={"Show URL of " + tabLabel(active)}
                onClick={() => setTbExpanded(true)}
              >
                {compact && uParts.host ? (uParts.host.startsWith("www.") ? uParts.host.slice(4) : uParts.host) : tabLabel(active)}
              </button>
            )}
          </span>
          <m3e-icon-button
            id="lb-devtools-btn"
            aria-label="Developer tools"
            toggle
            selected={activeDt.open ? "" : undefined}
            onClick={() => setDt(active.id, { open: !activeDt.open })}
          >
            <m3e-icon name="bug_report" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-tooltip for="lb-devtools-btn" position="above">Developer tools</m3e-tooltip>
          {/* Compaction 3: the diagnostics summary lives on the
              toolbar. The chip appears only when this tab captured
              load failures; it opens DevTools on the diagnostics
              page. */}
          {activeDt.fails.length > 0 && (
            <button
              type="button"
              className="lb-diag-tb-chip"
              aria-label={"Diagnostics: " + activeDt.fails.length + " load failures"}
              title={activeDt.fails.length + " load failures — open diagnostics"}
              onClick={() => setDt(active.id, { open: true, page: "diagnostics" })}
            >
              <m3e-icon name="warning" aria-hidden={true} />
              {activeDt.fails.length}
            </button>
          )}
          {/* Downloads: the button appears only while something is
              downloading (or just finished); opens the download card. */}
          {downloads.length > 0 && (
            <>
              <m3e-icon-button
                id="lb-dl-btn"
                aria-label={"Downloads (" + downloads.length + ")"}
                toggle
                selected={dlOpen ? "" : undefined}
                onClick={() => {
                  setDlOpen((v) => !v);
                  setTabsOpen(false);
                  setSiteInfoOpen(false);
                }}
              >
                <m3e-icon name="download" aria-hidden={true} />
              </m3e-icon-button>
              <m3e-badge for="lb-dl-btn">{String(downloads.length)}</m3e-badge>
              <m3e-tooltip for="lb-dl-btn" position="above">Downloads</m3e-tooltip>
            </>
          )}
          <m3e-icon-button
            id="lb-fs-btn"
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            toggle
            selected={fullscreen ? "" : undefined}
            onClick={toggleFullscreen}
          >
            <m3e-icon name={fullscreen ? "fullscreen_exit" : "fullscreen"} aria-hidden={true} />
          </m3e-icon-button>
          <m3e-tooltip for="lb-fs-btn" position="above">Full screen</m3e-tooltip>
          <m3e-icon-button
            id="lb-ext-btn"
            aria-label="Extensions"
            toggle
            selected={extPanelOpen ? "" : undefined}
            onClick={() => {
              const next = !extPanelOpen;
              setExtPanelOpen(next);
              if (next) loadExtensions();
            }}
          >
            <m3e-icon name="extension" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-tooltip for="lb-ext-btn" position="above">Extensions</m3e-tooltip>
          {/* Incognito toggle: a regular 40x40 icon button inside the
              toolbar, same slot as the other toggles. Toggling on
              suspends the normal session and opens one empty
              incognito tab (App.tsx); toggling off closes it and
              restores the session. The domino mask is an inline SVG
              (no font glyph exists), sized by CSS. */}
          {/* Incognito: the same m3e-icon-button primitive as every
              other toolbar control, with toggle semantics for the
              on/off state (selected attribute via the ref effect —
              React 18 mangles boolean custom-element attributes). The
              domino mask is an inline SVG: the glyph is missing from
              the self-hosted Material Symbols font. */}
          <m3e-icon-button
            id="lb-incognito-pill"
            toggle
            aria-label={props.incognito ? "Turn off incognito" : "Turn on incognito"}
            onClick={() => props.onIncognitoChange(!props.incognito)}
            {...{ ref: incognitoBtnRef }}
          >
            <span className="lb-incognito-ic" aria-hidden={true} dangerouslySetInnerHTML={{ __html: dominoMaskSvg }} />
          </m3e-icon-button>
          <m3e-tooltip for="lb-incognito-pill" position="above">
            {props.incognito
              ? "Incognito on: history and session are not recorded. The proxy server still sees traffic."
              : "Turn on incognito: stops history and session recording."}
          </m3e-tooltip>
        </m3e-toolbar>
          {/* Site info (#26): a real M3E card (elevated) anchored above
              the toolbar (outside the identity pill, so opening it can
              never inflate the pill or the toolbar). It is the single
              entry point for connection facts, cookies and per-site
              settings: the former toolbar Site settings chip and card
              were merged in here. Long cookie lists scroll inside the
              card. */}
          {siteInfoOpen && (
              <m3e-card variant="elevated" aria-label="Site information" {...{ class: "lb-site-card" }}>
                <div slot="header" className="lb-site-head">
                  <span
                    className={"lb-tb-lock " + (secure ? "secure" : "insecure")}
                    aria-hidden={true}
                    dangerouslySetInnerHTML={{ __html: secure ? lockSvg : noEncSvg }}
                  />
                  <span className="lb-site-ctitle">{secure ? "https connection" : "http connection, not secure"}</span>
                  <m3e-icon-button aria-label="Close site info" onClick={() => setSiteInfoOpen(false)}>
                    <m3e-icon name="close" aria-hidden={true} />
                  </m3e-icon-button>
                </div>
                <div slot="content" className="lb-site-body">
                  <div className="lb-site-row">
                    {uParts.scheme ? uParts.scheme + "://" + uParts.host + (uParts.port.includes("default") ? "" : ":" + uParts.port) : "No URL loaded"}
                  </div>
                  {secure && (
                    <>
                      <div className="lb-site-ctitle">Public certificate record</div>
                      {siteCert === null && <div className="lb-site-row">Press the lock again to check the certificate.</div>}
                      {siteCert === "checking" && <div className="lb-site-row">Checking certificate record...</div>}
                      {siteCert === "error" && <div className="lb-site-row">Certificate data unavailable (no public CT-log record or lookup failed).</div>}
                      {siteCert && siteCert !== "checking" && siteCert !== "error" && (
                        <div className="lb-site-row">
                          Issuer: {siteCert.issuer}
                          <br />
                          Valid until {siteCert.notAfter} ({siteCert.days} days left)
                          <br />
                          <span className="lb-muted">Source: Certificate Transparency logs (crt.sh / Cert Spotter). This is the public record for the host, not the certificate this session actually negotiated.</span>
                        </div>
                      )}
                    </>
                  )}
                  <div className="lb-site-ctitle">Page-readable cookies ({siteCookies.length})</div>
                  {siteCookies.length > 0 && (
                    <div className="lb-site-cookies">
                      {siteCookies.slice(0, 12).map((c) => (
                        <div key={c} className="lb-site-cookie">{c}</div>
                      ))}
                    </div>
                  )}
                  <p className="lb-site-note">
                    Only cookies the page itself can read. HttpOnly cookies live on the proxy server side.
                  </p>
                  {/* Per-site settings (#26): same store as the Settings
                      editor; created lazily, removed when it carries no
                      overrides anymore. Merged into the lock card from
                      the removed rules chip card. */}
                  {active.url && (
                    <>
                      <div className="lb-site-ctitle">Site settings</div>
                      <div className="lb-site-row lb-rule-row">
                        <span>Block ads &amp; trackers on this site</span>
                        <m3e-switch
                          aria-label="Block ads and trackers on this site"
                          checked={ruleAdBlock ? "" : undefined}
                          disabled={!settings.adblock ? "" : undefined}
                          onClick={() => setRuleAdblock(!ruleAdBlock)}
                        />
                      </div>
                      {!settings.adblock && (
                        <p className="lb-site-note">
                          Global ad &amp; tracker blocking is off in Settings; a site rule cannot turn it on.
                        </p>
                      )}
                      <div className="lb-site-ctitle">User-Agent</div>
                      <M3eSelect
                        label="User-Agent for this site"
                        value={ruleUa}
                        options={UA_RULE_OPTIONS}
                        onChange={(v) => setRuleUa(v as UaPresetId | "")}
                      />
                      <p className="lb-site-note">
                        Per-site rules reach the engine through the zl:rules push and apply from the next navigation.
                      </p>
                    </>
                  )}
                </div>
                <div slot="actions" className="lb-site-actions">
                  <m3e-button onClick={clearSiteCookies}>
                    <m3e-icon name="delete" aria-hidden={true} /> Clear page-readable cookies
                  </m3e-button>
                  <m3e-button onClick={exportCookies}>
                    <m3e-icon name="download" aria-hidden={true} /> Export CSV
                  </m3e-button>
                </div>
              </m3e-card>
            )}
          {xpiPrompt && (
            <XpiPrompt
              name={xpiPrompt.name}
              bytes={xpiPrompt.bytes}
              onInstall={() => void installXpi(xpiPrompt)}
              onSave={() => saveXpi(xpiPrompt)}
              onCancel={() => setXpiPrompt(null)}
            />
          )}
          {dlOpen && downloads.length > 0 && (
            <DownloadsCard
              downloads={downloads}
              onClose={() => setDlOpen(false)}
              onRemove={(id) => setDownloads((prev) => prev.filter((x) => x.id !== id))}
              onCancel={cancelDownload}
            />
          )}
        </div>
      </div>

      {extPanelOpen && (
        <ExtensionsPanel
          list={extList}
          busy={extBusy}
          error={extError}
          detail={extDetail}
          detailError={extDetailError}
          incognito={extIncognito}
          onRefresh={() => loadExtensions()}
          onClose={() => setExtPanelOpen(false)}
          onOpenDetail={openExtDetail}
          onCloseDetail={() => setExtDetail(null)}
          onToggleEnabled={toggleExtEnabled}
          onToggleIncognito={toggleExtIncognito}
          onOpenOptions={openExtOptions}
        />
      )}
    </section>
  );
}
