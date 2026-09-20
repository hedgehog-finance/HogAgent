# Artifact Manifest 与文件交付

保留 `artifact-manifest`、`delivery-manager` 和 `deliver_files`。Manifest 负责发现和分类文件；`src/artifacts/file-delivery.ts` 消费其候选并生成交付回执，delivery-manager 扩展仅接入工具注册、Harness 持久消息及收尾生命周期。Manifest 和来源注释都是内部状态，不能作为交付物。

## 归属与目录

| 场景 | 权威写入方 | 自动交付 |
|---|---|---|
| 独立 HogAgent | 原生 artifact-manifest | 原生 FileDelivery |
| Gateway 普通 Session | Gateway Coordinator | Gateway |
| Gateway Development | Gateway 项目服务 | 既有项目、资源与发布流程 |

普通 Session current 为 `<sessionTaskDir>/.hedgehog/artifact-manifest.json`，快照为 `.hedgehog/manifests/<runId>.json`（Gateway Task 快照沿用 Task ID）。`task_id` 表示稳定业务任务，`run_id` 表示一次外层 Prompt 执行；Task 累积证据与本轮变化分别使用。

Gateway 启动标记 `HOGAGENT_GATEWAY_MANAGED=1` 要求 Prompt 明确给出 `manifest_owner=gateway`；缺失或冲突在模型调用前拒绝。准入校验现有 Manifest 的 owner 和 Session 身份，恢复 checkpoint 同样校验 owner、Session 和业务根。同一个业务根不能同时交给独立与托管运行，切换运行方式应使用各自的 Session 目录；不自动争抢或重写 owner。

HogAgent 通过 `supports_gateway_projects` 接入正式 Development 绑定和授权目录。Development 使用 `dashboard/src/data/artifacts`；原生独立项目仍使用 `publish/src/data`，两者不互相映射。项目权限和资源修订仍由 Gateway 项目服务控制，不能通过 `artifact_role` 或通用 `deliver_files` 绕过。

## 角色与修改策略

| role | 普通 Session 默认规则 | 默认 access |
|---|---|---|
| intermediate | `sub-output-*`、临时文件和内部编排记录 | none |
| raw_data | `data-*`、已登记的原始网页/API 数据 | none |
| regular | 普通工作文件，如 `report.md` | none |
| deliverable | `final-output-*` 或合法显式声明的成果 | delivery_event |

普通 Session 的 `write.artifact_role` 写入已有 `artifact-overrides.json`，独立和 Gateway 消费相同有效角色。因此 `report.md` 声明 deliverable 后可被正常成果选择。内部文件、原始数据及受保护路径不能降级；Development 显式角色操作在写入前拒绝。文件已写成功而角色登记失败时返回部分失败信息，不重写文件、不声称声明已生效。

独立项目的 `publish/`、`src/`、`data/` 默认分别是 deliverable、regular、raw_data，access 为 project_api。一次交付不改变 role/access。过期来源不再沿用，但既有原始数据的保护不会因此消失。

原生 `write/edit` 保留事前保护：已有 raw_data 不可覆盖；未锁定时可单次选择 in_place/new_version，否则使用上下文默认。已有 Session regular/deliverable 默认新版本；独立项目 regular 默认原地修改；同轮新建的非 raw 文件可继续写入。版本使用 `name-v2.ext` 等，失败的 edit 不生成空版本。

收尾核对接收完整 mutation 策略；只有明确 locked new_version 才报告对应违约，合法单次 in_place 不被默认策略误报。原始数据的原地变化独立报告。Bash、Skills 和其他 Provider 使用事后核对；提示词不等同原生写保护，不自动回滚或改名。

## 本轮基线与选择

最外层 Prompt 在模型执行前使用现有 scanner 捕获实际目录基线。Gateway 在派发前捕获。基线包含 size、mtime、ctime、文件身份及至多 50 MiB 文件的 SHA-256，覆盖未来时间戳、保留 mtime 的复制和两轮间修改。内部 group、审计和最终摘要不重建基线；新 Prompt/Continue Task 建立新基线。

收尾保存明确核对状态和本轮变化集合；重复成功收尾复用结果。没有基线或扫描失败时不消费旧 Manifest changes、不把全部历史文件当新增，并报告无法自动发现。

顶层最终回复使用尾部 `delivery_decision`（none/deliverables/raw_data/selected_files）；内部 group/sub-agent 只用对应 Schema 的 `output_files`。Schema 与文件事实代码由仓库 `contracts/` 生成。

