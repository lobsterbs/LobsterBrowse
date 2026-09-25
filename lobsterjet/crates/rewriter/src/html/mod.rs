//! Streaming HTML rewriter.
//!
//! Incremental, rewrite-in-emit tokenizer. `process(chunk)` consumes as
//! much as it can and returns rewritten output; incomplete tokens (a tag
//! cut mid-attribute, a <script> without its close tag yet, a comment
//! without its terminator) are retained in `buf` until more input or
//! `finish()` arrives. Text passes through as raw slices; only rewritten
//! values allocate.

pub mod css;
pub mod url_attrs;

use crate::config::RewriteConfig;
use crate::encode::{b64u_decode, resolve};

/// Tokenizer state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum St {
    Text,
    Tag,        // inside <tag ...>, after tag name
    Raw,        // inside <script>/<style> raw text until matching close tag
    Comment,
    Doctype,
    AfterHead,  // waiting to inject bootstrap right after </head> opens
}

pub struct Rewriter {
    cfg: RewriteConfig,
    /// Real destination URL of the page being rewritten (page base).
    base: String,
    st: St,
    buf: String,
    /// Lowercase name of the current tag while in Tag/Raw state.
    cur_tag: String,
    injected: bool,
}

impl Rewriter {
    pub fn new(cfg: RewriteConfig) -> Self {
        Self { cfg, base: String::new(), st: St::Text, buf: String::new(), cur_tag: String::new(), injected: false }
    }

    /// Set the page's real destination URL (call before the first chunk).
    pub fn set_base(&mut self, base: &str) {
        self.base = base.to_string();
    }

    fn enc(&self, url: &str) -> String {
        if url.starts_with(&self.cfg.origin) {
            // Already engine-local (nested rewriting): keep as-is.
            return url.to_string();
        }
        let abs = resolve(url, &self.base);
        self.cfg.encode_url(&abs)
    }

    pub fn process(&mut self, chunk: &str) -> String {
        self.buf.push_str(chunk);
        let mut out = String::with_capacity(self.buf.len());
        loop {
            match self.st {
                St::Text => {
                    let Some(lt) = self.buf.find('<') else { break };
                    // Emit up to '<', keep everything from it.
                    out.push_str(&self.buf[..lt]);
                    let rest = self.buf[lt..].to_string();
                    self.buf = rest;
                    if let Some(next) = classify_open(&self.buf) {
                        self.st = next.0;
                        if next.0 == St::Tag {
                            self.cur_tag = next.1.clone();
                        }
                    } else if self.buf.len() < 10 {
                        break; // '<' near the end: wait for more input
                    } else {
                        // A literal '<' that starts no markup (rare).
                        out.push('<');
                        self.buf.remove(0);
                    }
                }
                St::Comment => {
                    if !eat_if(&mut self.buf, &mut out, "-->", true) {
                        break;
                    }
                    self.st = St::Text;
                }
                St::Doctype => {
                    if !eat_if(&mut self.buf, &mut out, ">", true) {
                        break;
                    }
                    self.st = St::Text;
                }
                St::Tag => {
                    // Need the full tag before rewriting attributes.
                    if let Some((tag_end, rewritten)) = self.try_rewrite_tag(&self.buf) {
                        out.push_str(&rewritten);
                        self.buf.drain(..tag_end);
                        if is_raw_tag(&self.cur_tag) {
                            self.st = St::Raw;
                        } else {
                            self.st = St::Text;
                            if self.cur_tag == "head" {
                                self.st = St::Tag; // head handled below at close
                            }
                        }
                        // Inject the bootstrap right after the opening
                        // <head> tag (or failing that, after <html>).
                        if !self.injected && self.cfg.inject_bootstrap
                            && (self.cur_tag == "head" || self.cur_tag == "html")
                        {
                            out.push_str(&format!(
                                "<script src=\"{}\"></script>",
                                self.cfg.bootstrap_path
                            ));
                            self.injected = true;
                        }
                        self.cur_tag.clear();
                    } else {
                        break; // incomplete tag: wait for more input
                    }
                }
                St::Raw => {
                    // script/style: rewrite until the matching close tag.
                    let close = format!("</{}", self.cur_tag);
                    let Some(ci) = find_ci(&self.buf, &close) else { break };
                    let raw = self.buf[..ci].to_string();
                    if self.cur_tag == "style" && self.cfg.rewrite_css {
                        out.push_str(&css::rewrite_stylesheet(&raw, |u| self.enc(u)));
                    } else if self.cur_tag == "script" && self.cfg.rewrite_js_literals {
                        out.push_str(&crate::js::rewrite_script(&raw, |u| self.enc(u)));
                    } else {
                        out.push_str(&raw);
                    }
                    // Emit the close tag verbatim, return to Text.
                    let after = self.buf[ci..].find('>').map(|i| ci + i + 1);
                    match after {
                        Some(end) => {
                            out.push_str(&self.buf[ci..end]);
                            self.buf.drain(..end);
                        }
                        None => {
                            out.push_str(close.as_str());
                            self.buf.drain(..ci + close.len());
                        }
                    }
                    self.st = St::Text;
                }
            }
        }
        out
    }

