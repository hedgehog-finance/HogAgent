# HogAgent

[English](README.md) · [简体中文](README-CN.md) · [日本語](README-JA.md)

HogAgent is a general-purpose AI agent engine optimized for financial research. It combines model reasoning, tools and Skills to complete research, analysis and file-based tasks, with a browser interface and a JSONL RPC interface for application integration.

- **Website:** [ciweiai.com/hogagent.html](https://ciweiai.com/hogagent.html)
- **Financial data sources and tools:** [Hedgehog Skills](https://github.com/hedgehog-finance/hedgehog-skills/)
- **Version:** `1.2.4` · **License:** [GPL-3.0](LICENSE)

## Capabilities

- **Task execution:** Quick, Standard and Long Task modes; Long Task supports planning, checkpoints, audit and resumption. Audit availability and results are reported separately from task completion.
- **Tools and Skills:** File operations, shell execution, calculations, web search and page retrieval. Eight built-in Skills cover skill creation, financial calculations, charts, presentations, document conversion, spreadsheets, technical indicators and valuation.
- **Extensions:** Optional content compression, sub-agents, artifact tracking, file delivery, persistent memory and external MCP services. Content compression is off by default.
- **Models:** Multiple model providers and custom OpenAI-compatible endpoints, with separate main-model and audit-model settings.
- **Web UI:** Streaming conversations, session history, user/workspace selection, model settings, Skills, tools, themes and file previews.
- **Integration:** stdin/stdout JSONL commands and events, session persistence, automatic context compaction and process/session/run context. Gateway supplies authenticated project bindings and owns its project metadata.

The Pi Agent Harness is included in `src/vendor/`. HogAgent runs independently or as a subprocess of HedgehogGateway, an IDE plugin or another application.

## Install and run

Requires **Node.js >= 22.19.0** on macOS, Linux or Windows. Shell-based Python workflows require a usable Python interpreter with `venv`.

```bash
git clone https://github.com/hedgehog-finance/HogAgent.git
cd HogAgent
npm install
npm run build

# Browser interface: http://localhost:9108
node dist/bin/hogagent-web.js --port 9108 --workspace /absolute/path/to/workspace

# Terminal conversation
node dist/bin/hogagent.js --mode interactive --user default --workspace /absolute/path/to/workspace

# Application integration
node dist/bin/hogagent.js --mode rpc --user default --session example --workspace /absolute/path/to/workspace
```

Run the launch commands separately from the repository root. Replace `/absolute/path/to/workspace` with your own absolute directory (quote paths containing spaces). Configure a valid API key before sending prompts; Web UI startup does not require one. Stop the Web UI with Ctrl+C and leave terminal chat with `/exit`. For an existing monorepo checkout, start in `hogagent/` and skip cloning.

Configure an LLM provider in the Web UI or `~/.hogagent/llm-settings.json`:

```json
{
  "provider": "hedgehog",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.ciweiai.com/api/llm/v1",
  "modelId": "qwen3.8-flash"
}
```

Use the model available from your provider. Search settings live in `~/.hogagent/search_settings.json`; financial data credentials live in the corresponding Skill's `api-key` entry in `~/.hogagent/skills_config.json`. Standalone and Gateway-managed HogAgent share this configuration directory.

## Workspace and runtime

`--workspace` selects the user's workspace; user mappings are stored in `~/.hogagent/user_settings.json`. Session history is stored in `~/.hogagent/sessions/<user-directory>/`. Workspace instructions come from `AGENTS.md` followed by `.hogagent/hogagent.md`; workspace Skills live in `.hogagent/skills/`.

Shell isolation is controlled by `sandboxMode` in `~/.hogagent/hogagent.json`. On macOS/Linux, `enabled` requires the OS sandbox, `fallback` permits an unsandboxed fallback, and the default `disabled` runs without OS isolation. Windows shell execution is unsandboxed. See [tool permissions](docs/tools.md) before choosing a deployment configuration.

## Development and evaluation

```bash
npm run check
npm test -- --run
npm run build
npm run test:readme
```

`npm run test:readme` exercises the built launch modes and RPC examples without an API key. See the [release validation record](docs/release-validation.md) for tested environments, live-provider coverage and limitations.

[RPC examples](examples/README.md) demonstrate application integration. [FinanceGym](FinanceGym/README.md) contains test conditions, the final report, and 20 questions with answer reports for `qwen3.8-flash` in `standard` mode.

## Documentation

| Guide | Contents |
|---|---|
| [Architecture](docs/architecture.md) | Runtime, task orchestration and component boundaries |
| [Deployment](docs/deployment.md) | Installation and deployment |
| [Configuration](docs/configuration.md) | Models, search, shared settings and workspaces |
| [RPC protocol](docs/orchestrator-integration.md) | Commands, events and runtime context |
| [Tools](docs/tools.md) / [Skills](docs/skills.md) | Tool parameters and Skill development |
| [Extensions](docs/extensions.md) / [External MCP](docs/external-mcp.md) | Extension API and external services |
| [Artifacts](docs/artifact-manifest.md) | File classification and delivery |
| [Web UI](docs/web-ui.md) | Conversations, settings and file previews |
| [Development](docs/development.md) / [Troubleshooting](docs/troubleshooting.md) | Build, tests and diagnostics |
