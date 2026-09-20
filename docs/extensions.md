# HogAgent Extension APIs and Interfaces

## Overview

Extensions are the primary mechanism for adding functionality to HogAgent beyond the built-in tools. They can register tools, use Pi's hook system to intercept tool results, and emit RPC events.

HogAgent ships with **6 built-in extensions**:
- `content-compressor` — Automatic tool result compression
- `sub-agent` — Isolated sub-agent spawning
- `delivery-manager` — Run-policy-aware real-file delivery; `deliver_files` remains a compatibility tool
- `artifact-manifest` — Always-on internal artifact classification, provenance and task snapshots; never a delivery
- `memory` — Cross-session persistent memory via Gateway KB MCP Server (`memory_save` / `memory_search`)
- `external-mcp` — Independent standard MCP Client with allowlisted capabilities and operation recovery

---

## IExtension Interface

Every extension must implement this interface:

```typescript
interface IExtension {
  /** Unique name (kebab-case). */
  name: string;

  /** Semantic version. */
  version: string;

  /**
   * Initialize the extension.
   * @param context - HogAgentContext providing extension APIs
   * @param config - Optional config from extensions.json
   */
  initialize(context: HogAgentContext, config?: unknown): Promise<void>;

  /** Awaited before a terminal agent_end event for the current run. */
  beforeAgentEnd?(): Promise<void>;

  /** Awaited when the active Agent run is aborted. */
  onAgentAbort?(): Promise<void>;

  /** Optional shutdown hook (called in reverse init order). */
  shutdown?(): Promise<void>;

  /**
   * Called after new_session/resume_session replaces the AgentHarness instance.
   * Extensions holding harness event hooks (e.g. tool_result interceptors)
   * must re-attach them here — hooks on the old harness are dead.
   */
  onHarnessReplaced?(harness: AgentHarness): void | Promise<void>;

  /**
   * Called when the extension's persisted config changes at runtime (save_settings).
   * Lets loaded extensions apply new settings without a process restart.
   * Extensions disabled at startup are never loaded, so enabling one still requires a restart.
   */
  applyConfigUpdate?(enabled: boolean, config?: unknown): void | Promise<void>;
}
```

---

## HogAgentContext API

The `HogAgentContext` is passed to every extension during initialization:

### Tool Registration

```typescript
/** Register a tool available to the LLM. */
registerTool(tool: unknown, registration?: AgentToolRegistration): Promise<void>;

/** Remove a tool by name. */
unregisterTool(name: string, ...additionalNames: string[]): Promise<void>;
```

**Tool object shape (AgentTool):**
```typescript
{
  name: string;               // snake_case identifier
  label?: string;             // Human-readable name
  description: string;        // Description for LLM
  parameters: TSchema;        // TypeBox schema
  execute: (
    toolCallId: string,
    params: unknown,          // Cast internally
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void
  ) => Promise<AgentToolResult>;
}
```

### Event System

```typescript
/** Subscribe to a local event. Returns unsubscribe function. */
on(event: string, handler: (...args: unknown[]) => void): () => void;

/** Emit event to stdout (RPC) and local listeners. */
emitEvent(event: RpcEvent): void;
```

### Configuration & State

```typescript
getConfig(): HogAgentConfig;
getSessionId(): string;
getWorkspaceDir(): string;

/** Access the underlying Pi AgentHarness for hook registration. */
getHarness(): AgentHarness;
```

The effective thinking level of a quick-mode prompt may be overridden by the RPC command's optional `thinking_level`. This override is scoped to prompt execution and does not update `llm-settings.json`; extensions should treat `getHarness().getThinkingLevel()` as runtime state and must not persist it as a user setting.

---

## Pi Hook System

The key integration point for extensions is Pi's `AgentHarness` hook system, accessed via `context.getHarness()`.

### `tool_result` Hook

Intercepts tool results **before** they enter the session context. Can modify or replace the result.

```typescript
const harness = context.getHarness();
const unsub = harness.on("tool_result", (event: ToolResultEventArgs) => {
  // event contains:
  //   type: "tool_result"
  //   toolCallId: string
  //   toolName: string
  //   input: unknown
  //   content: Array<{ type: string; text?: string; ... }>
  //   details: unknown
  //   isError: boolean

  if (shouldCompress(event.content)) {
    const compressed = compress(event.content);
    // Return a ToolResultPatch to replace the result:
    return { content: compressed };
  }

  // Return undefined to keep original
  return undefined;
});
```

