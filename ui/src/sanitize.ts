/* Central sanitizer for UNTRUSTED page diagnostics (console text,
   network URLs, failure notes). Every surface that persists or displays
   diagnostics MUST pass values through here instead of redacting at
   individual call sites. The server keeps a mirror of the URL part in
   push_log (main.rs redact_secrets) — keep the patterns in sync.

   Deliberately conservative: over-redaction destroys diagnostics.
   We redact secret-bearing query parameters, bearer/basic credentials,
   JWTs and labeled api keys. We do NOT redact emails or arbitrary
   long strings: they are page content, and redacting them makes
   failure reports useless. */

const SECRET_QUERY_KEYS =
  "token|access_token|refresh_token|api_key|apikey|password|passwd|pwd|secret|authorization|session|sessionid|session_id|sid|client_secret";

/** Redact secret-bearing query parameters in any URL-ish string. */
export function sanitizeUrl(u: string): string {
  let s = String(u ?? "");
  if (!s) return s;
  s = s.replace(
    new RegExp(`([?&])(${SECRET_QUERY_KEYS})=[^&]*`, "gi"),
    "$1$2=[redacted]",
  );
  /* JWTs leak into URLs less often, but they do (auth redirects). */
  s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[redacted-jwt]");
  return s;
}

/** Redact credentials that appear in free-form diagnostic text. */
export function sanitizeText(t: string): string {
  let s = String(t ?? "");
  if (!s) return s;
  s = s.replace(/(bearer|basic)\s+[a-z0-9._+/=-]{16,}/gi, "$1 [redacted]");
  s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[redacted-jwt]");
  s = s.replace(/(api[_-]?key|apikey|password|secret|token)\s*[:=]\s*"?[a-z0-9._+/=-]{8,}"?/gi, "$1=[redacted]");
  /* URLs pasted into console text get the query treatment too. */
  s = s.replace(
    new RegExp(`([?&])(${SECRET_QUERY_KEYS})=[^&\\s]*`, "gi"),
    "$1$2=[redacted]",
  );
  return s;
}
