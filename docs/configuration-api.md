# HogAgent 配置管理接口

HogAgent 拥有 LLM 配置持久化、Skill 配置持久化与 Provider 模型目录查询。Gateway 管理账号登录和 Key 生命周期，通过此接口同步，不直接读写 HogAgent 的两份凭据文件。Gateway 自己的内部服务仍使用账号 `keys.json`。

## 传输与生命周期

入口为 `node dist/bin/hogagent-config.js`。标准输入接收一条 JSON 请求，读到 EOF 后执行；标准输出只返回一条 `{ "success": true, "data": ... }` 或 `{ "success": false, "error": "..." }`。日志走 stderr，不输出 Key。请求上限 1 MiB。

这是同一系统用户启动的本地子进程接口，无需 HTTP 端口、WebUI、Agent Session 或 LLM 推理。凭据只经 stdin 传递，不放入命令行参数。`HOGAGENT_USER_DIR` 由 Gateway 和独立 HogAgent 共用，必须为绝对路径；未设置时使用当前系统用户的 `~/.hogagent`。`HOGAGENT_PROJECT_ROOT` 指向安装目录。Windows 路径和权限要求见 [配置文档](configuration.md#windows-paths-and-permissions)。源码检出可在 Node 22.19+ 上执行 `bin/hogagent-config.ts`；发布包使用编译入口。

传输使用 UTF-8，接受 UTF-8 BOM 和 CRLF；流式解码保留跨数据块的中文和 emoji。Gateway 直接以 Node 可执行文件加参数数组启动入口，不经 shell 拼接，因此安装目录和配置目录中的空格、中文、`&` 等不会被解释为命令。Windows 子进程环境按变量名忽略大小写合并，显式的目录和空 Key 覆盖继承值。

Gateway 对配置请求串行调用，模型查询独立异步执行；配置请求超时 10 秒，模型查询超时 45 秒。接口缺失需升级 HogAgent，禁止回退直接写文件或拿 `keys.json` 代替模型认证。未安装 HogAgent 时不影响其他 Agent 的登录，安装后的首次连接补做凭据同步。

## 请求

| type | 其他字段 | 返回 data |
|---|---|---|
| `get_settings` | 无 | `{ settings }`：完整 LLM 配置 |
| `save_settings` | `settings`：配置补丁 | `{ settings }`：合并后的配置 |
| `refresh_models` | 可选 `provider`、`baseUrl`、`apiKey` | `{ provider, baseUrl, modelId, models, error? }` |
| `sync_credentials` | 可选 `llm: { apiKey, provider?, model?, baseUrl? }`、`apiKey`、`workspace` | `{ settings }` |
| `get_skill_config` | `name` | `{ config }` |
| `configure_skill` | `name`、`config` | `{ ok: true }` |

`refresh_models` 复用 `model-updater.ts`，同会话内 `refresh_models` RPC 共用 `listConfiguredModels`。显式请求 Key 优先（空字符串表示无凭据，不回退）；省略时优先使用共享配置的当前主 Key，再使用对应 `providerApiKeys`。Hedgehog 缺少 LLM Key 时直接返回配置错误，不发送无认证的模型请求。Hedgehog `/api/llm/**`（包括模型 ID 列表）使用 LLM Key；数据 API Key 不参与该请求。显式 Base URL 优先，保持自定义代理的路由。

`save_settings` 保留同 provider 的未指定字段并同步主 Key 与 provider Key 缓存。切换 provider 时，省略 Key 只使用目标 provider 缓存，没有缓存则清空；省略地址和模型时清空旧值，不沿用另一 provider 的端点。audit 局部更新保留同 provider 的配置，切换 provider 遵循同样的隔离规则，`audit: {}` 清除审核配置。`sync_credentials` 由 Gateway 登录、续期、更新及切换账号调用：LLM Key 写入 `llm-settings.json`，API Key 写入 `skills_config.json` 相应 `hedgehog-*` Skill 的 `api-key`。Skill 名称由 HogAgent 自行扫描系统、安装目录和给定 workspace 下的 `.hogagent/skills`，并合并已有配置项。

同步保留模型、Base URL、思考级别、第三方 Key、Skill 标志及明确关闭的审核模型。空 Key 清除旧值，省略字段保持不变；损坏 JSON 不覆盖，写入使用同目录唯一临时文件及原子替换。POSIX 文件权限为 `0600`，Windows 继承目录 ACL，不能把 `0600` 视为 Windows 用户隔离。读取和写入权限失败、只读文件或文件锁导致的替换失败会返回 `success: false`，包含文件路径和错误码，不回退直接写目标文件，也不改变系统权限。两份文件不是跨文件事务；任一失败都使同步失败，修复权限后重试完整同步。Gateway 账号元数据中的历史第三方配置不覆盖 HogAgent 的个人配置。

连接状态和主模型的 provider 都不限制账号同步：即使 HogAgent 未连接、主模型使用 OpenAI 等第三方，也必须更新 `providerApiKeys.hedgehog`；主模型使用 Hedgehog 时更新主 `apiKey`；audit 使用 Hedgehog 时无条件一并更新 `audit.apiKey`。未使用 Hedgehog 的主模型和审核模型保持原有 Key。

## 已运行进程

此接口负责持久化。Gateway 对已连接的 HogAgent 仍发送现有 `save_settings` / `set_model` / `reload_config` RPC，由 FIFO 在安全边界应用。Gateway 的 `save_settings` 带 `reloadPersistedLlm: true`，在命令实际执行时读取最新共享文件并只更新内存，不再把排队的旧快照写回文件。若通知中的凭据与文件已不同则报错，要求重新应用或重启，避免旧账号进程读入新账号的 Key。配置子进程启动前还会核对同步请求所属账号，拒绝切换账号后才执行的旧账号写入；连接阶段显式传入本次解析出的安装目录，Skill 同步必须等待写入完成后才返回。API Key 更新还同步连接池和后续进程环境；不重放结果不确定的调用。跨账号切换及自动替换 LLM Key 沿用 Gateway 重启边界。

独立 WebUI 与托管 HogAgent 共享文件；已运行的独立 WebUI 在账号或 Key 改变后需重启。文件共享不提供多个账号并发写同一配置目录的隔离，也不自动热切换无关进程。
