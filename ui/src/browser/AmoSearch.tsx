/* AMO add-on search + install (Settings > Extensions). AMO web
   pages are blocked from this deployment's egress, but the public
   API v5 is not: search runs through the Zeolite engine route
   (the worker carries the request, JSON passes the rewriter
   untouched). The XPI download CDN blocks the server's egress, so
   the download tries the user's own connection first and then the
   engine route again; the bytes go straight to the engine via
   zl:installExt. */
import { useState } from "react";
import { routeUrl } from "../settings";
import { zlSend } from "../zeolite";
import { fmtBytes } from "./browserShared";

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

/* AMO API v5 over the Zeolite engine route: JSON passes the rewriter
   untouched (the XPI download CDN is the part that blocks server
   egress; the API itself is reachable from either). */
async function amoGet(url: string): Promise<unknown> {
  const r = await fetch(routeUrl(url));
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

export default function AmoSearch() {
  const [sq, setSq] = useState("");
  const [sres, setSres] = useState<AmoHit[] | null>(null);
  const [sbusy, setSbusy] = useState(false);
  const [serr, setSerr] = useState("");
  const [sok, setSok] = useState("");
  const [sdetail, setSdetail] = useState<AmoHit | null>(null);
  const [installing, setInstalling] = useState(false);

  const runSearch = async () => {
    const q = sq.trim();
    if (!q || sbusy) return;
    setSbusy(true);
    setSerr("");
    setSok("");
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

  /* Download the .xpi and install it into the engine. AMO's download
     CDN blocks this server's egress, so try the user's own connection
     first, then the Zeolite engine route. A non-ZIP body means both
     were refused. */
  const install = async (h: AmoHit) => {
    if (installing) return;
    setInstalling(true);
    setSerr("");
    setSok("");
    try {
      let bytes: Uint8Array | null = null;
      const isXpi = (b: Uint8Array | null): b is Uint8Array =>
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
      const rep = await zlSend({ type: "zl:installExt", bytes }, 20000);
      if (!rep || !rep.ok) {
        throw new Error(
          rep && rep.error
            ? String(rep.error)
            : "the Zeolite service worker could not be reached on this origin"
        );
      }
      setSok(
        "Installed " + h.name +
          (Array.isArray(rep.warnings) && rep.warnings.length ? " (warnings: " + rep.warnings.join(", ") + ")" : "")
      );
      setSdetail(null);
    } catch (e) {
      setSerr("Install failed: " + ((e as Error)?.message ?? "unknown error"));
    }
    setInstalling(false);
  };

  return (
    <div>
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
      {sok && !sbusy && <p className="lb-ext-note">{sok}</p>}
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
