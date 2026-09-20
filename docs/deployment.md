# HogAgent Deployment Guide

## Overview

HogAgent can be deployed in multiple ways depending on your use case. This guide covers installation, build, and production deployment considerations.

---

## Installation Methods

### Method 1: Build from Source

```bash
git clone https://github.com/hedgehog-finance/HogAgent.git
cd HogAgent
npm install
npm run build
```

Compiled output is placed in the `dist/` directory. The same build replaces `dist/src/web/public/` with the current WebUI assets, keeping the client and compiled server on the same protocol. Restart the WebUI server after building, once its sessions are idle, then reload the browser. Existing processes retain the previously loaded server/agent code.

Keep the complete `dist/src/web/public/` directory, including `preview-vendor/` and KaTeX fonts, in deployment packages. Markdown previews load these local assets on demand. The standalone checkout includes the generated chart parser and contract inputs, so builds and deployments need no sibling projects or CDN. In the monorepo, build/check still verify the shared sources; see [Development](development.md).

### Method 2: Via HedgehogGateway

When deployed alongside HedgehogGateway, HogAgent is managed as a subprocess. Gateway handles the lifecycle (start/stop/restart) and workspace initialization. Gateway deployment documentation lives in its own project.

---

## Launch Modes

### Interactive Mode (Development/Debugging)

```bash
node dist/bin/hogagent.js --mode interactive
```

Direct terminal conversation for testing and development. Not recommended for production.

### RPC Mode (Production)

```bash
node dist/bin/hogagent.js --user <user-id> --mode rpc --session <session-id> [--workspace <path>]
```

Production mode for programmatic integration. Accepts JSONL commands on stdin, emits events on stdout. Used by orchestrators like HedgehogGateway.

