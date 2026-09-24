//! Rule parsing and hostname matching.

use crate::ParseError;

/// A single parsed filter rule.
#[derive(Debug, Clone)]
pub struct Rule {
    pub kind: RuleKind,
    /// For Domain rules: the registrable part to match.
    pub pattern: String,
    /// For Substring rules: the literal to search for.
    pub literal: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleKind {
    /// `||domain^` - match the domain and any subdomain.
    Domain,
    /// plain substring match.
    Substring,
    /// `@@` exception (allowlist).
    ExceptionDomain,
    ExceptionSubstring,
}

/// A compiled, queryable filter set.
#[derive(Debug, Default)]
pub struct FilterSet {
    /// Exact + suffix hostnames: stored reversed for cheap subdomain checks.
    blocked_domains: Vec<String>,
    blocked_substrings: Vec<String>,
    exception_domains: Vec<String>,
    exception_substrings: Vec<String>,
}

impl FilterSet {
    pub fn from_list_text(text: &str) -> Self {
        let mut set = Self::default();
        for line in text.lines() {
            if let Ok(Some(rule)) = parse_line(line) {
                set.add(rule);
            }
        }
        set
    }

    pub fn add(&mut self, rule: Rule) {
        match rule.kind {
            RuleKind::Domain => self.blocked_domains.push(rule.pattern),
            RuleKind::Substring => self.blocked_substrings.push(rule.literal),
            RuleKind::ExceptionDomain => self.exception_domains.push(rule.pattern),
            RuleKind::ExceptionSubstring => self.exception_substrings.push(rule.literal),
        }
    }

    /// True when a CONNECT to this hostname should be answered CLOSE(0x48).
    pub fn is_blocked_hostname(&self, hostname: &str) -> bool {
        let h = hostname.trim_end_matches('.').to_ascii_lowercase();
        // Exceptions take priority.
        if self.exception_domains.iter().any(|d| domain_matches(d, &h)) {
            return false;
        }
        if self
            .exception_substrings
            .iter()
            .any(|s| h.contains(s.as_str()))
        {
            return false;
        }
        self.blocked_domains.iter().any(|d| domain_matches(d, &h))
            || self.blocked_substrings.iter().any(|s| h.contains(s.as_str()))
    }

    pub fn len(&self) -> usize {
        self.blocked_domains.len()
            + self.blocked_substrings.len()
            + self.exception_domains.len()
            + self.exception_substrings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// `||domain^` semantics: block the domain and any subdomain of it.
fn domain_matches(domain: &str, hostname: &str) -> bool {
    hostname == domain || hostname.ends_with(&format!(".{domain}"))
}

/// Parse one list line. Ok(None) = comment/blank/unsupported (skipped).
pub fn parse_line(line: &str) -> Result<Option<Rule>, ParseError> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('!') || line.starts_with('#') {
        return Ok(None);
    }
    if line.starts_with('[') {
        // Header like [Adblock Plus 2.0]
        return Ok(None);
    }
    // Reject lines with unsupported advanced syntax rather than mis-blocking.
    if line.contains("$") || line.contains("##") || line.contains("#@#") || line.contains("*") {
        return Ok(None);
    }
    let (is_exception, body) = match line.strip_prefix("@@") {
        Some(rest) => (true, rest),
        None => (false, line),
    };
    if let Some(domain) = body.strip_prefix("||") {
        let domain = domain.trim_end_matches('^').trim_end_matches('/');
        if domain.is_empty() {
            return Err(ParseError::Invalid(line.into()));
        }
        return Ok(Some(Rule {
            kind: if is_exception { RuleKind::ExceptionDomain } else { RuleKind::Domain },
            pattern: domain.to_ascii_lowercase(),
            literal: String::new(),
        }));
    }
    if let Some(rest) = body.strip_prefix('|') {
        // Address-anchored rules: use the hostname portion.
        let hostname = rest
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_start_matches("//")
            .split('/')
            .next()
            .unwrap_or("");
        if hostname.is_empty() {
            return Ok(None);
        }
        return Ok(Some(Rule {
            kind: if is_exception { RuleKind::ExceptionSubstring } else { RuleKind::Substring },
            pattern: String::new(),
            literal: hostname.to_ascii_lowercase(),
        }));
    }
    // Plain substring rule.
    Ok(Some(Rule {
        kind: if is_exception { RuleKind::ExceptionSubstring } else { RuleKind::Substring },
        pattern: String::new(),
        literal: body.to_ascii_lowercase(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_domain_rules() {
        let r = parse_line("||ads.example.com^").unwrap().unwrap();
        assert_eq!(r.kind, RuleKind::Domain);
        assert_eq!(r.pattern, "ads.example.com");
    }

    #[test]
    fn parses_exceptions_and_comments() {
        assert!(parse_line("! hello").unwrap().is_none());
        assert!(parse_line("[Adblock Plus 2.0]").unwrap().is_none());
        let r = parse_line("@@||good.example.com^").unwrap().unwrap();
        assert_eq!(r.kind, RuleKind::ExceptionDomain);
    }

    #[test]
    fn skips_unsupported_syntax() {
        assert!(parse_line("||x.com$script").unwrap().is_none());
        assert!(parse_line("example.com##.ad").unwrap().is_none());
    }
}