    /// Flush: emit retained buffer as-is (end of stream).
    pub fn finish(&mut self) -> String {
        let mut out = std::mem::take(&mut self.buf);
        if !self.injected && self.cfg.inject_bootstrap {
            let tag = format!("<script src=\"{}\"></script>", self.cfg.bootstrap_path);
            out = format!("{}{}", tag, out);
            self.injected = true;
        }
        self.st = St::Text;
        out
    }

    /// Try to fully parse + rewrite the tag at the start of buf.
    /// Returns (bytes consumed, rewritten tag) if the tag is complete.
    fn try_rewrite_tag(&self, buf: &str) -> Option<(usize, String)> {
        // Find the '>' that closes the tag, respecting quoted attr values.
        let bytes = buf.as_bytes();
        let mut i = 1; // past '<'
        if i < bytes.len() && bytes[i] == b'/' {
            i += 1;
        }
        let mut quote: Option<u8> = None;
        while i < bytes.len() {
            let b = bytes[i];
            match quote {
                Some(q) => {
                    if b == q {
                        quote = None;
                    }
                }
                None => {
                    if b == b'"' || b == b'\'' {
                        quote = Some(b);
                    } else if b == b'>' {
                        break;
                    }
                }
            }
            i += 1;
        }
        if i >= bytes.len() {
            return None; // no closing '>' yet
        }
        let end = i + 1; // include '>'
        let raw = &buf[..end];
        let rewritten = self.rewrite_single_tag(raw);
        Some((end, rewritten))
    }