- 锁定策略优先；有效 none 不自动交付。
- 非空明确清单限定交付范围，失败项也保留；全部失败不触发目录扩选。格式损坏的非空选择阻止自动扩选。
- 缺失决策或空清单回到有效默认：普通 Session deliverables，项目 none，并提示协议缺口。
- deliverables 保留正常角色成果选择，并补充本轮新增/改写的合格 `final-output-*.*`：basename 必须有非空名称及扩展名，只限当前普通 Session 受管目录，排除 raw_data、intermediate、内部及越界路径。兜底不改变角色，仍受锁定策略限制。
- 本轮符合兜底的不同格式、不同版本都保留，包括标记 superseded 的现存版本。稳定排序，每批最多 50 个，不做总量截断，逐文件报告失败。
- `data-index.md` 等伴随材料由明确清单选择。没有候选时只提示缺少成果，不额外调用模型造文件。

## 来源注释

实际落盘的原生 web_fetch 和 Skills 写 `.hedgehog/artifact-origins/<pathHash>.<contentSha256>.json`，只含 schema_version、根内相对 path、内容 sha256 和脱敏 origin。按文件及内容区分的独立原子注释避免跨进程共享 JSON 更新丢失；注释从不参与文件发现。

scanner 先发现业务文件，再读取与内容匹配的注释。继续兼容旧 `artifact-origins.json` 和旧 Manifest origin；旧表用于首次索引，后续仅保留未变文件上已有有效来源。旧记录没有内容校验证明，文件变化后失效，不能在下一轮从旧表重新带回，交付回执采用相同规则。URL 仅保留 scheme/host/path，不保存 query、fragment、凭据或请求体。保留必要时间、标题、工具/API 标识。原生大网页仍按原阈值落盘；小响应不强制保存。文件已落盘而注释失败时提示，不重新抓取。超过 50 MiB 的文件不创建未经完整内容指纹验证的来源注释。

Skills 使用显式 `--artifact-root` 指定 Session 根或正式项目根，不向上猜目录；`--dir/--out` 的路径基准保持。旧调用省略来源根可继续输出，但提示未登记来源。来源事实实现生成到权威 hedgehog-skills 库和已有分发副本。

## 回执、恢复与下载

`deliver_files({files:[{path,summary?}]})` 的路径相对 workspace（或受管绝对路径）；最终 selected_files 相对业务根。两入口共用一次路径解析、realpath/角色/策略检查与逐文件结果。同 run 同一未变文件使用稳定回执 ID，变化后的文件或新 run 使用不同 ID。

原生显式结果在 tool-result details 中携带协议、完整请求清单、成功回执和失败项。Harness 持久化 message_end 后才广播。自动交付在 Harness idle 后，通过绑定原 Session 的 appendCustomEntry 串行保存 `hogagent.file-delivery`，成功后广播；不改 vendor，不并发手写 JSONL。零成功可保留意图，但不产生卡片。

交付状态归属单个 run：并发收尾共用同一 Promise，异步读取或持久化后必须重验 Session、run、owner 和业务根。运行切换后停止旧批次，警告仍属于原 Session；已经持久化的整批回执不因广播失败再次登记。角色检查始终保留已索引 raw_data 的保护，真实路径进入 .hedgehog 的别名在文件解析时拒绝。

WebUI 从全部持久化工具回执和自动记录恢复卡片，按 ID 去重，不依赖模型压缩上下文或文件名扫描。下载沿用 `/api/download`，携带 Session、原路径和 receipt；校验受管根及文件指纹，原文件变化返回 409，丢失返回 404，不按同名文件回退。

Markdown 卡片提供主题化预览，详情见 [WebUI 文档预览](web-ui.md#markdown-交付预览)。内嵌本地图片复用该下载 URL 的 `resource` 参数，以未变化的 Markdown 回执授权实际引用的同根图片；拒绝未引用、非图片、越界及 `.hedgehog` 内部路径。不扩大直接下载权限、不产生图片回执或快照，引用图片按当前内容读取。

long_task 内部 group/sub-agent/审计不即时交付；最终摘要关闭工具。正常编排完成后，在唯一正式 agent_end 前核对与交付。审计未通过或跳过时说明真实验证状态；取消、澄清、异常或摘要失败不新增自动交付。摘要成功后 checkpoint 保存 completed 状态、运行身份和明确决策，原生收尾完成后清理；恢复 completed checkpoint 不再调用模型，仅复用明确清单并跳过已有真实回执。没有明确选择时不重发历史成果。

恢复执行同样由最外层收尾清理 checkpoint；交付钩子失败时保留 completed 恢复点。历史 deliverables/raw_data 或空清单在恢复时转换为 none，本地运行状态和发给 Gateway 的 turn_end 使用同一恢复决策；当前运行的锁定策略仍优先。
