# HogAgent

In development mode with the production API, data Skill credentials synchronize when the current Gateway account signs in, renews its credentials, or switches accounts, and all three legacy data Skills load normally. Restrictions remain in place for local and test APIs. Shared settings are still persisted through the HogAgent configuration API. See [configuration](docs/configuration.md).

Standalone builds validate bundled contracts without requiring sibling frontends. For partial Gateway tests, explicit `--skills=off` disables Skills only in development mode (same original directory and ports); production shared credentials and default behavior are unchanged. See [development](docs/development.md) and [configuration](docs/configuration.md).

[English](README.md) · [简体中文](README-CN.md) · [日本語](README-JA.md)

HogAgent is a general-purpose AI agent engine optimized for financial research. It combines model reasoning, tools and Skills to complete research, analysis and file-based tasks, with a browser interface and a JSONL RPC interface for application integration.

- **Website:** [ciweiai.com/hogagent.html](https://ciweiai.com/hogagent.html)
- **Financial data sources and tools:** [Hedgehog Skills](https://github.com/hedgehog-finance/hedgehog-skills/)
- **Version:** `1.2.6` · **License:** [GPL-3.0](LICENSE)

## Capabilities

- **Task execution:** Quick, Standard and Long Task modes; Long Task supports planning, checkpoints, audit and resumption. Audit availability and results are reported separately from task completion.
- **Tools and Skills:** File operations, shell execution, calculations, web search and page retrieval. Eight built-in Skills cover skill creation, financial calculations, charts, presentations, document conversion, spreadsheets, technical indicators and valuation.
- **Extensions:** Optional content compression, sub-agents, artifact tracking, file delivery, persistent memory and external MCP services. Content compression is off by default.
- **Models:** Multiple model providers and custom OpenAI-compatible endpoints, with separate main-model and audit-model settings.
- **Web UI:** Streaming conversations, session history, user/workspace selection, model settings, Skills, tools, themes and file previews.
- **Integration:** stdin/stdout JSONL commands and events, session persistence, automatic context compaction and process/session/run context. Gateway supplies authenticated project bindings and owns its project metadata.
- **Mid-turn steering:** RPC advertises `supports_steering`; session/run guards and correlated acknowledgements let clients correct the active task safely. Unconsumed control messages are cleared when their Prompt Run ends, including model failures. See [RPC steering](docs/orchestrator-integration.md#steer).

The Pi Agent Harness is included in `src/vendor/`. HogAgent runs independently or as a subprocess of HedgehogGateway, an IDE plugin or another application.

Development Gateway launches isolate HogAgent configuration with `HOGAGENT_USER_DIR`. Data Skills use production services and an explicitly copied production user key; three legacy data Skills are temporarily excluded from development loading without modifying the external skill library. Model borrowing still requires `--llm=prod`. See [configuration and development isolation](docs/configuration.md). Production default directories and Skill availability are unchanged.

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

Managed Hedgehog keys and their service endpoints synchronize together when Gateway changes environments; model preferences and other providers are preserved. See [configuration](docs/configuration.md).

## Workspace and runtime

`--workspace` selects the user's workspace; user mappings are stored in `~/.hogagent/user_settings.json`. Session history is stored in `~/.hogagent/sessions/<user-directory>/`. Workspace instructions come from `AGENTS.md` followed by `.hogagent/hogagent.md`; workspace Skills live in `.hogagent/skills/`.

Standalone CLI and Web UI provision a fresh `default` user in `~/.hogagent/workspace/` (or `<HOGAGENT_USER_DIR>/workspace/`) when no workspace is supplied; existing mappings are reused. HogAgent creates `AGENTS.md` from its own versioned template, with no Gateway build or runtime dependency. Startup or workspace selection after an upgrade replaces older template sections. Add personal rules under the trailing `User Rules` heading: those rules, and any pre-existing unmarked file, are preserved. See [workspace instructions and upgrades](docs/configuration.md#workspace-instructions-and-upgrades).

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

Windows checkouts preserve LF line endings for reproducible builds. Python setup accepts validated framework interpreter symlinks; downloads remain bounded to their announced size if a file grows during transfer.

Image/video input is distinct from ordinary file upload. Media references retain their original message through queued delivery, retries, audits and compaction. Native clipboard paste works with Ctrl+V on Windows and Cmd+V on macOS. See [multimodal input](docs/multimodal-input.md).

WebUI media audit: upload batches retain their intent before I/O, late events cannot restore an old Session input into a new Session, and video preview errors preserve the media attachment. See [Web UI](docs/web-ui.md).

Standalone 1.2.6 publication checks and their validation limits are recorded in [release validation](docs/release-validation.md).