**ToolResultPatch fields:**
- `content?` — Replace result content blocks
- `details?` — Replace details metadata
- `isError?` — Override error flag
- `terminate?` — Stop agent execution after this result

### `subscribe()` — Observe All Events

```typescript
harness.subscribe((event: AgentHarnessEvent) => {
  // Read-only observation of all harness events
  // event.type: "agent_start" | "agent_end" | "turn_start" | "turn_end"
  //           | "message_start" | "message_update" | "message_end"
  //           | "tool_execution_start" | "tool_execution_end" | etc.
});
```

### Other Hooks

```typescript
// Intercept before LLM provider payload is sent
harness.on("before_provider_payload", (event) => {
  // Can modify system prompt, messages, tools before sending to LLM
});

// Intercept before agent starts
harness.on("before_agent_start", () => {
  // Can inject messages or modify state before a new run
});
```

---

## Built-in Extensions Reference

### 1. content-compressor

**Purpose:** Optionally reduces large tool results using the `tool_result` hook. It is not a hard context-capacity guarantee.

Content compression is off by default. Disabling takes effect at the next idle RPC boundary after the current top-level task finishes: both retrieval tools and their model-visible definitions are removed, the hook is detached, and cached Entry IDs expire. Enabling always requires a process restart. Threshold changes apply only to an already active compressor. Both save_settings and Gateway reload_config await the same extension configuration application; failures are reported rather than acknowledged as applied.

**Compression strategies** (threshold unit: **tokens**, default `5000`, configurable via `textThreshold`):

| Content | Condition | Action |
|---------|-----------|--------|
| Any text | < threshold tokens | Keep original |
| Structured JSON | ≥ threshold | Keep full structure, sample long arrays in place (head + omitted-count marker + tail) via a progressive ladder |
| Markdown (has headings) | ≥ threshold | Table of Contents (progressive depth 3→2→1) |
| Other text | ≥ threshold | Head/tail preview |

While enabled, compressed tool-result text is stored in-memory (max 200 entries, FIFO) and retrievable via `get_tool_details` / `query_tool_result`. This does not restore text omitted by a producing tool such as a bounded `read`.

**Skip compression rules:**

| Scenario | Condition | Reason |
|----------|-----------|--------|
| Runtime disabled | `enabled: false` | Hook and retrieval tools are removed; no new compression |
| Tool error | `isError` or `details.error` | Keep the original failure and recovery guidance, even at low thresholds |
| Retrieval tools | `get_tool_details`, `query_tool_result` | Prevent double-compression loop |
| Raw read | any tool called with `raw=true` | LLM explicitly requests uncompressed |
| Targeted read | `read(path, offset/limit/section)` | LLM intentionally reads a slice |
| Tool opt-out | Tool result `details: { skipCompress: true }` | Includes bounded read pages; preserves continuation hints |

**Lifecycle behavior:**
- `onHarnessReplaced` — re-attaches the `tool_result` hook only while compression remains active to the new Harness after `new_session`/`resume_session` (hooks on the old Harness are dead). The in-memory store is kept so recent entry IDs stay retrievable in-process.
- Initialization registers both retrieval tools as an array via `registerTool` before attaching the compression hook. Registration and removal share the registry's transaction/rollback implementation; failed initialization leaves no compression hook or partially registered tools.
- `applyConfigUpdate` — asynchronous; disabling removes both tools through one registry/Harness update before detaching the hook and clearing the store. The registry restores the exact tool order, registration metadata and active subset on failure, including session-storage failures; the extension does not re-register tools individually. Enabling after disable is deferred to process restart.

**Tools provided:**

| Tool | Description |
|------|-------------|
| `get_tool_details` | Retrieve full uncompressed text by entry ID (supports `lines`/`offset` pagination) |
| `query_tool_result` | Query structured JSON data (filter, sort, aggregate, group_by, field selection) |

