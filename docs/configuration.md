# HogAgent Configuration Reference

## Configuration Priority

```
CLI args  >  --config file  >  llm-settings.json  >  workspace config  >  user config (~/.hogagent)  >  env vars  >  defaults
```

> **Note:** The `--config` file is a config source that provides values but does NOT override CLI arguments. It sits between llm-settings.json and workspace config in the priority chain.

---

## Default Directories

| Directory | Path | Override |
|-----------|------|----------|
| User config | `~/.hogagent/` | `HOGAGENT_USER_DIR` env var |
| Default workspace | Registered user mapping; `<HOGAGENT_USER_DIR>/workspace` on first use | `--workspace` CLI flag |
| Project root | Auto-detected from HogAgent installation | `HOGAGENT_PROJECT_ROOT` env var |

## Workspace Instructions and Upgrades

Standalone workspace selection (CLI/RPC or Web UI) and `createHogAgent()` initialize `<workspace>/AGENTS.md` before reading instructions. A fresh `default` CLI/Web user is automatically registered at `<HOGAGENT_USER_DIR>/workspace`, normally `~/.hogagent/workspace`; `default` is a user key, not a required directory name. An explicit workspace or existing user mapping takes precedence. Other unknown named users still require `--workspace`. The programmatic default also honors `HOGAGENT_USER_DIR`.

HogAgent ships its own template, currently **1.0.0**, compiled from `src/standalone-agents-template.ts`. Its content adapts general research, Skill, file, delegation and delivery principles; it contains no Gateway-only rules or supplemental business section. Neither generation, build nor runtime reads Gateway templates. Native execution/protocol rules remain in `SYSTEM.md` and `STANDALONE.md`.

The generated file has this structure (the full template replaces the abbreviated content below):

```markdown
<!-- hogagent:managed-agents:start -->
# HogAgent Workspace Rules
version: 1.0.0

...HogAgent-maintained rules...
<!-- hogagent:managed-agents:end -->

# User Rules / 用户自定义规则

Always answer in Chinese unless I request another language.
```

Add personal rules **after the end marker**, under the final user heading. On startup or workspace selection, a newer bundled template replaces only the marked section; text outside it is preserved, including whitespace and line endings. Same-version files are not rewritten, and opening the workspace with an older HogAgent never downgrades its rules. An existing file without markers is preserved in full after the new template and user heading. Edits inside the managed section survive only until a template upgrade.

Upgrade the installed code and rebuild, then restart CLI/Web UI (or recreate the programmatic instance). Template versions are independent of the package version; a package update with the same template version leaves the file untouched. Personal rule edits become visible at the next top-level execution boundary, while active executions and their children retain their existing instruction snapshot.

Malformed markers or versions, unreadable files and non-regular files (including symlinks) cause an explicit startup error instead of replacement. Restore the markers/version or back up the file and remove both markers to import it as personal rules. Writes use a temporary file and atomic replacement; a failed replacement leaves the original intact. Under `HOGAGENT_GATEWAY_MANAGED=1`, this initializer does nothing: the host continues to own its instructions. Standalone access to a previously shared workspace treats an unmarked existing file as preserved user content.

### Windows paths and permissions

Gateway and standalone HogAgent use the same `HOGAGENT_USER_DIR`, defaulting to the current OS user's `.hogagent` directory (`%USERPROFILE%\.hogagent` on Windows). The override must be an absolute native path. Drive paths, spaces, Chinese characters and UNC syntax are supported; `D:relative`, root-relative paths, `~`, literal `%USERPROFILE%` and surrounding quote characters are rejected. Expand variables in the launching shell first, and give both applications the same environment:

```powershell
$env:HOGAGENT_USER_DIR = Join-Path $env:USERPROFILE '.hogagent'
# Or an absolute directory with the current user's access permissions:
$env:HOGAGENT_USER_DIR = 'D:\刺猬数据\HogAgent 配置'
```

