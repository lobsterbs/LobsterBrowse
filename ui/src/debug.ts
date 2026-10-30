/* Beta hidden picker overrides, consumed on every zl:config push.
   Experimental selections are NOT evidence that unfinished features run.
   Zeolite reports requested/effective separately; effective remains false
   until each independent feature is implemented and verified.
   Defaults are ON (user request 2026-10-28): every experimental flag the
   engine grows goes live on beta without a debug-menu visit; stored
   per-flag overrides still win over the defaults. */
export const EXPERIMENTAL_KEYS = [
  "adaptiveTransit", "hybridLocation", "cspTranslation", "virtualSW",
] as const;
export type ExperimentalKey = typeof EXPERIMENTAL_KEYS[number];
export type ExperimentalSelections = Record<ExperimentalKey, boolean>;
export const defaultExperimental = (): ExperimentalSelections => ({
  adaptiveTransit: true,
  hybridLocation: true,
  cspTranslation: true,
  virtualSW: true,
});

export type DebugOverrides = {
  queryRoutes?: boolean;
  httpsUpgrade?: boolean;
  imageLazy?: boolean;
  split?: boolean;
  /* UI-only override: the AI mode mock (canned local answers). Never
     pushed to the engine workers; ui/src/ai/aiStore.ts reads it. */
  aiMock?: boolean;
  experimental?: Partial<ExperimentalSelections>;
};
const KEY = "lb_debug_overrides";

/** Never trust old stored overrides (or malformed imported browser
    storage) as engine config. Ignore unknown flag keys and non-booleans. */
export function cleanExperimental(v: unknown): Partial<ExperimentalSelections> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const input = v as Record<string, unknown>;
  const next: Partial<ExperimentalSelections> = {};
  for (const key of EXPERIMENTAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key) && typeof input[key] === "boolean")
      next[key] = input[key] as boolean;
  }
  return next;
}

export function loadDebugOverrides(): DebugOverrides {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const obj = v as Record<string, unknown>;
    return {
      ...(typeof obj.queryRoutes === "boolean" ? { queryRoutes: obj.queryRoutes } : {}),
      ...(typeof obj.httpsUpgrade === "boolean" ? { httpsUpgrade: obj.httpsUpgrade } : {}),
      ...(typeof obj.imageLazy === "boolean" ? { imageLazy: obj.imageLazy } : {}),
      ...(typeof obj.split === "boolean" ? { split: obj.split } : {}),
      ...(typeof obj.aiMock === "boolean" ? { aiMock: obj.aiMock } : {}),
      experimental: cleanExperimental(obj.experimental),
    };
  } catch { return {}; }
}

export function saveDebugOverrides(o: DebugOverrides): void {
  try { localStorage.setItem(KEY, JSON.stringify(o)); }
  catch { /* private mode: stored override unavailable */ }
}

export function clearDebugOverrides(): void {
  try { localStorage.removeItem(KEY); }
  catch { /* ignore */ }
}
