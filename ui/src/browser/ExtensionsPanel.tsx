/* Extensions side panel: installed add-ons list + detail view, plus
   a search-and-install UI over the public addons.mozilla.org API (AMO
   web pages are blocked from this deployment's network; the API is
   not). The engine control-plane queries and state stay in
   pages/Browser.tsx; the AMO search state is local to this panel. */
import { useState } from "react";
import { b64urlEncode } from "../settings";
import { fmtBytes } from "./browserShared";

export type ExtInfo = {
  id: string;
  name: string;
  version: string;
  state: string;
  enabled: boolean;
  lastError: string | null;
};

export type ExtDetail = {
  id: string;
  name: string;
  version: string;
  description: string;
  state: string;
  enabled: boolean;
  lastError: string | null;
  permissions: string[];
  hostPermissions: string[];
  contentScripts: number;
  optionsPath: string | null;
};

/* One AMO search hit: only the fields the panel shows. */
export type AmoHit = {
  slug: string;
  name: string;
  version: string;
  summary: string;
  icon: string;
  users: number;
  rating: number | null;
  size: number;
  xpiUrl: string;
};

/* AMO localizes name/summary as {"en-US": "..."} (the lang=en-US
   query keeps a single locale); plain strings pass through. */
function loc(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const first = typeof o["en-US"] === "string" ? o["en-US"] : Object.values(o)[0];
    return typeof first === "string" ? first : "";
  }
  return "";
}

function toHit(r: Record<string, unknown>): AmoHit | null {
  const cv = r.current_version as { version?: unknown; file?: { url?: unknown; size?: unknown } } | undefined;
  const xpiUrl = cv && cv.file && typeof cv.file.url === "string" ? cv.file.url : "";
  if (typeof r.slug !== "string" || !xpiUrl) return null;
  const ratings = r.ratings as { average?: unknown } | undefined;
  return {
    slug: r.slug,
    name: loc(r.name),
    version: cv && typeof cv.version === "string" ? cv.version : "",
    summary: loc(r.summary),
    icon: typeof r.icon_url === "string" ? r.icon_url : "",
    users: Number(r.average_daily_users) || 0,
    rating: ratings && typeof ratings.average === "number" ? ratings.average : null,
    size: cv && cv.file && Number(cv.file.size) ? Number(cv.file.size) : 0,
    xpiUrl,
  };
}

/* AMO API v5 over the server /r/ chain: JSON passes the rewriter
   untouched, and the server egress reaches the API fine (the XPI
   download CDN is the part that blocks it). */
