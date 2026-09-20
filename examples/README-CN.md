# HogAgent RPC 示例

[English](README.md) · [简体中文](README-CN.md) · [HogAgent](../README-CN.md)

这些 TypeScript 示例演示如何通过 stdin/stdout JSONL 接口使用 HogAgent 的对话、工具执行、文件交付和会话管理能力。

- **官网：**[ciweiai.com/hogagent.html](https://ciweiai.com/hogagent.html)
- **相关金融数据源和工具：**[Hedgehog Skills](https://github.com/hedgehog-finance/hedgehog-skills/)

## 运行条件

使用 **Node.js >= 22.19.0**，在仓库根目录中安装依赖，并通过 Web UI 或 `~/.hogagent/llm-settings.json` 配置模型。涉及搜索和金融 Skills 的示例还需配置相应服务。Node.js 可直接运行这些 TypeScript 示例，无需额外运行器。命令在仓库根目录执行。

```bash
git clone https://github.com/hedgehog-finance/HogAgent.git
cd HogAgent
npm install
npm run build
node examples/basic-chat.ts
node examples/basic-chat.ts --message "你好" --debug
```

## 示例列表

| 文件 | 用途 |
|---|---|
| [rpc-client.ts](rpc-client.ts) | 可复用客户端、子进程生命周期和事件订阅 |
| [basic-chat.ts](basic-chat.ts) | 流式输出与多轮对话 |
| [mode-switching.ts](mode-switching.ts) | 模型思考深度设置 |
| [tool-usage.ts](tool-usage.ts) | 工具调用与执行事件 |
| [delivery-example.ts](delivery-example.ts) | 文件生成、交付与交付事件 |
| [workflow-example.ts](workflow-example.ts) | 引导、追问、状态查询与会话创建 |
| [full-session.ts](full-session.ts) | 完整会话生命周期 |

使用 `node examples/<文件名>.ts` 运行示例。客户端选择可用的 HogAgent 入口，提供 `start`、`sendCommand`、`prompt`、`followUp`、`steer`、`abort`、`getState`、`newSession`、模型配置和事件订阅方法。完整协议可通过 `sendCommand` 调用。

## 协议要点

```json
{"type":"prompt","text":"你好","mode":"standard"}
{"type":"follow_up","text":"请解释分析假设。"}
{"type":"steer","text":"请重点说明证据。"}
{"type":"get_state"}
{"type":"set_thinking_level","level":"medium"}
{"type":"new_session"}
{"type":"abort"}
```

子进程通过 `ready` 声明实际能力。客户端监听流式 `message_*`、工具 `tool_execution_*`、文件交付事件及终态 `agent_end` 或 `aborted`。单个 `error` 通知不一定代表运行结束，应结合终态与原因判断。上下文压缩自动执行。

Long Task 还需跟踪 `orchestration_resuming` 和 `orchestration_completed`。规划或执行阶段的内部 `agent_end` 不代表整个任务结束；应等到编排结束及其终态事件后，再关闭进程。

`prompt.mode` 支持 `quick`、`standard`、`long_task`。Quick 不使用工具，Standard 使用当前可用工具，Long Task 支持规划、执行和审核。通过 `run_context` 传递 `work_id`、`task_id` 标识任务归属。审核是否可用与任务是否完成分别记录。

工具列表取决于配置，应读取 `ready.capabilities.builtin_tools`，不要依赖固定工具数量。内容压缩默认关闭，相应检索工具仅在启用后可用。使用 Skill 时须完整读取指令；输出截断时按返回的偏移量继续。

命令结构、超时、取消和运行上下文见 [RPC 协议](../docs/orchestrator-integration.md)；用户、工作区和共享凭据见[配置指南](../docs/configuration.md)。

`waitForResponse()` 用于 Quick/Standard，必须在发送命令前订阅，等待完整 `agent_end` 回合，不能用用户、工具或单条助手消息的 `message_end` 作为结束信号。`npm run test:readme` 使用临时配置和本地模拟模型验证所有可运行示例及三种启动模式，无需真实 API Key。

`steer` 和 `follow_up` 只在正在执行的回合中使用；上一轮结束后继续对话请发送新的 `prompt`。