    /// Rewrite one complete, well-formed tag string.
    fn rewrite_single_tag(&self, raw: &str) -> String {
        // Parse: name, then attribute list.
        let name_end = raw[1..]
            .find(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
            .map(|i| i + 1)
            .unwrap_or(raw.len());
        let name = raw[1..name_end].to_ascii_lowercase();
        let mut out = String::with_capacity(raw.len() + 64);
        out.push('<');
        out.push_str(&raw[1..name_end]);
        let mut rest = &raw[name_end..];
        while let Some(attr) = next_attr(rest) {
            let (consumed, attr_name, attr_value, quoted) = attr;
            let lower = attr_name.to_ascii_lowercase();
            let mut wrote = String::new();
            let val: Option<&str> = attr_value;
            match val {
                Some(v) => {
                    let newv = if lower == "srcset" || (lower == "imagesrcset" && name == "source") {
                        Some(url_attrs::rewrite_srcset(v, &|u| self.enc(u)))
                    } else if lower == "style" && self.cfg.rewrite_css {
                        Some(css::rewrite_stylesheet(v, |u| self.enc(u)))
                    } else if url_attrs::is_url_attr(&name, &lower) {
                        Some(self.enc(v))
                    } else if name != "" && is_event_attr(&lower) && self.cfg.rewrite_js_literals {
                        Some(crate::js::rewrite_inline(v, |u| self.enc(u)))
                    } else {
                        None
                    };
                    wrote = format_attr(&attr_name, newv.as_deref().unwrap_or(v), quoted);
                }
                None => {
                    wrote = attr_name.trim_end().to_string();
                }
            }
            out.push_str(&wrote);
            rest = &rest[consumed..];
        }
        out.push_str(rest);
        out
    }
}

/// Classify what follows a '<'. Returns (state, tag name).
fn classify_open(buf: &str) -> Option<(St, String)> {
    let b = buf.as_bytes();
    if b.len() < 2 {
        return None;
    }
    if b[1] == b'!' {
        if buf.starts_with("<!--") {
            return Some((St::Comment, String::new()));
        }
        return Some((St::Doctype, String::new()));
    }
    if b[1] == b'/' {
        return Some((St::Tag, String::new())); // close tags pass through Tag state
    }
    if b[1].is_ascii_alphabetic() {
        let name: String = buf[1..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        return Some((St::Tag, name));
    }
    None
}

fn is_raw_tag(tag: &str) -> bool {
    matches!(tag, "script" | "style")
}

fn is_event_attr(attr: &str) -> bool {
    attr.starts_with("on") && attr.len() > 2
}

/// Case-insensitive find, ASCII only.
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let h = hay.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// If buf starts with marker: move marker+prefix to out and return true.
/// Otherwise, if there is no possible future match, move everything to out.
fn eat_if(buf: &mut String, out: &mut String, marker: &str, _verbatim: bool) -> bool {
    if let Some(i) = buf.find(marker) {
        out.push_str(&buf[..i + marker.len()]);
        buf.drain(..i + marker.len());
        true
    } else {
        // Keep a tail that could still become the marker.
        let keep = marker.len().saturating_sub(1);
        let cut = buf.len().saturating_sub(keep);
        out.push_str(&buf[..cut]);
        buf.drain(..cut);
        false
    }
}

/// Pull one attribute (name, optional =value) off the front of s.
/// Returns (bytes consumed, name, Some(value), was_quoted) or
/// (bytes, trailing junk, None, false).
fn next_attr(s: &str) -> Option<(usize, String, Option<String>, bool)> {
    let trimmed = s.trim_start();
    let lead = s.len() - trimmed.len();
    if trimmed.is_empty() || trimmed.starts_with('>') || trimmed.starts_with("/>") {
        return None;
    }
    // Name runs to '=', whitespace, or '>'.
    let name_end = trimmed
        .find(|c: char| c == '=' || c.is_ascii_whitespace() || c == '>')
        .unwrap_or(trimmed.len());
    let name = trimmed[..name_end].to_string();
    let mut pos = name_end;
    let rest = &trimmed[name_end..];
    let after_ws = rest.trim_start();
    if after_ws.starts_with('=') {
        let eq = name_end + (rest.len() - after_ws.len()) + 1;
        let vrest = &trimmed[eq..];
        let vstart = vrest.trim_start();
        let ws = vrest.len() - vstart.len();
        let (val, consumed_v, quoted) = if vstart.starts_with('"') || vstart.starts_with('\'') {
            let q = vstart.as_bytes()[0] as char;
            match vstart[1..].find(q) {
                Some(i) => (vstart[1..1 + i].to_string(), ws + 1 + i + 2, true),
                None => return None, // value not closed yet
            }
        } else {
            let end = vstart
                .find(|c: char| c.is_ascii_whitespace() || c == '>')
                .unwrap_or(vstart.len());
            (vstart[..end].to_string(), ws + end, false)
        };
        let total = lead + eq + consumed_v;
        return Some((total, name, Some(val), quoted));
    }
    // Boolean attribute (no value).
    let total = lead + name_end;
    Some((total, name, None, false))
}

fn format_attr(name: &str, value: &str, quoted: bool) -> String {
    if quoted {
        let esc = value.replace('&', "&amp;").replace('"', "&quot;");
        format!("{}=\"{}\"", name.trim_end(), esc)
    } else {
        format!("{}={}", name.trim_end(), value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RewriteConfig;

    fn cfg() -> RewriteConfig {
        RewriteConfig { inject_bootstrap: false, ..Default::default() }
    }

    #[test]
    fn rewrites_attrs_streaming() {
        let base = "https://example.com/a/page.html";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        // Split mid-tag to prove streaming across chunk boundaries.
        let a = r.process("<html><head></head><body><a href='foo");
        let b = r.process(".html'>x</a><img src=\"/a.png\"></body></html>");
        assert!(a.is_empty());
        let full = format!("{}{}", a, b);
        let enc = |u: &str| {
            let abs = resolve(u, base);
            cfg().encode_url(&abs)
        };
        assert!(full.contains(&format!("href='{}'", enc("foo.html"))), "got: {}", full);
        assert!(full.contains(&format!("src=\"{}\"", enc("/a.png"))), "got: {}", full);
    }

    #[test]
    fn injects_bootstrap_once() {
        let c = RewriteConfig::default();
        let mut r = Rewriter::new(c.clone());
        r.set_base("https://example.com/");
        let out = r.process("<html><head><title>t</title></head>");
        assert_eq!(out.matches("bootstrap.js").count(), 1);
        assert!(out.starts_with("<html>"));
    }

    #[test]
    fn style_urls() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = r.process("<style>a{background:url(x.png)}</style>");
        assert!(out.contains("/j/"), "got: {}", out);
    }

    #[test]
    fn comments_pass_through() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = r.process("<!-- <a href='x'> --><p>hi</p>");
        assert!(out.contains("<!-- <a href='x'> -->"));
        assert!(out.contains("<p>hi</p>"));
    }

    #[test]
    fn chunked_text() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let mut out = String::new();
        out.push_str(&r.process("hello world, 1 < 2 and <p"));
        out.push_str(&r.process(">ok</p>"));
        out.push_str(&r.finish());
        assert!(out.contains("hello world, 1 < 2 and <p>ok</p>"), "got: {}", out);
    }
}
