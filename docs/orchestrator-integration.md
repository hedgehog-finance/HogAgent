# HogAgent RPC Protocol & Orchestrator Integration

> 2026-09-07 布局更新：当前目录、提示词、凭据与恢复规则以 [统一工作空间](unified-workspace.md) 为准；下文旧路径及历史审计结论仅用于兼容/迁移背景，不再作为执行配置。

## Overview

HogAgent communicates with its orchestrator via a **JSONL (newline-delimited JSON) protocol** over stdin/stdout. The orchestrator sends **commands** to HogAgent via stdin; HogAgent emits **events** via stdout.

---

## Process Startup

### Command

```bash
hogagent --user hedgehog --mode rpc --session <session-id> [--workspace <path>]
```

### Full CLI Flags

| Flag | Description | Default |
|------|-------------|--------|
| `--user <name>` | User identifier for workspace resolution | `default` |
| `--mode <interactive\|rpc>` | Operation mode | `rpc` |
| `--session <id>` | Session identifier (UUID) | Auto-generated |
| `--config <path>` | Path to custom config JSON file | None |
| `--workspace <path>` | Workspace directory (registers user→workspace mapping) | Resolved via user_settings.json |
| `--runtime-context-file <path>` | Absolute path to process runtime-context JSON | None |
| `--debug` | Enable debug-level logging | Off |
| `--help`, `-h` | Show help | — |
| `--version`, `-v` | Show version | — |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `HOGAGENT_DELIVERY_DIR` | Delivery output directory |
| `HOGAGENT_LLM_API_KEY` | LLM API key |
| `HOGAGENT_LLM_PROVIDER` | LLM provider name (e.g., `hedgehog`) |
| `HOGAGENT_LLM_BASE_URL` | LLM API base URL |

| `HOGAGENT_SEARCH_PROVIDER` | Search provider: `brave`, `you`, `tavily`, `serpapi`, `bing`, `google`, `custom`, `bocha`, `metaso`, `zhipu`, `volcengine` (default: `custom`) |
| `HOGAGENT_SEARCH_API_KEY` | Web search API key (international providers) |
| `HOGAGENT_SEARCH_ENDPOINT` | Web search API endpoint URL (for `custom` provider) |
| `HOGAGENT_SEARCH_CX` | Google Custom Search Engine ID (for `google` provider) |
| `HOGAGENT_BOCHA_API_KEY` | Bocha AI search API key |
| `HOGAGENT_BOCHA_ENDPOINT` | Bocha AI custom endpoint URL |
| `HOGAGENT_BOCHA_FRESHNESS` | Bocha search freshness (`noLimit`/`oneDay`/`oneWeek`/`oneMonth`/`oneYear`) |
| `HOGAGENT_BOCHA_CATEGORIES` | Bocha search category filter, comma-separated (e.g., `finance,news`) |
| `HOGAGENT_METASO_API_KEY` | Metaso AI search API key |
| `HOGAGENT_METASO_MODE` | Metaso search mode: `simple`, `deep`, `research` (default: `simple`) |
| `HOGAGENT_METASO_RANGE` | Metaso search range: `all_web`, `academic` (default: `all_web`) |
| `HOGAGENT_METASO_ENDPOINT` | Metaso AI custom endpoint URL |
| `HOGAGENT_ZHIPU_API_KEY` | Zhipu AI API key |
| `HOGAGENT_ZHIPU_MODEL` | Zhipu AI model (default: `glm-4-flash`) |
| `HOGAGENT_ZHIPU_BASE_URL` | Zhipu AI custom base URL |
| `HOGAGENT_VOLCENGINE_API_KEY` | Volcengine/Doubao API key |
| `HOGAGENT_VOLCENGINE_MODEL` | Volcengine model (default: `doubao-pro-latest`) |
| `HOGAGENT_VOLCENGINE_ENDPOINT` | Volcengine custom endpoint URL |
| `HOGAGENT_AUDIT_PROVIDER` | Audit model provider (unset, empty, or `'close'` explicitly disables audit model, default: disabled) |
| `HOGAGENT_AUDIT_API_KEY` | Audit model API Key |
| `HOGAGENT_AUDIT_BASE_URL` | Audit model Base URL |
| `HOGAGENT_AUDIT_MODEL_ID` | Audit model ID |
| `HOGAGENT_AUDIT_MIN_PASS_SCORE` | Minimum passing audit score (default: 70) |
| `HOGAGENT_AUDIT_MAX_ITERATIONS` | Maximum audit retry count; non-negative safe integer, `0` means no retry, invalid values warn and fall back to `2` |

---

## JSONL Protocol Format

### Commands (stdin → HogAgent)

One JSON object per line. Each object must have a nonempty string `type` field. Null, arrays, scalars and missing/blank types receive an `error` event without entering the command queue:

```jsonl
{"type":"prompt","text":"Analyze this stock: AAPL"}
{"type":"abort"}
```

### Events (HogAgent → stdout)

One JSON object per line. Each has `type`, `session_id` and `timestamp`:

- `session_id`: Auto-injected by `emitEvent`, value is the current active session ID (explicitly specified values take priority)
- After creating or switching sessions, subsequent events automatically use the updated `session_id`

```jsonl
{"type":"ready","session_id":"abc-123","version":"1.2.2","capabilities":{...},"timestamp":"2025-01-15T10:00:00.000Z"}
{"type":"agent_start","session_id":"abc-123","timestamp":"2025-01-15T10:00:01.000Z"}
{"type":"message_start","session_id":"abc-123","role":"assistant","timestamp":"2025-01-15T10:00:02.000Z"}
```

### Error Events

When a command fails or is unknown:

```jsonl
{"type":"error","session_id":"abc-123","error":"Unknown command type: foo","command_type":"foo","timestamp":"..."}
{"type":"error","session_id":"abc-123","error":"prompt command requires 'text' field","timestamp":"..."}
```

## Native Runtime Context

Runtime context is injected through the main Harness's native system prompt, not through a user message. The Gateway/UI therefore records only the original user text. Runtime context is not persisted in conversation JSONL, Long Task checkpoints, or compaction summaries.

HogAgent supports three scopes:

| Scope | Input transport | Lifetime |
|-------|-----------------|----------|
| Process | `--runtime-context-file` or programmatic `CliArgs.processRuntimeContext` | OS process |
| Session | Optional `session_context` on `new_session`, `resume_session`, or `prompt` | In-memory entry keyed by `session_id` |
| Current run | Optional `run_context` on `prompt` | One RPC `prompt` processing lifetime |

Each complete input object is bounded before it becomes active:

| Scope | Maximum compact UTF-8 JSON size | Maximum object/array depth |
|-------|--------------------------------|----------------------------|
| Process | 32 KiB | 16 |
| Session | 512 KiB | 16 |
| Current run | 64 KiB | 16 |

The root object has depth 1. `schema_version`, identity/policy fields, and `attributes` all count toward the size and depth limits. Values must be plain JSON data; cycles, accessors, class instances, non-finite numbers, symbols, and unsupported properties are rejected. The process context file is additionally capped at 32 KiB before parsing. Check `ready.capabilities.runtime_context.limits` instead of duplicating these constants in an adapter.

The process context file has this strict shape:

```json
{
  "schema_version": "1.0",
  "attributes": {
    "deployment": "gateway-pool-a"
  }
}
```

The path must be absolute. HogAgent derives process identity, workspace, mode, user, platform, and architecture itself.

Session context may carry declarative standalone project metadata (it does not select the actual filesystem root):

```json
{
  "schema_version": "1.0",
  "project_id": "project-123",
  "project_dir": "/local/research-root",
  "attributes": {
    "tenant_id": "tenant-a"
  }
}
```