**Events emitted:**
- `content_compressed` — `{ tool_call_id, original_length, compressed_length }`

---

### 2. sub-agent

**Purpose:** Allows the main agent to spawn sub-agents using independent Pi AgentHarness instances.

**Architecture:**
```
Main AgentHarness
  └── spawn_sub_agent tool call
       └── Creates:
           ├── InMemorySessionStorage (no persistence)
           ├── Session
           ├── New AgentHarness (independent, shares model config)
           └── Activity log: log-sub-<N>.txt
```

**Tools provided:**

| Tool | Description |
|------|-------------|
| `spawn_sub_agent` | Spawn a sub-agent for a task |

**Parameters:**
- `task_description` (required) — What the sub-agent should do
- `skills` — Optional names of skills to load from the parent's available inventory
- `max_turns` — Positive integer turn budget, including format repair (default: 50)
- `timeout_seconds` — Finite positive timeout in seconds (default: 900s)

**Lifecycle behavior:**
- `applyConfigUpdate` — `save_settings` pushes `maxTurns` / `timeoutSeconds` defaults at runtime (no restart needed).
- Each spawn reads the parent's **current** Harness via `context.getHarness()`, so model changes and session rebuilds are reflected. Sub-agents use their own fixed `minimal` thinking level.
- An already-aborted parent signal prevents any sub-agent model request. The parent abort listener is removed when the sub-agent settles, including failures.
- Execution and the single optional format repair share the same turn budget and cancellation checks. A valid final reply on the last allowed turn completes normally; an unfinished tool loop or a repair requiring another turn returns `max_turns_reached`. Format repair has no active tools or skills and cannot redo business work.
- Provider failures return `error` without a format-repair request. Cancellation during execution or repair cannot return `completed`; parent cancellation and timeout retain the existing `timeout` status, with the diagnostic explaining the abort.

**Working model:**
- Sub-agent shares the parent's `sessionTaskDir` (`<workspace>/tasks/<session-id>/`)
- No independent sandbox — file operations happen in the same directory
- Declared `output_files` must be regular files from the Session task directory or Project `publish/src/data`; directories, missing paths, workspace-root and arbitrary external-path fallbacks are filtered out with a warning. Directories are not expanded automatically.
- Independent `InMemorySessionStorage` + `Session` + `AgentHarness`
- `thinkingLevel: "minimal"` for lightweight reasoning
- Each sub-agent has its own activity log: `log-sub-<N>.txt`

**Events emitted:**
- `sub_agent_spawned` — `{ session_id, sub_agent_id, skills, task_description, timestamp }`
- `sub_agent_completed` — `{ session_id, sub_agent_id, status, turns_used, usage?, timestamp }`
  - `session_id` — the session that spawned the sub-agent (captured at spawn time, so late completions after a session switch are still attributed correctly)
  - `usage` — aggregated token usage of the sub-agent's own LLM calls: `{ input, output, cacheRead, cacheWrite, totalTokens }` (shown per sub-agent in the WebUI token stats panel and added to the main agent's totals)

**Usage persistence:** each completed sub-agent appends one record (its aggregated stats: `{ id, status, turns_used, input, output, cacheRead, cacheWrite, totalTokens, timestamp }`) to `<sessionTaskDir>/sub-agent-usage.json`; `switch_session` reads this file and returns it as `subAgentUsage`, so the WebUI rebuilds the per-sub-agent table and merges the values into the main agent's totals after session switch/reload.

**Registry auto-append:** on completion the extension also appends one line to `<sessionTaskDir>/sub-agent-list.txt` in the form `Sub-agent-<index>:<session_id>:<status>:<output_files>` (file created with a `# Sub-agent Registry` header when absent), so neither the main agent nor sub-agents need to maintain the registry manually.

---

### 3. delivery-manager

**Purpose:** Delivers existing real files through the conversation event protocol and provides a session `final-output-*` fallback.

**Configuration:**
- No extra config needed. Deliveries are stored directly in the session task directory.

**Tools provided:**

| Tool | Description |
|------|-------------|
| `deliver_files` | Deliver one or more existing managed files in a single call. Paths must resolve inside the current Session/Project artifact roots. Params: `files` (array of `{ path: string, summary?: string }`). Internal `.hedgehog/`, intermediate and out-of-root paths are rejected. |

