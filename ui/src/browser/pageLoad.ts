/* Browser activity is settled only after document.load completes and
   subresource entries stop increasing for three consecutive samples.
   Never pretend a still-loading document completed on a timer. */
export interface PageLoadSample { last: number; streak: number }

export function samplePageLoad(
  state: PageLoadSample, resources: number, complete: boolean, armed: boolean,
): "loading" | "settled" {
  if (resources !== state.last) {
    const newResource = state.last >= 0 && resources > state.last;
    state.last = resources;
    state.streak = 0;
    return armed || newResource || !complete ? "loading" : "settled";
  }
  state.streak++;
  return !complete || (armed && state.streak < 3) ? "loading" : "settled";
}
