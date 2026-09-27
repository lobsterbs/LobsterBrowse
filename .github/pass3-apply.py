import sys

path = "server/bin/server/src/main.rs"
src = open(path, encoding="utf-8").read()

# --- 1. formaction in rewrite_tag's attribute list ---
OLD_ATTRS = '''    let attrs: [(&str, u8); 6] = [
        ("href=", 0),
        ("src=", 0),
        ("action=", 0),
        ("poster=", 0),
        ("srcset=", 1),
        ("style=", 2),
    ];
'''
NEW_ATTRS = '''    let attrs: [(&str, u8); 7] = [
        ("href=", 0),
        ("src=", 0),
        ("action=", 0),
        // formaction on <button>/<input> submits to its own URL; leaving
        // it unrouted let a submitter button navigate straight off the
        // proxy origin. Same rewriting as action.
        ("formaction=", 0),
        ("poster=", 0),
        ("srcset=", 1),
        ("style=", 2),
    ];
'''
assert src.count(OLD_ATTRS) == 1, "attrs anchor not found exactly once"
src = src.replace(OLD_ATTRS, NEW_ATTRS)

# --- 2. shim integrity test module appended at EOF ---
OLD_TAIL = '''    #[test]
    fn invalid_tokens_fall_back_to_the_global_ring() {
        let state = test_state();
        push_log_sess(&state, Some("bad token!"), "info", "unified");
        assert_eq!(state.logs.lock().unwrap().len(), 1);
        assert!(state.sessions.lock().unwrap().is_empty());
    }
}
'''
assert src.endswith(OLD_TAIL), "file tail anchor not found"

NEW_MOD = '''
#[cfg(test)]
mod shim_integrity_tests {
    use super::*;

    /* engine-shim.js is include_str!'d and never executed as JS by any
    test, so a splice that parses but breaks semantics ships silently
    (the pass-2 CHALLENGE_HOST_RE replacement accident: the line parsed,
    the regex matched nothing, runtime-created captcha frames broke).
    These assertions pin the exact construction lines the runtime
    depends on; keep test and shim in sync. */
    #[test]
    fn challenge_regex_construction() {
        assert!(
            ENGINE_JS.contains(
                r#"h.replace(/[.*+?^${}()|[\]\\\\]/g, "\\\\$&"); }).join("|")"#
            ),
            "CHALLENGE_HOST_RE construction changed; keep this test in sync"
        );
        assert_eq!(
            ENGINE_JS.matches("CHALLENGE_HOST_RE").count(),
            2,
            "CHALLENGE_HOST_RE must appear exactly twice (build + use)"
        );
    }

    #[test]
    fn runtime_url_routing_patches_present() {
        assert!(ENGINE_JS.contains(r#"prop("HTMLAnchorElement", "href");"#));
        assert!(ENGINE_JS.contains(r#"prop("HTMLFormElement", "action");"#));
        assert!(ENGINE_JS.contains(r#""formaction""#));
        assert!(ENGINE_JS.contains(r#"ln === "href" && this.tagName === "BASE""#));
        assert!(ENGINE_JS.contains("WORKER_UNSUPPORTED"));
        assert!(ENGINE_JS.contains("WEBSOCKET_UNSUPPORTED"));
    }

    #[test]
    fn formaction_is_rewritten() {
        let tag = r#"<button formaction="https://example.com/submit" type="submit">"#;
        let out = rewrite_tag(tag, tag, "https://example.com/", "", "/r/");
        assert!(
            out.contains("/r/aHR0cHM6Ly9leGFtcGxlLmNvbS9zdWJtaXQ"),
            "formaction must route through the engine"
        );
        assert!(
            !out.contains("https://example.com/submit"),
            "the real formaction URL must not survive rewriting"
        );
    }
}
'''
src = src[: -len(OLD_TAIL)] + OLD_TAIL + NEW_MOD

open(path, "w", encoding="utf-8").write(src)
print("patched ok")
