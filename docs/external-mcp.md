# External MCP Client

HogAgent contains an independent standard MCP Client for user-configured external services. It does not import Gateway packages, discover Gateway services, consume Gateway-specific MCP environment variables, or require an orchestrator. Gateway remains an optional external process integrator and its existing skills CLI and KB Memory paths are unchanged.

## Configuration

HogAgent loads two files:

1. System: `<HOGAGENT_USER_DIR>/mcp-servers.json` (normally `~/.hogagent/mcp-servers.json`). The HogAgent WebUI edits this file.
2. Workspace: `<workspace>/.hogagent/mcp-servers.json`. This file is manual-only and replaces a system entry with the same `name`.

Both files must use `schemaVersion: 1`. A legacy top-level `[{"name":"...","url":"..."}]` array is rejected and is never migrated implicitly.

```json
{
  "schemaVersion": 1,
  "servers": [
    {
      "name": "research",
      "description": "External research service",
      "enabled": true,
      "transport": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "bearerTokenEnv": "RESEARCH_MCP_TOKEN",
        "headersFromEnv": {
          "X-Tenant-ID": "RESEARCH_TENANT_ID"
        }
      },
      "exposure": {
        "allowedTools": ["search", "fetch_report"],
        "directTools": ["search"],
        "resourceUriPrefixes": ["research://public/"],
        "allowedPrompts": ["review_report"]
      },
      "timeouts": {
        "connectMs": 10000,
        "callMs": 60000,
        "taskForegroundMs": 30000
      },
      "maxConcurrency": 4
    },
    {
      "name": "local-tools",
      "enabled": true,
      "transport": {
        "type": "stdio",
        "command": "node",
        "args": ["/opt/local-mcp/server.mjs"],
        "envFromHost": {
          "SERVICE_TOKEN": "LOCAL_MCP_SERVICE_TOKEN"
        }
      },
      "exposure": {
        "allowedTools": ["convert"],
        "directTools": [],
        "resourceUriPrefixes": [],
        "allowedPrompts": []
      }
    }
  ]
}
```

`bearerTokenEnv`, every `headersFromEnv` value, and every `envFromHost` value name a host environment variable. Raw bearer tokens, raw header values, inline stdio environment values, and URL-embedded credentials are rejected or are not valid schema fields. Stdio receives the SDK's conservative default environment plus only the explicitly mapped application variables. System configuration and local catalog caches are atomically written with mode `0600`.

`directTools` must be a subset of `allowedTools`. `"*"` is supported in an allowlist or URI-prefix list, but explicit names and prefixes are recommended.

## Lifecycle and protocol behavior

- Streamable HTTP and stdio use the official `@modelcontextprotocol/client` SDK with automatic 2026/2025 protocol negotiation.
- Connections are lazy. Searching, probing, reading, or invoking a server opens its single process-local client; concurrent connection attempts are coalesced.
- Defaults are a 10-second connection timeout, 60-second call timeout, 30-second Task foreground window, and four concurrent calls per server.
- Read-only operations may reconnect once after a connection failure. A write or Tool call is not replayed automatically because that could duplicate side effects.
- Reload rejects new work on replaced clients, lets in-flight calls drain for up to the smaller of their call timeout and 30 seconds, then closes the SDK client and any stdio child.
- RPC configuration and probe commands share HogAgent's FIFO queue, so they apply after the active Agent turn. MCP catalog change notifications stage direct-tool changes for the terminal turn boundary.
- Shutdown closes all MCP clients and stdio children.
- Connection observers attach to the Client lifecycle; SDK transport callbacks retain responsibility for rejecting in-flight requests and clearing timers on disconnect. A closed transport fails its pending call immediately rather than waiting for the call timeout.

## Capability exposure

The model sees only configured capabilities. A full catalog returned by a WebUI probe is administrative data and does not change model authorization.

When at least one effective external MCP server is enabled, HogAgent makes these top-level meta-tools available in Standard and Long Task modes. With no configured server, or with every server disabled, no external MCP tool is added to the model-visible tool set:

- `mcp_discover` with `search`, `get`, `list_resources`, and `list_prompts` actions
- `mcp_call_tool`
- `mcp_read_resource`
- `mcp_get_prompt`
- `mcp_operation` with `get`, `respond`, and `cancel` actions

