/** Return a readable address for the toolbar without changing the tab's
 * actual navigation or history entry. Google challenge pages sometimes
 * wrap the destination in several encoded `continue` parameters. */
export function displayAddressUrl(raw: string): string {
  let current = raw;
  const seen = new Set<string>();

  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(current)) return raw;
    seen.add(current);

    let page: URL;
    try {
      page = new URL(current);
    } catch {
      return raw;
    }

    const host = page.hostname.toLowerCase();
    const isGoogleSorry =
      (host === "google.com" || host.endsWith(".google.com")) &&
      page.pathname.startsWith("/sorry/");
    if (!isGoogleSorry) return current;

    const destination = page.searchParams.get("continue");
    if (!destination) return raw;

    let candidate = destination;
    for (let decode = 0; decode < 8; decode++) {
      if (/^https?:\/\//i.test(candidate)) break;
      try {
        const next = decodeURIComponent(candidate);
        if (next === candidate) break;
        candidate = next;
      } catch {
        return raw;
      }
    }

    try {
      const next = new URL(candidate, page.origin);
      if (next.protocol !== "https:" && next.protocol !== "http:") return raw;
      current = next.href;
    } catch {
      return raw;
    }
  }

  return raw;
}
