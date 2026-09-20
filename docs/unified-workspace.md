# HogAgent 统一工作区（1.2.3）

Gateway 1.1.19 起采用共享用户 workspace。完整跨组件约定由 Gateway 项目的统一工作空间文档维护。本文件及该约定优先于历史审计中的旧布局说明。

- 业务目录：~/.hedgehoggateway/workspace/<user-namespace>/；默认 Shell CWD 永远为 workspace，项目命令使用调用级 cwd 或显式 cd，项目文件用绝对地址。projects 是 workspace 子目录，没有重复授权或额外项目沙箱。
- 用户工作区映射：Gateway 启动传入 `--user <原始用户ID> --workspace <workspaceRoot>`，HogAgent 在托管模式下也同步 `~/.hogagent/user_settings.json`（可由 `HOGAGENT_USER_DIR` 定位）中该用户的 `workspace_dir`，保留主题和其他用户配置。独立 CLI/WebUI 后续连接复用该映射；旧进程和历史 CWD 不改写，切换目录后重新连接并新建会话。
- 原生历史：~/.hogagent/sessions/<user-namespace>/<sessionId>.jsonl，独立于 tasks 和任务备份。恢复验证 ID/CWD，不改写旧 CWD；`switch_session(read_only=true)` 只读已保存记录，不运行自动修复，并绕过 Prompt 队列以支持任务执行期间查看。只读查询不修改当前 Session、Harness、运行时上下文或恢复标记；可写切换仍在队列内执行。
- 工作区 Skills：.hogagent/skills/；旧根 skills/ 不扫描。安装包 skills/ 保留。同名工作区 Skill 优先。安装、发现、UI、热加载和 hog-memory 回退都遵守该路径。
- 提示词：SYSTEM.md 保留必要原生约束；独立运行还加载 STANDALONE.md。完整 workspace/AGENTS.md 后追加 .hogagent/hogagent.md（不存在可跳过，不可读则报错）；仍保留运行时注入。Gateway 的两个文件来自受管 default 与 runtime/hogagent.md 模板，不替换用户章节外内容。
- 独立工作区规则（1.2.5 起）：CLI/Web 的 `default` 用户首次运行自动注册到 `<HOGAGENT_USER_DIR>/workspace`，已有映射优先。选择工作区或创建 Agent 时，从 HogAgent 自有的 `src/standalone-agents-template.ts` 初始化 `AGENTS.md`；模板版本独立维护，不读取、不依赖 Gateway 文件。升级仅替换旧版标记区，末尾用户规则及无标记旧文件内容原样保留，同版不重写、不降级。托管模式不运行此初始化。详见[配置文档](configuration.md#workspace-instructions-and-upgrades)。
- 主对话外层执行冻结 SYSTEM、根规则、追加规则及进程提示词快照，子 Agent/压缩重建继承；下一轮更新。执行中 Skill 重载明确拒绝，结束后重试。quick 有规则但无隐式工具；子 Agent、规划、审计、内部无状态调用不输出主对话交付信封。
- LLM Key 必须保存在 llm-settings.json，API Key 必须保存在 skills_config.json 对应 Skill 的 api-key 字段；Gateway 托管与独立 HogAgent/WebUI 共用。Gateway 登录、续期、切换用户及 Key 更新通过 HogAgent 配置 API 自动同步，文件操作和模型目录查询由 HogAgent 自己执行，保留模型和 Skill 偏好；HogAgent 不按托管标记过滤或禁止保存这些 Key。MCP 凭据仍走进程环境。跨账号运行时继续重启隔离，不自动重放结果不确定的调用。

迁移与调度冻结由 Gateway 管理，HogAgent 不自行搬动业务目录、伪造旧记录恢复或修改用户脚本。旧 sessionTaskDir 成果仍可查看和下载；继续工作应在新会话附上标明来源的任务/成果摘要。

原生 `ready.capabilities.supports_concurrent_history_read=true` 声明运行中只读历史能力，Gateway 根据握手结果准入。只读加载失败返回目标会话的 `session_history_error`，不发出执行 `error` 或终态事件，避免把历史读取失败混入当前任务。

首次实施的类型检查、构建、回归及独立进程原生工具验证记录由 Gateway 项目的跨组件验证文档维护。

后续审计统一了 long_task 的调用范围与宽松审计规则：规划、内部组、审计和最终回复分开声明格式；复杂任务不强制创建文件；最终审计获得各组真实执行结果；澄清恢复刷新当前轮策略。详见 [提示词审计记录](long-task-prompt-audit.md)。

第二轮审计进一步贯通多轮澄清、最新重试反馈与修正后结果；数据检索说明逐项核对实际工具，不能因一个检索工具存在就宣称其他检索工具可用。Skills 管理收紧名称与 ZIP 条目校验，并使用唯一暂存目录。HogAgent 专属 Gateway 模板同步到 1.4.1，根 AGENTS 的公共规范保持原有职责。
