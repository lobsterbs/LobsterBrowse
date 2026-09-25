//! Streaming HTML rewriter.
//!
//! Incremental, rewrite-in-emit tokenizer. `process(chunk)` consumes as
//! much as it can and returns rewritten output; incomplete tokens (a tag
//! cut mid-attribute, a <script> without its close tag yet, a comment
//! without its terminator) are retained in `buf` until more input or
//! `finish()` arrives.
//!
//! Text is emitted immediately: a chunk with no '<' is pure text and
//! flushes in full. Only an open '<' (or an in-progress raw block) is
//! ever retained across chunk boundaries.

pub mod css;
pub mod url_attrs;

use crate::config::RewriteConfig;
use crate::encode::resolve;

/// Tokenizer state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum St {
    Text,
    /// Inside <tag ...>, until the closing '>'.
    Tag,
    /// Inside <script>/<style> raw text until the matching close tag.
    /// The whole raw block is held until its close tag arrives: the JS
    /// and CSS passes are single-shot over a complete block, and a
    /// split literal would rewrite incorrectly. Scripts execute only
    /// after their block closes, so this does not delay first paint.
    Raw,
    Comment,
    Doctype,
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
                    match self.buf.find('<') {
                        None => {
                            // Pure text: emit everything now (streaming).
                            out.push_str(&self.buf);
                            self.buf.clear();
                            break;
                        }
                        Some(lt) => {
                            out.push_str(&self.buf[..lt]);
                            self.buf.drain(..lt);
                            match classify_open(&self.buf) {
                                Some((st, name)) => {
                                    self.st = st;
                                    if st == St::Tag {
                                        self.cur_tag = name;
                                    }
                                }
                                None => {
                                    if self.buf.len() < 10 {
                                        break; // '<' near the end: wait for more input
                                    }
                                    // A literal '<' that starts no markup (rare).
                                    out.push('<');
                                    self.buf.remove(0);
                                }
                            }
                        }
                    }
                }
                St::Comment => {
                    if !eat_marker(&mut self.buf, &mut out, "-->") {
                        break;
                    }
                    self.st = St::Text;
                }
                St::Doctype => {
                    if !eat_marker(&mut self.buf, &mut out, ">") {
                        break;
                    }
                    self.st = St::Text;
                }
                St::Tag => {
                    // Need the full tag before rewriting attributes.
                    match self.try_rewrite_tag(&self.buf) {
                        Some((end, rewritten)) => {
                            out.push_str(&rewritten);
                            self.buf.drain(..end);
                            let raw = is_raw_tag(&self.cur_tag);
                            // Inject the bootstrap right after the opening
                            // <head> (fallback: <html>) so it precedes all
                            // page scripts.
                            if !self.injected && self.cfg.inject_bootstrap
                                && (self.cur_tag == "head" || self.cur_tag == "html")
                            {
                                out.push_str(&format!(
                                    "<script src=\"{}\"></script>",
                                    self.cfg.bootstrap_path
                                ));
                                self.injected = true;
                            }
                            self.st = if raw { St::Raw } else { St::Text };
                            self.cur_tag.clear();
                        }
                        None => break, // incomplete tag: wait for more input
                    }
                }
                St::Raw => {
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
        let rewritten = self.rewrite_single_tag(&buf[..end]);
        Some((end, rewritten))
    }

    /// Rewrite one complete, well-formed tag string.
    fn rewrite_single_tag(&self, raw: &str) -> String {
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
            match attr_value {
                Some(v) => {
                    let newv = if lower == "srcset" || lower == "imagesrcset" {
                        Some(url_attrs::rewrite_srcset(&v, |u| self.enc(u)))
                    } else if lower == "style" && self.cfg.rewrite_css {
                        Some(css::rewrite_stylesheet(&v, |u| self.enc(u)))
                    } else if url_attrs::is_url_attr(&name, &lower) {
                        Some(self.enc(&v))
                    } else if is_event_attr(&lower) && self.cfg.rewrite_js_literals {
                        Some(crate::js::rewrite_inline(&v, |u| self.enc(u)))
                    } else {
                        None
                    };
                    out.push_str(&format_attr(&attr_name, newv.as_deref().unwrap_or(&v), quoted));
                }
                None => {
                    out.push_str(attr_name.trim_end());
                }
            }
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

/// If buf contains marker: emit up to and including it, return true.
/// Otherwise emit everything except a tail that could still become the
/// marker, return false.
fn eat_marker(buf: &mut String, out: &mut String, marker: &str) -> bool {
    if let Some(i) = buf.find(marker) {
        out.push_str(&buf[..i + marker.len()]);
        buf.drain(..i + marker.len());
        true
    } else {
        let keep = marker.len().saturating_sub(1);
        let cut = buf.len().saturating_sub(keep);
        out.push_str(&buf[..cut]);
        buf.drain(..cut);
        false
    }
}

/// Pull one attribute (name, optional =value) off the front of s.
/// Returns (bytes consumed, name, Some(value), was_quoted); None when
/// the remaining text is not an attribute (tag end).
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
    fn text_flushes_without_lt() {
        // A chunk with no '<' must not be retained: streaming first paint.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let a = r.process("plain text, no markup here at all");
        assert_eq!(a, "plain text, no markup here at all");
        let b = r.process(" and more text");
        assert_eq!(b, " and more text");
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

    #[test]
    fn partial_tag_retained() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let a = r.process("before <div");
        assert_eq!(a, "before ");
        let b = r.process(" class='x'>after");
        assert!(b.starts_with("<div class='x'>"), "got: {}", b);
        assert!(b.ends_with("after"));
    }
}
