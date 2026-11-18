/* Zeolite #558: same-tab navigation requests from proxied frames.

   A target=_top activation inside a proxied frame must not commit
   the top document on the content origin: the first-party worker
   partition that serves a top navigation there holds a different
   route key and no transport config, so the engine hands the
   destination to the embedder instead. This module owns the
   message payload contract so the regression check can pin it
   without React. */

/** Longest accepted href, the Browser.tsx frame-message hygiene
    cap. Longer payloads are truncated before the scheme gate. */
export const NAVTAB_HREF_MAX = 2000;
/** Longest accepted ack nonce; the engine mints short counters. */
export const NAVTAB_ACK_MAX = 64;

export interface NavTabRequest {
  href: string;
  ack: string | null;
}

/** Decode a navigateTab data payload. Returns null when the payload
    is not a well-formed request; unknown extra fields are ignored,
    never trusted. */
export function parseNavTab(data: unknown): NavTabRequest | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { href?: unknown; ack?: unknown };
  if (typeof d.href !== "string") return null;
  const href = d.href.slice(0, NAVTAB_HREF_MAX);
  if (!/^https?:\/\//i.test(href)) return null;
  const ack =
    typeof d.ack === "string" && d.ack.length > 0 && d.ack.length <= NAVTAB_ACK_MAX
      ? d.ack
      : null;
  return { href, ack };
}

/* Zeolite #416 follow-up: the shell-side navigation guard. The engine
   worker recapture only sees fetch-driven shell navigations whose
   FetchEvent fields carry the source client; an ESTS-style breakout
   assigns top.location from a nested pane and the fields do not, so
   the guard watches the window's own Navigation API: a cross-document,
   script-initiated push or replace of the top document is cancelled
   before commit and reopened as an in-app tab. Every user navigation
   (address bar, reload button, link clicks) and every reload or
   history traverse passes untouched. The whole judgment is pure so
   the regression check can pin it without a DOM. */

/* Minimal Navigation API surface the guard uses. The full DOM types
    are not in the compiler lib yet, and the guard must not depend on
    more than this shape: a browser without the API answers undefined
    and the guard simply never mounts. */
export interface ShellNavApi {
  addEventListener(type: "navigate", listener: (ev: ShellNavEvent) => void): void;
  removeEventListener(type: "navigate", listener: (ev: ShellNavEvent) => void): void;
}

export interface ShellNavEvent {
  userInitiated: boolean;
  sameDocument: boolean;
  navigationType: string;
  cancelable: boolean;
  destination: { url: string };
  preventDefault(): void;
}

/** Map a cancelled navigation back to a real http(s) destination.
    raw is the event destination URL, frameKnown is the absolute URL
    of the pane's host context (the tab it lives in) or null, and
    shellOrigin is the shell window's own origin (opaque-path
    destinations resolve against it). Returns null when the
    destination cannot be reconstructed as a real http(s) URL. */
export function shellGuardDest(raw: string, frameKnown: string | null, shellOrigin: string): string | null {
  let u: URL;
  try {
    u = new URL(raw, shellOrigin);
  } catch {
    return null;
  }
  /* An off-origin target is already a real URL: on the http(s) web
     it reopens directly, any other scheme is dropped. */
  let so: URL;
  try {
    so = new URL(shellOrigin);
  } catch {
    return null;
  }
  if (so.origin !== u.origin) {
    return /^https?:$/i.test(u.protocol) ? u.href : null;
  }
  /* A same-origin shell route the pane-facing hooks did not decode.
     The query shape ("/<path>?...&zlNavh=<token>") hides the real
     host inside the keyed token, which the shell cannot decode, so
     the destination is the path and search (minus the token)
     resolved against the pane's known host: the same reconstruction
     the URL-sync poll uses for query-shape frames. Any other
     same-origin shape (an opaque path with no token, an app page) is
     dropped rather than guessed. */
  if (!u.search.includes("zlNavh=")) return null;
  const params = new URLSearchParams(u.search);
  params.delete("zlNavh");
  if (!frameKnown) return null;
  let base: URL;
  try {
    base = new URL(frameKnown);
  } catch {
    return null;
  }
  if (!/^https?:$/i.test(base.protocol)) return null;
  const qs = params.toString();
  return new URL(u.pathname + (qs ? "?" + qs : ""), base).href;
}

/** True when the top navigation must be cancelled and recaptured as
    an in-app tab. User-initiated navigations, same-document moves
    (hash changes), reloads and history traverses all pass: only a
    script-driven cross-document push or replace of the shell document
    is ever cancelled, and that class has no legitimate author. */
export function shellGuardCancel(
  ev: Pick<ShellNavEvent, "userInitiated" | "sameDocument" | "navigationType" | "cancelable">,
): boolean {
  if (ev.userInitiated) return false;
  if (ev.sameDocument) return false;
  if (!ev.cancelable) return false;
  return ev.navigationType === "push" || ev.navigationType === "replace";
}
