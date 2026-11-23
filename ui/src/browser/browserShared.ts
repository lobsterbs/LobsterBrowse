/* Shared helpers for the browser page and its extracted panels.
   Split out of pages/Browser.tsx so feature components do not reach
   back into the page file. */
import type { Tab } from "../store";

/* Tab display name: the page title when present, otherwise a trimmed
   hostname, otherwise the raw URL. */
export function tabLabel(t: Tab): string {
  if (t.title) return t.title;
  if (!t.url) return "New tab";
  const host = (u: string): string => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const label = host(t.url);
  if (!label) return t.url;
  /* A frame parked on this proxy's own origin (a Cloudflare or engine
     hop with no page title yet) must not label the tab with our host.
     Use the last real site in this tab's history instead. */
  const own = host(globalThis.location?.href ?? "");
  if (label === own) {
    for (let i = Math.min(t.idx ?? 0, (t.stack?.length ?? 1) - 1); i >= 0; i--) {
      const h = host(t.stack?.[i] ?? "");
      if (h && h !== own) return h;
    }
    return "New tab";
  }
  return label;
}

/* File-extension heuristic: download click capture in Browser.tsx. */
export const DL_FILE_RE = /\.(zip|xpi|crx|tar|gz|tgz|bz2|7z|rar|exe|msi|dmg|pkg|deb|rpm|apk|iso|mp3|flac|wav|ogg|m4a|mp4|mkv|webm|mov|avi|pdf|epub|doc|docx|xls|xlsx|ppt|pptx|csv|json|txt)([?#].*)?$/i;

/* Install-result warnings the engine may report. background.page
   is a known unsupported manifest field (Zeolite tracks support for
   it; the manifest still parses and the extension runs), so it is
   filtered out of user-facing results instead of being surfaced as
   an error. */
export const KNOWN_EXT_WARNING = /background\.page is not supported/;
export function extWarnings(rep: unknown): string[] {
  if (!rep || typeof rep !== "object" || !Array.isArray((rep as { warnings?: unknown }).warnings)) return [];
  return (rep as { warnings: unknown[] }).warnings.map(String).filter((w) => !KNOWN_EXT_WARNING.test(w));
}

/* Human byte count for download sizes and logs. */
export function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

/* React 19 assigns a custom-element prop as a DOM property when the
   element class defines that property, and the attribute never lands.
   @m3e/web parses its Boolean and list attributes from the DOM
   attribute, so JSX props authored as empty strings (modal="",
   handle="", hideable="") or plain strings (detents=) silently
   unset the feature: the tab sheet lost its modal top layer and
   rendered off-screen inside the transformed dock, and the DevTools
   sheet lost its handle and half/full detents to a raw string.
   setAttribute is the only path that lands them verbatim; every
   sheet sets its attribute contracts through this once at mount. */
export function m3eAttrs(el: Element | null, attrs: Record<string, string>): void {
  if (!el) return;
  for (const name in attrs) {
    el.setAttribute(name, attrs[name]);
  }
}

/* Honest clipboard write: navigator.clipboard can be absent or reject
   (permissions policy, window not focused) while the page is still
   usable, so fall back to a hidden textarea + execCommand inside the
   same user gesture. Returns true only when the bytes landed. Shared
   by the DevTools sheet copy actions and the AI response copy. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
