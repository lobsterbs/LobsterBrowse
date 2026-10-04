/* Navigation-poll routing decision, extracted from the same-origin
   poll in pages/Browser.tsx so the regression check
   (tests/poll-recovery/check.mjs) runs the real logic under plain
   node instead of a copy.

   The poll reads the active frame's protocol and path every tick and
   picks one of three moves:
   - "wait": leave the frame alone. Either it sits on an about:
     document (a navigation still in flight, or a page whose engine
     bootstrap never attached: about:blank's location.pathname is
     literally "blank", and treating that as an app path fabricated
     <site>/blank recoveries that aborted the real navigation and
     looped the tab), or it is on an app-shell route, or the tab has
     no URL yet.
   - "recover": the frame escaped to a non-route path on our origin
     while the tab has a real URL; the poll reconstructs the intended
     target and reloads it through the engine.
   - "sync": the frame is on an engine route (or an engine-owned
     marker path); the poll decodes the real URL and syncs the tab. */

export type PollAction = "wait" | "recover" | "sync";

const APP_PREFIXES = [
  "/zlsw", "/libcurl", "/zl-ext", "/zl-cs", "/suggest", "/cert",
  "/logs", "/build", "/wisp", "/favicon",
];

const ENGINE_PREFIXES = ["/r/", "/lj/", "/zl/", "/__zl_nav__/"];

export function pollAction(protocol: string, path: string, tabUrl: string): PollAction {
  if (protocol.startsWith("about:")) return "wait";
  if (!path || path === "/") return "wait";
  if (ENGINE_PREFIXES.some((p) => path.startsWith(p))) return "sync";
  if (!tabUrl) return "wait";
  if (APP_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) return "wait";
  return "recover";
}
