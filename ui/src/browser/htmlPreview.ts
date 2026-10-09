/* DOMPurify wrapper (#44): the only sanctioned path for rendering
   untrusted HTML on app-owned surfaces (downloaded file previews,
   snippets, extension-provided content). Proxied website HTML never
   passes through here - sanitizing real pages would alter them and
   conflict with the engine's compatibility goals; proxied pages keep
   iframe/origin isolation plus CSP as the actual boundary.
   DOMPurify loads lazily with the first owned preview. */

export type SanitizePolicy = "preview";

/* Explicit allowlist profiles: preview strips scripts, event
   handlers and javascript: URLs while keeping ordinary document
   markup. SVG/MathML stay (DOMPurify sanitizes those namespaces). */
const PROFILES: Record<SanitizePolicy, { USE_PROFILES: { html: boolean; svg?: boolean; mathMl?: boolean } }> = {
  preview: { USE_PROFILES: { html: true, svg: true, mathMl: true } },
};

export async function sanitizeOwnedHtml(html: string, policy: SanitizePolicy = "preview"): Promise<string> {
  const mod = await import("dompurify");
  return mod.default.sanitize(html, PROFILES[policy]);
}
