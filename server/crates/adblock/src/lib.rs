//! adblock: EasyList/uAssets network-filter matcher.
//!
//! LobsterBrowse runs ad blocking at CONNECT time: when a Wisp CONNECT
//! arrives, the destination hostname is checked against the compiled rule
//! set; a match returns "blocked" and the server answers CLOSE(0x48)
//! without ever opening a socket. Under Epoxy/libcurl transports the server
//! only sees hostnames, so this engine deliberately matches on hostnames
//! (and, for the rare plain-HTTP case, host + path).
//!
//! Supported rule syntax (the common EasyList subset):
//! - `||example.com^` block domain and subdomains
//! - `||example.com` block domain, subdomains, and any domain containing it
//! - `|https://example.com/` address-anchored (hostname part used)
//! - `example.com` plain substring match on the hostname
//! - `@@||example.com^` exception (allowlist) rule
//! - `!` and `#` lines are comments; `[Adblock Plus 2.0]` headers ignored

mod parse;

pub use parse::{FilterSet, Rule, RuleKind};

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("invalid rule: {0}")]
    Invalid(String),
}

/// Compile a full filter list into a matcher.
pub fn compile(list_text: &str) -> FilterSet {
    FilterSet::from_list_text(list_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "[Adblock Plus 2.0]\n! comment\n||ads.example.com^\n||tracker.io^\n@@||good.example.com^\nanalytics.js\n";

    #[test]
    fn blocks_and_allows() {
        let set = compile(SAMPLE);
        assert!(set.is_blocked_hostname("ads.example.com"));
        assert!(set.is_blocked_hostname("img.ads.example.com"));
        assert!(set.is_blocked_hostname("tracker.io"));
        // Exception wins over the general block.
        assert!(!set.is_blocked_hostname("good.example.com"));
        assert!(!set.is_blocked_hostname("example.com"));
        // Substring rule: matches hostnames containing analytics.js.
        assert!(set.is_blocked_hostname("cdn.analytics.js.example.com"));
    }

    #[test]
    fn clean_hosts_pass() {
        let set = compile(SAMPLE);
        assert!(!set.is_blocked_hostname("wikipedia.org"));
        assert!(!set.is_blocked_hostname("example.com"));
    }
}
