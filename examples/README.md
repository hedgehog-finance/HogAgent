# HogAgent RPC examples

[English](README.md) · [简体中文](README-CN.md) · [HogAgent](../README.md)

These TypeScript examples demonstrate HogAgent's stdin/stdout JSONL interface for conversations, tool execution, file delivery and session management.

- **Website:** [ciweiai.com/hogagent.html](https://ciweiai.com/hogagent.html)
- **Financial data sources and tools:** [Hedgehog Skills](https://github.com/hedgehog-finance/hedgehog-skills/)

## Requirements

Use Node.js **>= 22.19.0**, install the dependencies in the repository root, and configure a model through the Web UI or `~/.hogagent/llm-settings.json`. Configure search and financial Skills separately when an example needs them. Node.js runs these TypeScript examples directly; no additional runner is required. Run the commands from the repository root.

```bash
git clone https://github.com/hedgehog-finance/HogAgent.git
cd HogAgent
npm install
npm run build
node examples/basic-chat.ts
node examples/basic-chat.ts --message "Hello" --debug
```

## Examples

| File | Purpose |
|---|---|
| [rpc-client.ts](rpc-client.ts) | Reusable client, subprocess lifecycle and event subscriptions |
| [basic-chat.ts](basic-chat.ts) | Streaming, multi-turn conversations |
| [mode-switching.ts](mode-switching.ts) | Model thinking levels |
| [tool-usage.ts](tool-usage.ts) | Tool invocation and execution events |
| [delivery-example.ts](delivery-example.ts) | File generation, delivery and delivery events |
| [workflow-example.ts](workflow-example.ts) | Steering, follow-up, state and session creation |
| [full-session.ts](full-session.ts) | Complete session lifecycle |

Run an example with `node examples/<filename>.ts`. The client selects the available HogAgent entry point and provides `start`, `sendCommand`, `prompt`, `followUp`, `steer`, `abort`, `getState`, `newSession`, model configuration and event subscriptions. `sendCommand` exposes the full RPC protocol.

## Protocol essentials

```json
{"type":"prompt","text":"Hello","mode":"standard"}
{"type":"follow_up","text":"Explain the assumptions."}
{"type":"steer","text":"Focus on the evidence."}
{"type":"get_state"}
{"type":"set_thinking_level","level":"medium"}
{"type":"new_session"}
{"type":"abort"}
```

A subprocess emits `ready` with its actual capabilities. Listen for streamed `message_*` events, `tool_execution_*` events, delivery events and terminal `agent_end` or `aborted` events. An `error` notification alone does not necessarily end the run; inspect terminal status and reason. Context compaction runs automatically.

For Long Task, track `orchestration_resuming` and `orchestration_completed`. An inner `agent_end` during planning or execution does not end the whole task; wait for the orchestration boundary and its terminal event before closing the process.

`prompt.mode` selects `quick`, `standard` or `long_task`. Quick has no tools; Standard uses available tools; Long Task supports planning, execution and audit. Pass `work_id` and `task_id` through `run_context` for task ownership. Audit availability and task completion are separate states.

Tool inventory depends on configuration. Use `ready.capabilities.builtin_tools` instead of a fixed tool count. Content compression is off by default; its retrieval tools are available only when enabled. Required Skill instructions must be read completely, following continuation offsets when necessary.

See the [RPC reference](../docs/orchestrator-integration.md) for command schemas, timeouts, cancellation and runtime context, and the [configuration guide](../docs/configuration.md) for users, workspaces and shared credentials.

For Quick/Standard, subscribe with `waitForResponse()` before sending the command. It waits for the complete `agent_end` turn, rather than a user, tool or individual assistant `message_end`. `npm run test:readme` verifies all runnable examples and all three launch modes with temporary settings and a local model fixture; it needs no real API key.

Use `steer` and `follow_up` only during an active turn. Once the previous turn has ended, send a new `prompt` to continue the conversation.