Search/list/get operations filter the remote catalog before returning it to the model. The same allowlist is checked again at execution. A small configured `directTools` subset may also appear as `mcp__<server>__<tool>`. Its schema comes from the latest successful local catalog snapshot; absent a snapshot, only the meta-tools are available until discovery completes at a safe turn boundary. Any normalized direct-tool name collision rejects the external MCP extension load instead of replacing a native tool.

`mcp_operation.respond` rechecks the original Tool, Resource or Prompt against the current allowlist before replaying a suspended request or submitting Task input. Revoking permission while an operation waits for input therefore blocks its continuation; cancellation remains available.

Quick mode has no tools. External MCP tools are marked top-level-only and are excluded from Sub-Agents; audit Harnesses retain their existing fixed read-only tool set. Native tools and external tools are owned by HogAgent's `AgentToolRegistry`, which preserves the currently active mode-specific subset when a catalog changes.

## Tasks and multi-round input

HogAgent uses Tasks only when `server/discover` declares `io.modelcontextprotocol/tasks`. `ExternalMcpTaskAdapter` contains the SDK-extension seam so SDK experimental vocabulary changes do not leak into the general client.

A Task that completes inside `taskForegroundMs` returns its result. Otherwise HogAgent returns an operation handle. Modern `input_required` results are also persisted as operations. The next Agent turn can use:

- `mcp_operation` with `action: "get"` to poll;
- `mcp_operation` with `action: "respond"` and bare responses keyed by the server's input-request IDs;
- `mcp_operation` with `action: "cancel"` to request standard Task cancellation or locally abandon a suspended non-Task operation.

Operations are isolated by the active HogAgent session and atomically stored at `<sessionTaskDir>/.hedgehog/mcp-operations.json` with mode `0600`. Entries expire after 24 hours and are cleaned lazily on access. Aborting an Agent turn attempts to cancel active remote Tasks; a failed remote cancellation stops local waiting and records local cancellation without blocking the abort.

Only a completed Task is unwrapped into its tool result. Cancelled or failed Tasks retain their operation handle and status, including when remote cancellation arrives during foreground waiting or a later status poll.

Each new operation records a SHA-256 fingerprint of its transport configuration (URL or stdio command/arguments and configured environment references). Outbound poll, respond, and cancel requests require that fingerprint to match the current same-name server. Exposure and timeout changes do not change this identity; response permissions are still rechecked independently. Replaced connections and legacy records without a fingerprint fail explicitly: start a new operation rather than replaying the old handle. Cached status/result reads that require no remote request remain available. No secret environment values are stored in the fingerprint input. This binds configured endpoints, not remote process lifetimes or changes behind an unchanged URL/environment reference; remote Task persistence remains the server's responsibility.

HogAgent declares form/URL elicitation capability for modern in-band multi-round results. It does not declare Roots, Sampling, or Logging client capabilities in this release. Legacy server-initiated elicitation cannot be suspended across Agent turns and is declined.

## Deployment topology

HogAgent does not reject any valid MCP URL, port, server name, or identity. Operators must avoid configuring an MCP service that synchronously calls back into the same HogAgent session or active orchestration chain, because the resulting recursive topology can loop, wait on itself, or deadlock. A Gateway MCP service capable of invoking that same Agent chain is a typical risk example; this is an external deployment rule, not a code-level Gateway dependency or blocklist.

## HogAgent RPC

The built-in WebUI uses these HogAgent-owned JSONL commands directly:

| Command | Success event | Purpose |
|---------|---------------|---------|
| `get_mcp_servers` | `mcp_servers` | Read system configuration and effective server status |
| `save_mcp_servers` | `mcp_servers_saved` | Validate, atomically save, and reload system configuration |
| `probe_mcp_server` | `mcp_probe_result` | Connect and refresh one full administrative catalog |
| `reload_mcp_servers` | `mcp_servers_reloaded` | Reload system and workspace files |

Every response includes the input `request_id` (or `null` when omitted). Failures use `mcp_error` with `command_type`, `request_id`, and a category such as `CONFIG`, `CONNECTION`, `PROTOCOL`, `AUTH`, or `TIMEOUT`. Remote error bodies and stdio stderr are not copied into model results or logs.
