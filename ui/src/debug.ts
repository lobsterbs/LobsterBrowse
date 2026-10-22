/* Hidden debug menu overrides (beta): runtime engine toggles that
   live in localStorage and are consulted by every zl:config push
   (boot, the settings effect, controllerchange), so a debug toggle
   survives reloads and worker restarts until cleared. */
export type DebugOverrides = {
  queryRoutes?: boolean;
  httpsUpgrade?: boolean;
  imageLazy?: boolean;
};

const KEY = "lb_debug_overrides";

export function loadDebugOverrides(): DebugOverrides {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? (v as DebugOverrides) : {};
  } catch {
    return {};
  }
}

export function saveDebugOverrides(o: DebugOverrides): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    /* private mode: the toggle still applies for this session */
  }
}

export function clearDebugOverrides(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