**Full CLI Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--user <name>` | User identifier for workspace resolution | `default` |
| `--mode <interactive\|rpc>` | Operation mode | `rpc` |
| `--session <id>` | Session identifier (UUID) | Auto-generated |
| `--config <path>` | Path to custom config JSON file | None |
| `--workspace <path>` | Workspace directory | Resolved via user_settings.json |
| `--debug` | Enable debug-level logging | Off |
| `--help`, `-h` | Show help | — |
| `--version`, `-v` | Show version | — |

### Web UI Mode

```bash
node dist/bin/hogagent-web.js --port 9108 --workspace /path/to/project
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--port <number>` | `9108` | Listening port |
| `--workspace <path>` / `--default-workspace <path>` | Registered `default` user workspace | Set and persist the default WebUI user's working directory |

Browser-based interface for chat, session management, and model configuration.

If a workspace option is supplied, WebUI updates the `default` user's mapping in `user_settings.json` and uses it for browser sessions. With no workspace option, the registered mapping is reused; first use falls back to `<HOGAGENT_USER_DIR>/workspace`.

Standalone CLI/RPC use the same first-use behavior for `default`. Workspace selection and programmatic agent creation automatically create or upgrade workspace `AGENTS.md` from HogAgent's bundled template. Add personal rules after the managed section; they survive template upgrades. After updating and rebuilding HogAgent, restart its processes to apply a newer template. Gateway-managed runs retain host-owned initialization. See [workspace instructions and upgrades](configuration.md#workspace-instructions-and-upgrades).

The listener remains on `127.0.0.1`. Each HTML page load receives a fresh seven-day WebUI JWT backed by `~/.hogagent/web-jwt-secret.key`; all API and WebSocket traffic is authenticated automatically by the bundled UI. Do not put a reverse proxy in front of this listener without preserving the exact allowed localhost Origin behavior.

---

## Configuration

### Default Directories

| Directory | Path | Override |
|-----------|------|----------|
| User config | `~/.hogagent/` | `HOGAGENT_USER_DIR` env var |
| Default workspace | `~/.hogagent/workspace/` | `--workspace` CLI flag |
| Project root | Auto-detected | `HOGAGENT_PROJECT_ROOT` env var |

### Configuration Files

Located in `~/.hogagent/`:

| File | Purpose |
|------|---------|
| `llm-settings.json` | LLM provider configuration (provider/apiKey/baseUrl) |
| `search_settings.json` | Search provider configuration |
| `user_settings.json` | Per-user workspace mappings and UI theme |
| `hogagent.json` | System-level settings (extensions, cache, memory) |
| `skills_config.json` | Skill API keys and mode visibility |
| `web-jwt-secret.key` | Standalone WebUI HS256 key (`0600`, generated automatically) |

### Bash runtime prerequisites and default grants

HogAgent defaults `sandboxMode` to `disabled`, so a new installation uses an unrestricted direct command shell. Select `enabled` or `fallback` when isolation is required on macOS/Linux. Windows does not support the sandbox and ignores this setting:

| Platform | Requirement | Behavior when unavailable |
|----------|-------------|---------------------------|
| macOS | `/usr/bin/sandbox-exec` and Python with `venv` | `enabled`: Bash omitted; `fallback`: bare shell; `disabled`: dependencies are optional |
| Linux | Bubblewrap (`bwrap`) and Python with `venv` | `enabled`: Bash omitted; `fallback`: bare shell; `disabled`: dependencies are optional |
| Windows | No supported backend; Windows PowerShell or verified Git Bash available (`cmd.exe` unsupported) | Every mode: platform-marked unrestricted direct shell |

The Debian service package declares `bubblewrap` as a package dependency. For other Linux distribution formats, install Bubblewrap using the distribution package manager. The global environment is created at `~/.hogagent/python-venv`; all workspaces share its installed packages. Set an absolute `pythonPath` in `~/.hogagent/hogagent.json`, or use `HOGAGENT_PYTHON`, to prefer a specific interpreter. HogAgent verifies that candidate by starting it, resolves wrappers to the actual `sys.executable`, and continues through other `python3`/`python` entries if it fails.

Set `sandboxMode` in `~/.hogagent/hogagent.json`, HogAgent WebUI **Settings → System**, or Gateway **Agents → HogAgent → Runtime Settings → System Config**. On macOS/Linux, `enabled` fails closed, `fallback` degrades to a bare shell when sandbox initialization fails, and `disabled` always runs a shell with all filesystem permissions of the HogAgent service account. Reconnect or restart HogAgent after changing it. Windows ignores the setting and always prefers system Windows PowerShell, then verified Git Bash, with unrestricted HogAgent-process permissions. `cmd.exe` is unsupported.

The Windows desktop release job runs the HogAgent Skill shell-parameter smoke tests after assembling the target-platform payload. They verify direct named arguments for flat scalars, UTF-8/BOM parameter files named `tmp-*` for complex payloads, and rejection of mixed or inline-nested payloads. macOS/Linux regression tests keep the existing `sandbox-exec` or Bubblewrap command path covered.

At startup HogAgent composes one RuntimeGrant for both sandbox backends. It admits installed Python/browser runtimes, absolute inherited `PATH` tool prefixes, standard OS libraries/certificates/fonts/resolver data, Homebrew/MacPorts/Nix roots, and exact known browser or Office application bundles as read-only dependencies. Workspace output, the shared venv, and the workspace Bash temporary tree are writable. XDG, Node/Python package caches, browser native temporary state, and common renderer caches are redirected into that temporary tree. Broad user and configuration roots such as HOME, `/etc`, `/opt`, and `/Applications` are not granted wholesale.

### Configuration Priority

```
CLI args  >  llm-settings.json  >  env vars  >  workspace config  >  system config  >  defaults
```

---

## Environment Variables

### Essential Variables

| Variable | Description |
|----------|-------------|
| `HOGAGENT_LLM_API_KEY` | LLM API Key (overridden by llm-settings.json) |
| `HOGAGENT_LLM_PROVIDER` | LLM provider name (default: `hedgehog`) |
| `HOGAGENT_LLM_BASE_URL` | LLM API base URL |
| `HOGAGENT_USER_DIR` | User config directory (default: `~/.hogagent`) |
| `HOGAGENT_PROJECT_ROOT` | HogAgent project root (auto-detected if not set) |
| `HOGAGENT_PYTHON` | Absolute Python interpreter for creating the shared Bash venv |

### Search Variables

| Variable | Description |
|----------|-------------|
| `HOGAGENT_SEARCH_PROVIDER` | Search provider (11 options) |
| `HOGAGENT_SEARCH_API_KEY` | Web search API Key |
| `HOGAGENT_BOCHA_API_KEY` | Bocha AI search API Key |
| `HOGAGENT_METASO_API_KEY` | Metaso AI search API Key |
| `HOGAGENT_ZHIPU_API_KEY` | Zhipu AI API Key |
| `HOGAGENT_VOLCENGINE_API_KEY` | Volcengine/Doubao API Key |

### Audit Model Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HOGAGENT_AUDIT_PROVIDER` | Audit model provider | None |
| `HOGAGENT_AUDIT_API_KEY` | Audit model API Key | None |
| `HOGAGENT_AUDIT_BASE_URL` | Audit model Base URL | None |
| `HOGAGENT_AUDIT_MODEL_ID` | Audit model ID | None |
| `HOGAGENT_AUDIT_MIN_PASS_SCORE` | Minimum passing score | 70 |
| `HOGAGENT_AUDIT_MAX_ITERATIONS` | Maximum retry count | 2 |

---

## Production Deployment Recommendations

1. **Use RPC mode** for production integration with orchestrators
2. **Configure `llm-settings.json`** rather than environment variables for LLM settings
3. **Set up workspace directories** per user for proper session isolation
4. **Content compression is opt-in and off by default.** Prefer bounded tool results and paginated file reads. Enabling requires a restart; disabling removes the hook and both retrieval tools after the current task completes. Session compaction remains independent and cannot guarantee capacity during an internal tool loop.
5. **Configure audit model** for quality assurance on complex multi-step tasks
6. **Use the `--config` flag** to point to a custom config file for different environments

---

## Related Documentation

- [Configuration Reference](./configuration.md)
- [RPC Protocol](./orchestrator-integration.md)
- [Troubleshooting](./troubleshooting.md)

Framework Python installations may keep the venv base executable behind a symlink in their `home` directory. HogAgent accepts that layout only when the link resolves to the same trusted interpreter; launcher and pip validation remain mandatory.
