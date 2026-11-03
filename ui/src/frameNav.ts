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
