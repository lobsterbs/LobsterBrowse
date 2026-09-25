/* URL codec (TS side mirrors crates/rewriter/src/encode.rs).
   Destination encoded as base64url under the /j/ prefix. The scheme is
   swappable so the URL shape can rotate (Phase 2: per-deployment scheme
   + prefix communicated to the SW via a config endpoint). */

const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const PATH_PREFIX = "/j/";

export function b64uEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64URL[(n >> 18) & 63];
    out += B64URL[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64URL[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64URL[n & 63];
  }
  return out;
}

export function b64uDecode(s: string): Uint8Array | null {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const c of s) {
    let v = B64URL.indexOf(c);
    if (v < 0) return null;
    v = v as number;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Absolute destination URL -> engine-local path (/j/<b64url>). */
export function encodeDest(dest: string): string {
  return PATH_PREFIX + b64uEncode(ENC.encode(dest));
}

/** Engine-local path -> destination URL, or null if not ours. */
export function decodePath(path: string): string | null {
  const i = path.indexOf(PATH_PREFIX);
  if (i < 0) return null;
  const b64 = path.slice(i + PATH_PREFIX.length).split(/[?#]/)[0];
  const bytes = b64uDecode(b64);
  if (!bytes) return null;
  return DEC.decode(bytes);
}
