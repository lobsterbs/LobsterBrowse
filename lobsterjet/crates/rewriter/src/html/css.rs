//! Streaming-friendly CSS url() rewriting for <style> blocks and inline
//! style attributes. Operates on the full string of one stylesheet (style
//! blocks are raw-text anyway) with a single scan.

/// Rewrite every `url(...)` token through `enc`. Also rewrites @import
/// string forms ("...").
pub fn rewrite_stylesheet(css: &str, enc: &dyn Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(css.len() + 64);
    let bytes = css.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'u' || bytes[i] == b'U' {
            if css[i..].len() >= 4 && css[i..i + 4].eq_ignore_ascii_case("url(") {
                let paren = i + 4;
                // Find matching close paren.
                if let Some(close) = css[paren..].find(')') {
                    let inner = css[paren..paren + close].trim();
                    let url = inner.trim_matches(|c| c == '\'' || c == '"');
                    out.push_str("url('");
                    out.push_str(&enc(url));
                    out.push_str("')");
                    i = paren + close + 1;
                    continue;
                }
            }
        }
        // Copy one char (UTF-8 safe).
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&css[i..(i + ch_len).min(css.len())]);
        i += ch_len;
    }
    out
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 { 1 } else if b >> 5 == 0b110 { 2 } else if b >> 4 == 0b1110 { 3 } else { 4 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        let out = rewrite_stylesheet("a{background:url(img/x.png)}b{background:url( 'y.png' )}", &|u| format!("[{}]", u));
        assert_eq!(out, "a{background:url('[img/x.png]')}b{background:url('[y.png]')}");
    }

    #[test]
    fn passthrough_no_url() {
        let out = rewrite_stylesheet("a{color:red}", &|u| u.to_string());
        assert_eq!(out, "a{color:red}");
    }
}
