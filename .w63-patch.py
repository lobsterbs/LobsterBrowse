p = 'server/bin/server/src/main.rs'
s = open(p).read()
orig = len(s)

def rep(s, old, new, tag):
    n = s.count(old)
    assert n == 1, ('anchor count', tag, n)
    print('ok', tag)
    return s.replace(old, new)

A3_OLD = '''    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(body.into())
        .unwrap()
}

/// Zeolite version out of the vendored engine worker source.'''
A3_NEW = '''    body
}

/// Zeolite version out of the vendored engine worker source.'''
s = rep(s, A3_OLD, A3_NEW, 'A3-tail')

A4_OLD = '''Ok(v) if !v.is_empty() && same_origin_fetch(&headers) => v,'''
A4_NEW = '''Ok(v) if !v.is_empty() && same_origin_fetch(headers) => v,'''
s = rep(s, A4_OLD, A4_NEW, 'A4-borrow')

MCP = '''/* MCP diagnostics endpoint (beta): a stateless JSON-RPC 2.0 server so
an agent can inspect this deployment without a browser session.
Fail closed by design: while LB_MCP_TOKEN is unset the route answers
404 like any unowned path; a wrong bearer token gets 401. The tools
are strictly read-only (build info, health, the global server log
ring, a fixed-allowlist egress probe) - this endpoint never mints
routes, relays traffic or mutates state. */
async fn mcp_endpoint(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    body: String,
) -> Response {
    let Some(token) = std::env::var("LB_MCP_TOKEN")
        .ok()
        .filter(|t| !t.is_empty())
    else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == format!("Bearer {token}"));
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            "unauthorized",
        )
            .into_response();
    }
    let msg: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            return mcp_rpc_error(serde_json::Value::Null, -32700, &format!("parse error: {e}"))
        }
    };
    let id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
    if id.is_null() {
        // A notification: no response expected; the tools are
        // read-only, so there is nothing side-effecting to skip.
        return StatusCode::ACCEPTED.into_response();
    }
    let Some(method) = msg.get("method").and_then(|m| m.as_str()) else {
        return mcp_rpc_error(id, -32600, "invalid request: missing method");
    };
    match method {
        "initialize" => mcp_rpc_result(
            id,
            serde_json::json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "lobsterbrowse-mcp", "version": "0.1.0" }
            }),
        ),
        "ping" => mcp_rpc_result(id, serde_json::json!({})),
        "tools/list" => mcp_rpc_result(id, mcp_tool_list()),
        "tools/call" => {
            let params = msg
                .get("params")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let (text, is_error) = mcp_tool_call(&state, &headers, name, &args).await;
            mcp_rpc_result(
                id,
                serde_json::json!({
                    "content": [ { "type": "text", "text": text } ],
                    "isError": is_error
                }),
            )
        }
        other => mcp_rpc_error(id, -32601, &format!("method not found: {other}")),
    }
}

fn mcp_rpc_result(id: serde_json::Value, result: serde_json::Value) -> Response {
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

fn mcp_rpc_error(id: serde_json::Value, code: i64, message: &str) -> Response {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
    .to_string();
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

fn mcp_tool_list() -> serde_json::Value {
    let tool = |name: &str, desc: &str, schema: serde_json::Value| {
        serde_json::json!({ "name": name, "description": desc, "inputSchema": schema })
    };
    serde_json::json!({
        "tools": [
            tool("lb_build", "Deployment build info: LB and Zeolite versions, engine bundle hashes, wisp and content origins.", serde_json::json!({ "type": "object", "properties": {} })),
            tool("lb_health", "Liveness snapshot: healthz status and the current server time.", serde_json::json!({ "type": "object", "properties": {} })),
            tool("lb_logs", "The last N sanitized server-level log lines (default 50, max 1000): the global request and diagnostic ring, not the per-session rings.", serde_json::json!({ "type": "object", "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 1000 } } })),
            tool("lb_egress_check", "HTTPS reachability and latency from the deployment to a fixed allowlist of upstream hosts (example.com, DuckDuckGo, Brave, claude.ai, Microsoft login, Outlook, apis.google.com). Diagnoses egress IP blocks and tarpits; the host list is not configurable.", serde_json::json!({ "type": "object", "properties": {} }))
        ]
    })
}

async fn mcp_tool_call(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    name: &str,
    args: &serde_json::Value,
) -> (String, bool) {
    match name {
        "lb_build" => (build_payload(headers).await, false),
        "lb_health" => (
            serde_json::json!({ "ok": true, "healthz": "ok", "ts": now_secs() }).to_string(),
            false,
        ),
        "lb_logs" => {
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(50)
                .clamp(1, 1000) as usize;
            let logs = state.logs.lock().unwrap_or_else(|e| e.into_inner());
            let skip = logs.ring.len().saturating_sub(limit);
            let body = format!(
                "[{}]",
                logs.ring
                    .iter()
                    .skip(skip)
                    .cloned()
                    .collect::<Vec<String>>()
                    .join(",")
            );
            (body, false)
        }
        "lb_egress_check" => {
            // Fixed allowlist only: this tool must never turn into an
            // SSRF probe an agent can point at arbitrary hosts.
            const HOSTS: &[&str] = &[
                "example.com",
                "duckduckgo.com",
                "search.brave.com",
                "claude.ai",
                "login.microsoftonline.com",
                "outlook.office.com",
                "apis.google.com",
            ];
            let probes: Vec<_> = HOSTS
                .iter()
                .map(|h| {
                    let url = format!("https://{h}/");
                    async move {
                        let t0 = std::time::Instant::now();
                        let res = state
                            .client
                            .get(&url)
                            .timeout(std::time::Duration::from_secs(10))
                            .send()
                            .await;
                        let ms = t0.elapsed().as_millis() as u64;
                        match res {
                            Ok(r) => serde_json::json!({
                                "host": h,
                                "status": r.status().as_u16(),
                                "ms": ms
                            }),
                            Err(e) => serde_json::json!({
                                "host": h,
                                "error": format!("{e}"),
                                "ms": ms
                            }),
                        }
                        .to_string()
                    }
                })
                .collect();
            let rows = futures_util::future::join_all(probes).await;
            (format!("[{}]", rows.join(",")), false)
        }
        other => (format!("unknown tool: {other}"), true),
    }
}'''

