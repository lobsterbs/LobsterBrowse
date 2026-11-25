/* First-run tour: step metadata + the one localStorage answer that
   remembers whether the profile settled the ask. App.tsx drives the
   views (a step can require a view switch the component cannot do
   itself) and renders components/Tour.tsx; this module is a PURE
   LEAF (no React, no store, no zeolite imports) so the CI gate in
   tests/ui-tour can evaluate it under bare node. */

/* Which view a step needs mounted before its target exists. "any"
   targets the app chrome (the nav rail), which is always mounted. */
export type TourView = "any" | "browser" | "settings" | "home";

/* One tour step. The CSS selector must match exactly one chrome
   piece in the named view; Tour.tsx centers its card and drops the
   spotlight hole over that element's rect. */
export type TourStep = {
  id: string;
  view: TourView;
  target: string;
  title: string;
  body: string;
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "views",
    view: "any",
    target: "#nav-rail",
    title: "Getting around",
    body:
      "Home, Browse, AI and Settings live on this rail (a bottom bar on small screens). Views keep their state: a running tab keeps loading while you visit Settings.",
  },
  {
    id: "toolbar",
    view: "browser",
    target: ".lb-toolbar",
    title: "The toolbar",
    body:
      "Back, Forward and Reload sit on the left. The address pill is centered, and tabs plus the more-actions menu close out the bar on the right.",
  },
  {
    id: "omnibox",
    view: "browser",
    target: ".lb-tb-pill",
    title: "Address bar",
    body:
      "Press the pill and it expands in place into an editable URL field. Type an address or a search, suggestions appear as you type, Enter navigates.",
  },
  {
    id: "overflow",
    view: "browser",
    target: "#lb-overflow-btn",
    title: "More actions",
    body:
      "The three-dot menu holds the rest: per-site rules, Developer tools and Extensions, and the shortcuts straight into Settings.",
  },
  {
    id: "settings",
    view: "settings",
    target: ".lb-set-nav",
    title: "Settings",
    body:
      "Five sections: Search, Privacy, Appearance, Extensions and Advanced. Search engines, ad blocking, the color seed and the data tools all live here.",
  },
  {
    id: "done",
    view: "home",
    target: "#lb-search-input",
    title: "That is the tour",
    body:
      "Home is one search box and a fresh start. The tour can be replayed any time from Settings, Advanced.",
  },
];

/* The ask-memory. Absent answer = a profile that has not settled the
   question yet: the ask fires on every login until the tour runs
   (sets "done") or the user picks "Never ask again" ("skip"). This is
   a plain string key (no object shapes), so validation is strict
   equality against the two known answers; anything stored but
   unknown reads as unanswered. */
const TOUR_KEY = "lobsterbrowse-tour";

export type TourAnswer = "done" | "skip";

export function loadTourAnswer(storage: { getItem(k: string): string | null }): TourAnswer | null {
  try {
    const v = storage.getItem(TOUR_KEY);
    return v === "done" || v === "skip" ? v : null;
  } catch {
    /* storage unavailable: behave like a fresh profile */
    return null;
  }
}

export function saveTourAnswer(storage: { setItem(k: string, v: string): void }, a: TourAnswer): void {
  try {
    storage.setItem(TOUR_KEY, a);
  } catch {
    /* best effort: a failed write just asks again next login */
  }
}