The PowerShell quote delimiters above are shell syntax, not part of the environment value. In JSON, escape backslashes (`"D:\\刺猬数据\\HogAgent 配置"`) or use forward slashes. Installation paths and user configuration paths have separate roles; configuration is not written into the installation directory. Different Windows service accounts have different profiles and do not share credentials automatically.

Configuration files use UTF-8; readers accept a UTF-8 BOM and CRLF. UTF-16 output from Windows PowerShell 5's default redirection is not accepted. Save as UTF-8 explicitly.

Windows uses directory/file ACLs, not POSIX `0600`, to control access. The current OS user needs permission to read existing files, create temporary files, and replace files in the configuration directory (normally **Modify** inherited by child files). New temporary files inherit the directory ACL; atomic replacement does not preserve special ACLs applied only to the old file. Protect the directory itself, especially when overriding the default profile path. The application does not elevate privileges, grant Everyone access, or remove read-only attributes. On POSIX, new configuration directories use `0700` and new configuration files use `0600`.

Only `ENOENT` means no saved file. Permission/lock failures are reported with the operation, filename and OS error code instead of falling back to missing Keys or stale environment values. Failed replacement keeps the original file and attempts to remove its temporary file. If Windows also denies cleanup, the error still propagates; resolve the directory permissions/lock before retrying. Local regression coverage is in `test/unit/config-permissions.test.ts` and `test/unit/config-persistence.test.ts`; native Windows validation is tracked by the Gateway project.

## Process Runtime Context

An orchestrator may initialize process-scoped, model-visible attributes from a strict JSON file:

```bash
hogagent --mode rpc --workspace /absolute/workspace \
  --runtime-context-file /absolute/config/process-runtime-context.json
```

```json
{
  "schema_version": "1.0",
  "attributes": {
    "deployment": "gateway-pool-a"
  }
}
```

The file path must be absolute. The file and the accepted process-context JSON value are each limited to 32 KiB, and the JSON root has a maximum object/array depth of 16. Programmatic consumers can pass the same object as `CliArgs.processRuntimeContext`; they must not provide both inputs. Runtime context is not part of the configuration priority chain and is never persisted. HogAgent derives workspace, user, mode, process ID, platform, and architecture instead of accepting overrides for them.

