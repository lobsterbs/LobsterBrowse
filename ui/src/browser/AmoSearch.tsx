/* AMO add-on search + install (Settings > Extensions). AMO web
   pages are blocked from this deployment's egress, but the public
   API v5 is not: search runs through the Zeolite engine route
   (the worker carries the request, JSON passes the rewriter
   untouched). The XPI download CDN blocks the server's egress, so
   the download tries the user's own connection first and then the
   engine route again; the bytes go straight to the engine via
   zl:installExt. */
import { useState } from "react";
import EmptyState from "../components/ui/EmptyState";
import { routeUrl } from "../settings";
import { zlSend } from "../zeolite";
import { pushLog } from "../store";
import { extWarnings, fmtBytes } from "./browserShared";

/* One AMO search hit: only the fields the UI shows. */
type AmoHit = {
  slug: string;
  name: string;
  version: string;
  summary: string;
  icon: string;
  users: number;
  rating: number | null;
  size: number;
  hash: string;
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

/* #147: an AMO record's file URL must point at the Mozilla family
   (addons.mozilla.org plus its mozilla.org / allizom.org CDNs); a
   record whose XPI lives anywhere else is untrusted and dropped
   here, before any install or fetch uses it. */
const amoFileUrlAllowed = (u: string): boolean => {
  let h: string;
  try {
    h = new URL(u).hostname.toLowerCase();
  } catch {
    return false;
  }
  return h === "addons.mozilla.org" || h.endsWith(".mozilla.org") || h.endsWith(".allizom.org");
};

function toHit(r: Record<string, unknown>): AmoHit | null {
  const cv = r.current_version as { version?: unknown; file?: { url?: unknown; size?: unknown; hash?: unknown } } | undefined;
  const xpiUrl = cv && cv.file && typeof cv.file.url === "string" ? cv.file.url : "";
  if (typeof r.slug !== "string" || !xpiUrl || !amoFileUrlAllowed(xpiUrl)) return null;
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
    hash: cv && cv.file && typeof cv.file.hash === "string" ? cv.file.hash : "",
    xpiUrl,
  };
}

/* AMO API v5 over the Zeolite engine route: JSON passes the rewriter
   untouched (the XPI download CDN is the part that blocks server
   egress; the API itself is reachable from either). */
async function amoGet(url: string): Promise<unknown> {
  /* AMO's edge intermittently answers 502/503/504 to datacenter
     egress (observed live: one search 503s, the identical next
     request serves 200). The engine passes the upstream status
     through, so retry those briefly instead of failing the search. */
  let last = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(routeUrl(url));
    if (r.ok) return r.json();
    last = r.status;
    if (last !== 502 && last !== 503 && last !== 504) break;
    /* #175: no sleep after the final attempt, the error surfaces at once. */
    if (attempt < 2) await new Promise((res) => setTimeout(res, 900));
  }
  throw new Error("HTTP " + last);
}

