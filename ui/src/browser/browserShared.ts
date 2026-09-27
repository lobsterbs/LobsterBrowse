/* Shared helpers for the browser page and its extracted panels.
   Split out of pages/Browser.tsx so feature components do not reach
   back into the page file. */
import type { Tab } from "../store";

/* Tab display name: the page title when present, otherwise a trimmed
   hostname, otherwise the raw URL. */
export function tabLabel(t: Tab): string {
  if (t.title) return t.title;
  if (!t.url) return "New tab";
  try {
    return new URL(t.url).hostname.replace(/^www\./, "");
  } catch {
    return t.url;
  }
}

/* File-extension heuristic: download click capture in Browser.tsx and
   the download icon picker below. */
export const DL_FILE_RE = /\.(zip|xpi|crx|tar|gz|tgz|bz2|7z|rar|exe|msi|dmg|pkg|deb|rpm|apk|iso|mp3|flac|wav|ogg|m4a|mp4|mkv|webm|mov|avi|pdf|epub|doc|docx|xls|xlsx|ppt|pptx|csv|json|txt)([?#].*)?$/i;

/* Material Symbols icon name for a download, by file extension. */
export function dlIconFor(name: string): string {
  const n = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(n)) return "image";
  if (/\.(mp3|flac|wav|ogg|m4a)$/.test(n)) return "audio_file";
  if (/\.(mp4|mkv|webm|mov|avi)$/.test(n)) return "video_file";
  if (/\.(zip|xpi|crx|tar|gz|tgz|bz2|7z|rar)$/.test(n)) return "folder_zip";
  return "draft";
}

/* Human byte count for download sizes and logs. */
export function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}
