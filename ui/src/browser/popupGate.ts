/*
  Popup and recapture burst gate (LB#260).

  A proxied page can script window.open, target=_blank clicks and top
  navigations in a tight loop; the MSAL silent-auth disco on outlook.com
  was the live case: dozens of scripted opens per second, each minted
  as a real in-app tab AND stealing view focus. This gate is a small
  stateful limiter, shared by the openInTab shim in Browser.tsx and the
  shell navigate guard in App.tsx:

    allow(scripted, now):
      - user class (scripted=false): Always allowed, no counters. A
        real human click must never be capped.
      - scripted: Denied when more than `burst` scripted opens happened
        inside the last `windowMs` rolling window, or when `total`
        scripted opens happened over the gate lifetime (per document
        for the popup shim, per app run for the guard).
    denied(): number of scripted opens the gate refused so far.

  Pure state, no DOM, no deps; time is injected so tests are exact.
*/

export interface PopupGate {
  allow(scripted: boolean, now: number): boolean;
  denied(): number;
}

export function createPopupGate(burst = 3, windowMs = 5000, total = 10): PopupGate {
  let times: number[] = [];
  let lifetime = 0;
  let refused = 0;
  return {
    allow(scripted: boolean, now: number): boolean {
      if (!scripted) return true;
      times = times.filter((t) => now - t < windowMs);
      if (times.length >= burst || lifetime >= total) {
        refused++;
        return false;
      }
      times.push(now);
      lifetime++;
      return true;
    },
    denied(): number {
      return refused;
    },
  };
}
