/* Turn metrics for the AI page: the elapsed-time format under each
   assistant bubble. Pure functions so tests/ai-metrics can pin them. */

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const rest = total % 1000;
  const parts: string[] = [];
  /* Skip zero leading units so 70ms stays "70ms", not
     "0 hours, 0 minutes, 0 seconds, 70ms". */
  if (h) parts.push(h + (h === 1 ? " hour" : " hours"));
  if (parts.length || m) parts.push(m + (m === 1 ? " minute" : " minutes"));
  if (parts.length || s) parts.push(s + (s === 1 ? " second" : " seconds"));
  parts.push(rest + "ms");
  return parts.join(", ");
}