export default function AmoSearch() {
  const [sq, setSq] = useState("");
  const [sres, setSres] = useState<AmoHit[] | null>(null);
  const [sbusy, setSbusy] = useState(false);
  const [sdetail, setSdetail] = useState<AmoHit | null>(null);
  const [installing, setInstalling] = useState(false);

  /* Transient statuses report through the snackbar (the
     "Searching AMO" card and the inline result notes are gone);
     failures also land in the client log. */
  const snackbar = (msg: string, duration: number) => {
    if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) M3eSnackbar.open(msg, { duration });
  };
  const runSearch = async () => {
    const q = sq.trim();
    if (!q || sbusy) return;
    setSbusy(true);
    setSdetail(null);
    snackbar("Searching AMO...", 2500);
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
      const msg = "AMO search failed: " + ((e as Error)?.message ?? "unknown error");
      pushLog("warn", "amo search: " + msg);
      snackbar(msg, 6000);
    }
    setSbusy(false);
  };

  /* Download the .xpi and install it into the engine. AMO's download
     CDN blocks this server's egress, so try the user's own connection
     first, then the Zeolite engine route. A non-ZIP body means both
     were refused. */
  const install = async (h: AmoHit) => {
    if (installing) return;
    setInstalling(true);
    snackbar("Downloading and installing " + h.name + "...", 4000);
    try {
      let bytes: Uint8Array<ArrayBuffer> | null = null;
      const isXpi = (b: Uint8Array<ArrayBuffer> | null): b is Uint8Array<ArrayBuffer> =>
        !!b && b.length > 3 && b[0] === 0x50 && b[1] === 0x4b;
      try {
        const r = await fetch(h.xpiUrl);
        if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
      } catch {
        /* refused or offline; the engine route is next */
      }
      if (!isXpi(bytes)) {
        const r = await fetch(routeUrl(h.xpiUrl));
        bytes = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
      }
      if (!isXpi(bytes)) {
        throw new Error("the add-on CDN refused the download (tried direct and engine routes)");
      }
      /* #126: PK magic bytes alone prove nothing; the download must
         match the size and sha256 the AMO API reported. */
      if (h.size > 0 && bytes.length !== h.size) {
        throw new Error(`add-on size mismatch (expected ${h.size} B, got ${bytes.length} B)`);
      }
      /* #201: AMO reports file.hash algorithm-prefixed ("sha256:<hex>",
         never a bare hex string), so the raw compare rejected every
         valid package as a mismatch. Parse the prefix and verify
         against the matching digest; an unknown algorithm is an
         honest error, never a silently skipped check. */
      if (h.hash) {
        const hm = /^([a-z0-9]+):([0-9a-f]+)$/i.exec(h.hash.trim());
        const algo = hm ? hm[1].toLowerCase() : "sha256";
        const expectHex = (hm ? hm[2] : h.hash.trim()).toLowerCase();
        const subtleAlgo =
          algo === "sha256" ? "SHA-256" : algo === "sha512" ? "SHA-512" : algo === "sha1" ? "SHA-1" : null;
        if (!subtleAlgo) {
          throw new Error("add-on hash algorithm unsupported: " + algo);
        }
        const digest = new Uint8Array(await crypto.subtle.digest(subtleAlgo, bytes));
        const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
        if (hex !== expectHex) {
          throw new Error("add-on " + algo + " mismatch (download was tampered or truncated)");
        }
      }
      const rep = await zlSend({ type: "zl:installExt", bytes }, 20000);
      if (!rep || !rep.ok) {
        throw new Error(
          rep && rep.error
            ? String(rep.error)
            : "the Zeolite service worker could not be reached on this origin"
        );
      }
      const warnings = extWarnings(rep);
      snackbar("Installed " + h.name + (warnings.length ? " (warnings: " + warnings.join(", ") + ")" : ""), 5000);
      setSdetail(null);
    } catch (e) {
      const msg = "Install failed: " + ((e as Error)?.message ?? "unknown error");
      pushLog("error", "amo install: " + msg);
      snackbar(msg, 7000);
    }
    setInstalling(false);
  };

  return (
    <div>
      <div className="lb-ext-search">
        <m3e-search-bar style={{ flex: "1 1 auto", minWidth: 0 }}>
          <input
            slot="input"
            type="text"
            placeholder="Search Firefox add-ons..."
            aria-label="Search Firefox add-ons"
            value={sq}
            onChange={(e) => setSq(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearch();
            }}
          />
        </m3e-search-bar>
        <m3e-icon-button aria-label="Search add-ons" disabled={sbusy ? true : undefined} onClick={() => void runSearch()}>
          <m3e-icon name="search" aria-hidden={true} />
        </m3e-icon-button>
      </div>
      {sres && !sbusy && (
        <div className="lb-ext-hits">
          {sres.length === 0 && (
            <EmptyState
              icon="search"
              headline="No extensions found"
              help="Try a different search term."
              action={{ label: "Clear search", onClick: () => { setSq(""); setSres(null); } }}
            />
          )}
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
                    onLoad={(e) => {
                      e.currentTarget.style.display = "";
                    }}
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
          <m3e-button onClick={() => void install(sdetail)} disabled={installing ? true : undefined} {...{ class: "lb-ext-optbtn" }}>
            <m3e-icon name="download" aria-hidden={true} /> {installing ? "Installing..." : "Install"}
          </m3e-button>
        </div>
      )}
    </div>
  );
}
