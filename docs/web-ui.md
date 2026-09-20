# HogAgent Web UI Guide

## Overview

HogAgent includes a built-in browser interface for direct interaction without an external orchestrator. The Web UI provides chat, session management, model configuration, and theme customization.

After settings are applied, the existing `settings_saved` / `config_reloaded` events carry the current `builtin_tools` inventory and the persisted `systemConfig` snapshot. Initial connection and reconnect use the same snapshot formatter as native capabilities, and restore the saved controls independently of the live tool inventory. The WebUI refreshes both its cache and visible tool count, and reconnect replays the server's latest session inventory so changes received while disconnected are retained. Gateway also refreshes its capability cache. The saved compression toggle represents the requested next-start setting, while the tool list reflects the current process.

---

## Launch

```bash
node dist/bin/hogagent-web.js --port 9108 --workspace /path/to/project
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--port <number>` | `9108` | Listening port |
| `--workspace <path>` / `--default-workspace <path>` | Registered `default` user workspace | Set and persist the default WebUI user's working directory |

After launch, open your browser to `http://localhost:9108`.

The sidebar and settings dialog show the installed HogAgent version. Both the WebUI build and `hogagent --version` use `src/version.ts` to read the HogAgent `package.json`. `npm run build` writes the version directly into static HTML through `scripts/sync-web-version.mjs`; `npm run check` detects stale labels. After changing the package version, build or run `npm run web:version` and reload the page. Version display does not require a new server process, API, or WebSocket field; runtime code updates still require the usual server restart.

When either workspace option is supplied, it is authoritative for the `default` user and updates that user's entry in `user_settings.json` while preserving settings such as the selected theme. Without the option, WebUI reuses the existing mapping; on first use it creates `<HOGAGENT_USER_DIR>/workspace` (normally `~/.hogagent/workspace`). A WebSocket `workspace` query remains the highest-priority per-connection override and registers the selected user's mapping.

