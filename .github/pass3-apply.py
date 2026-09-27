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

# --- clippy: format! nested in format! args (engine_error_page) ---
OLD_JSON = r'''    let detail = json_escape(detail);
    let url_js = json_escape(url);
'''
NEW_JSON = r'''    let detail = json_escape(detail);
    let url_js = json_escape(url);
    let url_json = format!("\"{}\"", url_js);
    let detail_json = format!("\"{}\"", detail);
'''
assert src.count(OLD_JSON) == 1, "json_escape anchor not found exactly once"
src = src.replace(OLD_JSON, NEW_JSON)

OLD_JSON_ARGS = r'''        url_json = format!("\"{}\"", url_js),
        detail_json = format!("\"{}\"", detail),
    );
'''
NEW_JSON_ARGS = r'''        url_json = url_json,
        detail_json = detail_json,
    );
'''
assert src.count(OLD_JSON_ARGS) == 1, "json format args anchor not found exactly once"
src = src.replace(OLD_JSON_ARGS, NEW_JSON_ARGS)

# --- clippy: map_or(true, ...) -> is_none_or (best_crtsh) ---
OLD_NEWER = r'''            slot.as_ref().map_or(true, |(cur, _)| na > cur.as_str())
'''
NEW_NEWER = r'''            slot.as_ref().is_none_or(|(cur, _)| na > cur.as_str())
'''
assert src.count(OLD_NEWER) == 1, "map_or anchor not found exactly once"
src = src.replace(OLD_NEWER, NEW_NEWER)

# --- clippy: format! nested in format! args (/build endpoint) ---
OLD_BUILD = r'''    let body = format!(
        "{{\"ok\":true,\"lb\":\"{}\",\"zeolite\":\"{}\",\"zlswSha\":\"{}\",\"build\":\"{}\",\"buildShort\":\"{}\"}}",
        format!("{} Molt", env!("CARGO_PKG_VERSION")),
'''
NEW_BUILD = r'''    let lb_version = format!("{} Molt", env!("CARGO_PKG_VERSION"));
    let body = format!(
        "{{\"ok\":true,\"lb\":\"{}\",\"zeolite\":\"{}\",\"zlswSha\":\"{}\",\"build\":\"{}\",\"buildShort\":\"{}\"}}",
        lb_version,
'''
assert src.count(OLD_BUILD) == 1, "/build anchor not found exactly once"
src = src.replace(OLD_BUILD, NEW_BUILD)

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

NEW_MOD = r'''
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
                r#"h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|")"#
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
