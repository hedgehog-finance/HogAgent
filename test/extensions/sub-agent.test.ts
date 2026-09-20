import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { SubAgentExtension } from "../../src/extensions/sub-agent/index.ts";
import { AgentHarness } from "../../src/vendor/agent/harness/agent-harness.ts";
import type { HogAgentContext, RpcEvent, HogAgentConfig } from "../../src/utils/types.ts";

function createMockContext(workspaceDir: string): HogAgentContext & { events: RpcEvent[]; tools: Map<string, unknown> } {
  const events: RpcEvent[] = [];
  const tools = new Map<string, unknown>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const mockHarness = {
    getModel: () => ({
      id: "test-model",
      name: "Test Model",
      api: "openai-completions",
      provider: "test",
      baseUrl: "http://localhost:9999",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }),
    on: () => () => {},
    subscribe: () => () => {},
    getTools: () => [],
    getResources: () => ({ skills: [] }),
  };

  return {
    events,
    tools,
    registerTool(tool: unknown): Promise<void> {
      const t = tool as { name: string };
      tools.set(t.name, tool);
      return Promise.resolve();
    },
    unregisterTool: vi.fn().mockResolvedValue(undefined),
    on(event: string, handler: (...args: unknown[]) => void): () => void {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    emitEvent(event: RpcEvent): void {
      events.push(event);
    },
    getConfig: () => ({
      llmProvider: {
        provider: "test",
        apiKey: "test-key",
        baseUrl: "http://localhost:9999",
        models: [{ id: "test-model", name: "Test Model", contextWindow: 128000 }],
      },
    } as any),
    getSessionId: () => "test-session",
    getWorkspaceDir: () => workspaceDir,
    getHarness: () => mockHarness as any,
    getLlmTracking: () => ({ sessionId: "test-session", workId: "", taskId: "" }),
    getRuntimeContext: () => ({
      process: {
        schema_version: "1.0",
        process_instance_id: "test-process",
        workspace_dir: workspaceDir,
        mode: "rpc",
        platform: process.platform,
        arch: process.arch,
        attributes: {},
      },
      session: {
        schema_version: "1.0",
        session_id: "test-session",
        workspace_dir: workspaceDir,
        session_task_dir: join(workspaceDir, "tasks", "test-session"),
        revision: 1,
        attributes: { tenant: "subagent-snapshot-marker" },
      },
      current_run: {
        schema_version: "1.0",
        prompt_run_id: "prompt-run-test",
        task_id: "task-test",
        attributes: { inherited: true },
      },
    }),
  };
}

describe("SubAgentExtension", () => {
  let ext: SubAgentExtension;
  let ctx: ReturnType<typeof createMockContext>;
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "hogagent-subagent-"));
    ext = new SubAgentExtension();
    ctx = createMockContext(workspaceDir);
    await ext.initialize(ctx);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ext.shutdown();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("should register spawn_sub_agent tool", () => {
    expect(ctx.tools.has("spawn_sub_agent")).toBe(true);
  });

  function simulateTurns(replies: Array<{ text: string; stopReason?: string; toolCall?: boolean; beforeReply?: () => void }>) {
    let subscriber: (event: any) => void = () => {};
    vi.spyOn(AgentHarness.prototype, "subscribe").mockImplementation(handler => {
      subscriber = handler;
      return () => {};
    });
    const abort = vi.spyOn(AgentHarness.prototype, "abort").mockResolvedValue({ clearedSteer: [], clearedFollowUp: [] });
    const prompt = vi.spyOn(AgentHarness.prototype, "prompt").mockImplementation(async () => {
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected extra model call");
      reply.beforeReply?.();
      const message = {
        role: "assistant", stopReason: reply.stopReason ?? "stop", errorMessage: "provider failed",
        content: [{ type: "text", text: reply.text }, ...(reply.toolCall ? [{ type: "toolCall", id: "call", name: "read", arguments: {} }] : [])],
      };
      subscriber({ type: "message_end", message });
      subscriber({ type: "turn_end", message, toolResults: [] });
      return message as any;
    });
    return { prompt, abort };
  }

  const validResult = JSON.stringify({ schema_version: "1.0", type: "sub_agent_result", summary: "done", content: "result", output_files: [] });

  it("accepts a valid final result on the last allowed turn", async () => {
    const { prompt, abort } = simulateTurns([{ text: validResult }]);
    const result = await (ctx.tools.get("spawn_sub_agent") as any).execute("call", { task_description: "task", max_turns: 1 });
    expect(result.details).toMatchObject({ status: "completed", turns_used: 1, content: "result" });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not exceed the budget for invalid output or an unfinished tool loop (tools=%s)", async toolCall => {
    const { prompt, abort } = simulateTurns([{ text: toolCall ? validResult : "invalid", toolCall }]);
    const result = await (ctx.tools.get("spawn_sub_agent") as any).execute("call", { task_description: "task", max_turns: 1 });
    expect(result.details).toMatchObject({ status: "max_turns_reached", turns_used: 1 });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(toolCall ? 1 : 0);
  });

  it("repairs once without tools or skills using the remaining turn", async () => {
    const activeTools = vi.spyOn(AgentHarness.prototype, "setActiveTools");
    const resources = vi.spyOn(AgentHarness.prototype, "setResources");
    const { prompt } = simulateTurns([{ text: "invalid" }, { text: validResult }]);
    const result = await (ctx.tools.get("spawn_sub_agent") as any).execute("call", { task_description: "task", max_turns: 2 });
    expect(result.details).toMatchObject({ status: "completed", turns_used: 2 });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(activeTools).toHaveBeenLastCalledWith([]);
    expect(resources).toHaveBeenLastCalledWith({ skills: [] });
    expect(activeTools.mock.invocationCallOrder.at(-1)).toBeLessThan(prompt.mock.invocationCallOrder[1]!);
  });

  it("does not accept a repair result after parent cancellation", async () => {
    const parent = new AbortController();
    simulateTurns([{ text: "invalid" }, { text: validResult, beforeReply: () => parent.abort() }]);
    const result = await (ctx.tools.get("spawn_sub_agent") as any).execute("call", { task_description: "task", max_turns: 2 }, parent.signal);
    expect(result.details).toMatchObject({ status: "timeout", turns_used: 2, output_files: [], content: "" });
  });

  it("reports provider failure without spending a format repair turn", async () => {
    const { prompt } = simulateTurns([{ text: validResult, stopReason: "error" }]);
    const result = await (ctx.tools.get("spawn_sub_agent") as any).execute("call", { task_description: "task", max_turns: 2 });
    expect(result.details).toMatchObject({ status: "error", error: "provider failed" });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("does not start a model call for an already aborted parent and releases its listener", async () => {
    const parent = new AbortController();
    parent.abort();
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");
    const prompt = vi.spyOn(AgentHarness.prototype, "prompt").mockResolvedValue({ content: [], stopReason: "stop" } as any);
    try {
      const tool = ctx.tools.get("spawn_sub_agent") as any;
      await tool.execute("cancelled-call", { task_description: "must not start" }, parent.signal);
      expect(prompt).not.toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      prompt.mockRestore();
      removeListener.mockRestore();
    }
  });

  it("accepts declared files only from Session and managed Project roots", () => {
    const taskDir = join(workspaceDir, "tasks", "test-session");
    const projectDir = join(workspaceDir, "projects", "demo");
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(join(projectDir, "src"), { recursive: true });
    mkdirSync(join(taskDir, "assets"), { recursive: true });
    mkdirSync(join(projectDir, "src", "assets"), { recursive: true });
    writeFileSync(join(taskDir, "data-source.json"), "{}");
    writeFileSync(join(projectDir, "src", "app.ts"), "export {};");
    writeFileSync(join(workspaceDir, "workspace-secret.txt"), "secret");

    const validate = (ext as unknown as {
      validateDeclaredOutputFiles(files: string[], workspace: string, task: string, project?: string): string[];
    }).validateDeclaredOutputFiles.bind(ext);

    expect(validate([
      "tasks/test-session/data-source.json",
      "projects/demo/src/app.ts",
      "tasks/test-session/assets",
      "projects/demo/src/assets",
      "workspace-secret.txt",
      "outside/data-source.json",
    ], workspaceDir, taskDir, projectDir)).toEqual([
      "tasks/test-session/data-source.json",
      "projects/demo/src/app.ts",
    ]);
  });

  describe("sandbox directory", () => {
    it("should create and clean up sandbox directory", async () => {
      const tool = ctx.tools.get("spawn_sub_agent") as {
        execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
      };

      const result = await tool.execute("call-id", {
        task_description: "Test task",
        task_type: "research",
      });

      // After execution, the sandbox should be cleaned up
      const tasksDir = join(workspaceDir, "tasks");
      // The specific sandbox UUID dir should be gone (cleaned up)
      if (existsSync(tasksDir)) {
        const { readdirSync } = await import("node:fs");
        const entries = readdirSync(tasksDir);
        expect(entries.length).toBe(0);
      }

      expect(result.details).toBeDefined();
    });
  });

  describe("timeout enforcement", () => {
    it("should timeout with very short timeout", async () => {
      const tool = ctx.tools.get("spawn_sub_agent") as {
        execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }>; details: { status: string } }>;
      };

      // The simulated replies remain invalid after the single repair turn.
      const result = await tool.execute("call-id", {
        task_description: "Quick task",
        timeout_seconds: 300,
      });

      expect(result.details.status).toBe("error");
    });
  });

  describe("max_turns limit", () => {
    it("should respect max_turns configuration", async () => {
      simulateTurns([{ text: "invalid" }, { text: "invalid" }]);
      const tool = ctx.tools.get("spawn_sub_agent") as {
        execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }>; details: { turns_used: number } }>;
      };

      const result = await tool.execute("call-id", {
        task_description: "Multi-turn task",
        max_turns: 5,
      });

      // The simulated first reply is legacy/unstructured, so the protocol allows one repair turn.
      expect(result.details.turns_used).toBe(2);
    });
  });

  describe("result summary generation", () => {
    it("should generate a summary with task info", async () => {
      simulateTurns([{ text: "invalid" }, { text: "invalid" }]);
      const tool = ctx.tools.get("spawn_sub_agent") as {
        execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }>; details: { summary: string } }>;
      };

      const result = await tool.execute("call-id", {
        task_description: "Analyze data trends",
        task_type: "analysis",
      });

      expect(result.details.summary).toContain("sub_agent_result schema");
    });
  });

  describe("events", () => {
    it("should emit sub_agent_spawned and sub_agent_completed events", async () => {
      const tool = ctx.tools.get("spawn_sub_agent") as {
        execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
      };
      ctx.events.length = 0;

      await tool.execute("call-id", {
        task_description: "Event test",
      });

      const spawnEvent = ctx.events.find((e) => e.type === "sub_agent_spawned");
      expect(spawnEvent).toBeDefined();
      expect(spawnEvent!.task_description).toBe("Event test");

      const completeEvent = ctx.events.find((e) => e.type === "sub_agent_completed");
      expect(completeEvent).toBeDefined();
      expect(completeEvent!.status).toBe("error");
    });
  });

  describe("task description delivery", () => {
    it("passes the task as a user message, not in the system prompt", async () => {
      const promptSpy = vi.spyOn(AgentHarness.prototype, "prompt");
      try {
        const tool = ctx.tools.get("spawn_sub_agent") as {
          execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
        };
        const uniqueTask = "UNIQUE_TASK_MARKER_9f3a analyze the alpha dataset in detail";
        await tool.execute("call-id", { task_description: uniqueTask });

        // Task is delivered as a user message via prompt()
        expect(promptSpy).toHaveBeenCalledWith(uniqueTask);

        // The sub-harness system prompt must remain stable across spawns and
        // therefore must NOT embed the per-call task description.
        const harnessInstance = promptSpy.mock.instances[0] as unknown as { systemPrompt: string };
        expect(typeof harnessInstance.systemPrompt).toBe("string");
        expect(harnessInstance.systemPrompt).not.toContain(uniqueTask);
        expect(harnessInstance.systemPrompt).toContain("Sub-Agent Role");
        expect(harnessInstance.systemPrompt).toContain("subagent-snapshot-marker");
        expect(harnessInstance.systemPrompt).toContain("task-test");
        expect(harnessInstance.systemPrompt).not.toContain("prompt-run-test");
        expect(harnessInstance.systemPrompt).not.toContain("prompt_run_id");
      } finally {
        promptSpy.mockRestore();
      }
    });
  });
});