Gateway-managed HogAgent startup also registers its explicit `--user`/`--workspace` mapping in this file, so WebUI connections for that user use the same workspace and Skills. After Gateway changes a legacy mapping, reconnect WebUI and create a new session; existing processes and saved histories retain their original workspace. See [user workspace configuration](configuration.md#user_settingsjson).

The selected user is stored in the browser. Before opening its first WebSocket, WebUI checks that selection against `user_settings.json`. If the mapping no longer exists, it updates the browser selection and URL to `default`; the server applies the same fallback defensively. CLI and RPC calls remain strict and still reject an unknown user without an explicit workspace.

---

## Authentication

The standalone Web UI has its own JWT boundary; it does not reuse a Gateway token.

- HogAgent creates and reuses a 256-bit HS256 key at `~/.hogagent/web-jwt-secret.key` with owner-only (`0600`) permissions. A symbolic- or hard-linked key is rejected rather than followed.
- Every `index.html` response receives a newly issued token valid for exactly seven days. The response is `Cache-Control: no-store` with `Referrer-Policy: no-referrer`.
- The page reads the one-time token meta element, removes it immediately, and retains the token only in memory. It is never put in local storage or an application URL.
- Every `/api/*` request uses `Authorization: Bearer <token>`. Static HTML, JavaScript, CSS, and i18n resources remain public on the loopback listener.
- WebSocket handshakes carry the token in the connection query. The server validates the signature, expiry, and exact `http://localhost:<port>` or `http://127.0.0.1:<port>` Origin before resolving a user/workspace or starting a HogAgent child process.
- When the local token expires, an API returns `401`, or a failed WebSocket handshake is confirmed as an authentication failure, the UI reloads the whole page to receive a new token. A session-storage retry guard stops repeated reload loops and displays an authentication error instead.

Custom clients must first GET `/`, extract that response's `hogagent-web-token` meta value, then use it as a Bearer token and WebSocket `token` query value. Refreshing `/` always rotates the client token without rotating the server secret.

---

## Interface Features

### Workspace Layout and Navigation

The interface follows a Codex-inspired workspace layout while preserving the existing feature set and all HTTP API / WebSocket request and event shapes. This is a presentation and interaction refactor; it adds no service, workflow, model call, project grouping, or backend capability.

- **Sidebar:** New Session stays at the top, recent sessions occupy the scrollable middle, and Chat / Skills / Extensions / Tools sit above the user, language, theme, and settings controls with an 8px bottom inset. Skills / Extensions / Tools summaries show their lists without redundant "Installed" / "Loaded" headings. History titles truncate with the full title available on hover; timestamps remain on a separate secondary line. Historical sessions support Enter and Space activation.
- **Conversation:** The header shows the current session title (or the selected management page). Messages and the composer share an 860px maximum reading width. Assistant responses use the main canvas; user messages have a quiet background. Thinking, tool activity, deliveries, and token statistics retain their existing behavior.
- **Composer:** The mode selector and its explanation sit above a rounded input surface. Attachments, tool/skill selection, the current model and thinking level, and Send remain together below the text. Clicking the model opens a small inline model/thinking panel without a modal overlay. Enter sends, Shift+Enter adds a line, and IME confirmation does not send. Creating a new session restores the welcome view when its existing `ready` event arrives. Quick has no file-reading Tool, so sending with attachments is blocked at the browser boundary; the draft and uploads remain intact until the user explicitly selects Standard.
- **Responsive navigation:** Desktop supports a collapsed icon rail; tablets start with that rail. Phones use a drawer opened by the header button or the existing left-edge swipe. Close it with the sidebar button, outside click, Escape, or page/session selection. There is no timed dismissal during interaction. The shared header remains accessible on management pages; Stop, Compress, and Token Stats remain visible on mobile chat. Wide management tables scroll horizontally.
- **Keyboard and dialogs:** Controls have visible keyboard focus and translated accessible labels. The mobile drawer keeps focus within its controls. Existing dialogs receive dialog semantics, initial focus, Tab wrapping, Escape dismissal, and focus restoration on close. Reduced-motion preferences disable animations.

Sending a message or changing the mode/page closes the composer menus so old command suggestions cannot populate an empty input. The model and thinking indicators refresh from the existing runtime events.

Once the conversation contains messages, reasoning, or delivery records (including restored history), the composer defaults to one input line and grows with multiline text within the existing height limit. Clearing or sending the text returns it to one line. New-session welcome screens retain the original input height on desktop and mobile.

The inline panel fetches only the currently active provider using its saved credentials and Base URL. It does not read unsaved provider drafts, reuse the audit model list, or add built-in/custom IDs to the returned choices. The existing `refresh_models` free-form `target` echo separates each lookup from other requests; replies from a previous lookup or provider/session are ignored. An empty or failed list displays a disabled `auto` option. Opening the panel never saves a setting automatically.

The thinking slider follows HogAgent's current model conversion and supported-level rules: recognized reasoning models expose the supported `off` through `high` levels; unsupported models (including unresolved `auto`) stay at `off` with the slider disabled. It does not invent upstream capability metadata that the model-list API does not supply. A parity test checks the UI rule against `configModelToAgentModel` and vendor `getSupportedThinkingLevels`; vendor code and inference behavior are unchanged.

Click **Apply** to persist the selected model and thinking level together through the existing `save_settings` command. Provider credentials, audit and system settings are preserved. While loading, disconnected, busy, or saving, submission is disabled. Active values change after the success reply; errors stay visible in the panel and permit retry. Escape, outside click, or page navigation closes the panel; the sidebar Settings entry retains the full provider configuration dialog.

The interaction regression suite (`test/web/workspace-interactions.test.ts`) uses the real HTML and client with mocked transport to check navigation, single-dispatch session transitions, frozen attachment/mode snapshots, resume failure, Quick attachment blocking, composer mode/IME behavior, settings saves, MCP transport switching, and token display without calling an LLM. The offline browser smoke test (`test/browser/webui-smoke.mjs`) additionally exercises responsive layout and visible controls in Chromium, including pausing/resuming chat scrolling during streaming and resetting it on session transitions at desktop and mobile widths. See the [WebUI audit](./web-ui-audit-2026-09-12.md) for commands, results, and coverage limits.

### Chat Panel

The server decodes subprocess JSONL incrementally as UTF-8, preserving Chinese characters and emoji split across stdout chunks. Malformed WebSocket envelopes receive an error without terminating the connection.

- Multi-turn conversations with real-time streaming output
- Support for thinking model reasoning display
- Tool execution progress indicators
- File delivery notifications with download links

Automatic scrolling follows updates only while the chat is at the bottom. Scrolling up pauses following for text, reasoning, tools, and status/delivery updates; returning to the bottom resumes it (with a 2px rounding tolerance). Following uses instant scrolling so animation frames cannot disable it. New sessions and restored historical sessions start at the latest record; reconnecting preserves the current scrolling preference.

Delivery cards require persisted receipts from the matching backend. Build and restart the idle WebUI server together with its bundled client after protocol changes; an old backend's transient delivery events have no receipt ID and cannot produce cards in the current UI. Files from such older sessions need explicit redelivery through the existing delivery path; refreshing alone cannot create missing receipts.

The final delivery decision is runtime control data rather than chat content. The model response may stream it temporarily, but when the structured `turn_end` arrives the Web UI replaces the just-completed assistant bubble with the authoritative cleaned text. A decision-only response removes that bubble; ordinary turns without a structured delivery decision keep their existing streaming behavior.

For reasoning models, `message_start` does not create an empty assistant bubble. The Web UI renders any `thinking_start`/`thinking` content first and creates the answer bubble only when the first text delta arrives, preserving the model's reasoning-before-answer event order in the conversation DOM.

Long Task keeps intermediate assistant output in collapsible thinking sections. The orchestrator exits internal mode before starting its final summary turn, so that turn follows the same reasoning-before-answer rule and remains the last visible assistant reply.

History replay determines each assistant reply's presentation from the persisted planning/execution/final-summary prompt boundaries on the complete active branch, before applying compaction and filtering tool-only or empty messages. Final summaries and ordinary follow-ups remain normal replies, including after multiple Long Task rounds or session restoration. `complexAssistantCount` is an orchestration statistic, not an index into visible messages; it no longer controls rendering. Existing sessions are corrected when reopened, without rewriting their history. Unknown historical prompts default to normal replies rather than guessing from a cumulative count.

### Session Management

Creating a new WebUI session removes the old process entry from the server registry. Process teardown sends SIGTERM and, if the child has still not exited after five seconds, SIGKILL; sending a signal alone does not count as process exit. The existing reconnect grace period is unchanged. While `new_session` waits for the old process to exit, commands, duplicate switches, and another socket attempting to reconnect to that retiring session receive an explicit error. They are not queued or replayed; send again after the new child emits `ready`. If the socket closes during the switch, the old process is retired without spawning a replacement.

New/resume transitions have one owner in the browser. The pending send is an immutable snapshot of text, uploaded-file metadata and conversation mode; Send, upload and mode controls remain disabled until the authoritative `ready`. That event consumes the snapshot once, while preserving any newer draft text or attachments created during the transition. A failed `resume_session` restores the historical read-only state and leaves the editor and uploads untouched, so the draft cannot be sent to the old or another Session.

- Create new sessions
- New Session is disabled while disconnected or waiting for a session transition; duplicate clicks do not send another request. The existing `ready` event restores the welcome view and enables the control.
- Switch between historical sessions
- Sessions are persisted as JSONL files for long-term storage
- **Disconnect grace period**: when the browser disconnects (page refresh, brief network drop), the backing HogAgent child process is kept alive for **60 seconds**. Reconnecting within the window re-attaches to the same process, so running tasks are not lost; after the grace period the child is killed.

Each browser tab stores a user-scoped Web process connection ID in `sessionStorage`. This ID is stable even after the child resumes or switches its business Session ID; tabs do not share it. The Web server separately tracks the current business Session, busy state and latest validated prompt mode for reconnect snapshots. It injects `_web_connection_id`, `_web_busy` and the fresh-process fallback marker only into browser-bound events—never into the child JSONL stdout consumed by Gateway. A reconnect socket's temporary child cannot overwrite the stable ID while the reconnect decision is pending. A brief same-page reconnect keeps the DOM. After a full refresh, an idle process restores its current Session through the existing `switch_session(read_only=true)` history path; a busy process first continues streaming, then requests the same read-only replay at the final boundary. If the process is dead, the explicitly marked fresh-Session fallback remains authoritative.

Reconnection reuses a process only while it has not exited or received a termination signal. A naturally exited child may still have `killed=false`; its exit code/signal takes precedence. Dead session entries are retired and the existing fresh-session path creates a replacement.

Reattaching preserves the child process's existing stream and lifecycle listeners, including buffered stderr diagnostics. Those listeners send through the session's current socket. Late messages from a replaced socket are ignored before parsing or dispatch, so they cannot affect its successor.

### Token Stats

Live and restored main/sub-agent/audit counters use non-negative integers and preserve explicit totals, with the category sum as a minimum. Duplicate sub-agent completion IDs are counted once. Audit events for another session are ignored by the active view; their persisted usage is restored when that session is reopened. These display counters do not estimate ciwei-ai points.

The token stats modal (accessible via the toolbar) displays per-turn LLM token consumption:

- **Main totals**: input, cache write, cache read, output, total tokens, cache hit rate
- **Audit LLM line**: when audit model (intent classification / scoring) has consumed tokens, a separate summary line shows audit-specific totals. Its title and input/cache write/cache read/output/total/cache hit rate labels use the selected UI language in all 16 supported locales; metric labels are shared with the main and sub-agent statistics.
- **Per-turn detail table**: each assistant turn's breakdown
- **Sub-agent table**: per-sub-agent aggregated usage

Audit LLM usage is tracked independently from the main agent and persisted to `audit-usage.json` in the session task directory. When switching sessions, audit usage is restored alongside main usage history.

Audit-only usage still opens the statistics tables, even before the main agent or a sub-agent has produced usage.

Main usage history is restored from all persisted assistant message entries in the session, including calls before compaction and on abandoned branches. Those calls still consumed tokens even when their messages are no longer in the active context. Visible chat history continues to use the compacted active context; viewing history does not emit new usage increments to the Gateway.

### Settings Panel

- The settings dialog uses a 760px maximum desktop width and responsive mobile margins. Its tab strip scrolls on narrow screens; all existing settings tabs and save operations remain available.
- Dynamically switch LLM models (no restart required)
- Adjust thinking depth level (off/minimal/low/medium/high/xhigh)
- Configure LLM provider (provider, API key, base URL)
- Configure audit model settings
- Search provider configuration
- Manage HogAgent's independent external MCP system configuration

For the main and audit LLM, changing the provider URL or key triggers a debounced model-list request. A user-supplied Base URL is authoritative: the UI/server derive `/models` from API roots or complete inference URLs and also try `/v1/models` for unversioned roots. If the endpoint is unavailable, empty, or uses a provider-specific protocol, the model ID can still be entered and saved directly. Keyless custom/local OpenAI-compatible providers are supported. An explicitly cleared key input sends an empty string; an untouched hidden environment key remains omitted. Explicitly empty credentials received on `ready` clear the old UI state and provider cache. Switching provider does not inherit the previous provider’s credentials or endpoint. Saving sends one `save_settings` command: persistence, the active main model/auth configuration, thinking depth, and the mutable audit model reference are updated together before the next queued turn.

The active model/provider/thinking display updates only after `settings_saved`. LLM and system saves disable the shared Save button while pending; an error or disconnect releases it for retry without presenting an unacknowledged LLM configuration as active.

Main/audit provider choices match Gateway, including xAI, Groq and OpenRouter. Each opening restores confirmed audit values (including `maxIterations: 0`), discarding cancelled drafts. Provider Key caches are updated only after successful saving. The authenticated WebUI bridge adds the actual persisted LLM settings to a successful LLM `settings_saved` acknowledgement; the form uses that snapshot rather than assuming all submitted values were persisted unchanged. System-only saves do not replace LLM state. Turning audit off writes `{ "provider": "close" }`, so environment defaults cannot re-enable it after restarting. Invalid/unreadable LLM JSON rejects the initial connection with an error instead of opening an empty configuration session. The shared-file rule remains: restart an independently running WebUI after Gateway replaces account credentials.

### Theme Selector

Switch between 10 built-in financial color themes. Each user's theme selection is persisted in `user_settings.json` and applied to the entire interface via CSS variable overrides.

All themes share a common visual baseline: hairline borders for structural separation (`--border-light`), soft two-layer shadows, generous spacing, and elevated surfaces for the composer, floating menus, and modals. The default FinTech UI uses a white canvas and neutral gray sidebar with blue accents. The other nine palettes, including the dark Bloomberg palette, remain selectable; the layout uses their existing CSS variables.

When generating visual content (HTML, tables, charts, PPT, etc.), the LLM receives the user's current theme color scheme in the system prompt, ensuring generated content matches the user's interface style.

| Key | Name | Best For |
|-----|------|----------|
| `fintech` (default) | Modern FinTech | SaaS dashboards, tech startup decks |
| `oldmoney` | Old Money | Wealth management, private equity reports |
| `bloomberg` | Bloomberg / Quant | Dark dashboards, terminal style |
| `economist` | Economist | Research publications, data journalism |
| `saas` | Silicon Valley SaaS | Product analytics, growth decks |
| `mist` | Morning Mist | Muted slate blues, calm professional tone |
| `twilight` | Twilight | Muted violets, elegant dusk palette |
| `parchment` | Parchment | Warm sepia tones, classic document style |
| `azure` | Azure | Pale coastal blues, clean and airy |
| `gravel` | Gravel | Neutral warm grays, understated professional |

---

## Theme API

All endpoints in this table require the WebUI Bearer token.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/themes` | List all available themes |
| GET | `/api/user-theme?user=<id>` | Get user's current theme |
| POST | `/api/user-theme` | Save user's theme (`{ user, theme }` body) |

---

## Search Settings

The Web UI includes a dedicated "Search Settings" tab for configuring web search providers:

- **Active Search Provider** — Selects which search provider is currently in use; changes take effect immediately
- **Config Search Provider** — Selects which provider's configuration to edit; saved configurations are auto-populated

Settings are saved to `~/.hogagent/search_settings.json`.

## External MCP Settings

The External MCP tab manages `<HOGAGENT_USER_DIR>/mcp-servers.json` directly through HogAgent RPC. It can add, remove, enable, and disable Streamable HTTP or stdio services; configure environment-variable references, timeouts, concurrency and allowlists; probe a server catalog; and select a small direct-tool subset. Probe status distinguishes configuration, connection, protocol, authentication, and timeout failures.

Switching between HTTP and stdio preserves the server's common settings and replaces its transport-specific fields. Enter the URL or command for the selected type before saving.

The tab never edits `<workspace>/.hogagent/mcp-servers.json`; a manual workspace entry remains authoritative by server name. Saving or reloading is queued after an active Agent turn, and discovered direct-tool changes become visible only at a safe turn boundary.

The warning in this tab is an operational topology rule. HogAgent does not block any URL, port, name, or service identity, but a deployment should not point the Client at an MCP service that synchronously calls back into the same Agent/active orchestration chain. See [External MCP Client](./external-mcp.md).

---

## System Settings Tab

The System tab provides runtime configuration for:

- Three-state Bash sandbox mode: strict `enabled`, `fallback` to a bare shell on initialization failure, or default `disabled` direct-shell access on macOS/Linux. The configuration label states that Windows does not support the sandbox; Windows ignores every value and always exposes an `UNSANDBOXED` Windows PowerShell or verified Git Bash. `cmd.exe` is unsupported.
- Extension enable/disable toggles (content-compressor, sub-agent, delivery-manager, memory)
- Extension-specific parameters (e.g., `textThreshold` for content-compressor, `maxTurns` for sub-agent)
- `explicitCache` and `showCacheStats` toggles
- Memory system enable/disable

The internal `artifact-manifest` extension is intentionally not exposed as a toggle and its files are not shown as downloads.

Settings are saved to `~/.hogagent/hogagent.json`.

**Effect timing:** Content compression is off by default. Disabling takes effect at the next idle RPC boundary after the current top-level task finishes: both retrieval tools and their model-visible definitions are removed, the hook is detached, and cached Entry IDs expire. Enabling always requires a process restart. Threshold changes apply only to an already active compressor. Both save_settings and Gateway reload_config await the same extension configuration application; failures are reported rather than acknowledged as applied. Settings display persisted intent; the actual tool catalogue determines runtime capabilities. Sub-agent maxTurns remains hot-updated; sandboxMode applies to the next process/tool runtime.

---

## Related Documentation

- [Deployment](./deployment.md)
- [Configuration](./configuration.md)
- [Tool System](./tools.md)
- [External MCP Client](./external-mcp.md)

### 持久文件交付

下载卡片来自原生 tool-result details 和 hogagent.file-delivery 自定义记录，按回执 ID 恢复与去重。切换 Session、刷新和上下文压缩不靠文件名扫描重建卡片。下载 URL 保留原 Session/path/receipt；文件已变更显示 409，缺失显示 404，持久化失败没有下载卡片。详见 [文件交付](artifact-manifest.md)。

### Markdown 交付预览

`.md` / `.markdown` 交付卡片在“下载”左侧显示“预览”。点击打开大模态框，正文独立滚动；关闭按钮、遮罩和 Escape 均可关闭，并回到触发按钮。关闭或重新打开会取消旧请求、释放图片和图表资源。预览只读取原文件，下载内容保持原样。单篇上限为 2 MiB，超限提示下载；回执对应的文档已变化时提示重新交付。

- 文字、背景、链接、表格和 ECharts 跟随用户当前主题，打开期间切换主题也会更新。表格采用顶线、表头分隔线、底线三线样式；窄屏表格和长公式横向滚动。
- KaTeX 支持 `$…$`、`$$…$$`、`\(…\)`、`\[…\]`、equation/align 环境以及 `math` / `latex` / `tex` 代码块。含等号的独立简单计算行也会排版；普通代码保持原样。复杂计算请明确使用数学分隔符，不可解析的公式保留原文。
- Markdown 图片、HTML 图片和图表中的图片 URL 内嵌加载。相对路径以文档目录为基准，绝对路径必须仍位于同一受管根；本地图片沿用文档回执认证，不要求另建图片交付卡片。HTTP(S) 图片直接加载，不携带 WebUI Token 或 Referer；资源不可用时显示提示。
- 复用既有 `{图N}` 和 `[图表数据]` 格式，以及 `echarts` 代码块。正文占位符替换为交互图表或图片，代码和链接中的占位符保持原样。图表数据区隐藏 JSON，只保留编号和说明列表，其后的参考资料仍展示。仅接受数据型配置；历史 formatter 函数字面量安全剥离，解析失败显示提示，不执行报告中的 JavaScript。

示例：

````markdown
本期收入趋势：

{图1}

![经营概览](images/overview.png)

[图表数据]
- {图1}: {"option":{"xAxis":{"type":"category","data":["Q1","Q2"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[80,96]}]}} 季度收入

[参考资料]
统计口径说明。
````

渲染器在首次预览时从本地构建产物加载 Marked、DOMPurify、KaTeX 和 ECharts，不依赖 CDN。HTML 会净化，公式关闭可信命令，图表移除可执行格式化器及外链配置。图片读取复用 `/api/download` 的 `resource` 可选参数：先验证原文档 Session、路径、回执与指纹，再检查图片确实出现在文档引用中、真实路径位于同一受管根，且不是 `.hedgehog` 内部文件；仅允许图片扩展名。不创建新回执或图片快照，引用图片显示其当前内容。

回归测试：`test/web/markdown-document.test.ts` 检查图表尾注解析和图片路径边界，`test/web/delivery-download.test.ts` 检查实际下载认证及文档变更；构建后运行 `node test/browser/markdown-preview.mjs` 检查真实浏览器渲染、主题、响应式布局、恶意内容净化、超限提示和关闭时的资源清理。可通过 `HOGAGENT_BROWSER_EXECUTABLE` 指定 Chromium 路径，测试仅使用临时文档和模拟会话，不调用模型。

Download streams are bounded to the announced Content-Length, including on persistent HTTP connections. If a file grows during a transfer, the appended bytes cannot corrupt the following response. Empty files complete without opening a stream. Receipt checks still reject files already changed before download.
