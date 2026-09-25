//! Which attributes of which tags carry URLs. Case-insensitive matching;
//! `srcset` handled specially (comma-separated candidate list).

/// URL-bearing attributes per tag (lowercase tag, lowercase attr).
pub fn is_url_attr(tag: &str, attr: &str) -> bool {
    match attr {
        "href" | "src" | "action" | "formaction" | "poster" | "background" | "cite" => true,
        "data" => matches!(tag, "object"),
        "code" | "codebase" => matches!(tag, "applet"),
        "srcset" | "imagesrcset" => matches!(tag, "img" | "source"),
        "lowsrc" => true,
        _ => false,
    }
}

/// Rewrite a srcset value: `url 2x, url2 3x` -> rewritten pairs.
pub fn rewrite_srcset(srcset: &str, enc: &dyn Fn(&str) -> String) -> String {
    srcset
        .split(',')
        .map(|cand| {
            let cand = cand.trim();
            if cand.is_empty() {
                return String::new();
            }
            // First whitespace splits URL from descriptor.
            match cand.find(char::is_whitespace) {
                Some(i) => format!("{}{}", enc(&cand[..i]), &cand[i..]),
                None => enc(cand),
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attrs() {
        assert!(is_url_attr("a", "href"));
        assert!(is_url_attr("img", "srcset"));
        assert!(!is_url_attr("a", "src"));
        assert!(is_url_attr("object", "data"));
        assert!(!is_url_attr("video", "data"));
    }

    #[test]
    fn srcset() {
        let out = rewrite_srcset("a.png 1x, b.png 2x", &|u| format!("[{}]", u));
        assert_eq!(out, "[a.png] 1x, [b.png] 2x");
    }
}