**Automatic finalization:** On the awaited `beforeAgentEnd` lifecycle, standalone HogAgent first reconciles the Manifest, then resolves the effective run-scoped `delivery_decision`. `deliverables` and `raw_data` select only current files in this run's Manifest changes; `selected_files` resolves exact non-intermediate Manifest entries; `none` emits nothing. Session defaults to `deliverables`, Project defaults to `none`. If the required Manifest hook did not run or produced no valid Manifest, automatic delivery fails closed instead of scanning filenames. Restored sessions keep the mtime cutoff for role-based automatic delivery so unchanged historical outputs are not resent.

**Idempotency (mtime-based):** `deliver_files` tracks each delivered file's `mtime`. Re-delivering an unchanged file (same mtime) is skipped with an `[already delivered]` note instead of emitting a duplicate `delivery` event. This applies to session-task-dir files, workspace-relative paths, and external absolute paths (within `sessionTaskDir`/`projectDir`) alike.

Project files remain available through the Project Manifest/API. They are sent to chat only when a locked policy or the final `delivery_decision` selects them; an explicit compatible `deliver_files` call is subject to the same locked policy. In an unlocked standalone run, a successful compatibility-tool call becomes the run's `selected_files` decision.

**Events emitted:**
- `delivery` — `{ path, session_id, description, mime_type, size, timestamp }`
  - `path` is workspace-relative when the file is inside the workspace.

---

### 4. artifact-manifest

**Purpose:** In standalone mode, updates the hidden `.hedgehog/artifact-manifest.json` and per-run snapshots before `agent_end`. Gateway-owned runs skip this write so Gateway performs one authoritative reconciliation. It classifies intermediate, raw, regular and deliverable files, records current-task changes and integrity warnings, and never emits a delivery event. See [Artifact Manifest](./artifact-manifest.md).

### 5. memory

**Purpose:** Provides cross-session persistent memory by delegating to the Gateway KB MCP Server over HTTP JSON-RPC 2.0. Enables the agent to save and recall market insights, research conclusions, portfolio changes, reviews, and quant strategies across sessions.

**Configuration** (from `hogagent.json` `memory` section):

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Whether the memory extension registers its tools. If `false` or absent, initialization is skipped. |
| `mcpKbUrl` | string | Gateway KB MCP Server endpoint (e.g. `http://127.0.0.1:59101`). If empty, registration is skipped with a warning. |

> The Gateway auto-fills `mcpKbUrl` (and defaults `enabled: true`) into `hogagent.json` on connect when its MCP server is available, unless the user has already set a value. Toggling memory takes effect on the **next session** (a `reload_config` does not re-initialize extensions).

**System prompt integration:** when both `memory_save` and `memory_search` are
registered, `buildSystemPrompt` adds a `memory_extension` section under
`memory_guidance` with the extension's save/search rules. The extension takes
priority over `hog-memory`: if both are available, the skill is ignored and no
`hog_memory_skill` section is emitted. The fallback skill is also omitted from
the model-visible `available_skills` catalog for that prompt.

When the extension is unavailable and `hog-memory` is used as the fallback,
its prompt uses the workspace-derived `SKILL.md` path and translates the same
proactive save, tag, and search guidance into the skill's `save`/`search`
operations without embedding CLI implementation details.

**Tools provided:**

| Tool | Description | Backing MCP method |
|------|-------------|--------------------|
| `memory_save` | Save a memory entry. `tags` MUST include stock codes (exchange-suffixed, e.g. `600519.SH`), Shenwan L1 industry (e.g. `食品饮料`), and key topics. Params: `content`, `task_type?`, `tags`, `task_desc?`. The extension forwards the trusted current task `work_id` when available; otherwise it omits it and never invents one. | `kb_memory_create` |
| `memory_search` | Search memories by `query`, `task_type`, `stock_codes`, `industry`, `tags`, `limit`. | `kb_memory_search` |

**task_type categories:** `market_insight` / `research_record` / `portfolio` / `review` / `strategy_quant` / `other`

