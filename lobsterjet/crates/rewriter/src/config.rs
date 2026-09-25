//! Rewrite configuration: origin, URL codec scheme, feature toggles.

use crate::encode::Codec;

/// Per-site overrides discovered by the compat suite. Every compat failure
/// becomes a rule here (or a JSON site config loaded at runtime), never a
/// hardcoded branch inside the rewriter.
#[derive(Debug, Clone)]
pub struct RewriteConfig {
    /// Engine origin, e.g. "https://jet.example.com".
    pub origin: String,
    /// URL codec: destination encoding scheme (path shape can rotate).
    pub codec: Codec,
    /// Rewrite url(...) inside <style> and style="".
    pub rewrite_css: bool,
    /// Rewrite URL string literals inside <script> and event attributes.
    pub rewrite_js_literals: bool,
    /// Inject the runtime bootstrap <script> into <head>.
    pub inject_bootstrap: bool,
    /// Bootstrap asset path on the engine origin.
    pub bootstrap_path: String,
    /// Strip ad/tracker hosts at the rewrite layer (Phase 3, off for now).
    pub block_hosts: Vec<String>,
}

impl Default for RewriteConfig {
    fn default() -> Self {
        Self {
            origin: String::new(),
            codec: Codec::Base64Url { prefix: "/j/".into() },
            rewrite_css: true,
            rewrite_js_literals: true,
            inject_bootstrap: true,
            bootstrap_path: "/bootstrap.js".into(),
            block_hosts: Vec::new(),
        }
    }
}

impl RewriteConfig {
    /// Encode an absolute destination URL into an engine-local URL.
    pub fn encode_url(&self, dest: &str) -> String {
        match &self.codec {
            Codec::Base64Url { prefix } => {
                format!("{}{}{}", self.origin, prefix, crate::encode::b64u_encode(dest.as_bytes()))
            }
            Codec::PathMirror => format!("{}/m/{}", self.origin, dest),
        }
    }
}