Session and current-run values use the existing JSONL RPC commands. See [RPC Protocol](./orchestrator-integration.md#native-runtime-context).

---

## Configuration Files

All located in `~/.hogagent/`:

### `llm-settings.json` (Recommended for LLM config)

Automatically saved by the WebUI settings panel, can also be manually edited:

```json
{
  "provider": "hedgehog",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.ciweiai.com/api/llm/v1",
  "modelId": "qwen3.8-flash",
  "thinkingLevel": "high",
  "compaction": {
    "autoCompactThreshold": 0.75
  },
  "audit": {
    "provider": "openai",
    "apiKey": "sk-...",
    "baseUrl": "",
    "modelId": "gpt-4.1",
    "minPassScore": 70,
    "maxIterations": 2
  }
}
```

`artifact-manifest` is an always-on internal protocol extension and does not need a configuration entry. A legacy entry with `enabled: false` is ignored so every completed task still receives a validated Manifest snapshot.

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string | LLM provider name |
| `apiKey` | string | API key |
| `baseUrl` | string | API base URL |
| `modelId` | string | Default model ID to use |
| `thinkingLevel` | string | Thinking depth (`low`/`medium`/`high`) |
| `compaction.autoCompactThreshold` | number | Auto-compaction trigger threshold (`0 < value < 1`, default: 0.75) |
| `audit` | object | Audit model configuration (optional) |
| `audit.minPassScore` | number | Minimum passing audit score (default: 70). Pass/fail is decided by `score >= minPassScore`; the audit LLM's `passed` field is record-only. Timeout / turn-cap / model-unavailable fallbacks are skipped, not passed, regardless of this threshold. Invalid values (non-numeric / out of 0-100) are clamped to `[0, 100]` or fall back to `70` |
| `audit.maxIterations` | number | Maximum retry count. Must be a non-negative safe integer; `0` disables audit-driven retries, default is `2`, and no separate product maximum is imposed. `save_settings` rejects an invalid supplied value before persistence. Invalid environment or historical persisted values are warned and read as `2` |

> Intent classification and its optional JSON-format repair share one fixed **60-second total budget**. Each audit run is separately bounded by a fixed **3-minute timeout** and a **100-turn cap** (not configurable). A skipped audit returns `skipped: true, passed: false`; `score: 0` is a placeholder, not a verified grade. Execution can continue, but the final reply must disclose the verification limitation.

Model discovery is optional. When `baseUrl` is supplied it takes precedence over provider presets; HogAgent accepts an API root, a versioned root, a complete `/chat/completions`/`responses` URL, or `/models` itself and derives model-list candidates. For an unversioned root it tries both `<base>/models` and `<base>/v1/models`. Custom providers may be queried without an API key. If discovery fails, the Web UI keeps direct model-ID input available for both the main and audit models.

Missing, invalid, too-small, or legacy 200,000-token windows use the product default of 500,000 tokens; other explicit valid windows are preserved. Unknown model IDs may be selected and are validated by the provider on the next call. Before inference, a pasted terminal `/models`, `/chat/completions`, `/responses`, or `/messages` path is reduced to the SDK API root, so successful discovery cannot leave a duplicated runtime path. An explicitly empty custom-provider API key overrides inherited environment credentials; HogAgent supplies only an in-memory placeholder required by the OpenAI client and does not persist it. When WebUI intentionally omits a non-custom Key that came from the environment, `save_settings` preserves that live credential instead of writing an empty replacement. Gateway-managed and standalone HogAgent share persisted credentials: LLM keys in `llm-settings.json`, and data API keys in each corresponding Skill entry of `skills_config.json`. Gateway calls the [HogAgent configuration API](configuration-api.md) on login, renewal, key updates and account switches, even without a connected Agent. HogAgent owns file persistence and model discovery; Gateway internal services continue using its account keys.json. Managed mode neither strips these keys nor prevents saving them; omitted keys preserve existing credentials. MCP credentials retain their separate process-environment contract. Existing `set_model`, `set_llm_provider`, and `save_settings` request shapes remain supported, and queued changes apply before the next turn.

Provider changes never inherit a different provider’s Key, URL or model: omitted keys use only the destination provider cache, otherwise clear; omitted URL/model fields clear. This merge policy is shared by the management API and runtime settings, including partial audit updates. Gateway runtime notifications use `save_settings` with `reloadPersistedLlm: true` to read the latest persisted configuration at execution time without writing a stale snapshot back.

An explicit empty Key clears a credential; omitting it preserves the saved value. Key updates through `save_settings` keep the active provider cache and live configuration consistent. Merge writes refuse to overwrite malformed shared JSON and use atomic replacement with POSIX mode `0600` or inherited directory ACLs on Windows. Restart an already-running standalone WebUI after Gateway switches accounts or replaces credentials; sharing files does not hot-switch an unrelated process.

### `search_settings.json` (Recommended for search config)

```json
{
  "provider": "brave",
  "active_provider": "bocha",
  "api_key": "your-api-key",
  "providers": {
    "brave": { "api_key": "..." },
    "tavily": { "api_key": "..." },
    "bocha": { "api_key": "...", "freshness": "noLimit", "categories": ["finance"] },
    "metaso": { "api_key": "...", "mode": "simple" },
    "zhipu": { "api_key": "...", "model": "glm-4-flash" },
    "volcengine": { "api_key": "...", "model": "doubao-pro-latest" },
    "google": { "api_key": "...", "cx": "..." }
  }
}
```

| Field | Description |
|-------|-------------|
| `provider` | Last configured search provider (auto-updated when saving) |
| `active_provider` | **Currently active search provider** (controlled by WebUI selector) |
| `api_key` | General API Key, used as default for all providers |
| `providers` | Per-provider independent configuration (overrides top-level `api_key`) |

### `user_settings.json`

Per-user workspace mappings and UI theme selection:

```json
{
  "user-id": {
    "workspace_dir": "/path/to/workspace",
    "theme": "fintech"
  }
}
```

For `hogagent-web`, an explicit `--workspace` or `--default-workspace` updates the `default` user's mapping while preserving its other fields. If neither option is supplied, the existing mapping is reused. A connection-level WebSocket `workspace` query overrides the server default for that user and persists the new mapping.

Gateway starts HogAgent with `--user <raw-user-id> --workspace <workspaceRoot>`. HogAgent registers this explicit workspace even when `HOGAGENT_GATEWAY_MANAGED=1`, updating only that user's `workspace_dir` and preserving its theme and other users' entries. The file belongs to HogAgent under `HOGAGENT_USER_DIR` (default `~/.hogagent`); Gateway does not write it directly. Subsequent standalone CLI/WebUI connections for the same user resolve the updated workspace and its `.hogagent/skills/`. Existing processes and saved session CWDs are not changed; reconnect WebUI and create a new session after switching workspaces.

WebUI validates a user restored from its URL or browser storage before connecting. A user missing from this file is treated as stale browser state and automatically replaced with `default`. This stale-user fallback is WebUI-only; standalone CLI and RPC automatically provision `default` but must still register other unknown users by supplying a workspace.

### `hogagent.json` (System-level settings)

`save_settings` validates a supplied `sandboxMode` before writing either the LLM settings or system settings. A mixed request with an invalid mode is rejected without partially saving its LLM fields.

```json
{
  "sandboxMode": "disabled",
  "explicitCache": false,
  "showCacheStats": false,
  "pythonPath": "/absolute/path/to/python3",
  "extensions": [
    { "name": "content-compressor", "enabled": false, "config": { "textThreshold": 5000 } },
    { "name": "sub-agent", "enabled": true, "config": { "maxTurns": 50 } },
    { "name": "delivery-manager", "enabled": true }
  ],
  "memory": {
    "enabled": true,
    "mcpKbUrl": "http://127.0.0.1:59101"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sandboxMode`（Windows 不支持沙箱） | `enabled` \| `fallback` \| `disabled` | `disabled` | On macOS/Linux, `enabled` requires the OS sandbox and disables Bash if initialization fails; `fallback` prefers isolation but uses an unrestricted bare shell if any sandbox dependency or validation fails; `disabled` always runs a shell directly with the HogAgent process account's filesystem permissions. Applies after reconnect/restart. Windows ignores every value and always uses an `UNSANDBOXED` Windows PowerShell or verified Git Bash; `cmd.exe` is unsupported. |
| `explicitCache` | boolean | `false` | Enable Anthropic-style cache_control for Qwen models |
| `showCacheStats` | boolean | `false` | Display cache_read/cache_write token counts |
| `pythonPath` | string | auto-detect | Preferred absolute interpreter used to create `python-venv` under the HogAgent configuration directory; if unusable, HogAgent continues through working `python3`/`python` candidates (`.exe` on Windows). Windows requires a verifiable standard CPython installation and creates the venv at its final path. On macOS/Linux the result follows `sandboxMode`; on Windows the direct shell remains available and reports that managed Python is unavailable. |
| `extensions` | array | `[]` | Extension enable/config overrides |
| `extensions[].enabled` | boolean | `false` for `content-compressor`; otherwise `true` | Requested extension state; enabling content compression requires restart |
| `extensions[].config` | object | `{}` | Extension-specific config |
| `memory.enabled` | boolean | `false` | Enable/disable the memory extension |
| `memory.mcpKbUrl` | string | — | Gateway KB MCP Server URL |

Legacy `sandboxEnabled` values remain readable for upgrades: `true` maps to `fallback`, `false` maps to `disabled`, and the field is removed the next time either UI saves `sandboxMode`.
An explicitly present but unrecognized `sandboxMode` normalizes to fail-closed `enabled`; only a missing value receives the default `disabled`. This normalization is persisted and reported on every platform, but Windows execution still ignores the value because Windows does not support the sandbox.

HogAgent and Gateway replace `hogagent.json` atomically when saving system settings. If persistence fails, the save request fails instead of reporting a sandbox mode that was not written.

**Runtime effect of system settings:** Content compression is off by default. Disabling takes effect at the next idle RPC boundary after the current top-level task finishes: both retrieval tools and their model-visible definitions are removed, the hook is detached, and cached Entry IDs expire. Enabling always requires a process restart. Threshold changes apply only to an already active compressor. Both save_settings and Gateway reload_config await the same extension configuration application; failures are reported rather than acknowledged as applied. Sub-agent settings retain their existing hot-update behavior; memory and sandboxMode still require a new process/tool runtime. Both settings entry points reject non-boolean `compressorEnabled` values before persistence. WebUI initial/reconnect/settings replies use one persisted-settings snapshot; a saved enabling intent remains separate from the live tool list. Explicitly enabled existing user configurations are preserved; changing only the compression threshold never implicitly enables it.

### `skills_config.json`

See [Development Guide](./development.md#skills_configjson) for details.

### `mcp-servers.json` (External MCP Client)

The system file is `<HOGAGENT_USER_DIR>/mcp-servers.json`; the optional manual workspace override is `<workspace>/.hogagent/mcp-servers.json`. Workspace entries replace system entries by server name. Both require `{ "schemaVersion": 1, "servers": [...] }`; legacy arrays are rejected.

Server entries select Streamable HTTP or stdio, reference credentials only through host environment-variable names, define Tool/Resource/Prompt allowlists and optional direct tools, and may override connection/call/Task timeouts plus per-server concurrency. The WebUI edits only the system file and writes it atomically with mode `0600`. See [External MCP Client](./external-mcp.md) for the schema and lifecycle details.

---

## LLM Providers

| Provider | Env Var Name | Base URL | API Type | Recommended Model |
|----------|-------------|----------|----------|-------------------|
| **Hedgehog** | `hedgehog` | `https://api.ciweiai.com/api/llm/v1` | openai-completions | qwen3.8-flash |
| **OpenAI** | `openai` | `https://api.openai.com/v1` | openai-completions | gpt-5.6-terra |
| **Anthropic** | `anthropic` | `https://api.anthropic.com` | anthropic-messages | claude-sonnet-5 |
| **Google** | `google` | `https://generativelanguage.googleapis.com/v1beta` | google-generative-ai | gemini-2.5-flash, gemini-2.5-pro |
| **DeepSeek** | `deepseek` | `https://api.deepseek.com` | openai-completions | deepseek-v4-flash |
| **Mistral** | `mistral` | `https://api.mistral.ai/v1` | mistral-conversations | mistral-medium-3-5 |
| **xAI (Grok)** | `xai` | `https://api.x.ai/v1` | openai-completions | grok-4.5 |
| **Groq** | `groq` | `https://api.groq.com/openai/v1` | openai-completions | llama-3.3-70b-versatile |
| **OpenRouter** | `openrouter` | `https://openrouter.ai/api/v1` | openai-completions | anthropic/claude-sonnet-5 |

> Other providers using OpenAI-compatible APIs can directly use the `openai-completions` type.

---

## Environment Variables

### LLM Variables

| Variable | Description |
|----------|-------------|
| `HOGAGENT_LLM_API_KEY` | LLM API Key (overridden by llm-settings.json) |
| `HOGAGENT_LLM_PROVIDER` | LLM provider name (default: `hedgehog`) |
| `HOGAGENT_LLM_BASE_URL` | LLM API base URL |
| `HOGAGENT_USER_DIR` | Absolute user config directory, shared with Gateway (default: `~/.hogagent`) |
| `HOGAGENT_PROJECT_ROOT` | HogAgent project root (auto-detected) |
| `HOGAGENT_PYTHON` | Preferred absolute Python interpreter for the shared Bash venv; `hogagent.json.pythonPath` takes precedence, then automatic candidates are attempted |
| `HOGAGENT_GATEWAY_PROCESS_INSTRUCTIONS` | Gateway-managed JSON string array appended to main/sub-agent system prompts in every mode; invalid JSON or non-array values are ignored |

### Search Variables

| Variable | Description |
|----------|-------------|
| `HOGAGENT_SEARCH_PROVIDER` | Search provider (11 options) |
| `HOGAGENT_SEARCH_API_KEY` | Web search API Key (international providers) |
| `HOGAGENT_SEARCH_ENDPOINT` | Custom search API URL |
| `HOGAGENT_SEARCH_CX` | Google Custom Search Engine ID |
| `HOGAGENT_BOCHA_API_KEY` | Bocha AI search API Key |
| `HOGAGENT_BOCHA_FRESHNESS` | Bocha freshness: `noLimit`/`oneDay`/`oneWeek`/`oneMonth`/`oneYear` |
| `HOGAGENT_BOCHA_CATEGORIES` | Bocha category filter (comma-separated) |
| `HOGAGENT_METASO_API_KEY` | Metaso AI search API Key |
| `HOGAGENT_METASO_MODE` | Metaso mode: `simple`/`deep`/`research` |
| `HOGAGENT_METASO_RANGE` | Metaso range: `all_web`/`academic` |
| `HOGAGENT_ZHIPU_API_KEY` | Zhipu AI API Key |
| `HOGAGENT_ZHIPU_MODEL` | Zhipu model (default: `glm-4-flash`) |
| `HOGAGENT_VOLCENGINE_API_KEY` | Volcengine/Doubao API Key |
| `HOGAGENT_VOLCENGINE_MODEL` | Volcengine model (default: `doubao-pro-latest`) |

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

## Thinking Level

Quick overrides are temporary. Creating or resuming another session uses the main thinking level. Changing the main level through `set_thinking_level` or `save_settings` during Quick also updates the value restored when leaving Quick.

| Level | Description | Use Case |
|-------|-------------|----------|
| `off` | No reasoning output, lowest latency | Simple Q&A |
| `minimal` | Minimal reasoning, internal decisions only | Lightweight tasks |
| `low` | Light reasoning | General conversation |
| `medium` | Medium reasoning depth | Tasks requiring analysis |
| `high` | Deep reasoning | Complex multi-angle analysis |
| `xhigh` | Maximum reasoning depth | Difficult reasoning, mathematical proofs |

---

## Default Pre-configured Models (hedgehog provider)

| Model ID | Name | Context Window |
|----------|------|----------------|
| `qwen3.8-flash` | Qwen 3.8 Flash (default) | 500K |
| `claude-sonnet-4-20250514` | Claude Sonnet 4 | 200K |
| `claude-3-5-haiku-20241022` | Claude 3.5 Haiku | 200K |
| `gpt-4.1` | GPT-4.1 | 1M |
| `gemini-2.5-pro` | Gemini 2.5 Pro | 1M |
| `gemini-2.5-flash` | Gemini 2.5 Flash | 1M |
| `deepseek-r1` | DeepSeek R1 | 64K |

---

## Related Documentation

- [Architecture](./architecture.md)
- [RPC Protocol](./orchestrator-integration.md)
- [Deployment](./deployment.md)
- [Tool System](./tools.md)
- [Web UI Guide](./web-ui.md)
