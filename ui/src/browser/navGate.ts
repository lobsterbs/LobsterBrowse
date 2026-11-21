/* Auto-load gating and in-flight dedupe, extracted from
   pages/Browser.tsx so the regression check
   (tests/load-visibility/check.mjs) runs the real logic under plain
   node instead of a copy.

   The operator's rule: no site loads at all until the user actually
   sees it. The Browse view stays keep-alive mounted (hidden) whenever
   tabs exist, so the gate - not the mounting - decides when a tab's
   navigation may start:
   - "no-tab": no active tab or no URL: nothing to load.
   - "hidden": the Browse view is not the visible view. A restored
     session tab stays parked at about:blank; nothing asks the
     engine for anything.
   - "recovery-hold": an escape recovery is already in flight for
     this tab (#169); a settings/rules re-run must not re-drive the
     escaped-from URL.
   - "done": the same URL already loaded this tab and the frame is
     not blank (#249): re-entering the view shows the intact frame
     instead of re-navigating.
   - "load": the user is looking at the Browse view and this tab has
     never loaded (or was unloaded idle): start the navigation. */

export type AutoLoadDecision = "no-tab" | "hidden" | "recovery-hold" | "done" | "load";

export function autoLoadGate(v: {
  hasActive: boolean;
  hasUrl: boolean;
  visible: boolean;
  recovering: boolean;
  sameLastNav: boolean;
  blankFrame: boolean;
}): AutoLoadDecision {
  if (!v.hasActive || !v.hasUrl) return "no-tab";
  if (!v.visible) return "hidden";
  if (v.recovering) return "recovery-hold";
  if (v.sameLastNav && !v.blankFrame) return "done";
  return "load";
}

/* In-flight dedupe for load() heads: the same destination already
   minting/loading for this tab is not a second navigation. Core to
   the blank-frame flow: load() blanks the frame before the async
   route mint, which makes the auto-load effect's #249 re-navigation
   check (same lastNav + blank frame) fire again; without this guard
   every navigation would double-mint and double-navigate. */
export function navInFlight(v: { lastNav?: string; pendingNav?: string; loading: boolean }, url: string): boolean {
  return v.lastNav === url && v.pendingNav === url && v.loading;
}
