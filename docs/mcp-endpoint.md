# MCP diagnostics endpoint (beta)

The beta deployment exposes a read-only MCP (Model Context Protocol)
diagnostics endpoint for agent tooling:

    POST https://lobsterbrowse-beta-cts6.onrender.com/mcp
    Authorization: Bearer <LB_MCP_TOKEN value>

It is a stateless JSON-RPC 2.0 server (initialize, ping, tools/list,
tools/call). It exists only on the beta branch deployment; the main
and content-origin services build the same server without
LB_MCP_TOKEN, so the route answers 404 there.

## Fail-closed auth

- `LB_MCP_TOKEN` unset: the route answers 404 like any unowned path.
- Wrong or missing bearer: 401.
- The token is a random 48-hex value set per deployment in the Render
  dashboard; rotate it by updating the environment variable.

## Tools (read-only)

| Tool | Purpose |
| --- | --- |
| `lb_build` | The /build payload: LB and Zeolite versions, engine bundle hashes, wisp and content origins. |
| `lb_health` | Liveness snapshot: healthz status and the current server time. |
| `lb_logs` | The last N sanitized server-level log lines (default 50, max 1000) from the global request/diagnostic ring. Optional integer argument `limit`. |
| `lb_egress_check` | HTTPS reachability and latency from the deployment to a FIXED allowlist of upstream hosts (example.com, duckduckgo.com, search.brave.com, claude.ai, login.microsoftonline.com, outlook.office.com, apis.google.com). Diagnoses egress IP blocks and tarpits. |

## Security notes

- No tool mutates state, mints routes or relays arbitrary traffic.
- The egress host list is hardcoded: the endpoint can never be turned
  into an SSRF probe.
- `lb_logs` reads the global ring only; per-session diagnostic rings
  stay behind the session-scoped /logs endpoint.