async function amoGet(url: string): Promise<unknown> {
  const r = await fetch("/r/" + b64urlEncode(url));
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

export default function ExtensionsPanel(props: {
  list: ExtInfo[] | null;
  busy: boolean;
  error: string | null;
  detail: ExtDetail | null;
  detailError: string | null;
  incognito: Record<string, boolean>;
  onRefresh: () => void;
  onClose: () => void;
  onOpenDetail: (id: string) => void;
  onCloseDetail: () => void;
  onToggleEnabled: (id: string, on: boolean) => void;
  onToggleIncognito: (id: string, on: boolean) => void;
  onOpenOptions: (d: ExtDetail) => void;
  /* Hand a downloaded .xpi to the engine (the same zl:installExt path
     the download prompt in Browser.tsx uses). */
  onInstallXpi: (name: string, bytes: Uint8Array) => void;
}) {
  /* AMO search: query, hits, the expanded hit, install state. */
  const [sq, setSq] = useState("");
  const [sres, setSres] = useState<AmoHit[] | null>(null);
  const [sbusy, setSbusy] = useState(false);
  const [serr, setSerr] = useState("");
  const [sdetail, setSdetail] = useState<AmoHit | null>(null);
  const [installing, setInstalling] = useState(false);

  const runSearch = async () => {
    const q = sq.trim();
    if (!q || sbusy) return;
    setSbusy(true);
    setSerr("");
    setSdetail(null);
    try {
      const api =
        "https://addons.mozilla.org/api/v5/addons/search/?q=" + encodeURIComponent(q) +
        "&app=firefox&type=extension&page_size=6&lang=en-US";
      const data = (await amoGet(api)) as { results?: unknown };
      const hits = (Array.isArray(data.results) ? data.results : [])
        .map((r) => toHit(r as Record<string, unknown>))
        .filter((h): h is AmoHit => h !== null);
      setSres(hits);
    } catch (e) {
      setSres(null);
      setSerr("AMO search failed: " + ((e as Error)?.message ?? "unknown error"));
    }
    setSbusy(false);
  };

  /* Download the .xpi and hand it to the engine. AMO's download CDN
     blocks this server's egress, so try the user's own connection
     first, then the Zeolite engine route (wisp carries the browser's
     real headers). A non-ZIP body means both were refused. */
  const install = async (h: AmoHit) => {
    if (installing) return;
    setInstalling(true);
    setSerr("");
    try {
      let bytes: Uint8Array | null = null;
      const isXpi = (b: Uint8Array | null) => !!b && b.length > 3 && b[0] === 0x50 && b[1] === 0x4b;
      try {
        const r = await fetch(h.xpiUrl);
        if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
      } catch {
        /* refused or offline; the engine route is next */
      }
      if (!isXpi(bytes)) {
        const r = await fetch("/zl/" + b64urlEncode(h.xpiUrl));
        bytes = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
      }
      if (!isXpi(bytes)) {
        throw new Error("the add-on CDN refused the download (tried direct and engine routes)");
      }
      props.onInstallXpi(h.slug + (h.version ? "-" + h.version : "") + ".xpi", bytes as Uint8Array);
      setSdetail(null);
    } catch (e) {
      setSerr("Install failed: " + ((e as Error)?.message ?? "unknown error"));
    }
    setInstalling(false);
  };

  return (
    <div className="lb-ext-panel" role="dialog" aria-label="Extensions">
      <div className="lb-ext-head">
        <span className="lb-ext-title">Extensions</span>
        <span>
          <m3e-icon-button aria-label="Refresh extensions" onClick={props.onRefresh}>
            <m3e-icon name="refresh" aria-hidden={true} />
          </m3e-icon-button>
          <m3e-icon-button aria-label="Close extensions" onClick={props.onClose}>
            <m3e-icon name="close" aria-hidden={true} />
          </m3e-icon-button>
        </span>
      </div>
      <div className="lb-ext-search">
        <input
          className="lb-ext-search-input"
          type="text"
          placeholder="Search Firefox add-ons..."
          aria-label="Search Firefox add-ons"
          value={sq}
          onChange={(e) => setSq(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch();
          }}
        />
        <m3e-icon-button aria-label="Search add-ons" disabled={sbusy ? true : undefined} onClick={() => void runSearch()}>
          <m3e-icon name="search" aria-hidden={true} />
        </m3e-icon-button>
      </div>
      {sbusy && <p className="lb-ext-note">Searching AMO...</p>}
      {serr && !sbusy && <p className="lb-ext-err">{serr}</p>}
      {sres && !sbusy && (
        <div className="lb-ext-hits">
          {sres.length === 0 && <p className="lb-ext-note">No extensions found.</p>}
          {sres.map((h) => {
            const sel = sdetail !== null && sdetail.slug === h.slug;
            return (
              <div
                key={h.slug}
                className={"lb-ext-hit" + (sel ? " sel" : "")}
                role="button"
                tabIndex={0}
                onClick={() => setSdetail(sel ? null : h)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    setSdetail(sel ? null : h);
                  }
                }}
              >
                {h.icon ? (
                  <img
                    className="lb-ext-hit-ic"
                    src={h.icon}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <m3e-icon name="extension" aria-hidden={true} />
                )}
                <span className="lb-ext-name">{h.name}</span>
                <span className="lb-ext-ver">{h.version}</span>
              </div>
            );
          })}
        </div>
      )}
      {props.list === null ? (
        <p className="lb-ext-note">
          {props.busy
            ? "Querying the engine service worker..."
            : props.error
              ? "Engine extensions unavailable: " + props.error
              : "Engine extensions unavailable. No Zeolite service worker on this origin."}
        </p>
      ) : props.list.length === 0 ? (
        <p className="lb-ext-note">No extensions installed.</p>
      ) : (
        <div className="lb-ext-list">
          {props.list.map((e) => (
            <div
              key={e.id}
              className={"lb-ext-item" + (props.detail && props.detail.id === e.id ? " sel" : "")}
              title={e.lastError ?? ""}
              role="button"
              tabIndex={0}
              onClick={() => props.onOpenDetail(e.id)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") props.onOpenDetail(e.id);
              }}
            >
              <span className="lb-ext-name">{e.name}</span>
              <span className="lb-ext-ver">{e.version}</span>
              <span className={"lb-ext-state" + (e.enabled ? "" : " off")}>
                {e.enabled ? e.state : "disabled"}
              </span>
            </div>
          ))}
        </div>
      )}
      {props.detailError && <p className="lb-ext-err">{props.detailError}</p>}
      {props.detail && (
        <div className="lb-ext-detail">
          <div className="lb-ext-dhead">
            <span className="lb-ext-dname">
              {props.detail.name} <span className="lb-ext-ver">{props.detail.version}</span>
            </span>
            <m3e-icon-button aria-label="Close extension details" onClick={props.onCloseDetail}>
              <m3e-icon name="close" aria-hidden={true} />
            </m3e-icon-button>
          </div>
          {props.detail.description && <p className="lb-ext-desc">{props.detail.description}</p>}
          <div className="lb-ext-trow">
            <span className="lb-ext-tlabel">Enabled</span>
            <m3e-switch
              checked={props.detail.enabled ? "" : undefined}
              icons="selected"
              aria-label="Extension enabled"
              onClick={() => props.onToggleEnabled(props.detail!.id, !props.detail!.enabled)}
            />
          </div>
          <div className="lb-ext-trow">
            <span className="lb-ext-tlabel">Allow in incognito tabs</span>
            <m3e-switch
              checked={props.incognito[props.detail.id] ? "" : undefined}
              icons="selected"
              aria-label="Allow extension in incognito tabs"
              onClick={() => props.onToggleIncognito(props.detail!.id, !props.incognito[props.detail!.id])}
            />
          </div>
          {/* Honest labeling (P0): this records the user's intent only.
              The engine has no incognito concept yet, so the grant is
              NOT enforced; do not present it as a security control. */}
          <p className="lb-ext-desc">
            {props.incognito[props.detail.id]
              ? "Grant recorded, but not enforced yet: the engine does not have incognito tabs."
              : "Not enforced yet: the engine does not have incognito tabs."}
          </p>
          {(props.detail.permissions.length > 0 || props.detail.hostPermissions.length > 0) && (
            <div className="lb-ext-perms">
              {[...props.detail.permissions, ...props.detail.hostPermissions].slice(0, 12).map((p) => (
                <code key={p}>{p}</code>
              ))}
            </div>
          )}
          {props.detail.contentScripts > 0 && (
            <p className="lb-ext-desc">
              {props.detail.contentScripts} content script{props.detail.contentScripts === 1 ? "" : "s"} registered.
            </p>
          )}
          {props.detail.optionsPath && (
            <m3e-button onClick={() => props.onOpenOptions(props.detail!)} {...{ class: "lb-ext-optbtn" }}>
              <m3e-icon name="settings" aria-hidden={true} /> Open options page
            </m3e-button>
          )}
          {props.detail.lastError && <p className="lb-ext-err">{props.detail.lastError}</p>}
        </div>
      )}
      {sdetail && (
        <div className="lb-ext-detail">
          <div className="lb-ext-dhead">
            <span className="lb-ext-dname">
              {sdetail.name} <span className="lb-ext-ver">{sdetail.version}</span>
            </span>
            <m3e-icon-button aria-label="Close add-on details" onClick={() => setSdetail(null)}>
              <m3e-icon name="close" aria-hidden={true} />
            </m3e-icon-button>
          </div>
          {sdetail.summary && <p className="lb-ext-desc">{sdetail.summary}</p>}
          <p className="lb-ext-desc">
            {sdetail.users > 0 ? sdetail.users.toLocaleString() + " daily users" : "Daily user count unavailable"}
            {sdetail.rating !== null ? " · rated " + sdetail.rating.toFixed(1) + " / 5" : ""}
            {sdetail.size > 0 ? " · " + fmtBytes(sdetail.size) : ""}
          </p>
          {installing ? (
            <p className="lb-ext-note">Downloading and installing...</p>
          ) : (
            <m3e-button onClick={() => void install(sdetail)} {...{ class: "lb-ext-optbtn" }}>
              <m3e-icon name="download" aria-hidden={true} /> Install
            </m3e-button>
          )}
        </div>
      )}
    </div>
  );
}