**Robustness notes:**
- **Bounded requests:** every MCP call uses `AbortSignal.timeout(15000)`, so an unresponsive Gateway KB MCP Server cannot hang a tool call — it fails after 15s and the error is returned as tool output rather than blocking the agent.
- **Work attribution:** `memory_save` reads `work_id` only from the current Gateway-provided task tracking context and passes it to `kb_memory_create`; the Gateway stores it as `source_work_id`. Empty or unavailable IDs are omitted.
- **`limit` clamping:** `memory_search` clamps `limit` to the Gateway's accepted range `[1, 50]` (via `Math.min(Math.max(1, Math.floor(limit)), 50)`) before sending. This avoids a hard schema rejection on the Gateway (its `MemorySearchParamsSchema` enforces `min(1).max(50)`), which would otherwise cause the entire search to fail when the model requests an out-of-range value.

---

## Writing a Custom Extension

### Step 1: Create the Extension

```typescript
// my-extension/index.ts
import { Type } from "@sinclair/typebox";
import type { IExtension, HogAgentContext } from "hogagent";

export class MyExtension implements IExtension {
  name = "my-extension";
  version = "1.0.0";
  private unsubs: Array<() => void> = [];

  async initialize(context: HogAgentContext): Promise<void> {
    // Register a custom tool
    context.registerTool({
      name: "my_custom_tool",
      description: "Does something useful",
      parameters: Type.Object({
        input: Type.String({ description: "Input data" }),
      }),
      execute: async (_id, rawParams) => {
        const params = rawParams as { input: string };
        return { content: [{ type: "text", text: `Processed: ${params.input}` }] };
      },
    });

    // Use Pi hook to observe tool execution
    const harness = context.getHarness();
    const unsub = harness.on("tool_result", (event) => {
      if (event.toolName === "my_custom_tool") {
        context.emitEvent({ type: "my_tool_executed", tool_call_id: event.toolCallId });
      }
      return undefined;
    });
    this.unsubs.push(unsub);
  }

  async shutdown(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
  }
}

export default new MyExtension();
```

### Step 2: Deploy

Place compiled `index.js` in:
- `~/.hogagent/extensions/my-extension/index.js` (system)
- `<workspace>/extensions/my-extension/index.js` (workspace)

### Step 3: Configure (Optional)

In `extensions.json`:
```json
[
  { "name": "my-extension", "enabled": true, "config": { "key": "value" } }
]
```

### Step 4: Verify

Start HogAgent — the `ready` event's capabilities will include your extension name and registered tools.

---

## Extension Discovery Order

1. **Built-in extensions** (fixed order):
   1. `content-compressor` (only when explicitly enabled)
   2. `sub-agent`
   3. `artifact-manifest` (always enabled; old config cannot disable the internal protocol)
   4. `delivery-manager`
   5. `memory`
   6. `external-mcp`

2. **External extensions** discovered from:
   - `~/.hogagent/extensions/<name>/index.js` (system)
   - `<workspace>/extensions/<name>/index.js` (workspace)

3. **Filtered** by `extensions.json` (disabled = excluded)

4. **Initialized** sequentially (built-ins first, then externals)

5. **Shutdown** in reverse initialization order

---

## Cross-References

- [Architecture Overview](./architecture.md) — System design
- [RPC Protocol](./orchestrator-integration.md) — Commands and events
- [Skill System](./skills.md) — Skills vs. extensions

### Manifest 与交付实现边界

artifact-manifest 仍先完成独立运行的核对。delivery-manager 保留名称、启停配置和 deliver_files 工具，具体校验与回执实现在 src/artifacts/file-delivery.ts；工具订阅只消费已持久化的 message_end。Gateway-owned 不运行原生自动交付。详见 [Artifact Manifest](artifact-manifest.md)。

FileDelivery 将配置快照、历史回执和收尾 Promise 绑定到同一 run，异步边界重验身份。扩展只绑定工具/生命周期及原 Session 的错误提示，不维护第二份发现索引。

### Sub-agent usage ownership

The sub-agent completion event preserves the parent Session and the Work/Task tracking identifiers captured when it was spawned. Its aggregate usage is independent of the parent message_end stream and is added once to parent consumption; audit-model calls remain separate. The cross-component usage accounting audit is maintained in the Gateway project.
