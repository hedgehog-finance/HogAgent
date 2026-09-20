# HogAgent

[English](README.md) · [简体中文](README-CN.md) · [日本語](README-JA.md)

HogAgent 是针对金融投研优化的通用 AI Agent 引擎，通过模型推理、工具和 Skills 完成研究、分析及文件任务，提供浏览器界面和便于应用集成的 JSONL RPC 接口。

- **官网：**[ciweiai.com/hogagent.html](https://ciweiai.com/hogagent.html)
- **相关金融数据源和工具：**[Hedgehog Skills](https://github.com/hedgehog-finance/hedgehog-skills/)
- **版本：**`1.2.4` · **许可证：**[GPL-3.0](LICENSE)

## 主要能力

- **任务执行：**Quick、Standard 和 Long Task 三种模式；长任务支持规划、检查点、审核和恢复。审核是否可用、是否通过与任务完成状态分别记录。
- **工具与 Skills：**文件操作、Shell、数学计算、网页搜索和内容抓取。内置八个 Skill，覆盖技能创建、金融计算、图表、演示文稿、文档转换、表格、技术指标和公司估值。
- **扩展：**按需启用内容压缩、子 Agent、产物追踪、文件交付、持久记忆和外部 MCP 服务。内容压缩默认关闭。
- **模型：**支持多家模型提供商及自定义 OpenAI 兼容接口，主模型与审核模型分别配置。
- **Web UI：**流式对话、会话历史、用户与工作区选择、模型设置、Skills、工具、主题和文件预览。
- **应用集成：**通过 stdin/stdout 交换 JSONL 命令与事件，支持会话持久化、自动上下文压缩及进程、会话、当轮运行上下文。Gateway 提供经过认证的项目绑定并管理项目元数据。

Pi Agent Harness 内置于 `src/vendor/`。HogAgent 可独立运行，也可作为 HedgehogGateway、IDE 插件或其他应用的子进程。

## 安装与运行

支持 macOS、Linux、Windows，要求 **Node.js >= 22.19.0**。通过 Shell 使用 Python 时，需要可用的 Python 解释器及 `venv`。

```bash
git clone https://github.com/hedgehog-finance/HogAgent.git
cd HogAgent
npm install
npm run build

# 浏览器界面：http://localhost:9108
node dist/bin/hogagent-web.js --port 9108 --workspace /absolute/path/to/workspace

# 终端对话
node dist/bin/hogagent.js --mode interactive --user default --workspace /absolute/path/to/workspace

# 应用集成
node dist/bin/hogagent.js --mode rpc --user default --session example --workspace /absolute/path/to/workspace
```

启动命令应在仓库根目录分别运行。请将 `/absolute/path/to/workspace` 替换为自己的绝对目录，含空格时加引号。发送消息前需配置有效的 API Key；仅启动 Web UI 不需要。Web UI 用 Ctrl+C 停止，终端对话输入 `/exit` 退出。已有主仓库时直接进入 `hogagent/`，无需重新克隆。

在 Web UI 或 `~/.hogagent/llm-settings.json` 中配置模型：

```json
{
  "provider": "hedgehog",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.ciweiai.com/api/llm/v1",
  "modelId": "qwen3.8-flash"
}
```

模型名称以提供商实际可用模型为准。搜索配置位于 `~/.hogagent/search_settings.json`；金融数据凭据保存在 `~/.hogagent/skills_config.json` 对应 Skill 的 `api-key` 中。独立运行与 Gateway 托管运行共用这一配置目录。

## 工作区与运行环境

`--workspace` 指定用户工作区，用户映射保存在 `~/.hogagent/user_settings.json`。会话历史位于 `~/.hogagent/sessions/<用户目录>/`。工作区指令依次加载 `AGENTS.md` 和 `.hogagent/hogagent.md`，工作区 Skills 位于 `.hogagent/skills/`。

Shell 隔离由 `~/.hogagent/hogagent.json` 中的 `sandboxMode` 控制。在 macOS/Linux 上，`enabled` 要求系统沙箱可用，`fallback` 允许失败后无沙箱运行，默认值 `disabled` 不启用系统隔离。Windows Shell 无沙箱隔离。部署配置请参阅[工具权限说明](docs/tools.md)。

## 开发与评测

```bash
npm run check
npm test -- --run
npm run build
npm run test:readme
```

`npm run test:readme` 无需 API Key，可验证构建后的启动方式与 RPC 示例。测试环境、真实模型覆盖范围和限制见[发布验证记录](docs/release-validation.md)。

[RPC 示例](examples/README-CN.md)介绍应用集成。[FinanceGym](FinanceGym/README.md)提供 `qwen3.8-flash` 在 `standard` 模式下的测试条件、最终报告及 20 道题目与对应答题报告。

## 文档

| 文档 | 内容 |
|---|---|
| [架构](docs/architecture.md) | 运行时、任务编排和组件边界 |
| [部署](docs/deployment.md) | 安装与部署 |
| [配置](docs/configuration.md) | 模型、搜索、共享设置和工作区 |
| [RPC 协议](docs/orchestrator-integration.md) | 命令、事件和运行上下文 |
| [工具](docs/tools.md) / [Skills](docs/skills.md) | 工具参数与技能开发 |
| [扩展](docs/extensions.md) / [外部 MCP](docs/external-mcp.md) | 扩展接口与外部服务 |
| [产物](docs/artifact-manifest.md) | 文件分类与交付 |
| [Web UI](docs/web-ui.md) | 对话、设置和文件预览 |
| [开发](docs/development.md) / [故障排除](docs/troubleshooting.md) | 构建、测试和诊断 |

Windows 检出保留 LF 换行以保证构建一致。Python 环境支持经过验证的框架解释器符号链接；下载期间文件增长不会突破已声明的响应长度。
