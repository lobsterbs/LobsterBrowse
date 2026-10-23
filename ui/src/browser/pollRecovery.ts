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
     marker path, or a query-shape committed route whose search
     carries the zlNavh token); the poll decodes the real URL and
     syncs the tab. */

export type PollAction = "wait" | "recover" | "sync";

const APP_PREFIXES = [
  "/zlsw", "/libcurl", "/zl-ext", "/zl-cs", "/suggest", "/cert",
  "/logs", "/build", "/wisp", "/favicon", "/sj",
];

const ENGINE_PREFIXES = ["/zl/", "/__zl_nav__/", "/__zl_navh__", "/sj/r/"];

export function pollAction(protocol: string, path: string, tabUrl: string, search = ""): PollAction {
  if (protocol.startsWith("about:")) return "wait";
  if (!path) return "wait";
  if (path === "/") {
    /* #112: a tab frame sitting on the app root is never a healthy
       upstream document - real navigations ride engine routes
       (/zl/, /__zl_nav*__), so "/" inside a proxy tab means a
       navigation escaped to the SPA fallback and the app shell is
       rendering inside the tab. Hand it to the recover branch, which
       only acts once it actually finds the shell (.lb-shell) in the
       frame, so in-flight and healthy frames are never touched. A
       tab with no URL yet has nothing to recover to: keep waiting. */
    return tabUrl ? "recover" : "wait";
  }
  if (ENGINE_PREFIXES.some((p) => path.startsWith(p))) return "sync";
  /* queryRoutes: the query-shape committed route is the real
     destination path plus the keyed zlNavh token in the search -
     an engine-owned route that must sync, never a bare-app-path
     escape (a healthy query-shape frame would otherwise never
     reach the URL/title sync and churn the recover branch). */
  if (search.includes("zlNavh=")) return "sync";
  if (!tabUrl) return "wait";
  if (APP_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) return "wait";
  return "recover";
}