A2_OLD = '''async fn build_endpoint(headers: axum::http::HeaderMap) -> Response {
    let build = std::env::var("RENDER_GIT_COMMIT")'''
A2_NEW = '''async fn build_endpoint(headers: axum::http::HeaderMap) -> Response {
    let body = build_payload(&headers).await;
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(body.into())
        .unwrap()
}

''' + MCP + '''

/// Shared payload builder for /build and the MCP lb_build tool: one
/// code path, so the two can never disagree about what the deployment
/// serves.
async fn build_payload(headers: &axum::http::HeaderMap) -> String {
    let build = std::env::var("RENDER_GIT_COMMIT")'''
s = rep(s, A2_OLD, A2_NEW, 'A2-head')

A1_OLD = '''        .route("/build", get(build_endpoint))'''
A1_NEW = '''        .route("/build", get(build_endpoint))
        // MCP diagnostics endpoint (see mcp_endpoint): bearer-token
        // JSON-RPC 2.0 with read-only tools. Fail closed: while
        // LB_MCP_TOKEN is unset the route answers 404.
        .route("/mcp", post(mcp_endpoint))'''
s = rep(s, A1_OLD, A1_NEW, 'A1-route')

TESTS = '''
#[cfg(test)]
mod mcp_tests {
    use super::*;

    fn mcp_state() -> AppState {
        AppState {
            client: reqwest::Client::new(),
            relay_client: reqwest::Client::new(),
            relay_token: None,
            relay_permits: Arc::new(tokio::sync::Semaphore::new(RELAY_MAX_CONCURRENT_CONNECTS)),
            relay_rate: Mutex::new(HashMap::new()),
            relay_trusted_proxies: Vec::new(),
            logs: Mutex::new(LogRing { ring: VecDeque::new(), bytes: 0 }),
            sessions: Mutex::new(HashMap::new()),
            suggest_cache: Mutex::new(HashMap::new()),
            cert_cache: Mutex::new(HashMap::new()),
            lookup_permits: tokio::sync::Semaphore::new(LOOKUP_MAX_CONCURRENT),
        }
    }

    #[test]
    fn mcp_tools_list_four_unique_read_only_tools() {
        let v = mcp_tool_list();
        let tools = v.get("tools").and_then(|t| t.as_array()).expect("tools array");
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t.get("name").and_then(|n| n.as_str()).expect("name"))
            .collect();
        let want = ["lb_build", "lb_health", "lb_logs", "lb_egress_check"];
        assert_eq!(names.len(), want.len());
        for w in want {
            assert!(names.contains(&w), "missing tool {w}");
        }
        for t in tools {
            assert_eq!(
                t.get("inputSchema").and_then(|x| x.get("type")).and_then(|x| x.as_str()),
                Some("object")
            );
        }
    }

    #[tokio::test]
    async fn lb_logs_returns_ring_tail_with_limit() {
        let state = mcp_state();
        for i in 0..60 {
            push_log(&state, "info", &format!("probe line {i}"));
        }
        let headers = axum::http::HeaderMap::new();
        let (text, is_err) =
            mcp_tool_call(&state, &headers, "lb_logs", &serde_json::json!({ "limit": 10 })).await;
        assert!(!is_err);
        let v: serde_json::Value = serde_json::from_str(&text).expect("logs body is JSON");
        assert_eq!(v.as_array().map(|a| a.len()), Some(10));
        assert!(text.contains("probe line 59"));
        assert!(!text.contains("probe line 49"));
        let (text, _) =
            mcp_tool_call(&state, &headers, "lb_logs", &serde_json::json!({})).await;
        let v: serde_json::Value = serde_json::from_str(&text).expect("logs body is JSON");
        assert_eq!(v.as_array().map(|a| a.len()), Some(50));
    }

    #[tokio::test]
    async fn unknown_tool_reports_error() {
        let state = mcp_state();
        let headers = axum::http::HeaderMap::new();
        let (text, is_err) = mcp_tool_call(&state, &headers, "nope", &serde_json::json!({})).await;
        assert!(is_err);
        assert!(text.contains("unknown tool"));
    }
}
'''
assert s.rstrip().endswith('}') and s.endswith(chr(10)), 'unexpected file tail'
s = s + TESTS
print('ok tests-append')

open(p, 'w').write(s)
print('done bytes', orig, '->', len(s))
