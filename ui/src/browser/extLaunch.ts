/* #230: launching an extension's UI directly from the toolbar card.

   Deliberately import-free so the regression check
   (tests/ext-launch/check.mjs) can evaluate it in bare node: zeolite's
   extensionless ./debug import does not resolve under
   --experimental-strip-types. Callers pass their zlSend in. */

/* The engine currently exposes one extension surface: the options
   page (zl:openExtPage). There is no action-popup surface yet, so an
   extension without an options page has nothing to launch; the plan
   says so honestly instead of pretending. */
export type ExtLaunchPlan =
  | { launch: true; which: "options" }
  | { launch: false; reason: string };

export function extLaunchPlan(detail: { optionsPath: string | null }): ExtLaunchPlan {
  if (detail && detail.optionsPath) return { launch: true, which: "options" };
  return {
    launch: false,
    reason:
      "This extension has no options page or popup to open here. Its settings live in Settings > Extensions.",
  };
}

/* Extension pages are gated: an options page that is not a
   web-accessible resource is served only behind a short-lived page
   token. Ask the worker to mint one via zl:openExtPage and open the
   /zl-ext/ URL it answers.

   The placeholder tab opens synchronously INSIDE the user gesture:
   the token mint is async, and Chrome drops window.open calls that
   happen after transient activation expires (a cold service worker
   can take seconds to answer). The placeholder keeps the gesture
   alive; its location is set once the mint replies.

   Returns null on success, an honest error string on failure. */
export async function openExtPageWindow(
  send: (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, any> | null>,
  extId: string,
  which: "options",
): Promise<string | null> {
  const placeholder = window.open("", "_blank");
  if (!placeholder) return "the browser blocked the new tab";
  const rep = await send({ type: "zl:openExtPage", extId, which }, 6000);
  if (!rep || !rep.ok) {
    placeholder.close();
    return rep && rep.error ? String(rep.error) : "the worker did not answer zl:openExtPage";
  }
  const p = typeof rep.url === "string" ? rep.url : "";
  if (!extPageUrlOk(p)) {
    placeholder.close();
    return "the worker returned no options page URL";
  }
  placeholder.location.assign(p);
  return null;
}

/* #560: the engine roots extension pages at the origin root
   (/options.html?zlExt=<id>&zlPageTok=<tok>) because extension page
   worlds dispatch their boot on location.pathname; the legacy
   /zl-ext/<id>/<path> form is still served too. Accept both, and
   nothing that is not one of them. */
export function extPageUrlOk(p: string): boolean {
  if (p.startsWith("/zl-ext/")) return true;
  if (!p.startsWith("/") || p.startsWith("//")) return false;
  const q = p.indexOf("?");
  if (q < 0) return false;
  const params = new URLSearchParams(p.slice(q + 1));
  return params.get("zlExt") !== null && params.get("zlPageTok") !== null;
}
