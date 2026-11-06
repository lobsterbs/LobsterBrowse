import { looksLikeUrl, normalizeUrl } from "./settings.ts";

/* Wave 77: the suggestor stays completely shut until the query clears
   the minimum character count search engines accept for completion
   requests (2). Below it the menu never opens, so a single stray
   keystroke cannot flash an empty panel. */
export const SUGGEST_MIN_CHARS = 2;

export type Suggestion = { icon: string; text: string; url: string; src?: string };

/* Suggestion order (wave 77): relevance-ranked engine suggestions
   lead - the most probable completion is the first row - then the
   direct search row, then a URL row. The
   engine relevance ranking itself: prefix hits, then substring
   matches, then word-start matches, then the rest. */
export function buildSuggests(
  input: string,
  opts: { engineName: string; search: string; remote?: { text: string; src: string }[]; searchFor: (q: string) => string }
): Suggestion[] {
  const q = input.trim();
  if (q.length < SUGGEST_MIN_CHARS) return [];
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (icon: string, text: string, url: string, src?: string) => {
    if (!seen.has(url) && out.length < 8) {
      seen.add(url);
      out.push({ icon, text, url, src });
    }
  };
  const ql = q.toLowerCase();
  const rel = (t: string): number => {
    const tl = t.toLowerCase();
    if (tl.startsWith(ql)) return 0;
    if (tl.includes(ql)) return 1;
    if (tl.includes(" " + ql)) return 2;
    return 3;
  };
  for (const s of [...(opts.remote ?? [])].sort((a, b) => rel(a.text) - rel(b.text))) {
    push("search", s.text, opts.searchFor(s.text), s.src);
  }
  push("search", q + " · " + opts.engineName + " search", opts.search, opts.engineName);
  if (looksLikeUrl(q)) push("language", q, normalizeUrl(q));
  return out;
}
