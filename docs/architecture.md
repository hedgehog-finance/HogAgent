# HogAgent Architecture Overview

> 2026-09-07 布局更新：当前目录、提示词、凭据与恢复规则以 [统一工作空间](unified-workspace.md) 为准；下文旧路径及历史审计结论仅用于兼容/迁移背景，不再作为执行配置。

## Introduction

HogAgent is a **unified AI agent engine** that internalizes [Pi Agent Harness](https://github.com/earendil-works/pi) source code into `src/vendor/`. It provides a general-purpose agent framework designed to be driven by an external orchestrator through a JSONL-based RPC protocol.

`AgentToolRegistry` owns transactional tool registration/removal and rollback. `context.registerTool(toolOrArray, registration)` and `context.unregisterTool(name, ...additionalNames)` publish one Harness update for a related group; on failure the shared transaction restores the registry's ordered definitions/metadata and the Harness's previous active subset. Compression attaches its hook only after both retrieval tools register successfully, and detaches it/clears the cache only after both tools are removed. Single-tool consumers use the same path. Native RPC attaches a command request ID through its existing async event scope. Gateway waits for a matching reload completion/error and propagates failure through the existing Pool reload path, including processes already starting. Persisted system controls use one snapshot formatter; actual model tools remain authoritative for live capability.

**Version:** package.json 3.0.0 / CLI 4.0.0  
**Runtime:** Node.js ≥ 22.19.0  
**Language:** TypeScript (ESM)

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          ORCHESTRATOR LAYER                              │
│  (hedgehog-plugin / hedgehog-gateway / any stdin/stdout JSONL client)   │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ stdin (JSONL commands)
                                    │ stdout (JSONL events)
┌───────────────────────────────────┼─────────────────────────────────────┐
│                            HOGAGENT PROCESS                              │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                      RPC LAYER (rpc.ts)                          │    │
│  │  stdin → parse JSONL → dispatch to handlers → emit events        │    │
│  └────────────────────────────────┬────────────────────────────────┘    │
│                                   │                                     │
│  ┌────────────────────────────────┼────────────────────────────────┐    │
│  │           CORE LAYER (Pi AgentHarness, vendored)                 │    │
│  │                                                                  │    │
│  │  ┌──────────────────────────────────────────────────────────┐   │    │
│  │  │  AgentHarness (src/vendor/agent/harness/agent-harness.ts) │   │    │
│  │  │  - prompt() / steer() / followUp() / abort()             │   │    │
│  │  │  - subscribe() / on() (hook system)                      │   │    │
│  │  │  - setModel() / setThinkingLevel() / compact()           │   │    │
│  │  │  - getTools() / setTools() / setResources()              │   │    │
│  │  └──────────────────────────────────────────────────────────┘   │    │
│  │                                                                  │    │
│  │  ┌────────────────────┐  ┌─────────────────────────────────┐   │    │
│  │  │  Session (JSONL)   │  │  HogAgentContext (index.ts)     │   │    │
│  │  │  - Persistent      │  │  - registerTool / unregisterTool│   │    │
│  │  │  - Auto-compaction │  │  - on() / emitEvent()           │   │    │
│  │  │  - Model changes   │  │  - getConfig() / getHarness()   │   │    │
│  │  └────────────────────┘  └─────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    AUDIT LAYER (optional)                        │    │
│  │  ┌───────────────────┐  ┌───────────────────┐  ┌─────────────┐  │    │
│  │  │audit-classifier   │  │long-task-         │  │skills-filter│  │    │
│  │  │(classify, quick   │  │orchestrator       │  │(mode-based  │  │    │
│  │  │ reply, scoring)   │  │(state machine)    │  │ filtering)  │  │    │
│  │  └───────────────────┘  └───────────────────┘  └─────────────┘  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                     EXTENSION LAYER                              │    │
│  │  ┌───────────────────┐  ┌───────────────────┐  ┌─────────────┐  │    │
│  │  │content-compressor │  │sub-agent          │  │delivery-    │  │    │
│  │  │(tool_result hook) │  │(independent       │  │manager      │  │    │
│  │  │                   │  │ AgentHarness)     │  │(auto-deliver)│  │    │
│  │  └───────────────────┘  └───────────────────┘  └─────────────┘  │    │
│  │  + artifact-manifest + memory + independent external-mcp       │    │
│  │  + External extensions (discovered)                             │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                       TOOL LAYER                                 │    │
│  │  ┌──────────────────────────────────────────────────────────┐   │    │
│  │  │ Pi Built-in: read │ write │ edit │ bash*│ grep │ find│ ls│   │    │
│  │  └──────────────────────────────────────────────────────────┘   │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                      │    │
│  │  │math_calc │  │web_search│  │web_fetch │                      │    │
│  │  └──────────┘  └──────────┘  └──────────┘                      │    │
│  │  ┌──────────────────────────────────────────────────────────┐   │    │
│  │  │ Extension: get_tool_details │ query_tool_result │         │   │    │
│  │  │ spawn_sub_agent │ deliver_files │ memory_save │          │   │    │
│  │  │ memory_search │ external MCP meta/direct tools             │   │    │
│  │  └──────────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                     LLM LAYER (vendored pi-ai)                   │    │
│  │  Claude Sonnet 4 │ GPT-4.1 │ Gemini 2.5 Pro │ DeepSeek │ etc.  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Component Overview

### Core Layer (Vendored Pi)

| Component | Location | Role |
|-----------|----------|------|
| `AgentHarness` | `src/vendor/agent/harness/agent-harness.ts` | Agent loop, tool execution, streaming, hook system |
| `Session` | `src/vendor/agent/harness/session/session.ts` | Message history, model changes, compaction |
| `JsonlSessionStorage` | `src/vendor/agent/harness/session/jsonl-storage.ts` | Persistent JSONL storage |
| `InMemorySessionStorage` | `src/vendor/agent/harness/session/memory-storage.ts` | In-memory (sub-agents) |
| `NodeExecutionEnv` | `src/vendor/agent/harness/env/nodejs.ts` | File system & process execution |

### HogAgent Layer

| Component | File | Role |
|-----------|------|------|
| `createHogAgent()` | `src/index.ts` | Factory: creates harness + extensions + RPC + audit model |
| `HogAgentContext` | `src/index.ts` | Bridge: extensions ↔ harness, unified audit entry |
| `RPC Layer` | `src/rpc.ts` | JSONL stdin/stdout protocol |
| `loadConfig()` | `src/config.ts` | Multi-level config loading (incl. audit model + skills_config) |
| `Audit Classifier` | `src/audit-classifier.ts` | Intent classification (Tool Calling routing with terminate), audit scoring (no quick reply — main Harness handles all modes) |
| `Long Task Orchestrator` | `src/long-task-orchestrator.ts` | Hybrid dispatch state machine (planning → grouping → execution+checkpoint → final audit) |
| `Skills Filter` | `src/skills-filter.ts` | Mode-based skill filtering (quick=none, standard=filtered, long_task=all) |
| `Web Server` | `src/web/server.ts` | HTTP + WebSocket UI |
| `Web JWT` | `src/web/auth.ts` | Persistent HS256 key, seven-day token issue/verification |
| `Bash Runtime` | `src/tools/bash-sandbox.ts` | Three-state macOS sandbox-exec / Linux Bubblewrap selection, RuntimeGrant consumption, platform shell discovery, strict failure, and configured/fallback direct-shell modes |
| `Runtime Grants` | `src/tools/runtime-grants.ts` | Shared Python/browser/system-tool read/write paths and redirected child environment for every sandbox backend |
| `Python Environment` | `src/tools/python-environment.ts` | Atomic shared venv creation and validation |

### Extension Layer

| Extension | Hook Mechanism | Purpose |
|-----------|---------------|---------|
| `content-compressor` | `harness.on("tool_result", ...)` | Opt-in, default off; compress large tool results — markdown TOC / JSON structural sample / text preview (skips retrieval tools, raw reads, chunked reads) |
| `sub-agent` | Creates independent `AgentHarness` | Isolated sub-task execution (shared session dir) |
| `artifact-manifest` | First ordered, awaited `beforeAgentEnd` artifact hook | Standalone hidden Session/Project reconciliation; long_task suppresses the nested final-summary `agent_end` and finalizes once after orchestration completion. Gateway-owned ordinary and formally bound project runs skip native reconciliation; ordinary Session role overrides and content-bound origin notes remain available to the Gateway writer |
| `delivery-manager` | Keeps `deliver_files` compatibility; standalone runs resolve `delivery_decision` against the reconciled Manifest | Real-file delivery with existing `delivery` events; Gateway-owned runs are finalized by Gateway |
| `memory` | Registers Gateway KB MCP-backed memory tools | Cross-session persistent memory |
| `external-mcp` | Registers top-level-only meta/direct tools over `AgentToolRegistry` only when an external service is enabled | Independent external MCP Tool/Resource/Prompt/Task access |

### Tool Layer

| Category | Tools | Source |
|----------|-------|--------|
| Pi Built-in | `read`, `write`, `edit`, `grep`, `find`, `ls`; conditional `bash` | `src/tools/builtin-tools.ts`, `bash-sandbox.ts` |
| Custom | `math_calc`, `web_search`, `web_fetch` | `src/tools/math-calc.ts`, `web-search.ts`, `web-fetch.ts` |
| Extension | `get_tool_details`, `query_tool_result`, `spawn_sub_agent`, `deliver_files`, `memory_save`, `memory_search`; external MCP meta/direct tools only when configured | Registered at runtime; artifact-manifest registers no user tool |

---

## Data Flow

### Prompt Processing Flow

Run outcomes are declared at lifecycle boundaries, not inferred from individual tool failures or error notifications. The Harness bridge derives `turn_end`/`agent_end.reason` from the final assistant outcome, preserves benign provider-tail-error normalization, and reports the turn limit as `max_turn_requests`. Prompt admission/execution exceptions and RPC conversation-handler exceptions emit `agent_end(reason=error, error=...)`; orchestration failure does likewise and cancellation uses `cancelled`. A delivery finalization exception is left to the owning prompt instead of emitting premature success. Internal/deferred orchestration events do not settle the outer run. See [RPC terminal contract](./orchestrator-integration.md#agent_end).

The outer Long Task error/interruption boundary emits `orchestration_completed` before its terminal `agent_end`, including errors before the orchestration wrapper and shutdown interruption. If a recovery checkpoint disappears after the availability check, recovery fails explicitly. Abort cleanup uses `Promise.allSettled` for Harness and extensions so an early rejection cannot release the runtime while the other branch is still unwinding. Regression coverage: `test/unit/prompt-terminal-boundary.test.ts`.

```
Orchestrator                    HogAgent
    │                               │
    │  {"type":"prompt","text":"…"}  │
    │──────────────────────────────▶ │
    │                               │ ┌─────────────────────────┐
    │                               │ │ RPC: parse + dispatch    │
    │                               │ └──────────┬──────────────┘
    │                               │            ▼
    │                               │ ┌─────────────────────────┐
    │                               │ │ Handler: onPrompt()      │
    │                               │ │  → harness.prompt(text)  │
    │                               │ └──────────┬──────────────┘
    │                               │            ▼
    │                               │ ┌─────────────────────────┐
    │                               │ │ AgentHarness internals   │
    │                               │ │ → LLM streaming call     │
    │                               │ │ → tool_result hook       │
    │                               │ │ → tool execution         │
    │                               │ │ → message assembly       │
    │                               │ └──────────┬──────────────┘
    │                               │            ▼
    │  {"type":"agent_start"}       │ Events emitted via
    │◀──────────────────────────────│ harness.subscribe()
    │  {"type":"tool_execution_*"}  │
    │◀──────────────────────────────│
    │  {"type":"message_*"}         │
    │◀──────────────────────────────│
    │  {"type":"agent_end"}         │
    │◀──────────────────────────────│
```

### Hook System

Pi's AgentHarness provides hooks for intercepting events:

```typescript
// tool_result hook — intercept/modify tool output before context insertion
harness.on("tool_result", (event: ToolResultEvent) => {
  // event: { toolCallId, toolName, input, content, details, isError }
  // Return ToolResultPatch to modify: { content?, details?, isError?, terminate? }
  // Return undefined to keep original
});

// subscribe — observe all harness events (read-only)
harness.subscribe((event: AgentHarnessEvent) => {
  // event.type: "agent_start" | "turn_start" | "message_start" | ...
});
```

---

## Session Management

- **Persistent storage:** JSONL files at `~/.hogagent/sessions/<user-namespace>/<session-id>.jsonl` (native history is independent of workspace/tasks)
- **Recovery boundary:** New storage is created only for absent or empty files. Missing-header repair is staged in a unique sibling file, validated with Pi's existing parser, and atomically renamed only after validation. Invalid existing entries fail recovery without replacing the original history.
- **Session task directory:** `<workspace>/tasks/<session-id>/` — output files and activity logs
  - `log.txt` — main agent activity log
  - `log-sub-<N>.txt` — sub-agent activity logs
  - `output-<N>.<ext>` — delivered files
  - `mode.json` — mode metadata (persisted after first classification, restored on session switch; unsupported values are ignored without rewriting the file)
  - `plan.json` — Long Task execution plan (steps generated during planning phase)
- **Auto-compaction:** HogAgent checks capacity immediately before each main-session prompt and delegates persistence to Pi
- **Model changes:** Tracked in session history
- **Quick thinking isolation:** New/resumed Harnesses inherit the underlying main thinking level, excluding the previous Quick override. Explicit main-thinking changes made during Quick update the value restored on mode exit.
- **Sub-agents:** Use `InMemorySessionStorage` (no persistence), share parent session task directory

---

## Configuration Priority

```
CLI args  >  --config file  >  llm-settings.json  >  Workspace config  >  User config (~/.hogagent, HOGAGENT_USER_DIR)  >  Environment variables  >  Defaults
```

The audit minimum passing score defaults to `70` and decides pass/fail via `score >= minPassScore` (the audit LLM's `passed` field is record-only). A value persisted in the `llm-settings.json` audit block takes precedence over `HOGAGENT_AUDIT_MIN_PASS_SCORE` and this default.

See [Configuration](./configuration.md) for the full reference.

---

## Unified Audit Entry Architecture

The conversation mode is determined by the RPC `mode` parameter (**hard routing**), not by the audit model:

```
User Message (with mode parameter) → Hard Routing
                  │
                  ├─→ quick    │ Main Harness (no tools, no skills) — direct conversation
                  │
                  ├─→ standard │ Main Harness (filtered skills and all enabled top-level tools, including configured external MCP) — single-step execution
                  │
                  └─→ long_task│ Audit model optimizes prompt (if configured)
                               → Main Harness (all skills) plans steps
                               → Orchestrator groups & dispatches → Main Harness executes each group
                               → Temp Audit Harness checkpoint scoring (declared-file read only, after each group)
                               → Temp Audit Harness final review (after all groups complete)
```

**Subsequent messages** are routed by the existing mode. In `long_task` mode, messages starting with `/audit` trigger the audit harness with the main Harness conversation history for intent recognition.

**Mode Persistence**: Mode metadata is persisted to `<sessionTaskDir>/mode.json`, enabling mode recovery after session switch or process restart. One runtime validator is shared by `prompt`, `resume_session`, and metadata reads. The supported routes remain exactly `quick`, `standard`, and `long_task`; invalid disk metadata is treated as absent and defaults to Standard at the next prompt. Restored Sessions lock their existing or history-derived title; legacy `optimizedPrompt`/`goals` fallbacks are copied into the existing first-value metadata fields only when the next normal metadata write already occurs. A genuinely new Session still records its first meaningful user message once.

**Qwen cache compatibility**: Quick disables only `compat.cacheControlFormat`. Returning to Standard/Long Task restores that one field from `explicitCache`; `thinkingFormat` and any other provider compatibility fields remain intact. Tool/Skill selection, thinking level and orchestration routing are not rebuilt by this cache toggle.

**Internal Mode**: During Long Task execution, `_internalMode` flag is set to redirect all intermediate `message_*` events to `thinking_*` events via `subscribeToHarnessEvents`. Only the final response and deliverables appear as normal message events.

**Long Task planning boundary**: Planning awaits the complete main-Harness response; an intermediate text block is not a planning completion signal. Only the already-active `read` tool is exposed for Skill discovery, so planning cannot invoke business commands, write files, or spawn sub-agents. The original active tools are restored in `finally`, including on abort, failure, or clarification suspension. Execution groups retain their normal tools.

**Intent-classification boundary**: The classifier receives visible user conversation context, but drops synthetic compaction/branch summaries and internal planning, group execution, retry, and format-repair prompts together with the assistant replies they own. The hidden `Task Execution Complete` control prompt is the exception: its visible final assistant reply remains context. The initial classification call and its single JSON-format repair share one 60-second deadline and one `AbortSignal`; user cancellation exits immediately, while timeout and ordinary provider failures retain the warning plus original-prompt/simple fallback. Key/quota failures retain the Standard-mode degradation path.

The parser joins text blocks without inserting characters, scans balanced arrays with JSON string escaping, and accepts only non-empty step arrays with unique non-empty string `id`, non-empty string `description`, and string-valued optional `group` / `skill` / `workflowStage`. Unrelated arrays are rejected. Legacy trailing commas remain tolerated outside quoted strings. Empty, malformed, schema-invalid, or output-limit-truncated replies receive at most one tool-free format-correction prompt through the existing context-capacity, abort and clarification boundaries. Failure after correction propagates to the common orchestration terminal handler, which emits an invalid-plan error and archives any remaining planning checkpoint for explicit continuation; no fallback execution plan is invented. Genuine provider errors bypass format correction and preserve the canonical `LLM call failed: ...` diagnostic, so Gateway's existing provider retry classifier remains authoritative; existing fatal key/quota and benign Gemini completion handling are retained.

**Final delivery selection**: The read-only final summary prompt lists declared outputs with their Manifest roles and explains the delivery filters. `deliverables` includes only changed `deliverable` entries; successful generation or audit does not promote `regular` entries. When requested conversation outputs include `regular` files or unchanged files from a previous attempt, the LLM must use the existing `selected_files` mode with exact Manifest-relative paths for all requested outputs and required companions, unless a locked policy prevents that choice. The default decision object is labeled as an example, not as the required decision. Runtime classification and delivery filtering remain unchanged.

**harnessRef + sessionRef Pattern**: The main Harness is wrapped in a mutable `{ current: AgentHarness }` reference, and the Session in a `{ current: Session }` reference. Both refs are created **before** `HogAgentContext`, and the context holds the ref (not a captured instance) — so `context.getHarness()` / tool registration always target the current Harness. On `new_session`/`resume_session`, both are replaced and `notifyHarnessReplaced()` invokes each loaded extension's `onHarnessReplaced` hook (e.g. content-compressor re-attaches its `tool_result` hook only while still enabled). The `currentMode` is tracked via a getter/setter object shared between `createHogAgent` and `createRpcHandlerContext`.

**Writable session replacement transaction**: `new_session` and non-fast-path `resume_session` use a local prepare/commit boundary. Preparation opens or repairs target storage, constructs the target `Session` and `AgentHarness`, creates its activity logger, and attaches event/LLM hooks while the old session tuple remains active. A preparation failure leaves the old logger, subscriptions, Harness, config, and runtime context untouched. Commit temporarily rejects immediate `abort`/`steer`/`follow_up`, retires the old Harness, then publishes runtime context, config, refs, tracking identity, and mode as one synchronous tuple before notifying extensions. This is an in-process state transaction, not a filesystem rollback protocol: preparation may create a new session file or repair target JSONL before commit.

**Fallback**: When the audit model is not configured or explicitly closed, `long_task` degrades to `standard`. An unusable audit key during intent classification also degrades the turn. Mid-orchestration audit unavailability instead returns `skipped: true, passed: false`; `score: 0` is a schema placeholder, not a verdict. Execution may continue without redo, but progress and final-summary prompts explicitly report unverified results, never a passing audit or a verified score.

**Main LLM fail-fast**: During orchestration, if the main LLM returns an unrecoverable key/quota error (invalid key, quota exhausted), the orchestration fails the conversation immediately (error event, orchestration state cleared) instead of looping continuation prompts and audit-driven retries against a dead key.

**Long Task recovery cursor**: The persisted `currentGroupIdx` is the next group to execute. It advances after both successful groups and groups skipped because execution raised a non-fatal exception. Recovery prioritizes this cursor and also derives the furthest completed-group position for compatibility with older state files.

**Clarification and audit continuity**: Multiple clarification answers accumulate across planning and group suspension, enter the persisted execution state, and accompany execution, checkpoint/final audits and the final summary. The latest answer supersedes conflicting earlier requirements; original classification goals are background, not a reason to reimpose obsolete acceptance criteria. Every checkpoint retry uses the latest feedback. Final-audit findings enter the first restarted group's prompt through the existing continuation directive rather than only a progress event. A format-corrected response replaces the original reply for auditing and downstream context, and an empty new note clears the superseded group note. These changes retain lenient scoring, bounded retries and skipped/unverified delivery.

**Long Task terminal handling**: Fresh runs, interrupted recovery and clarification continuations share `runOrchestrationTurn`. Normal return, including lenient completion after skipped or retry-exhausted audits, still finalizes available delivery. `completed` means orchestration and delivery finalization closed normally; it does not mean audit passed. If delivery finalization explicitly returns `false` or throws, the completed checkpoint is retained and this same boundary emits the existing `error` plus one `agent_end(reason: "error")`; no outer duplicate close is produced. The next recovery replays the saved final response and delivery decision and retries only delivery finalization, without planning, execution, or audit. An unhandled orchestration or final-summary error emits `error`, archives any remaining checkpoint and closes the interval without invoking delivery finalization. `orchestration_completed` remains an interval boundary, not an acceptance verdict. An explicit continuation after summary failure returns to final audit with the existing completed-group cursor. No new persistence phase or audit success gate is introduced.

**Long Task abort semantics**: If the main Harness returns `stopReason: "aborted"` during orchestration, HogAgent unwinds the orchestration via `OrchestrationAbortedError` (never a generic `error` event), clears persisted orchestration state, and emits the semantic `aborted` event. An `abort_completed` settle event is guaranteed at the end of abort handling (even if harness teardown fails) — orchestrators managing run/pool lifecycles should treat `abort_completed` as the terminal boundary for releasing state.

**Restart-safe progress**: Suspended planning answers and per-group notes are persisted together with the cursor, replies and file references. A new answer after process restart is appended before resumed planning or group execution; it also reaches audits and final completion. Parsed checkpoints are validated before use: status, classification, steps/groups, completed IDs, cursor, retry count, tracker containers, identity, and final fields must have safe shapes. Older checkpoints may omit the cursor (derived from completed group IDs), retry count (default `2`), or optional trackers (empty objects). Structurally dangerous JSON fails recovery instead of entering the execution loop. Checkpoint updates write a unique temporary file and rename it into place, retaining the previous complete checkpoint on ordinary write/publication failure. Persistence remains best effort and does not turn an otherwise recoverable task into failure. Cancellation is checked again after asynchronous resource preparation, before calling the model.

### Audit Model Characteristics

The audit model itself has **no mode concept**. Its behavior is entirely determined by the calling phase:

| Phase | System Prompt | Tools | Skills | LLM Call |
|-------|--------------|-------|--------|----------|
| Prompt Optimization (long_task only) | Inherited rules + classification scope | None | None | `streamSimple` (streaming) |
| Checkpoint Audit | Inherited rules + checkpoint audit scope | Declared-file `read` proxy + `submit_score` | All | Temp `AgentHarness` (multi-turn) |
| Final Audit | Inherited rules + final audit scope | Declared-file `read` proxy + `submit_score` | All | Temp `AgentHarness` (multi-turn) |

Prompt optimization produces no more than four high-confidence acceptance criteria, centered on critical deliverables, core correctness, explicit hard requirements, and blocking issues. Checkpoint audits are instructed to verify at most two decisive points, while final audits verify at most four. Non-blocking details may be reported as feedback but do not independently fail an audit or trigger group re-execution.

The optimization prompt preserves the latest request's exact file/path/schema constraints, required outputs and companions, validation errors, delivery requirements, and continuation limits. It uses first-person request language rather than an executor's completion report, separates historical evidence from pending actions, and distinguishes generated/audited files from registered deliveries. Complexity follows the remaining work: selecting existing outputs for delivery normally stays simple when no substantial content work remains. The optimizer leaves delivery-mode decisions to execution under the original runtime policy and does not prescribe renaming files or editing internal metadata. Explanatory prose follows the input language while literal contracts and errors retain their original form.

All first-pass and retry audits use the same lenient policy. Recovered tool errors, non-critical plan deviations and missing non-required files do not independently fail a run. Only evidenced unmet core goals, explicit hard requirements or blocking defects justify a failing score. An unavailable audit remains skipped/unverified and does not turn available results into a business failure. Planning and classification must not infer a file requirement from task complexity.

`instruction-snapshot.ts` provides the same SYSTEM, root AGENTS, Hog supplement and frozen process instructions to classification, main Harness, child agents, audits and stateless calls. `instruction-scope.ts` uses invocation-local async context for reused Harness phases; child agents explicitly select their own scope. Planning and internal groups never emit conversation delivery envelopes; final completion restores the main scope with no tools. Tool-dependent memory, self-evolution and Skill CLI guidance is omitted when those tools are unavailable.

Final audit and final summary receive a bounded per-group evidence summary, including groups that did not complete. A non-fatal group failure is recorded as a fact, not an automatic failure veto; the auditor decides its impact on the objective. Retries preserve only actually completed groups. Audit file checks use the normalized declaration exactly, with no same-name fallback into other directories; access errors are unverified rather than proof of absence. A new prompt that resumes clarification refreshes tools, credentials, Runtime Context and delivery policy at that execution boundary, and rejects a different workspace/session/project binding.

**Audit run guardrails:**
- **Threshold decision** — pass/fail is decided in code by `score >= minPassScore` inside `submit_score`; the audit LLM's `passed` field is record-only and never overrides the decision. When the score is below the threshold, the audit LLM must provide `retryFrom`. Checkpoint and final audits share this rule.
- **Final audit scoring rubric (100 points)** — primary deliverable existence (10, conditional: 0 only when the task explicitly requires `final-output-*` and the system scan reports NOT FOUND; otherwise 10), goal fulfillment (40), deliverable correctness & completeness (30), explicit hard requirements (20). `final-output-*` existence is a neutral fact report from the code scan, no longer a hard fail gate.
- **Code-level hard veto list** — `HARD_VETO_RULES` can force `passed = false` / `score = 0` regardless of the score; the list is currently empty.
- **Exact-file verification** — the Harness exposes only `submit_score` and a wrapper around the existing `read` tool. Each declared path is normalized against `workspaceDir`, resolved to its real regular file, and required to remain inside the current Session or Project artifact root; reads are forwarded with the canonical path only for that declaration's derived relative/absolute forms. Undeclared sibling or absolute escape paths, directories and symlink aliases return an unverified tool error, and symlink declarations are never annotated as existing evidence. Offset, limit and section paging remain available for an allowed file; search, listing and every mutating tool are absent.
- **Timeout: 3 minutes** per audit run. On timeout the harness is aborted and verification is marked skipped. Time waiting for user checkpoint confirmation is excluded. Timeout, turn-cap and audit-model-unavailable results carry `skipped: true` and a reason; they do not trigger content redo or claim verification.
- **Turn cap: 100** agent turns per audit run (safety cap alongside the timeout).
- **Early abort** — once `submit_score` resolves, the audit harness is aborted immediately so it cannot keep burning tokens.
- **User abort** — the running audit harness is registered in a module-level registry; an RPC `abort` aborts it directly (the main-harness abort cannot reach it). The audit promise then rejects with `OrchestrationAbortedError` so the orchestration unwinds immediately instead of waiting out the timeout.
- **Audit model failure → skip** — a model error response or a thrown key/quota error resolves immediately as skipped, with a warning. Other thrown execution errors retain failure behavior. A skipped final audit preserves the available results and requires the final reply to state the verification limitation.

---

## Skill Discovery

```
1. Load <project_root>/skills/*   → Project Skills (bundled with HogAgent)
2. Load <workspace>/.hogagent/skills/*      → Workspace Skills (override project by name)
```

Skills provide contextual knowledge (SKILL.md) that gets injected into the LLM system prompt.

### Skill Filtering by Mode

Skills are filtered based on the conversation mode specified by the RPC `mode` parameter:

| Mode | Skills Available | Rule |
|------|-----------------|------|
| `quick` | None | Empty array — no skills loaded |
| `standard` | Filtered | Excludes skills marked `isLongTaskSpecific: true` in `~/.hogagent/skills_config.json` |
| `long_task` | All | Full skill set including long-task-specific skills |

---

## System Prompt Construction

`buildSystemPrompt` (`src/system-prompt.ts`) assembles the prompt from segments
ordered **most-stable first** to maximize LLM prompt-cache hit rates across
providers:

| # | Segment | Stability |
|---|---------|-----------|
| 1 | `SYSTEM.md` | project-level, rarely changes |
| 2 | Complete `AGENTS.md`, then optional `.hogagent/hogagent.md` | fixed for the top-level execution and its children |
| 3 | `self_evolution` | hardcoded, never changes |
| 4 | `available_skills` | stable within same mode |
| 5 | `data_access_strategies` | semi-stable, depends on tool set |
| 6 | `memory_guidance` | semi-stable, present when the Memory Extension is active or the `hog-memory` skill is available |
| 7 | `theme` | stable per user |
| 8 | `conversation_mode` | may change during session |
| 9 | context info (date + paths) | most volatile |

`SYSTEM.md` is required and must be readable and nonempty. Under
`HOGAGENT_GATEWAY_MANAGED=1`, the workspace `AGENTS.md` is also required;
missing, unreadable or empty rules fail explicitly rather than falling back to
installation rules. Quick loads necessary rules without claiming unavailable tools.
The HogAgent supplemental file is appended, never substituted; missing is allowed,
but a read failure is fatal. Standalone use additionally loads STANDALONE.md and
still permits an absent AGENTS file. Updates apply at the next top-level execution;
sub-agents, compaction and long-task Harness reconstruction inherit its snapshot.

`SYSTEM.md` describes capability-conditional behavior rather than assuming every
extension is active. Durable memory requires an enabled memory capability plus
user or workspace authorization, and sub-agent delegation is optional: the main
agent remains responsible for completing and accepting the result. Ambiguous
input is handled through bounded assumptions and runtime interaction policy; the
base prompt does not independently require a clarification turn. Its financial
services policy focuses specific-stock analysis on logic and reasoning without
aiming to recommend stocks or buy/sell points. Quantitative strategies must
include code or an explanation of the approach, keep parameters transparent and
adjustable to users, never operate as a black box, and be used only for simulation
testing for research purposes.

SYSTEM retains minimal native requirements. Gateway default/AGENTS.md owns common
business, delivery and sub-agent rules for all Agents. Runtime templates own each
Agent's differences; HogAgent appends runtime/hogagent.md via .hogagent/hogagent.md.
These are product templates, distinct from this repository's contributor instructions.
DIY details arrive only through the supporting Adapter; native projectDir alone
does not activate a managed project. All scopes exempt internal structured runs (including Work soft
orchestration) from `delivery_decision`, honor exact requested filenames over
default prefixes, and require `selected_files` for requested regular or unchanged
outputs, including their companions. Audit success never changes Manifest roles.
Focused verification is allowed after edits; token discipline forbids redundant
full reads, not correctness checks. The related Gateway prompt-layering design is maintained in the Gateway project.

`memory_guidance` detects its two capability sources with explicit priority. The Memory
Extension is considered active only when both `memory_save` and `memory_search`
are registered (which requires the extension to be enabled and its Gateway MCP
URL configured). The `hog-memory` source is detected by exact skill name. When
both exist, only `memory_extension` is emitted and `hog-memory` is also removed
from the model-visible `available_skills` catalog. The `hog_memory_skill`
fallback is emitted only when the extension is unavailable. Its model-visible
skill path is derived from the active workspace as
`<workspaceDir>/.hogagent/skills/hog-memory/SKILL.md`; the prompt refers to the skill's
`save` and `search` operations without embedding CLI implementation details.

Tool name/description/parameters are **not** duplicated in the system prompt — they
are sent to the provider as native tool definitions. Sub-agents share the same
`buildSystemPrompt`; the assigned task is delivered as a user message via
`prompt()`, not embedded in the system prefix, keeping the prefix stable across
spawns.

---

## Design Principles

1. **Source Internalization** — Pi source code is vendored into `src/vendor/`, zero external AI framework dependencies.
2. **Focused Extensions** — Six bundled extensions cover opt-in compression, sub-agents, real-file delivery, the internal Artifact Manifest protocol, memory, and independent external MCP access. Complexity remains isolated behind extension boundaries.
3. **Pi-Native First** — Leverage Pi's hook system, Session persistence, and Compaction instead of reimplementing.
4. **Orchestrator-Driven** — HogAgent is a passive subprocess. The orchestrator decides what to prompt and configure.
5. **Convention over Configuration** — Skills = directory with `SKILL.md`. Extensions = `IExtension` from `index.js`.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@sinclair/typebox` | JSON Schema definitions for tool parameters |
| `@modelcontextprotocol/client` | Official external MCP Client SDK and transports |
| `ws` | WebSocket (Web UI) |
| `vitest` | Testing framework (dev) |

> Note: `pi-agent-core` and `pi-ai` are **vendored** (source in `src/vendor/`), not npm dependencies.

---

## Context Compaction

HogAgent provides automatic context compaction to prevent context window overflow during long conversations.

Before every provider request made by the main session Harness, HogAgent estimates the current conversation context size and applies a stateless send delay: more than 20,000 tokens waits 0.5 seconds, more than 30,000 waits 1 second, more than 40,000 waits 1.5 seconds, and more than 50,000 waits 2 seconds. The delay only changes request timing; it does not read or modify task, orchestration, or session status. Audit-model and sub-agent requests are unaffected.

### Auto-Compaction

Before every main-model `prompt()` call, HogAgent measures the current context token usage. Provider usage is trusted only when it was produced after the latest compaction boundary; otherwise HogAgent sums the current messages with the usage-independent token estimator. If usage reaches the configured threshold (default: 75%), the shared compaction manager summarizes older history before the prompt begins.

Consumption accounting is independent of context occupancy: session-switch usage history reads every persisted assistant message entry, including entries before compaction and on abandoned branches. Visible messages and future model input continue to use the active compacted context. Session restoration itself emits no consumption increment.

- **Trigger point**: Immediately before every main-Harness `prompt()` call; there is no turn-end or background compaction
- **Threshold**: Configurable via `compaction.autoCompactThreshold` in `llm-settings.json`; it must satisfy `0 < threshold < 1` (default: `0.75`)
- **Mechanism**: A non-vendor manager supplies a bounded summary through `session_before_compact`; Pi AgentHarness still owns preparation, persistence, `session_compact`, and phase cleanup
- **Execution lock**: while compaction runs, FIFO commands continue to be accepted and wait; only bypass commands (`abort`, `steer`, `follow_up`) are rejected
- **Deadline**: the remote summary request has a fixed five-minute deadline. Timeout or provider failure fails the owning prompt/Long Task and marks the Gateway adapter unusable
- **Commit boundary**: Local Session reads/writes are not forcibly interrupted. Once provider output has entered Session commit, it completes normally and emits `compact_completed`
- **reserveTokens**: Uses Pi's default value of 16384 (summary max tokens = `floor(0.8 × 16384) = 13107`)
- **Failure boundary**: Provider failure or the five-minute deadline fails the owning prompt/Long Task with `agent_end(reason=context_compaction_failed)`; Gateway treats that adapter as errored
- **No compression abort path**: user abort and other session mutations are rejected while compaction owns the session. Process shutdown follows the normal process teardown boundary rather than producing another compaction terminal reason.

### Manual Compaction

Manual `compact` uses the same manager and five-minute deadline. It starts only with an idle FIFO, a writable Session, and no pending/incomplete Long Task. A duplicate request received while compaction is already running is ignored idempotently so the original operation remains the sole owner of the terminal event; other busy or custom-instruction requests receive `compact_failed` without changing the conversation lifecycle.

### Compaction Events

| Event | Description |
|-------|-------------|
| `compact_started` | Session-scoped operation started |
| `compact_completed` | Success terminal (`status: skipped` only when there was nothing to compact) |
| `compact_failed` | Failure terminal (`reason: error`) |
| `session_compact` | Legacy persistence observation only (`from_hook`); clients must not use it as lifecycle state |

Compaction never emits `agent_end`; success continues the owning prompt, while failure is closed by that prompt with `error + agent_end(reason=context_compaction_failed)`.

---

## Operating Modes

| Mode | Launch Command | Description |
|------|---------------|-------------|
| **RPC Subprocess Mode** | `hogagent --mode rpc` | Programmatic integration, driven by external orchestrator via stdin/stdout JSONL |
| **Interactive CLI Mode** | `hogagent --mode interactive` | Direct terminal conversation for development and debugging |
| **Web UI Mode** | `hogagent-web --port 9108` | Browser-based interface with chat, session management, and settings |

`bash*` uses `hogagent.json.sandboxMode` on macOS/Linux before preparing its runtime. `enabled` requires an OS-level file sandbox and validated `~/.hogagent/python-venv`; `fallback` attempts the same runtime and converts any initialization failure into a logged bare shell; the default `disabled` mode selects that direct shell immediately. Windows has no supported sandbox and bypasses the mode branch entirely: every configured value selects a platform-marked `UNSANDBOXED` runtime that discovers system Windows PowerShell and verified Git for Windows Bash in preference order; `cmd.exe` is deliberately unsupported. Skill processes remain on the Agent's native shell/tool path and execute with that Agent's current workspace, user permissions, and sandbox. Safe flat scalar values are sent as named arguments. Complex values are written as UTF-8 JSON to unique Agent-owned `tmp-*.json` files and supplied only through the Skill CLI's documented file-input option; nested inline JSON and mixed payload sources are rejected. Gateway never receives an executable path and exposes no process-execution capability. A single composable RuntimeGrant supplies sandboxed macOS/Linux processes and every bare-shell mode with the same Python, browser, inherited tool-prefix, system dependency, writable-state, and child-environment policy, including removal of HogAgent-owned secret variables from child processes; only the sandbox backends enforce its file boundary. Web UI mode issues a fresh seven-day JWT in each HTML response and verifies every API and WebSocket request before session creation.

---

## Directory Structure

```
hogagent/
├── bin/
│   ├── hogagent.ts              # CLI entry point
│   └── hogagent-web.ts          # Web UI entry point
├── src/
│   ├── index.ts                 # Main entry: createHogAgent() + unified audit entry
│   ├── rpc.ts                   # JSONL RPC protocol
│   ├── config.ts                # Config loading & discovery + audit model config
│   ├── audit-classifier.ts      # Audit model direct call: prompt optimization, audit scoring
│   ├── long-task-orchestrator.ts # Long Task hybrid dispatch state machine
│   ├── skills-filter.ts         # Skill filtering by mode
│   ├── model-updater.ts         # Per-provider model list fetcher
│   ├── model-utils.ts           # Model utility helpers
│   ├── harness-events.ts        # Harness event wiring
│   ├── llm-chat.ts              # Direct LLM call (no tools/skills, streaming)
│   ├── session-storage.ts       # Session file persistence
│   ├── user-workspace.ts        # Per-user workspace directory management
│   ├── handlers/                # RPC handler groups
│   │   ├── index.ts             # Handler context factory
│   │   ├── types.ts             # Handler deps & mutable state types
│   │   ├── prompt-handlers.ts   # prompt / steer / follow_up / abort
│   │   ├── session-handlers.ts  # new_session / list_sessions / switch_session / resume_session
│   │   ├── model-handlers.ts    # set_model / set_thinking_level / set_llm_provider / refresh_models / save_settings
│   │   ├── skill-handlers.ts    # install_skill / configure_skill / reload_config / llm_chat / reset_search_cache
│   │   └── mcp-handlers.ts      # HogAgent-owned external MCP settings/probe RPC
│   ├── vendor/                  # Pi internalized source (do not modify)
│   │   ├── agent/               # pi-agent-core
│   │   │   └── harness/         # AgentHarness + Session + Env
│   │   └── ai/                  # pi-ai (LLM layer)
│   ├── extensions/
│   │   ├── index.ts             # Extension loader
│   │   ├── content-compressor/  # Content compression extension
│   │   ├── sub-agent/           # Sub-agent extension
│   │   ├── delivery-manager/    # File delivery extension
│   │   ├── artifact-manifest/   # Internal artifact protocol extension
│   │   ├── memory/              # Memory extension (Gateway MCP)
│   │   └── external-mcp/        # Independent external MCP extension
│   ├── mcp/                     # Config, SDK lifecycle, catalog, Tasks and operation store
│   ├── tool-registry.ts         # Tool ownership and top-level/Sub-Agent visibility
│   ├── artifacts/               # Manifest reconciliation and mutation guard
│   ├── protocol/                # Structured agent-result schemas/parsers
│   ├── tools/
│   │   ├── builtin-tools.ts     # 6 file tools + conditional Bash registration
│   │   ├── bash-sandbox.ts      # macOS/Linux OS sandbox backend
│   │   ├── runtime-grants.ts    # Shared Python/browser/system runtime capabilities
│   │   ├── python-environment.ts# Shared Python venv initialization/validation
│   │   ├── math-calc.ts         # Math calculation tool (expr-eval)
│   │   ├── web-search.ts        # Web search tool (multi-provider)
│   │   └── web-fetch.ts         # Web fetch tool (readability+markdown)
│   ├── web/                     # JWT-authenticated Web UI (auth.ts + server.ts + public assets)
│   ├── skills/                  # Built-in Skills
│   └── utils/                   # Utility functions (logger/types/activity-logger/token-estimation/path-safety/git-binary)
├── test/                        # Tests (24 test files)
├── examples/                    # Example code
├── docs/                        # Detailed documentation
├── SYSTEM.md                    # System prompt
├── package.json
└── tsconfig.json
```

---

## Cross-References

- [Extension APIs](./extensions.md)
- [RPC Protocol](./orchestrator-integration.md)
- [Skill System](./skills.md)
- [Tool System](./tools.md)
- [Deployment](./deployment.md)
- [Configuration](./configuration.md)
- [Development](./development.md)

---

## Runtime Context Injection

HogAgent exposes one native, hidden runtime-context channel for orchestrators. It extends the existing process, session, and `prompt` boundaries without adding a Gateway dependency, a new RPC command, or a synthetic conversation message.

### Three scopes

| Scope | Lifetime | Consumer supplies it | HogAgent adds |
|-------|----------|----------------------|---------------|
| Process runtime context | One OS process | At startup through `--runtime-context-file` or `CliArgs.processRuntimeContext` | `process_instance_id`, workspace, mode, user, platform, architecture |
| Session runtime context | One `session_id` inside the process | On `new_session`, `resume_session`, or `prompt` as `session_context` | `session_id`, workspace, session task directory, in-memory revision |
| Current run context | One RPC `prompt` command | On every top-level `prompt` as `run_context` | Unique internal `prompt_run_id` |

The session registry is memory-only. It allows several Gateway sessions to share one HogAgent process through **sequential multiplexing** without context crossover, but it is not a persistence or parallel-execution mechanism. The process owns one active Harness and at most one Prompt Run; ordinary commands remain FIFO-serialized. Immediate `abort`, `steer`, and `follow_up` commands that include a different `session_id` are rejected before they can affect the active Harness, and all three are rejected during the short session commit phase. Multiplexing consumers must include `session_id` on those controls; omission remains supported only for legacy single-session clients.

The registry retains at most 256 session contexts. Binding or rebinding a session updates its recency. Adding the 257th entry evicts the least-recently-bound inactive entry; the session that owns an active Prompt Run is protected. Eviction deletes runtime metadata only—it never deletes JSONL, task files, or conversation history. A consumer must re-send the complete `session_context` after process restart or whenever an evicted session is activated again. Legacy project fields in `prompt.metadata` can rebuild their supported projection, but should not be treated as durable storage.

### Capacity governance

Limits apply to the complete consumer-supplied JSON object for each scope, including `schema_version`, identity/policy fields, and `attributes`:

| Scope | Maximum compact UTF-8 JSON size | Maximum JSON depth |
|-------|--------------------------------|--------------------|
| Process input | 32 KiB | 16 |
| Session input | 512 KiB | 16 |
| Current-run input | 64 KiB | 16 |

The root object has depth 1; every nested object or array adds one. Programmatic values must also be plain JSON data: cycles, accessors, class instances, non-finite numbers, symbols, and unsupported properties are rejected. The process file itself is capped at 32 KiB before parsing. Process violations fail startup; session/current-run violations produce an RPC error before any LLM request. The advertised `ready.capabilities.runtime_context.limits` values are the protocol source of truth.

`attributes` is the single extension point at every scope. Values must be plain JSON data and are model-visible by design. They are therefore for trusted structured control data, not secrets or untrusted natural-language instructions. Unknown fields in legacy `metadata` are not promoted into `attributes`.

### Prompt Run terminology

A **HogAgent Prompt Run** is the complete processing lifetime of one RPC command whose `type` is `prompt`. It is not synonymous with an LLM turn, a provider request, or a business task.

One Prompt Run may include:

- multiple `AgentHarness.prompt()` executions;
- multiple Harness turns and provider requests;
- tool calls and sub-agent executions;
- `steer` and `follow_up` messages accepted while that run is active;
- Long Task classification, planning, execution groups, retries, checkpoint/final audit, and final delivery.

`CurrentRunContext` begins in the outer `onPrompt()` after session activation and input validation. It is cleared only in that same invocation's `finally` block. An internal `agent_end` event does not clear it. `abort` requests termination, but the original `onPrompt()` remains the lifecycle owner and clears the context after the Harness unwinds.

A clarification answer, continuation dispatch, or external retry sent as a new RPC `prompt` is a new Prompt Run and receives a new `prompt_run_id`. It may keep the same business `task_id`, `work_id`, or external `run_id`. Internal Long Task checkpoint retries remain inside their existing Prompt Run.

### Long Task closure

Long Task does not create a second context lifecycle. Every internal main-Harness prompt inherits the outer Prompt Run context because the system prompt callback reads the active snapshot before each Harness turn.

For an interrupted task, the order is:

1. activate or rebuild the session context;
2. create the new Current Run context for the incoming RPC `prompt`;
3. read and restore the Long Task checkpoint;
4. run the resumed groups, audit, and delivery;
5. clear Current Run context in the outer `finally` block.

Runtime context is not written to session JSONL, `mode.json`, `orchestration-state.json`, archived checkpoints, or compaction summaries. Restart recovery therefore requires the consumer to bind session/run values before HogAgent restores the checkpoint.

The main agent and a spawned sub-agent see model-visible runtime context. A sub-agent receives a deep read-only snapshot taken at spawn, so a later session switch cannot relabel it. The isolated audit model keeps its existing structured parameters and audit system prompts; arbitrary runtime `attributes` are not injected into audit prompts.

### Injection path

The main Harness already supports a dynamic system-prompt callback. HogAgent appends a volatile `<runtime_context>` JSON segment to that native system prompt. This segment:

- is not a user message or an `internal` role message;
- never appears in Gateway/UI conversation history;
- is not replayed or filtered by text matching;
- stays outside JSONL history and compaction input;
- escapes `<`, `>`, and `&` inside JSON strings so an attribute cannot close the segment.

Extensions can read a deep-frozen snapshot through `HogAgentContext.getRuntimeContext()`. They must treat it as request context, not durable configuration.

### Identity fields

| Field | Meaning | May span several Prompt Runs | Artifact business ID |
|-------|---------|------------------------------|----------------------|
| `task_id` | Business task identity | Yes | Yes, where existing artifact logic uses it |
| `work_id` | Parent work/workflow identity | Yes | Tracking only |
| `run_id` | Consumer-provided correlation identity | Yes | Only if the consumer's contract says so |
| `prompt_run_id` | HogAgent-generated cleanup token for one RPC `prompt` | No | No |

The internal `prompt_run_id` prevents stale cleanup from clearing a newer run. It is present in extension snapshots but deliberately omitted from the model-visible `<runtime_context>` segment, so the model cannot mistake it for an artifact or business run ID. Artifact discovery uses the supplied `run_id`, or the outer Prompt cleanup token when standalone; `task_id` remains the stable business Task and does not delimit current-run changes.

### Compatibility boundary

Native `session_context` and `run_context` take precedence as the public integration contract. Existing clients may continue to use these `prompt.metadata` fields:

- session projection: `project_id`, `project_dir`;
- current-run projection: `work_id`, `task_id`, `manifest_owner`, `artifact_run_policy`.

If the same field is supplied through both transports, equal values are accepted and conflicting values fail before any LLM call. Native standalone root checks, Manifest ownership, artifact-policy defaults, tracking metadata, modes, and delivery behavior remain unchanged. Gateway-owned runs accept only formally bound paths under the process-owned authenticated projects directory; legacy workspace-project inference remains unavailable.

`session_context` is a complete replacement when supplied natively. The native standalone `metadata.project_id` and `metadata.project_dir` projection remains a field-level declarative update: omitting one preserves its existing session value. Runtime context is not path authority. Standalone selects its actual root from startup configuration or the current request, not this stored metadata. The Gateway public API rejects legacy project aliases; Gateway-managed execution accepts explicit/rebound project contexts only under the process-owned authenticated projects directory. Business CWD remains workspace; Gateway owns Manifest and the artifacts/ layout. A complete empty project context restores ordinary Gateway execution without changing Session JSONL or task files.

See [RPC Protocol](./orchestrator-integration.md) for request schemas and examples.

### History-free internal LLM calls

`llm_chat` is a separate tool-less execution boundary for orchestrator-owned classification, extraction, and similar internal work. It creates a temporary `InMemorySessionStorage` Harness and never reads, activates, or writes the main Agent Session. An optional `session_id` is event correlation/accounting only, while optional `run_context` is validated and rendered only for the temporary Harness; Session Runtime Context is deliberately unavailable on this path.

The handler emits explicit `internal=true` metadata on every streamed and terminal event. Trusted consumers may additionally request `persist_usage=true` for the supplied accounting owner, but must not expose those events as conversation history or use their session ID to update the process's active Session pointer. Commands remain FIFO-serialized with main prompts, and success or failure always terminates with `agent_end`. An optional `timeout_ms` best-effort aborts only the temporary Harness and reports `error + agent_end`; it never aborts the main Harness or kills the shared process. This isolated call is not a HogAgent Prompt Run and does not change the three-scope lifecycle of the main Harness.

Input/context validation failures use that same isolated event scope and emit `error + agent_end`. A provider response with `stopReason: error` is also a failure even when `Harness.prompt()` resolves instead of throwing.

Gateway-owned artifact runs skip native Manifest reconciliation. Ordinary Sessions retain explicit role annotations, and saved native/Skill data retains content-bound origin notes. Gateway classifies Development files by project paths/revisions and rejects ineffective native role overrides before writing. The Gateway launch passes HOGAGENT_GATEWAY_PROJECTS_DIR, while HOGAGENT_PROJECT_ROOT continues to identify the installation. A ready/state supports_gateway_projects acknowledgement prevents an older runtime from being mistaken for the new implementation.

The handler's OrchestrationContext aliases LongTaskDeps instead of duplicating it. The captured manifestOwner accompanies projectDir and artifactRunPolicy through long-task execution, resume, audit and final-summary file classification, so an old native overrides registry cannot change a Gateway project's declared roles.

Artifact delivery now uses the local FileDelivery module behind the retained extension. Admission baselines, persistent receipts, completion recovery and download semantics are specified in [Artifact Manifest](artifact-manifest.md).