`project_dir`, when present, must be absolute. Standalone execution selects its actual root only from startup configuration or an explicit path in the current request. Gateway-owned runs accept a complete project binding under HOGAGENT_GATEWAY_PROJECTS_DIR when HOGAGENT_GATEWAY_MANAGED=1. This process-owned root shares workspace grants; native session metadata alone cannot authorize another directory. Ordinary Gateway Session context omits both project fields; there is no workspace-project fallback. Session context is memory-only. The process retains at most 256 entries and uses least-recently-bound eviction when a new entry is added; a session that owns an active Prompt Run is never evicted. Eviction removes runtime metadata only, not JSONL history or task files. Re-send the complete context after restart or when activating a session that may have been evicted, normally on `resume_session` or the first `prompt`. Rebinding equal content is idempotent; changed content increments an internal session revision.

Current run context has this shape:

```json
{
  "schema_version": "1.0",
  "run_id": "external-run-789",
  "work_id": "work-456",
  "task_id": "task-123",
  "manifest_owner": "gateway",
  "artifact_run_policy": {
    "schema_version": "1.0",
    "delivery": {
      "mode": "deliverables",
      "locked": false,
      "source": "system_default",
      "files": []
    },
    "mutation": {
      "mode": "contextual",
      "locked": false,
      "source": "system_default"
    }
  },
  "attributes": {
    "request_source": "gateway"
  }
}
```

HogAgent generates `prompt_run_id`; clients must not send it. It is an internal cleanup token exposed to extensions through the read-only snapshot but omitted from model input. A **Prompt Run** is the entire processing lifetime of one RPC `prompt`, not one Harness turn or one LLM request. Long Task may make many internal prompts, checkpoint retries, and tool calls under the same Prompt Run. `steer` and `follow_up` accepted during that run inherit it. A clarification answer, continuation, or external retry sent as another RPC `prompt` creates a new Prompt Run, even if `task_id`, `work_id`, or external `run_id` is unchanged.

All `attributes` values must be plain JSON data and are model-visible. They are available to extensions through a deep read-only snapshot. Sub-agents receive a spawn-time snapshot; audit-model prompts do not receive arbitrary attributes. Treat attributes as trusted structured control data: do not place secrets or untrusted natural-language instructions in them. Escaping protects the segment boundary, not the model from the meaning of supplied content.

For compatibility, these existing `prompt.metadata` fields are projected into the same scopes:

- session: `project_id`, `project_dir`;
- current run: `work_id`, `task_id`, `manifest_owner`, `artifact_run_policy`.

The handler snapshots `manifest_owner` into the shared long-task context together with the project directory and artifact policy. Retries, resume, final audit and the final-summary prompt use that owner; Gateway-owned project files ignore native origin/role overrides. Standalone ownership continues to use its native registries.

Unknown legacy metadata is not model-visible. If native context and legacy metadata supply the same field, equal values are accepted; conflicting values produce `error` + `agent_end` before any LLM request.

Native `session_context` uses replacement semantics: include the complete session value when rebinding it. The native standalone protocol retains `metadata.project_id` and `metadata.project_dir` as field-level declarative updates, so an omitted field keeps its prior session value. They are not filesystem authority and cannot activate a Gateway project: Gateway public requests reject these metadata aliases, and Gateway-owned HogAgent runs validate complete project bindings against the process-owned authenticated projects directory before committing runtime state. Clear project fields with a complete empty Session context when returning to ordinary Gateway execution.

See [Architecture](./architecture.md) for Long Task resume/abort ordering and persistence boundaries.

---

## RPC Command Reference

### Universal Agent Commands

#### `prompt`

Start a new agent run with a user message.

Before session activation, HogAgent rejects empty/non-string `text`, invalid supplied `session_id` (allowed: 1–128 ASCII letters, digits, `_`, `-`), and modes outside `quick`, `standard`, `long_task`. Rejection emits `error + agent_end` without switching the active session or clearing pending work.

