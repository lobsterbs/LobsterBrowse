//! URL codec: destination URLs encoded into engine-local paths.
//!
//! The codec is swappable so the URL shape can rotate (Phase 2 makes the
//! scheme configurable per deployment). Phase 1 ships Base64Url under
//! `/j/` and a path-mirror stub for future schemes.

/// Installed codec scheme.
#[derive(Debug, Clone)]
pub enum Codec {
    /// `/j/<base64url of absolute destination URL>` (default).
    Base64Url { prefix: String },
    /// Path mirroring (site visible in the path). Stub, Phase 2.
    PathMirror,
}

/// Decode a path into the destination URL. Returns None if the path does
/// not belong to the engine's path scheme.
pub fn decode_path(codec: &Codec, origin: &str, path: &str) -> Option<String> {
    let local = path.strip_prefix(origin).unwrap_or(path);
    match codec {
        Codec::Base64Url { prefix } => {
            let rest = local.strip_prefix(prefix.as_str())?;
            let bytes = b64u_decode(rest)?;
            String::from_utf8(bytes).ok()
        }
        Codec::PathMirror => {
            let rest = local.strip_prefix("/m/")?;
            Some(rest.to_string())
        }
    }
}

/* ---- tiny base64url, no external deps (keeps the wasm bundle small) ---- */

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn b64u_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).map_or(0, |b| *b as u32);
        let b2 = chunk.get(2).map_or(0, |b| *b as u32);
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64URL[(n >> 18) as usize & 63] as char);
        out.push(B64URL[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 { out.push(B64URL[(n >> 6) as usize & 63] as char); }
        if chunk.len() > 2 { out.push(B64URL[n as usize & 63] as char); }
    }
    out
}

pub fn b64u_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// Resolve `url` against `base` (the current page's real destination URL).
/// Hand-rolled to keep the wasm bundle free of a URL crate; covers the
/// forms that occur in real markup (absolute, protocol-relative,
/// root-relative, path-relative, fragment, query-only).
pub fn resolve(url: &str, base: &str) -> String {
    let url = url.trim();
    if url.is_empty() || url.starts_with('#') {
        return url.to_string();
    }
    // Engine-local paths and other non-URLs pass through untouched.
    let lower = url.as_bytes();
    let has_scheme = lower.len() > 7
        && lower[..8].iter().all(|b| b.is_ascii_alphanumeric())
        && lower[7] == b':';
    if has_scheme || url.starts_with("data:") || url.starts_with("blob:") || url.starts_with("javascript:") || url.starts_with("mailto:") || url.starts_with("tel:") {
        return url.to_string();
    }
    // Split base into scheme://host and path.
    let (scheme, rest) = match base.find("://") {
        Some(i) => (&base[..i + 3], &base[i + 3..]),
        None => return url.to_string(),
    };
    let (host, base_path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let root = format!("{}{}", scheme, host);
    if let Some(p) = url.strip_prefix("//") {
        // Protocol-relative.
        return format!("{}{}", scheme, p);
    }
    if url.starts_with('/') {
        return format!("{}{}", root, url);
    }
    if url.starts_with('?') {
        let p = base_path.split(['?', '#']).next().unwrap_or("/");
        return format!("{}{}{}", root, p, url);
    }
    // Path-relative: resolve against the base's directory.
    let dir = match base_path.rfind('/') {
        Some(i) => &base_path[..i + 1],
        None => "/",
    };
    let mut segs: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for seg in url.split(['?', '#']).next().unwrap_or("").split('/') {
        match seg {
            "." | "" => {}
            ".." => { segs.pop(); }
            s => segs.push(s),
        }
    }
    let path = if segs.is_empty() { String::new() } else { format!("/{}", segs.join("/")) };
    let tail = url.split('/').next_back().unwrap_or("");
    let qpos = tail.find(['?', '#']).map(|i| url.len() - tail.len() + i);
    let suffix = qpos.map(|i| &url[i..]).unwrap_or("");
    format!("{}{}{}", root, path, suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64_roundtrip() {
        for s in ["", "a", "ab", "abc", "https://example.com/x?y=1", "ünïcode"] {
            assert_eq!(b64u_decode(&b64u_encode(s.as_bytes())).unwrap(), s.as_bytes());
        }
    }

    #[test]
    fn resolve_forms() {
        let b = "https://example.com/a/b/c.html";
        assert_eq!(resolve("d.png", b), "https://example.com/a/b/d.png");
        assert_eq!(resolve("/x", b), "https://example.com/x");
        assert_eq!(resolve("//cdn.example.net/x", b), "https://cdn.example.net/x");
        assert_eq!(resolve("?q=1", b), "https://example.com/a/b/c.html?q=1");
        assert_eq!(resolve("../up", b), "https://example.com/a/up");
        assert_eq!(resolve("https://other.example/", b), "https://other.example/");
        assert_eq!(resolve("#frag", b), "#frag");
        assert_eq!(resolve("data:image/png;base64,AAA", b), "data:image/png;base64,AAA");
    }

    #[test]
    fn codec_roundtrip() {
        let c = Codec::Base64Url { prefix: "/j/".into() };
        let dest = "https://example.com/page";
        let path = format!("/j/{}", b64u_encode(dest.as_bytes()));
        assert_eq!(decode_path(&c, "", &path).unwrap(), dest);
        assert!(decode_path(&c, "", "/other").is_none());
    }
}