```json
{"type": "prompt", "text": "Your prompt text here", "session_id": "uuid-xxx", "mode": "quick", "thinking_level": "off", "session_context": {"schema_version":"1.0","attributes":{"tenant":"a"}}, "run_context": {"schema_version":"1.0","task_id":"task-123","attributes":{"source":"gateway"}}}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | The user prompt to process |
| `session_id` | string | No | Create, resume, or select the session that owns this prompt |
| `mode` | string | No | Hard route: `quick`, `standard`, or `long_task`; defaults to `standard` for a new session |
| `session_context` | object | No | Native session-scoped runtime context. Stored only in this process and isolated by `session_id` |
| `run_context` | object | No | Native context for this entire RPC Prompt Run; custom `attributes` are model-visible |
| `metadata.project_id` / `metadata.project_dir` | string | No | Native standalone declarative metadata only; never selects a filesystem root. Gateway public clients must use applicationContext, not these aliases, and the HogAgent Adapter requires supports_gateway_projects acknowledgement and a formal binding. Standalone uses startup configuration or an explicit absolute path in the current prompt, never conversation history. Full Windows drive/UNC paths are accepted; Windows root-relative/drive-relative paths and traversal are rejected. Prompt paths still require realpath validation and workspace containment. |
| `metadata.artifact_run_policy` | object | Internal | Gateway-validated, run-scoped delivery/mutation policy. Public clients send `delivery_mode`, `delivery_files`, and/or `artifact_update_mode` to Gateway rather than constructing this object. |
| `metadata.manifest_owner` | string | No | Gateway sets `gateway`; standalone defaults to `hogagent` ownership behavior |
| `thinking_level` | string | No | Per-call quick-mode override (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). It does not modify persisted settings; when omitted, `quickThinkingLevel` is used, then `off` |

#### `steer`

Inject a steering message into a running agent (mid-stream guidance). **Bypasses the FIFO command queue** and executes immediately — required because `steer` needs `Harness.phase ≠ idle` (e.g., during an active LLM turn); queuing would miss the execution window.

For a process serving more than one session, include the active `session_id` on `steer`, `follow_up`, and `abort`. When present, it must be a non-empty string. A mismatched or malformed ID is rejected before the immediate command can affect another session or invalidate its queued prompts. All three controls are also rejected during the short commit phase of `new_session`/`resume_session`. Omitting `session_id` is retained for legacy single-session clients only. HogAgent multiplexes sessions sequentially: one process has one active Harness and at most one Prompt Run.

```json
{"type": "steer", "text": "Focus on the financial aspects"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Steering instruction |

#### `follow_up`

Queue a follow-up message to be processed after current run completes. **Bypasses the FIFO command queue** and is dispatched immediately to HogAgent (not queued in Gateway), because `followUp` also requires `Harness.phase ≠ idle`.

```json
{"type": "follow_up", "text": "Also check the PE ratio"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Follow-up prompt |

#### `abort`

Abort the current agent run. This is an **asynchronous operation** — the `aborted` event is emitted only after the abort completes, and the terminal `abort_completed` settle event is guaranteed at the end of abort handling. In `long_task` mode, an LLM response with `stopReason: "aborted"` is normalized to the same `aborted` lifecycle event rather than an `error` event.

```json
{"type": "abort"}
```

Optional `task_id` / `work_id` fields (sent by the Gateway when aborting a workflow task) are echoed back on the `abort_completed` event so the orchestrator can match the exact task:

```json
{"type": "abort", "task_id": "task-123", "work_id": "work-456"}
```

> **Note:** Since abort is async, the orchestrator should wait for `abort_completed` before sending a new `prompt` to avoid race conditions.

If `compact_started` has not yet reached its terminal event, `abort`, `steer`, and `follow_up` are rejected. FIFO commands may wait and run after compaction. The owning turn either continues after successful compression or fails after the five-minute deadline/provider error.

**Long Task behavior:** abort fully stops a running long_task orchestration, not just the current LLM run:

- A sticky abort flag prevents the orchestration loop from issuing any further prompts (groups, continuation prompts, audits, final delivery).
- The isolated audit harness (a temporary instance per audit) is aborted explicitly; an interrupted audit rejects with `OrchestrationAbortedError` instead of scoring or waiting out its timeout.
- Checkpoint handling distinguishes the abort source: a **user abort** (the sticky flag is set by the `abort` command) means cancel — the persisted checkpoint is ARCHIVED (`orchestration-state.json` renamed to `tmp-orchestration-state.json`) and both suspended clarification states (mid-execution `[ASK_USER]` and pre-planning clarification) are discarded. The next user message starts fresh and will NOT auto-resume the aborted task (`hasIncompleteOrchestration` only reads the canonical file), but an explicit Gateway `[Continue Task]` continuation message restores the archive (`tryRestoreArchivedOrchestration`) and resumes from the interrupted group via the standard resume route. A **shutdown-triggered abort** (process exit; the sticky flag is never set) keeps `orchestration-state.json`, so the next prompt on the same session resumes from the interrupted group via `hasIncompleteOrchestration` instead of re-classifying the whole history.
- Archived checkpoints are purged when they are superseded: at the start of a fresh orchestration (`executeLongTask`), after the final summary succeeds, and on mode switch. The `[Continue Task]` marker on the first line of the Gateway continuation message (`buildTaskContinuationMessage`) is the cross-module contract for restore. Two guards bound the restore: a canonical `orchestration-state.json` always wins (a shutdown-preserved checkpoint is never overwritten by an older archive), and a `[Continue Task]` message is treated as a control command — it is never replayed as a task, and it never enters a planning prompt as a whole. On the planning-phase resume route (an archived checkpoint suspended before any group existed, `groups: []`) only the user's own text inside the dispatch is passed in as the clarification answer; it is delimited by the `Additional instructions from the user for this continuation:` label line and the trailing `When done, declare the final delivery decision ...` line, which are part of the same cross-module contract as the marker (`CONTINUATION_USER_DIRECTIVE_LABEL` / `CONTINUATION_TRAILER`). A dispatch with no user text yields an empty answer. If the same marker message arrives while a pre-planning clarification is pending (before any orchestration state exists), the template text is dropped entirely and the ORIGINAL request is re-classified under a no-questions directive with `skipClarification` forced on — the dispatch is read as "stop asking, just execute". The same reading applies when it arrives during a mid-execution `[ASK_USER]` suspension: the template is dropped, the suspended group resumes under a "no more questions, complete with reasonable assumptions" directive, and a module-level override suppresses every further `[ASK_USER]` suspension for the rest of that orchestration (the suspended continuation closure captures an immutable classification, so the override cannot ride on it). When a payload is present it is wrapped as a supplementary instruction before entering planning (`wrapContinuationDirectiveAsClarification`): it is explicitly presented as NOT a direct answer to the planning phase's clarification question, because the payload slot also holds an automatic Gateway continuation's resume wording, which must never be mistaken for the user's answer.
- The continuation message is not discarded on the resume route: its full text is injected once into the execution prompt of the group the resume starts at, as a `## Continuation Directive` block (additive — it never replaces the group requirements). This is how the extra instructions the orchestrator puts in that message (user notes, validation-failure reasons) take effect, since a long_task prompt body itself never enters the orchestration prompts. The block sits above the mandatory output-format section, so the JSON contract and the language instruction remain the last things the model reads; it is capped at ~800 tokens (free-form user text is not length-limited upstream) and states explicitly that any delivery wording it contains does not override the group-execution delivery restriction. The directive survives a clarification suspension that re-runs the same group and is re-stated in a checkpoint redo of that same group (the redo rebuilds the whole execution prompt); a resume that lands directly in the final audit keeps it for the audit-retry round. Later groups and subsequent final-audit rounds do not repeat it.
- The owning Prompt clears internal mode and emits `orchestration_completed` before `[Long Task] Task aborted` (thinking) + `agent_end(reason=cancelled)`. The completion marker closes orchestration suppression; it does not declare success. This also applies to shutdown interruption without a separate abort command. No `error` event is emitted for this interruption.
- Abort handling waits for both `harness.abort()` and extension cleanup to settle, including when either rejects early. Successful cleanup emits `aborted`; cleanup failure emits a diagnostic error. `abort_completed` follows in both cases. Orchestrators managing run/pool lifecycles should wait for this settle boundary before reusing the runtime. Queued prompts invalidated by the same abort are skipped silently; the abort handler remains the sole sender of this terminal event.

#### `shutdown`

Gracefully shut down the HogAgent process. The agent will abort any running task, wait for idle, clean up extensions, flush stdout, and exit.

If a long_task orchestration is running at shutdown time, the abort is treated as an interruption rather than a cancellation: `orchestration-state.json` is preserved, and the next prompt received after restart resumes the orchestration from the interrupted group (see `abort` above).

```json
{"type": "shutdown"}
```

**Response event:**
```json
{"type": "shutdown", "reason": "command", "timestamp": "..."}
```

> **Note:** After the shutdown event, the process will exit with code 0. The orchestrator should treat this as a clean termination.

#### `new_session`

Reset the agent and create a new session. Optionally accepts a custom session ID.

```json
{"type": "new_session"}
```

or with a custom session ID:

```json
{"type": "new_session", "session_id": "custom-id", "session_context": {"schema_version":"1.0","attributes":{"tenant":"a"}}}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | No | Custom session ID: 1–128 ASCII letters, digits, `_`, or `-` (auto-generated UUID v4 if omitted) |
| `session_context` | object | No | Initial in-memory session context for the new session |

> **Note:** If the provided `session_id` matches an existing historical session, the command returns an `error` event. Use `switch_session` or `resume_session` to access historical sessions.

> **Prepare/commit:** HogAgent prepares target storage, Harness, logger, and hooks before retiring the active session. A preparation error leaves the active in-process session tuple unchanged. Preparation can still create the target JSONL/task directory; this guarantee is not a filesystem rollback.

#### `get_state`

Request current agent state.

```json
{"type": "get_state"}
```

**Response event:**
```json
{
  "type": "state",
  "model": "qwen3.7-plus",
  "provider": "hedgehog",
  "base_url": "https://api.ciweiai.com/api/llm/v1",
  "thinking_level": "medium",
  "session_id": "abc-123",
  "tool_count": 16
}
```

#### `set_model`

Change the active LLM model.

```json
{"type": "set_model", "model_id": "qwen3.7-plus"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model_id` | string | Yes | Model identifier from configured models |

The client does not provide provider identity or context capacity. HogAgent keeps the existing model configuration contract: a known model uses its configured window, while an unknown model can still be selected and is validated by the provider on the next call. Missing, invalid, too-small, or legacy 200,000-token windows use the 500,000-token product default.

#### `set_thinking_level`

Adjust the LLM thinking/reasoning depth.

```json
{"type": "set_thinking_level", "level": "high"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `level` | string | Yes | One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |

### Configuration Commands

#### `set_llm_provider`

Update the in-memory LLM provider configuration using the existing provider object shape. When a non-empty model list is supplied, HogAgent switches to its first model; otherwise the current Harness model remains selected. Use `set_model` for an explicit model change.

```json
{
  "type": "set_llm_provider",
  "provider": {
    "provider": "hedgehog",
    "apiKey": "sk-..."
  }
}
```

#### `install_skill`

Install a skill by name.

```json
{"type": "install_skill", "name": "hedgehog-stock-research"}
```

#### `reload_config`

Reload skills, refresh the existing in-memory `skillsConfig` object, and apply persisted extension settings after the current top-level task finishes. An optional `request_id` is echoed on completion/error (including queue rejection). `config_reloaded` carries the live `builtin_tools` and saved `systemConfig`; it is emitted only after application completes. Gateway waits for that correlated result, not just a successful stdin write. The command name, FIFO boundary and acknowledgement order are unchanged. External MCP has its own `reload_mcp_servers` command so an MCP configuration failure cannot interfere with this existing workflow.

```json
{"type": "reload_config", "request_id": "reload-1"}
```

#### External MCP configuration

These commands belong to HogAgent's own protocol. An orchestrator does not need to implement, proxy, or manage them. Include a unique `request_id`; every success/error response echoes it.

```jsonl
{"type":"get_mcp_servers","request_id":"mcp-1"}
{"type":"save_mcp_servers","request_id":"mcp-2","config":{"schemaVersion":1,"servers":[]}}
{"type":"probe_mcp_server","request_id":"mcp-3","server_name":"research"}
{"type":"reload_mcp_servers","request_id":"mcp-4"}
```

Success events are `mcp_servers`, `mcp_servers_saved`, `mcp_probe_result`, and `mcp_servers_reloaded`. Failures emit `mcp_error` with `request_id`, `command_type`, `code`, and a sanitized message. See [External MCP Client](./external-mcp.md) for configuration and topology rules.

---

## RPC Event Reference

### Lifecycle Events

#### `ready`

Emitted once on startup **and also on `resume_session`**. Contains full capability negotiation payload.

```json
{
  "type": "ready",
  "session_id": "abc-123",
  "version": "1.2.2",
  "capabilities": {
    "extensions": ["sub-agent", "delivery-manager", "artifact-manifest", "memory", "external-mcp"],
    "builtin_tools": ["read", "write", "edit", "bash", "grep", "find", "ls", "math_calc", "web_search", "web_fetch"],
    "installed_skills": ["fin-calc", "gen-chart", "playwright", "print-pdf"],
    "supports_compaction": true,
    "supports_sub_agent": true,
    "runtime_context": {
      "schema_version": "1.0",
      "scopes": ["process", "session", "current_run"],
      "transports": {
        "process": ["cli_file", "programmatic"],
        "session": ["new_session", "resume_session", "prompt"],
        "current_run": ["prompt"]
      },
      "session_persistence": "memory_only",
      "session_eviction": "lru_inactive",
      "legacy_prompt_metadata": true,
      "attributes_model_visible": true,
      "limits": {
        "max_json_depth": 16,
        "process_max_bytes": 32768,
        "session_max_bytes": 32768,
        "current_run_max_bytes": 65536,
        "max_session_contexts": 256
      }
    },
    "llmProvider": { "provider": "hedgehog", "baseUrl": "...", "models": [...] },
    "currentModel": "qwen3.7-plus",
    "thinkingLevel": "off",
    "systemConfig": { "sandboxMode": "disabled" }
  },
  "timestamp": "..."
}
```

The `external-mcp` extension name indicates that the independent Client capability is installed. External MCP meta-tools appear in `builtin_tools` only when at least one effective external server is enabled, so an unconfigured installation retains the original model-visible tool set.

> **Note:** `ready` is emitted both at startup and after `resume_session`. The `mode` field (e.g., `"standard"`, `"long_task"`) is restored from validated session task-directory metadata. An unreadable or unsupported disk value is logged and treated as missing (`null` at startup, Standard on the next prompt); the file is not rewritten.

> **Conditional Bash capability:** consumers must inspect `capabilities.builtin_tools` and `capabilities.systemConfig.sandboxMode`. On macOS/Linux, `enabled` omits Bash when isolation cannot initialize; `fallback` keeps Bash in a warning-marked `UNSANDBOXED` mode after such a failure; `disabled` selects the operator-configured direct shell. Windows does not support the sandbox and ignores `sandboxMode`, so every value uses Windows PowerShell or verified Git Bash in a platform-marked `UNSANDBOXED` runtime; `cmd.exe` is unsupported. Systems without any platform shell candidate omit the capability in every mode. Capabilities expose the stored policy, while startup logs and the tool description expose the effective backend.

#### `agent_start`

Agent begins processing a prompt.

```json
{"type": "agent_start", "session_id": "abc-123", "timestamp": "..."}
```

#### `agent_end`

Agent finished processing.

Main Harness, prompt failure and orchestration boundaries carry an explicit `reason`: `completed`, `error`, `cancelled`, `max_turn_requests`, or `context_compaction_failed`, with an `error` detail when available. Synthetic clarification/success events and older versions may omit reason. The final assistant outcome determines Harness status; an earlier failed tool does not taint a later successful result. Benign provider-tail errors remain completed. Prompt input/session/runtime rejection and conversation-handler exceptions also put the failure on the terminal event. A failed delivery-finalization hook is terminated by the owning prompt, never preceded by a successful orchestration terminal.

Consumers keep tool failures and standalone `error` notifications as process feedback until an explicit outer terminal arrives; they must not release the run or dispatch queued prompts solely on an error notification. Internal events and intermediate orchestration boundaries are excluded. Do not infer failure merely from a previous diagnostic after a successful terminal.

```json
{"type": "agent_end", "session_id": "abc-123", "message_count": 12, "timestamp": "..."}
```

#### `shutdown`

Agent is shutting down (stdin closed or signal received).

```json
{"type": "shutdown", "session_id": "abc-123", "reason": "SIGTERM", "timestamp": "..."}
```

---

### Conversation Events

#### `turn_start` / `turn_end`

```json
{"type": "turn_start", "session_id": "abc-123", "timestamp": "..."}
{"type": "turn_end", "session_id": "abc-123", "has_tool_results": true, "timestamp": "..."}
{"type": "turn_end", "session_id": "abc-123", "has_tool_results": false, "content": "本轮助手文本回复", "timestamp": "..."}
```

- `content`（可选）：本轮助手消息的完整文本。编排器在最后一个无工具调用的 `turn_end`（`has_tool_results: false`）上缓存该字段，作为文本交付任务的最终结果（`agent_end` 边界确认时落库）。文本为空时不携带。
- `reason` / `error`：主 Harness 同样在 turn 边界传递规范化结果；有工具结果或编排中的中间 turn 不能作为外层回合终态。

#### `message_start` / `message_update` / `message_end`

```json
{"type": "message_start", "session_id": "abc-123", "role": "assistant", "timestamp": "..."}
{"type": "message_update", "session_id": "abc-123", "role": "assistant", "timestamp": "..."}
{"type": "message_end", "session_id": "abc-123", "role": "assistant", "terminal_status": "success", "stop_reason": "stop", "timestamp": "..."}
```

`prompt` RPC 通道中由 provider 生成的 assistant `message_end` 会携带规范化终态：`terminal_status` 为 `success` 或 `error`，并可携带 provider 原始 `stop_reason`、`error_message`。消费端应优先以 `terminal_status` 判定该消息是否成功；旧版或合成消息不含此字段时，仍需按原有生命周期兼容。HogAgent 继续为真实失败发送独立 `error` 事件，兼容尚未识别新字段的 Gateway 和客户端；会话切换、命令校验等无法产生 assistant `message_end` 的错误也仍只通过独立 `error`/生命周期事件表达。已产生有效文本的已知良性尾部误报会标记为 `success`，其诊断字段不应被消费端重新判定为失败。

#### `thinking_start` / `thinking` / `thinking_end`

Emitted when the LLM uses a thinking/reasoning model. The thinking content is streamed via `thinking` events between `thinking_start` and `thinking_end`.

```json
{"type": "thinking_start", "session_id": "abc-123", "role": "assistant", "timestamp": "..."}
{"type": "thinking", "session_id": "abc-123", "role": "assistant", "delta": "Let me analyze this...", "timestamp": "..."}
{"type": "thinking_end", "session_id": "abc-123", "role": "assistant", "timestamp": "..."}
```

| Event | Description |
|-------|-------------|
| `thinking_start` | LLM begins reasoning phase |
| `thinking` | Thinking content delta (streamed) |
| `thinking_end` | Reasoning phase complete |

**Audit LLM usage reporting:** `thinking_end` is also used to report audit LLM token consumption (classifyIntent / auditScore). Audit events carry additional fields:

```json
{"type": "thinking_end", "session_id": "abc-123", "role": "assistant", "usage": {"input": 1200, "output": 300, "cacheRead": 800, "cacheWrite": 200, "totalTokens": 2500}, "source": "audit", "phase": "classify", "timestamp": "..."}
```

| Field | Description |
|-------|-------------|
| `usage` | Token consumption of the audit LLM call(s) |
| `source` | `"audit"` — distinguishes from normal thinking_end events |
| `phase` | `"classify"` (intent classification), `"checkpoint_audit"` or `"final_audit"` (scoring) |

Consumers should check `source === "audit"` to separate audit usage from main LLM usage. The WebUI accumulates audit usage into a separate counter and displays it as an independent line in the token stats panel. Audit usage is also persisted to `<sessionTaskDir>/audit-usage.json` for session restoration.

Scoring emits one usage increment per assistant message_end, including messages settling after score submission, timeout or cancellation. It no longer emits a second aggregate at the scoring boundary. Provider-reported usage on a failed classification stream is preserved before returning a fallback. Classification, scoring and sub-agent completion events retain the original accounting Session and optional task_id/work_id; classification and scoring request metadata use the same frozen owner. Consumers must not reassign late usage to the next task in a shared Session.

#### `internal_mode`

Emitted during Long Task execution to indicate the agent is in internal orchestration mode. When `active: true`, intermediate `message_start`/`message_update`/`message_end` events from the main Harness are automatically redirected to `thinking_start`/`thinking`/`thinking_end` events at the backend level. Only the final response and deliverables appear as normal message events.

```json
{"type": "internal_mode", "session_id": "abc-123", "active": true, "timestamp": "..."}
{"type": "internal_mode", "session_id": "abc-123", "active": false, "timestamp": "..."}
```

| Field | Type | Description |
|-------|------|-------------|
| `active` | boolean | `true` = entering internal mode, `false` = exiting |

For `session_switched` history, each message's existing `type` field reflects the persisted prompt phase on the active branch: planning/execution replies are `thinking`, while final-summary and ordinary follow-up replies are `message`. Classification precedes compaction and empty-message filtering, so tool-only calls, retries and multiple orchestration rounds cannot consume the final reply's position. The legacy `mode.json.complexAssistantCount` remains statistical and is not used as a display boundary. Live event shapes and consumers are unchanged.

#### `orchestration_resuming` / `orchestration_completed`

Long Task orchestration lifecycle markers. Fresh execution, interrupted recovery, and clarification continuations share one terminal handler. It invokes delivery finalization only when orchestration returns normally; an unhandled failure emits `error`, archives any remaining checkpoint for explicit `[Continue Task]` recovery, then closes the orchestration interval and Agent turn. Abort/compaction termination stays with the owning Prompt Run; audit-model fallback still defers Agent termination to the fallback prompt.

This does not tighten Long Task acceptance: non-fatal group exceptions may still be skipped, skipped audits continue with unverified results, and exhausted audit retries still deliver current results. `agent_end(reason: "completed")` means orchestration and delivery finalization closed normally, not that audit passed. Checkpoints are cleared only after the final summary and native artifact/delivery hooks complete. If finalization explicitly returns `false` or throws, the completed checkpoint is retained and this handler emits the existing `error` plus the only `agent_end(reason: "error")`; the outer prompt does not emit another orchestration close. Recovery reuses the saved final reply and delivery decision and retries only the delivery close, without another model call. A failed summary retains the group cursor for the existing final-audit recovery path. Delivery ID deduplication does not claim atomic exactly-once network transmission.

Interrupted execution keeps its completed checkpoint until that same outer finalization succeeds. Completed recovery normalizes historical role selections and empty lists to `none`; native state and the outgoing `turn_end.delivery_decision` agree. A nonempty explicit list remains reusable, subject to the current locked policy and real receipts.

Final-summary tool/resource preparation shares the same cleanup boundary as the summary request. Preparation failure or an abort before the request resets message-suppression and deferred-finalization flags, so later turns retain their normal display and lifecycle behavior.

The final statistics update preserves existing original user messages without appending them again. Failure to persist these auxiliary statistics is logged as a warning; it does not replace the execution outcome or suppress orchestration and Agent termination events.

```json
{"type": "orchestration_resuming", "session_id": "abc-123", "session_task_dir": "/path/tasks/abc-123", "timestamp": "..."}
{"type": "orchestration_completed", "session_id": "abc-123", "timestamp": "..."}
```

- `orchestration_resuming` — emitted when a suspended orchestration resumes (user answered an `[ASK_USER]` clarification, or an interrupted orchestration is picked up after restart).
- `orchestration_completed` — marks the end of an orchestration interval, not business success. Successful, failed and interrupted terminal paths emit it before the final `agent_end`; its explicit reason determines run outcome. The owning Prompt also closes the interval for errors outside the orchestration wrapper; repeated closure is idempotent. A checkpoint that becomes unavailable during recovery fails explicitly instead of leaving the turn active. Delivery/final-turn/audit events supply result evidence, and standalone errors remain diagnostics. Known Gemini end-of-turn misfires (`MALFORMED_FUNCTION_CALL` / `UNEXPECTED_TOOL_CALL`) remain warning-only when non-empty final text was already produced.
- If the orchestration suspends again for another clarification round, **no** completion events are emitted — the clarification question bubble is the turn's final output.
- All orchestration events carry the `session_id` of the session that **started** the orchestration (pre-bound at start), so events remain correctly attributed even if the active session is switched mid-run.

Planning is read-only Skill discovery: only an already-active `read` tool remains available, and the original tool set is restored before execution or suspension. Invalid/empty/truncated step JSON receives one tool-free format correction, announced as a `thinking` event. If correction still fails, HogAgent emits `Main model did not generate a valid execution plan after one format correction...`; consumers must not interpret this as proof that the user's task is too complex. Genuine planning provider failures retain `LLM call failed: <provider diagnostic>` without adding a planning-error prefix, preserving Gateway's existing rate-limit/`terminated` retry classification. Abort and compaction failures retain their existing terminal semantics.

---

### Tool Events

#### `tool_execution_start`

```json
{
  "type": "tool_execution_start",
  "session_id": "abc-123",
  "tool_call_id": "tc_001",
  "tool_name": "web_search",
  "timestamp": "..."
}
```

#### `tool_execution_update`

```json
{
  "type": "tool_execution_update",
  "session_id": "abc-123",
  "tool_call_id": "tc_001",
  "tool_name": "web_search",
  "timestamp": "..."
}
```

#### `tool_execution_end`

```json
{
  "type": "tool_execution_end",
  "session_id": "abc-123",
  "tool_call_id": "tc_001",
  "tool_name": "web_search",
  "is_error": false,
  "timestamp": "..."
}
```

---

### HogAgent-Specific Events

#### `delivery`

A deliverable file was written.

```json
{
  "type": "delivery",
  "path": "output-1.md",
  "session_id": "abc123...",
  "description": "Q4 earnings analysis report",
  "mime_type": "text/markdown",
  "size": 4523,
  "timestamp": "..."
}
```

Note: `path` is the output filename relative to the session task directory (`tasks/<session-id>/`).

#### `model_changed`

Model was changed via `set_model`.

```json
{"type": "model_changed", "session_id": "abc-123", "model_id": "gpt-4.1", "timestamp": "..."}
```

#### `thinking_level_changed`

Thinking level was changed via `set_thinking_level`.

```json
{"type": "thinking_level_changed", "session_id": "abc-123", "level": "high", "timestamp": "..."}
```

#### `llm_provider_changed`

Credentials for the current LLM provider were refreshed via `set_llm_provider`.

```json
{"type": "llm_provider_changed", "session_id": "abc-123", "provider": "hedgehog", "timestamp": "..."}
```

#### `session_compact`

Session was auto-compacted by Pi.

```json
{"type": "session_compact", "session_id": "abc-123", "from_hook": true, "timestamp": "..."}
```

This is a legacy persistence observation. Do not use it to open or close UI state.

#### `compact_started`

```json
{"type":"compact_started","session_id":"abc-123","timestamp":"..."}
```

#### `compact_completed`

Compaction completed or was skipped because there was nothing to compact.

```json
{"type":"compact_completed","session_id":"abc-123","summary_length":512,"tokens_before":15000,"timestamp":"..."}
```

When there is nothing to compact, the same terminal event carries `"status":"skipped"`. A normal completion omits `status`.

#### `compact_failed`

```json
{"type":"compact_failed","session_id":"abc-123","reason":"error","message":"Context compaction exceeded 5 minutes","timestamp":"..."}
```

Every `compact_started` has exactly one `compact_completed` or `compact_failed` terminal event and is scoped by `session_id`; no operation ID is required. User abort is rejected while compression owns the session. Timeout/provider failure uses `compact_failed(reason=error)` and the owning prompt then emits the normal error lifecycle. Once provider output has entered Session commit, it completes normally. Local Session reads/writes are not forcibly interrupted.

#### `session_created`

New session created via `new_session`.

```json
{"type": "session_created", "session_id": "uuid-here", "timestamp": "..."}
```

#### `session_switched`

Switched to a historical session via `switch_session`.

```json
{"type": "session_switched", "session_id": "...", "messages": [...], "title": "...", "mode": "standard", "timestamp": "..."}
```

#### `session_list`

Response to `list_sessions`.

```json
{"type": "session_list", "sessions": [...], "current_session_id": "...", "timestamp": "..."}
```

#### `skill_installed`

A skill was installed.

```json
{"type": "skill_installed", "session_id": "abc-123", "name": "hedgehog-stock-research", "timestamp": "..."}
```

#### `config_reloaded`

Configuration was reloaded.

```json
{"type": "config_reloaded", "session_id": "abc-123", "timestamp": "..."}
```

#### `models_refreshed`

Model list was refreshed.

```json
{"type": "models_refreshed", "session_id": "abc-123", "provider": "hedgehog", "models": [...], "timestamp": "..."}
```

#### `settings_saved`

LLM settings were persisted.

```json
{"type": "settings_saved", "session_id": "abc-123", "provider": "hedgehog", "modelId": "qwen3.7-plus", "timestamp": "..."}
```

#### `steer_queued` / `follow_up_queued` / `aborted`

Confirmation events for `steer`, `follow_up`, and `abort` commands. All carry `session_id`. `aborted` is also the terminal lifecycle event for an externally aborted `long_task` orchestration.

> **Naming note:** `steer_queued` / `follow_up_queued` are historical names. These events are emitted **after** steer/followUp successfully executes, not when they are "queued". Both commands bypass the FIFO queue and execute immediately.

#### `abort_completed`

Terminal settle event guaranteed at the end of abort handling (after `aborted` on success, or after the `error` event when harness teardown fails). The abort handler is its sole sender; queued prompts invalidated by that abort are skipped without emitting another terminal. Carries `session_id`; echoes `task_id` / `work_id` from either the current top-level abort fields or the legacy nested `params` form. Orchestrators that defer run release / cascade handling until cancellation settles should listen for this event.

#### `status_update`

Progress or status message.

```json
{"type": "status_update", "session_id": "abc-123", "message": "...", "timestamp": "..."}
```

#### `state`

Response to `get_state`.

```json
{"type": "state", "session_id": "abc-123", "model": "...", "provider": "...", "base_url": "...", "thinking_level": "...", "tool_count": 16}
```

---

## Capability Negotiation

The `ready` event is the first event emitted after startup. The orchestrator uses it to:

1. **Confirm session** — verify the `session_id`
2. **Discover features** — check `supports_compaction`, `supports_sub_agent`, etc.
3. **Enumerate tools** — `builtin_tools` lists all tools (including extension-registered ones)
4. **Verify skills** — check `installed_skills` list
5. **Check LLM state** — `llmProvider`, `currentModel`, `thinkingLevel`

```typescript
interface Capabilities {
  extensions: string[];           // Loaded extension names
  builtin_tools: string[];        // All tools (Pi built-in + custom + extension-registered)
  installed_skills: string[];     // Discovered skill names
  supports_compaction: boolean;   // Automatic and idle manual compaction available
  supports_sub_agent: boolean;    // Sub-agent spawning available
  runtime_context: {              // Native hidden runtime-context contract
    schema_version: "1.0";
    scopes: ["process", "session", "current_run"];
    transports: {
      process: ["cli_file", "programmatic"];
      session: ["new_session", "resume_session", "prompt"];
      current_run: ["prompt"];
    };
    session_persistence: "memory_only";
    session_eviction: "lru_inactive";
    legacy_prompt_metadata: true;
    attributes_model_visible: true;
    limits: {
      max_json_depth: number;
      process_max_bytes: number;
      session_max_bytes: number;
      current_run_max_bytes: number;
      max_session_contexts: number;
    };
  };
  llmProvider?: {                 // Current LLM provider config
    provider: string;
    apiKey?: string;
    baseUrl: string;
    models: ModelConfig[];
  };
  currentModel?: string;          // Active model ID
  thinkingLevel?: string;         // Current thinking level
}
```

---

## Session Lifecycle Management

```
Orchestrator                         HogAgent
    │                                    │
    │  spawn process                     │
    │───────────────────────────────────▶│
    │                                    │ initialize
    │       {"type":"ready",...}          │
    │◀───────────────────────────────────│
    │                                    │
    │  {"type":"prompt","text":"..."}    │
    │───────────────────────────────────▶│
    │       (events during processing)   │
    │◀───────────────────────────────────│
    │                                    │
    │  ... more prompts ...              │
    │                                    │
    │  {"type":"new_session"}            │ ← Reset for new conversation
    │───────────────────────────────────▶│
    │  {"type":"session_created",...}     │
    │◀───────────────────────────────────│
    │                                    │
    │  Note: WebUI uses process restart,  │
    │  so new_session → subprocess respawn │
    │  → ready event (with new session_id) │
    │                                    │
    │  {"type":"switch_session",...}     │ ← View historical session (read-only)
    │───────────────────────────────────▶│
    │  {"type":"session_switched",...}   │
    │◀───────────────────────────────────│
    │                                    │
    │  {"type":"resume_session",...}     │ ← Restore write access
    │───────────────────────────────────▶│
    │  {"type":"ready",...}              │
    │◀───────────────────────────────────│
    │                                    │
    │  {"type":"prompt","text":"..."}    │ ← Continue conversation
    │───────────────────────────────────▶│
    │       (events during processing)   │
    │◀───────────────────────────────────│
    │                                    │
    │  close stdin  /  SIGTERM           │ ← Shutdown
    │───────────────────────────────────▶│
    │  {"type":"shutdown",...}            │
    │◀───────────────────────────────────│
    │                                    │ process exits
```

> **WebUI session creation:** When the WebUI is first opened, a session is automatically created (emitting a `ready` event). Clicking "New Session" immediately asks the Web server to replace its managed HogAgent subprocess; the UI clears when the replacement emits `ready`. A `/new <text>` send keeps one frozen browser-side snapshot and dispatches it once after that event. In direct RPC (stdin/stdout), `new_session` only emits `session_created` (no process restart).

---

## Session Management Commands

#### `list_sessions`

List all available sessions.

```json
{"type": "list_sessions"}
```

**Response event:** `session_list` — contains `sessions` array and `current_session_id`.

#### `switch_session`

Switch to a historical session (read-only mode).

```json
{"type": "switch_session", "session_id": "uuid-here"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | Yes | Session ID to switch to |

**Response event:** `session_switched` — contains `messages` array, `title`, `mode`, a `files` array reconstructed from durable native tool and automatic delivery receipts, `usageHistory` (per-turn token usage of the main agent), `subAgentUsage` (per-sub-agent aggregated stats restored from `sub-agent-usage.json`, rendered as a table and merged into the main agent's totals by the UI), and `auditUsage` (audit LLM token usage records restored from `audit-usage.json`, accumulated separately by the UI) for display. Historical download cards are not reconstructed from `final-output-*` filenames because delivery is an event/task-history fact; the Gateway keeps its own durable delivery records.

`usageHistory` includes all persisted assistant calls in the session, including compacted history and abandoned branches. `messages` still uses the compacted active context. Restored usage is a display snapshot, not a fresh consumption event, and must not be accumulated again by external accounting consumers.

> **Note:** After switching, the session is read-only. Sending `prompt`/`steer`/`follow_up` will return an error. Use `resume_session` to restore write access, or `new_session` to start a fresh session.

#### `resume_session`

Resume a historical session to writable state **without restarting the process**. An already-active session uses an idempotent fast path. Otherwise HogAgent first opens/repairs the target JSONL and prepares the replacement Harness, logger, and hooks while the old session stays active; only then does it enter the guarded commit phase, retire the old Harness, and publish the complete target tuple.

```json
{"type": "resume_session", "session_id": "uuid-here", "session_context": {"schema_version":"1.0","attributes":{"tenant":"a"}}}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | Yes | Session ID to resume |
| `mode` | string | No | Optional hard route: `quick`, `standard`, or `long_task`; invalid values are rejected before the active Session changes |
| `session_context` | object | No | Rebind in-memory session context, especially after process restart |

**Response event:** `ready` — contains `capabilities`, `session_id`, and `mode` (restored from the session's task directory).

> **Note:** This command reuses the current model configuration and API key. The resumed session retains all previous conversation history, and its existing/fallback title is locked so later follow-ups do not append another `session_name`; no JSONL entry is rewritten. Runtime context is deliberately not restored from history. Supply the complete `session_context` after restart or whenever the entry may have been evicted from the bounded in-memory registry.

#### `refresh_models`

Fetch the latest model list from a provider.

```json
{"type": "refresh_models", "provider": "hedgehog", "apiKey": "optional-key"}
```

#### `install_skill_from_git`

Install a skill by cloning a Git repository.

```json
{"type": "install_skill_from_git", "url": "https://github.com/org/skill-repo.git"}
```

#### `configure_skill`

Save API key for a skill to `$HOGAGENT_USER_DIR/skills_config.json` when that variable is set, otherwise `~/.hogagent/skills_config.json`. Multiple skills are stored in the same file. The RPC accepts `apiKey`; the persisted skill entry uses the standard `"api-key"` field.

```json
{"type": "configure_skill", "name": "hedgehog-stock-research", "apiKey": "..."}
```

Response event:
```json
{"type": "skill_configured", "name": "hedgehog-stock-research", "configPath": "~/.hogagent/skills_config.json"}
```

Skill scripts read this file and use the key as Bearer token when calling remote APIs.

#### `save_settings`

Persist LLM settings to `~/.hogagent/llm-settings.json`.

```json
{
  "type": "save_settings",
  "provider": "hedgehog",
  "apiKey": "...",
  "baseUrl": "https://api.ciweiai.com/api/llm/v1",
  "modelId": "qwen3.7-plus",
  "thinkingLevel": "high",
  "audit": {
    "provider": "hedgehog",
    "apiKey": "...",
    "baseUrl": "https://api.ciweiai.com/api/llm/v1",
    "modelId": "claude-3-5-haiku-20241022",
    "minPassScore": 70,
    "maxIterations": 2
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | No | Main LLM provider |
| `apiKey` | string | No | Main LLM API key |
| `baseUrl` | string | No | Main LLM base URL |
| `modelId` | string | No | Main LLM model ID |
| `thinkingLevel` | string | No | Thinking depth level |
| `audit` | object | No | Audit model configuration (all sub-fields optional; omit to clear) |

After persisting through the local configuration API, Gateway adds `reloadPersistedLlm: true` to this existing command. HogAgent then reads the latest `llm-settings.json` when the command reaches the FIFO boundary, applies it in memory and skips persistence. The notification’s credential fields must still match the file; otherwise it fails and requires a fresh apply or restart. This prevents an old-account process from adopting a new account’s Key as well as preventing a stale snapshot from overwriting rotated/revoked credentials. Ordinary WebUI calls omit this flag.

`save_settings` keeps its existing merge-and-hot-update behavior and does not fetch a provider model list or require authoritative window metadata. Missing or unusable context-window values use the documented 500,000-token product default. The Gateway runtime-settings endpoint adds one UI safety check: changing the main `provider` or `baseUrl` there requires a non-empty `modelId` in the same existing request.

#### `reset_search_cache`

Reset the web_search tool's cached search settings. Called automatically by the WebUI server after saving new search configuration.

```json
{"type": "reset_search_cache"}
```

#### `llm_chat`

Validation failures and resolved provider-error messages emit `error + agent_end` with `internal=true` and the supplied correlation `session_id`, just like exceptions during execution. Consumers must keep these errors out of normal conversation history.

Direct LLM call without tools or skills. Uses the main harness's model configuration (no model_id override supported).

This command is designed for external applications that need to call the LLM directly through HogAgent, without the overhead of tool execution or skill loading.

```json
{"type": "llm_chat", "text": "Explain quantum computing in simple terms", "system_prompt": "Answer for a general audience.", "thinking_level": "off", "timeout_ms": 60000, "session_id": "usage-owner", "run_context": {"schema_version":"1.0","run_id":"classify-42"}, "internal": true, "persist_usage": true}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | User message to send to the LLM |
| `system_prompt` | string | No | Trusted system instruction for the temporary Harness; it has system priority inside this isolated call but does not modify the main Agent system prompt or conversation |
| `thinking_level` | string | No | Override thinking depth for this call only (`off` / `low` / `medium` / `high`); defaults to `off` |
| `timeout_ms` | number | No | Positive execution timeout in milliseconds; on expiry HogAgent best-effort aborts only this temporary Harness and emits `error + agent_end` |
| `session_id` | string | No | Correlation/accounting owner for emitted events only; it never selects, resumes, or mutates an Agent Session |
| `run_context` | object | No | Optional Current Run-shaped metadata for this isolated request; Session context is intentionally unsupported |
| `internal` | boolean | No | Marks command-scoped events internal. The `llm_chat` handler also marks its own events internal unconditionally |
| `persist_usage` | boolean | No | Echoed on internal events so a trusted orchestrator may account token usage to an explicit `session_id` |

**Event sequence:**
```
← {"type": "message_start", "role": "assistant", ...}
← {"type": "message_update", "role": "assistant", "delta": "Quantum computing...", ...}
← {"type": "message_update", "role": "assistant", "delta": "uses qubits...", ...}
← {"type": "message_end", "role": "assistant", ...}
← {"type": "agent_end", "message_count": 1, ...}
```

**Notes:**
- Uses a temporary in-memory session — does not affect the main conversation history
- No tools, skills, or system prompt from the main harness. The optional trusted `system_prompt` applies with system priority only to this temporary call; ordinary business prompts should remain in `text`
- Does not install or read Session Runtime Context. `run_context`, when present, is validated with the normal Current Run limits and appended to this temporary Harness only
- All handler events carry `internal=true`; UI/history consumers must filter by this explicit flag rather than message text. On failure HogAgent emits `error` followed by `agent_end`, keeping process lifecycle state balanced
- Queued like other commands (blocks subsequent commands until complete); `timeout_ms` bounds cooperative providers without aborting the main Harness or process
- Error events may be emitted on failure (e.g., API key issues)

---

## Error Handling and Recovery

### Command Errors

All command errors produce an error event:
```json
{"type": "error", "error": "descriptive message", "command_type": "the_failing_command"}
```

### Recovery Strategies

| Scenario | Action |
|----------|--------|
| Unknown command | Check spelling, refer to command reference |
| Missing required field | Resend with all required fields |
| Model not found | Use `get_state` to check available models |
| Agent stuck streaming | Send `abort`, then re-prompt |
| Stale session | Send `new_session` to reset |

### Graceful Shutdown

HogAgent supports three shutdown mechanisms:

1. **`shutdown` RPC command** (recommended): Send `{"type": "shutdown"}` via stdin. The agent will abort running tasks, wait for idle, clean up extensions, flush stdout, and exit with code 0.
2. **SIGTERM signal**: Same behavior as shutdown command — emits `shutdown` event, stops RPC loop, runs shutdown callbacks, flushes stdout, and exits.
3. **SIGINT signal**: Same behavior as SIGTERM.

All shutdown paths ensure **stdout is flushed** before process exit, so the orchestrator will always receive the final `shutdown` event. Shutdown callbacks are **idempotent**: if the `shutdown` command and a signal both arrive (e.g., the gateway sends `shutdown` and then SIGTERMs), the callbacks run only once.

| Shutdown Method | Trigger | Use Case |
|----------------|---------|----------|
| `shutdown` command | stdin JSONL | Orchestrator-initiated clean shutdown |
| SIGTERM | OS signal | Container/process manager termination |
| SIGINT | OS signal | User interrupt (Ctrl+C) |

---

## Example Integration Scenario

### Basic Prompt/Response

```
→ stdin:  {"type":"prompt","text":"What is 2+2?"}
← stdout: {"type":"agent_start","timestamp":"..."}
← stdout: {"type":"turn_start","timestamp":"..."}
← stdout: {"type":"message_start","role":"assistant","timestamp":"..."}
← stdout: {"type":"message_update","role":"assistant","timestamp":"..."}
← stdout: {"type":"message_end","role":"assistant","timestamp":"..."}
← stdout: {"type":"turn_end","has_tool_results":false,"timestamp":"..."}
← stdout: {"type":"agent_end","message_count":2,"timestamp":"..."}
```

### Tool Execution Flow

```
→ stdin:  {"type":"prompt","text":"Calculate sqrt(144) + log(1000)"}
← stdout: {"type":"agent_start","timestamp":"..."}
← stdout: {"type":"turn_start","timestamp":"..."}
← stdout: {"type":"tool_execution_start","tool_call_id":"tc_1","tool_name":"math_calc","timestamp":"..."}
← stdout: {"type":"tool_execution_end","tool_call_id":"tc_1","tool_name":"math_calc","is_error":false,"timestamp":"..."}
← stdout: {"type":"turn_end","has_tool_results":true,"timestamp":"..."}
← stdout: {"type":"turn_start","timestamp":"..."}
← stdout: {"type":"message_start","role":"assistant","timestamp":"..."}
← stdout: {"type":"message_end","role":"assistant","timestamp":"..."}
← stdout: {"type":"turn_end","has_tool_results":false,"timestamp":"..."}
← stdout: {"type":"agent_end","message_count":4,"timestamp":"..."}
```

#### `warning`

Non-fatal warning message (e.g., mode degradation notice, intent classification fallback).

```json
{"type": "warning", "message": "Audit model not configured or disabled, Long Task degraded to Standard", "timestamp": "..."}
{"type": "warning", "message": "Audit model LLM key unavailable (…), Long Task degraded to Standard", "timestamp": "..."}
{"type": "warning", "message": "Audit model key unavailable (…) — audit skipped, proceeding without verification", "timestamp": "..."}
{"type": "warning", "message": "Intent classification failed (…) — falling back to simple mode for this message", "timestamp": "..."}
```

---

### Audit & Long Task Events

When the audit model is configured, additional events are emitted during prompt processing. These events use the `thinking` event type and are intended for the thinking/steps detail panel, **not** the main chat stream.

#### Long Task Progress (thinking events)

```
← stdout: {"type":"thinking","role":"assistant","delta":"[Audit] Planning..."}
← stdout: {"type":"thinking","role":"assistant","delta":"[Audit] Executing group 1/3..."}
← stdout: {"type":"thinking","role":"assistant","delta":"[Audit] Checkpoint score: 85/100 ✓"}
← stdout: {"type":"thinking","role":"assistant","delta":"[Audit] Redoing group 2 (2/3)..."}
← stdout: {"type":"thinking","role":"assistant","delta":"[Audit] Final review score: 92/100 ✓"}
```

#### /audit Trigger (thinking events)

When a user sends `/audit <content>` in long_task mode, the audit harness is re-engaged with the main Harness conversation history:

```
← stdout: {"type":"thinking","role":"assistant","delta":"[Audit] /audit triggered, optimized prompt: ..."}
```

#### mode Field Semantic Change

The `prompt` command's optional `mode` field is a **hard routing directive**:

| Scenario | Behavior |
|----------|----------|
| `mode` = `quick` | Main Harness, no tools, no skills. Optional `thinking_level` overrides this call only; otherwise the persisted quick setting is used, then `off` |
| `mode` = `standard` | Main Harness, all tools, filtered skills |
| `mode` = `long_task` | Audit model (if configured) optimizes prompt → orchestrator → audit scoring. If audit model closed/not configured — or its key/quota is unusable — degrades to `standard` for the turn. If the **main** LLM returns a key/quota error during orchestration, the conversation fails fast with an `error` event (no redo loops) |
| `mode` not specified | Defaults to `standard` |

---

## Cross-References

- [Architecture Overview](./architecture.md) — System design and component overview
- [Extension APIs](./extensions.md) — How extensions register tools and handle events
- [Skill System](./skills.md) — Skill installation and management

### Content compression configuration

Content compression is off by default. Disabling takes effect at the next idle RPC boundary after the current top-level task finishes: both retrieval tools and their model-visible definitions are removed, the hook is detached, and cached Entry IDs expire. Enabling always requires a process restart. Threshold changes apply only to an already active compressor. Both save_settings and Gateway reload_config await the same extension configuration application; failures are reported rather than acknowledged as applied. Native tool definitions and data-access prompt guidance follow the effective tool catalogue, independently of persisted enabling intent. History may retain old tool names and Entry IDs; disabling does not rewrite history.

The delivery event now includes stable `id`, `session_id`, `run_id`, `fingerprint` and source metadata. Empty `files` with `requested_files` records explicit intent only and must not create download cards. See [Artifact Manifest](artifact-manifest.md); consumers must preserve receipt IDs and original Session identity.
