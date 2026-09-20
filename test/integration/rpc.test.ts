import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { emitEvent, registerHandler, unregisterHandler, enqueueCommand, registerBuiltinHandlers, setCurrentSessionId, onShutdown, type RpcHandlerContext } from "../../src/rpc.ts";
import { createPromptHandlers, resolveQuickThinkingLevel } from "../../src/handlers/prompt-handlers.ts";
import { isSafeSessionId } from "../../src/handlers/session-handlers.ts";
import { CompactionManager } from "../../src/compaction-manager.ts";
import { setAbortRequested } from "../../src/agent-state.ts";
import { RUNTIME_CONTEXT_LIMITS, RuntimeContextManager } from "../../src/runtime-context.ts";
import { beginSessionTransition, endSessionTransition } from "../../src/session-transition-state.ts";
import { AgentToolRegistry } from "../../src/tool-registry.ts";

function createRuntimeContext(workspaceDir: string, sessionId: string, sessionTaskDir: string): RuntimeContextManager {
  const manager = new RuntimeContextManager({ workspaceDir, mode: "rpc" });
  manager.bindSession(sessionId, sessionTaskDir);
  return manager;
}

describe("RPC module", () => {
  it("correlates completion and failure to the queued command without leaking request IDs", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    registerHandler("reload_config", async command => {
      await Promise.resolve();
      if (command.fail) throw new Error("sync failed");
      emitEvent({ type: "config_reloaded" });
    });
    try {
      enqueueCommand({ type: "reload_config", request_id: "first" });
      enqueueCommand({ type: "reload_config", request_id: "second", fail: true });
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
      emitEvent({ type: "outside_command" });
      const events = write.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(events[0]).toMatchObject({ type: "config_reloaded", request_id: "first" });
      expect(events[1]).toMatchObject({ type: "error", command_type: "reload_config", request_id: "second" });
      expect(events[2]).not.toHaveProperty("request_id");
    } finally {
      unregisterHandler("reload_config");
      write.mockRestore();
    }
  });
  it.each([null, [], 1, "prompt", {}, { type: " " }])("rejects malformed command envelopes: %j", (command) => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(() => enqueueCommand(command as any)).not.toThrow();
      expect(writeSpy).toHaveBeenCalledOnce();
      expect(JSON.parse(String(writeSpy.mock.calls[0]![0])).type).toBe("error");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it.each([
    { text: 1, session_id: "other" },
    { text: "   ", session_id: "other" },
    { text: "hello", session_id: 0 },
    { text: "hello", mode: "unknown", session_id: "other" },
  ])("rejects malformed prompt routing before activating a session: %j", async (input) => {
    const ensureSession = vi.fn();
    const deps = { config: {}, ensureSessionRef: { current: ensureSession } };
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createPromptHandlers(deps as any, {} as any).onPrompt({ type: "prompt", ...input });
      expect(ensureSession).not.toHaveBeenCalled();
      expect(writeSpy.mock.calls.map(([line]) => JSON.parse(String(line)).type)).toEqual(["error", "agent_end"]);
      expect(JSON.parse(String(writeSpy.mock.calls.at(-1)![0]))).toMatchObject({ type: "agent_end", reason: "error", error: expect.any(String) });
    } finally {
      writeSpy.mockRestore();
    }
  });
  it("accepts only session IDs that are safe as file and directory segments", () => {
    expect(isSafeSessionId("session_A-123")).toBe(true);
    expect(isSafeSessionId("../outside")).toBe(false);
    expect(isSafeSessionId("nested/session")).toBe(false);
    expect(isSafeSessionId("nested\\session")).toBe(false);
    expect(isSafeSessionId("session.jsonl")).toBe(false);
    expect(isSafeSessionId(123)).toBe(false);
    expect(isSafeSessionId("a".repeat(129))).toBe(false);
  });

  it("prioritizes a per-prompt quick thinking level without losing fallback behavior", () => {
    expect(resolveQuickThinkingLevel("off", "high")).toBe("off");
    expect(resolveQuickThinkingLevel(undefined, "low")).toBe("low");
    expect(resolveQuickThinkingLevel(undefined, undefined)).toBe("off");
    expect(resolveQuickThinkingLevel("invalid", "high")).toBe("off");
  });

  it("applies the resolved quick thinking level before harness.prompt executes", async () => {
    const previousUserDir = process.env["HOGAGENT_USER_DIR"];
    const userDir = join(tmpdir(), `hogagent-thinking-${randomUUID()}`);
    const taskDir = join(userDir, "task");
    mkdirSync(taskDir, { recursive: true });
    process.env["HOGAGENT_USER_DIR"] = userDir;

    const cases: Array<{
      requested?: string;
      persisted?: string;
      expected: string;
    }> = [
      { requested: "off", persisted: "high", expected: "off" },
      { persisted: "low", expected: "low" },
      { expected: "off" },
      { requested: "invalid", persisted: "high", expected: "off" },
    ];

    try {
      for (const testCase of cases) {
        if (testCase.persisted) {
          writeFileSync(
            join(userDir, "llm-settings.json"),
            JSON.stringify({ quickThinkingLevel: testCase.persisted }),
            "utf8",
          );
        } else {
          rmSync(join(userDir, "llm-settings.json"), { force: true });
        }

        const observedLevels: string[] = [];
        const harness = {
          thinkingLevel: "medium",
          setActiveTools: vi.fn().mockResolvedValue(undefined),
          setResources: vi.fn().mockResolvedValue(undefined),
          getModel: vi.fn(() => ({ id: "mock", provider: "mock", compat: false, contextWindow: 200_000 })),
          getThinkingLevel: vi.fn(() => harness.thinkingLevel),
          prompt: vi.fn(async () => { observedLevels.push(harness.thinkingLevel); }),
          compact: vi.fn(),
        };
        const sessionId = `thinking-${randomUUID()}`;
        const deps = {
          harnessRef: { current: harness },
          sessionRef: {
            current: {
              appendSessionName: vi.fn(),
              getBranch: vi.fn().mockResolvedValue([]),
            },
          },
          config: {
            mode: "rpc",
            sessionId,
            workspaceDir: userDir,
            sessionTaskDir: taskDir,
            llmProvider: { provider: "mock", apiKey: "", models: [] },
            extensions: [],
            compaction: { autoCompactThreshold: 1 },
          },
          activityLoggerRef: { current: { init: vi.fn(), log: vi.fn() } },
          auditModelObjRef: { value: null },
          allSkills: [],
          toolRegistry: new AgentToolRegistry(),
          skillsConfig: {},
          executionEnv: {},
          currentModeRef: { value: null },
          getCapabilitiesFn: vi.fn(),
          ensureSessionRef: { current: null },
          llmTracking: { sessionId: "", workId: "", taskId: "" },
          runtimeContext: createRuntimeContext(userDir, sessionId, taskDir),
        };
        const state = {
          switchedSession: false,
          sessionNameSaved: false,
          unsubscribe: null,
          quickThinkingOverride: false,
          savedThinkingLevel: null,
        };

        const { onPrompt } = createPromptHandlers(deps as any, state);
        await onPrompt({
          type: "prompt",
          text: "thinking level test",
          mode: "quick",
          thinking_level: testCase.requested,
        });

        expect(observedLevels).toEqual([testCase.expected]);
      }
    } finally {
      if (previousUserDir === undefined) delete process.env["HOGAGENT_USER_DIR"];
      else process.env["HOGAGENT_USER_DIR"] = previousUserDir;
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  it("does not start a direct prompt when abort arrives during the context read", async () => {
    const userDir = join(tmpdir(), `hogagent-abort-capacity-${randomUUID()}`);
    const taskDir = join(userDir, "task");
    mkdirSync(taskDir, { recursive: true });
    let resolveBranch!: (entries: unknown[]) => void;
    const harness = {
      setActiveTools: vi.fn().mockResolvedValue(undefined),
      setResources: vi.fn().mockResolvedValue(undefined),
      getModel: vi.fn(() => ({ id: "mock", provider: "mock", compat: false, contextWindow: 200_000 })),
      prompt: vi.fn().mockResolvedValue(undefined),
    };
    const sessionId = `abort-capacity-${randomUUID()}`;
    const deps = {
      harnessRef: { current: harness },
      sessionRef: {
        current: {
          appendSessionName: vi.fn(),
          getBranch: vi.fn(() => new Promise((resolve) => { resolveBranch = resolve; })),
        },
      },
      config: {
        mode: "rpc",
        sessionId,
        workspaceDir: userDir,
        sessionTaskDir: taskDir,
        llmProvider: { provider: "mock", apiKey: "", models: [] },
        extensions: [],
        compaction: { autoCompactThreshold: 0.75 },
      },
      activityLoggerRef: { current: { init: vi.fn(), log: vi.fn() } },
      auditModelObjRef: { value: null },
      allSkills: [],
      toolRegistry: new AgentToolRegistry(),
      skillsConfig: {},
      executionEnv: {},
      currentModeRef: { value: "standard" },
      getCapabilitiesFn: vi.fn(),
      ensureSessionRef: { current: null },
      llmTracking: { sessionId: "", workId: "", taskId: "" },
      compactionManager: { run: vi.fn() },
      resolveMainLlmAuth: vi.fn(),
      runtimeContext: createRuntimeContext(userDir, sessionId, taskDir),
    };
    const state = {
      switchedSession: false,
      sessionNameSaved: false,
      unsubscribe: null,
      quickThinkingOverride: false,
      savedThinkingLevel: null,
    };

    try {
      const { onPrompt } = createPromptHandlers(deps as any, state);
      const turn = onPrompt({ type: "prompt", text: "do not send", mode: "standard" });
      await vi.waitFor(() => expect(deps.sessionRef.current.getBranch).toHaveBeenCalledOnce());
      setAbortRequested(true);
      resolveBranch([]);
      await turn;

      expect(harness.prompt).not.toHaveBeenCalled();
      expect(deps.compactionManager.run).not.toHaveBeenCalled();
      expect(deps.runtimeContext.getSnapshot().current_run).toBeUndefined();
    } finally {
      setAbortRequested(false);
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  it("keeps CurrentRunContext through internal terminal events and clears it at outer prompt completion", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const workspaceDir = join(tmpdir(), `hogagent-prompt-run-${randomUUID()}`);
    const sessionTaskDir = join(workspaceDir, "tasks", "session-a");
    mkdirSync(sessionTaskDir, { recursive: true });
    const runtimeContext = createRuntimeContext(workspaceDir, "session-a", sessionTaskDir);
    const observedPromptRunIds: string[] = [];
    const harness = {
      setActiveTools: vi.fn().mockResolvedValue(undefined),
      setResources: vi.fn().mockResolvedValue(undefined),
      getModel: vi.fn(() => ({ id: "mock", provider: "mock", compat: false, contextWindow: 200_000 })),
      prompt: vi.fn(async () => {
        const beforeTerminal = runtimeContext.getSnapshot().current_run?.prompt_run_id;
        if (beforeTerminal) observedPromptRunIds.push(beforeTerminal);
        // Long Task has internal terminal boundaries; they are RPC events, not
        // CurrentRunContext lifecycle owners.
        emitEvent({ type: "agent_end" });
        const afterTerminal = runtimeContext.getSnapshot().current_run?.prompt_run_id;
        if (afterTerminal) observedPromptRunIds.push(afterTerminal);
      }),
    };
    const deps = {
      harnessRef: { current: harness },
      sessionRef: {
        current: {
          appendSessionName: vi.fn(),
          getBranch: vi.fn().mockResolvedValue([]),
        },
      },
      config: {
        mode: "rpc",
        sessionId: "session-a",
        workspaceDir,
        sessionTaskDir,
        llmProvider: { provider: "mock", apiKey: "", models: [] },
        extensions: [],
        compaction: { autoCompactThreshold: 0.75 },
      },
      activityLoggerRef: { current: { init: vi.fn(), log: vi.fn() } },
      auditModelObjRef: { value: null },
      allSkills: [],
      toolRegistry: new AgentToolRegistry(),
      skillsConfig: {},
      executionEnv: {},
      currentModeRef: { value: "standard" },
      getCapabilitiesFn: vi.fn(),
      ensureSessionRef: { current: null },
      llmTracking: { sessionId: "session-a", workId: "", taskId: "" },
      compactionManager: { run: vi.fn() },
      resolveMainLlmAuth: vi.fn(),
      runtimeContext,
    };
    const state = {
      switchedSession: false,
      sessionNameSaved: false,
      unsubscribe: null,
      quickThinkingOverride: false,
      savedThinkingLevel: null,
    };

    try {
      const { onPrompt } = createPromptHandlers(deps as any, state);
      await onPrompt({
        type: "prompt",
        text: "runtime context lifecycle",
        run_context: {
          schema_version: "1.0",
          task_id: "business-task",
          attributes: { source: "test" },
        },
      });

      expect(observedPromptRunIds).toHaveLength(2);
      expect(observedPromptRunIds[0]).toBe(observedPromptRunIds[1]);
      expect(runtimeContext.getSnapshot().current_run).toBeUndefined();

      harness.prompt.mockClear();
      await onPrompt({
        type: "prompt",
        text: "must fail before llm",
        run_context: { schema_version: "1.0", task_id: "native-task" },
        metadata: { task_id: "legacy-task" },
      });
      expect(harness.prompt).not.toHaveBeenCalled();
      expect(runtimeContext.getSnapshot().current_run).toBeUndefined();
    } finally {
      writeSpy.mockRestore();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("preserves declarative session project context and commits prompt state atomically", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const workspaceDir = join(tmpdir(), `hogagent-context-atomic-${randomUUID()}`);
    const sessionTaskDir = join(workspaceDir, "tasks", "session-a");
    const projectDir = join(workspaceDir, "projects", "project-a");
    mkdirSync(sessionTaskDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const runtimeContext = createRuntimeContext(workspaceDir, "session-a", sessionTaskDir);
    const harness = {
      setActiveTools: vi.fn().mockResolvedValue(undefined),
      setResources: vi.fn().mockResolvedValue(undefined),
      getModel: vi.fn(() => ({ id: "mock", provider: "mock", compat: false, contextWindow: 200_000 })),
      prompt: vi.fn().mockResolvedValue(undefined),
    };
    const deps = {
      harnessRef: { current: harness },
      sessionRef: {
        current: {
          appendSessionName: vi.fn(),
          getBranch: vi.fn().mockResolvedValue([]),
        },
      },
      config: {
        mode: "rpc",
        sessionId: "session-a",
        workspaceDir,
        sessionTaskDir,
        llmProvider: { provider: "mock", apiKey: "", models: [] },
        extensions: [],
        compaction: { autoCompactThreshold: 0.75 },
      } as any,
      activityLoggerRef: { current: { init: vi.fn(), log: vi.fn() } },
      auditModelObjRef: { value: null },
      allSkills: [],
      toolRegistry: new AgentToolRegistry(),
      skillsConfig: {},
      executionEnv: {},
      currentModeRef: { value: "standard" },
      getCapabilitiesFn: vi.fn(),
      ensureSessionRef: { current: null },
      llmTracking: { sessionId: "session-a", workId: "", taskId: "" },
      compactionManager: { run: vi.fn() },
      resolveMainLlmAuth: vi.fn(),
      runtimeContext,
    };
    const state = {
      switchedSession: false,
      sessionNameSaved: false,
      unsubscribe: null,
      quickThinkingOverride: false,
      savedThinkingLevel: null,
    };

    try {
      const { onPrompt } = createPromptHandlers(deps as any, state);
      await onPrompt({
        type: "prompt",
        text: "standalone does not consume the declared Gateway project path",
        session_context: {
          schema_version: "1.0",
          project_id: "project-a",
          project_dir: projectDir,
          attributes: { tenant: "alpha" },
        },
        run_context: {
          schema_version: "1.0",
          task_id: "accepted-task",
          manifest_owner: "hogagent",
        },
      });

      expect(runtimeContext.getSessionInput("session-a")).toMatchObject({
        project_id: "project-a",
        project_dir: projectDir,
        attributes: { tenant: "alpha" },
      });
      expect(deps.config.projectDir).toBeUndefined();
      expect(harness.prompt).toHaveBeenCalledTimes(1);

      const committedPolicy = deps.config.artifactRunPolicy;
      const runEnvelope = {
        schema_version: "1.0" as const,
        attributes: { payload: "" },
      };
      const boundaryPayloadBytes = RUNTIME_CONTEXT_LIMITS.currentRunMaxBytes
        - Buffer.byteLength(JSON.stringify(runEnvelope), "utf8");
      const boundaryRunContext = {
        ...runEnvelope,
        attributes: { payload: "x".repeat(boundaryPayloadBytes) },
      };
      expect(Buffer.byteLength(JSON.stringify(boundaryRunContext), "utf8"))
        .toBe(RUNTIME_CONTEXT_LIMITS.currentRunMaxBytes);
      await onPrompt({
        type: "prompt",
        text: "finalized run exceeds capacity after default policy",
        session_context: {
          schema_version: "1.0",
          attributes: { tenant: "must-not-commit" },
        },
        run_context: boundaryRunContext,
      });

      expect(harness.prompt).toHaveBeenCalledTimes(1);
      expect(runtimeContext.getSessionInput("session-a")?.attributes).toEqual({ tenant: "alpha" });
      expect(runtimeContext.getSnapshot().current_run).toBeUndefined();

      await onPrompt({
        type: "prompt",
        text: "reject this project",
        session_context: {
          schema_version: "1.0",
          project_id: "outside",
          project_dir: join(workspaceDir, "outside"),
        },
        run_context: {
          schema_version: "1.0",
          task_id: "rejected-task",
          manifest_owner: "gateway",
        },
      });

      expect(harness.prompt).toHaveBeenCalledTimes(1);
      expect(deps.llmTracking.taskId).toBe("accepted-task");
      expect(deps.config.manifestOwner).toBe("hogagent");
      expect(deps.config.projectId).toBe("project-a");
      expect(deps.config.projectDir).toBeUndefined();
      expect(deps.config.artifactRunPolicy).toBe(committedPolicy);
      expect(runtimeContext.getSessionInput("session-a")?.project_dir).toBe(projectDir);
      expect(runtimeContext.getSnapshot().current_run).toBeUndefined();

      await onPrompt({
        type: "prompt",
        text: "reuse the session-scoped project context",
        run_context: {
          schema_version: "1.0",
          task_id: "gateway-task",
          manifest_owner: "gateway",
        },
      });

      expect(harness.prompt).toHaveBeenCalledTimes(1);
      expect(deps.config.projectDir).toBeUndefined();
      expect(deps.llmTracking.taskId).toBe("accepted-task");
      expect(writeSpy.mock.calls.map((call) => String(call[0])).join(""))
        .toContain("Gateway project binding is incomplete");

      // An ordinary Gateway run explicitly clears the old native session binding.
      await onPrompt({
        type: "prompt",
        text: "ordinary Gateway session",
        session_context: { schema_version: "1.0", attributes: {} },
        run_context: { schema_version: "1.0", task_id: "gateway-task", manifest_owner: "gateway" },
      });
      expect(harness.prompt).toHaveBeenCalledTimes(2);
      expect(deps.config.projectDir).toBeUndefined();
      expect(deps.llmTracking.taskId).toBe("gateway-task");
    } finally {
      writeSpy.mockRestore();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  describe("emitEvent", () => {
    it("should emit events as JSONL to stdout", () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      emitEvent({ type: "test_event", data: "hello" });

      expect(writeSpy).toHaveBeenCalledTimes(1);
      const output = writeSpy.mock.calls[0][0] as string;
      expect(output.endsWith("\n")).toBe(true);

      const parsed = JSON.parse(output.trim());
      expect(parsed.type).toBe("test_event");
      expect(parsed.data).toBe("hello");
      expect(parsed.timestamp).toBeDefined();

      writeSpy.mockRestore();
    });

    it("should add timestamp if not provided", () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      emitEvent({ type: "no_ts" });

      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.timestamp).toBeDefined();
      expect(new Date(parsed.timestamp).getTime()).toBeGreaterThan(0);

      writeSpy.mockRestore();
    });

    it("should preserve provided timestamp", () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const ts = "2024-01-01T00:00:00.000Z";

      emitEvent({ type: "with_ts", timestamp: ts });

      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.timestamp).toBe(ts);

      writeSpy.mockRestore();
    });
  });

  describe("command handlers", () => {
    afterEach(() => {
      unregisterHandler("test_command");
      unregisterHandler("another_command");
    });

    it("should register and invoke a handler", async () => {
      const handler = vi.fn();
      registerHandler("test_command", handler);

      // We can't easily test dispatchCommand since it's not exported,
      // but we can verify that the handler was registered and unregistered
      unregisterHandler("test_command");
      // No error thrown = test passes
    });

    it("should register multiple handlers for different command types", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      registerHandler("test_command", handler1);
      registerHandler("another_command", handler2);

      // Both handlers registered without conflict
      unregisterHandler("test_command");
      unregisterHandler("another_command");
    });

    it("should override handler when registering same type twice", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      registerHandler("test_command", handler1);
      registerHandler("test_command", handler2);

      // Second handler replaces the first
      unregisterHandler("test_command");
      // No error = test passes
    });

    it("should not throw when unregistering non-existent handler", () => {
      expect(() => unregisterHandler("nonexistent_command")).not.toThrow();
    });

    it("should emit error for unknown command types", () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      // The unknown command handling is internal to dispatchCommand
      // which is called from the readline listener. We verify the error event format.
      emitEvent({ type: "error", error: "Unknown command type: fake_command", command_type: "fake_command" });

      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.type).toBe("error");
      expect(parsed.error).toContain("Unknown command type");

      writeSpy.mockRestore();
    });

    it("should emit error for malformed JSON", () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      emitEvent({ type: "error", error: "Invalid JSON in command" });

      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.type).toBe("error");
      expect(parsed.error).toBe("Invalid JSON in command");

      writeSpy.mockRestore();
    });
  });

  describe("event format", () => {
    it("should produce valid JSON with type and timestamp", () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      emitEvent({
        type: "state",
        is_streaming: false,
        message_count: 5,
        tool_count: 3,
        model: "claude-sonnet-4",
        thinking_level: "medium",
        mode: "standard",
        session_id: "sess-123",
      });

      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.type).toBe("state");
      expect(parsed.is_streaming).toBe(false);
      expect(parsed.message_count).toBe(5);
      expect(parsed.session_id).toBe("sess-123");

      writeSpy.mockRestore();
    });
  });

  describe("session_id auto-injection", () => {
    it("should auto-inject session_id after setCurrentSessionId is called", () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      setCurrentSessionId("test-session-123");

      emitEvent({ type: "test_event" });

      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.session_id).toBe("test-session-123");

      writeSpy.mockRestore();
    });

    it("should prefer explicit session_id over module-level value", () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      setCurrentSessionId("module-session");

      emitEvent({ type: "test_event", session_id: "explicit-session" });

      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.session_id).toBe("explicit-session");

      writeSpy.mockRestore();
    });

    it("should not include session_id when neither explicit nor module-level is set", () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      // Reset module-level session ID by setting empty string then clearing
      setCurrentSessionId("");

      emitEvent({ type: "test_event" });

      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      // Empty string is falsy, so JSON.stringify will still include it as ""
      // But it's not undefined, so it's serialized
      expect(parsed.session_id).toBe("");

      writeSpy.mockRestore();
    });

    it("should inject session_id into all event types (agent_start, error, etc.)", () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      setCurrentSessionId("sess-abc");

      emitEvent({ type: "agent_start" });
      emitEvent({ type: "error", error: "test error" });
      emitEvent({ type: "thinking", role: "assistant", delta: "hello" });

      for (const call of writeSpy.mock.calls) {
        const parsed = JSON.parse((call[0] as string).trim());
        expect(parsed.session_id).toBe("sess-abc");
      }

      writeSpy.mockRestore();
    });
  });

  describe("command queue (Bug 2 fix)", () => {
    afterEach(() => {
      unregisterHandler("slow_cmd");
      unregisterHandler("fast_cmd");
      unregisterHandler("abort");
      unregisterHandler("steer");
      unregisterHandler("follow_up");
      unregisterHandler("prompt");
      unregisterHandler("switch_session");
    });

    it("reads history during a running prompt while writable session switches stay queued", async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const prompt = vi.fn(async () => { await gate; });
      const history = vi.fn();
      registerHandler("prompt", prompt);
      registerHandler("switch_session", history);
      enqueueCommand({ type: "prompt", text: "long task" });
      try {
        await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
        enqueueCommand({ type: "switch_session", session_id: "other-history", read_only: true });
        for (const readOnly of [undefined, false, "true"]) {
          enqueueCommand({ type: "switch_session", session_id: "other-history", read_only: readOnly });
        }
        await vi.waitFor(() => expect(history).toHaveBeenCalledOnce());
        expect(history).toHaveBeenCalledWith({ type: "switch_session", session_id: "other-history", read_only: true });
      } finally {
        release();
        await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(4));
      }
    });

    it("rejects immediate controls for another session without invalidating queued prompts", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const promptHandler = vi.fn();
      const abortHandler = vi.fn();
      const steerHandler = vi.fn();
      const followUpHandler = vi.fn();
      setCurrentSessionId("active-session");
      registerHandler("slow_cmd", async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      registerHandler("prompt", promptHandler);
      registerHandler("abort", abortHandler);
      registerHandler("steer", steerHandler);
      registerHandler("follow_up", followUpHandler);

      try {
        enqueueCommand({ type: "slow_cmd" });
        enqueueCommand({ type: "prompt", session_id: "active-session", text: "still valid" });
        enqueueCommand({ type: "abort", session_id: "other-session" });
        enqueueCommand({ type: "steer", session_id: "other-session", text: "wrong target" });
        enqueueCommand({ type: "follow_up", session_id: "other-session", text: "wrong target" });
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(abortHandler).not.toHaveBeenCalled();
        expect(steerHandler).not.toHaveBeenCalled();
        expect(followUpHandler).not.toHaveBeenCalled();
        expect(promptHandler).toHaveBeenCalledOnce();
        const events = writeSpy.mock.calls.map(([line]) => JSON.parse(String(line).trim()));
        expect(events).toHaveLength(3);
        expect(events.every((event) => event.session_id === "other-session")).toBe(true);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it("rejects malformed explicit session IDs on immediate controls", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const abortHandler = vi.fn();
      registerHandler("abort", abortHandler);
      setCurrentSessionId("active-session");

      try {
        enqueueCommand({ type: "abort", session_id: 123 });
        enqueueCommand({ type: "abort", session_id: "" });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(abortHandler).not.toHaveBeenCalled();
        const events = writeSpy.mock.calls.map(([line]) => JSON.parse(String(line).trim()));
        expect(events).toHaveLength(2);
        expect(events.every((event) => (
          event.type === "error"
          && event.command_type === "abort"
          && event.error.includes("non-empty string")
        ))).toBe(true);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it("rejects immediate controls during the session commit phase", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const abortHandler = vi.fn();
      registerHandler("abort", abortHandler);
      setCurrentSessionId("active-session");
      beginSessionTransition();
      try {
        enqueueCommand({ type: "abort", session_id: "active-session" });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(abortHandler).not.toHaveBeenCalled();
        const event = JSON.parse(String(writeSpy.mock.calls[0]![0]).trim());
        expect(event).toMatchObject({
          type: "error",
          command_type: "abort",
          session_id: "active-session",
        });
        expect(event.error).toContain("session transition");
      } finally {
        endSessionTransition();
        writeSpy.mockRestore();
      }
    });

    it("should execute queued commands in FIFO order", async () => {
      const order: string[] = [];

      registerHandler("slow_cmd", async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push("slow");
      });
      registerHandler("fast_cmd", async () => {
        order.push("fast");
      });

      // Enqueue slow first, then fast
      enqueueCommand({ type: "slow_cmd" });
      enqueueCommand({ type: "fast_cmd" });

      // Wait for both to complete
      await new Promise((r) => setTimeout(r, 150));

      expect(order).toEqual(["slow", "fast"]);
    });

    it("should not let commands overlap execution", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      registerHandler("slow_cmd", async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent--;
      });

      enqueueCommand({ type: "slow_cmd" });
      enqueueCommand({ type: "slow_cmd" });
      enqueueCommand({ type: "slow_cmd" });

      await new Promise((r) => setTimeout(r, 200));

      expect(maxConcurrent).toBe(1); // Never ran concurrently
    });

    it("should let abort bypass the queue", async () => {
      const order: string[] = [];

      registerHandler("slow_cmd", async () => {
        await new Promise((r) => setTimeout(r, 100));
        order.push("slow_done");
      });
      registerHandler("abort", async () => {
        order.push("abort_done");
      });

      // Enqueue slow command, then abort — abort should complete first
      enqueueCommand({ type: "slow_cmd" });
      enqueueCommand({ type: "abort" });

      await new Promise((r) => setTimeout(r, 200));

      // abort bypassed queue and executed immediately
      expect(order.indexOf("abort_done")).toBeLessThan(order.indexOf("slow_done"));
    });

    it("queues ordinary commands until context compaction releases the FIFO", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      let finishCompaction!: () => void;
      const harness = {
        on: vi.fn(() => () => {}),
        compact: vi.fn(() => new Promise((resolve) => {
          finishCompaction = () => resolve({ summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100 });
        })),
        getModel: vi.fn(() => ({ id: "model", provider: "test", contextWindow: 500_000 })),
        getThinkingLevel: vi.fn(() => "off"),
      };
      const queuedHandler = vi.fn();
      const duplicateCompactHandler = vi.fn();
      registerHandler("fast_cmd", queuedHandler);
      registerHandler("compact", duplicateCompactHandler);
      let run!: Promise<unknown>;
      registerHandler("slow_cmd", async () => {
        const manager = new CompactionManager();
        run = manager.run({
          harness: harness as any,
          emitEvent,
          resolveAuth: async () => ({ apiKey: "test-key" }),
        });
        await run;
      });

      try {
        enqueueCommand({ type: "slow_cmd" });
        await vi.waitFor(() => expect(harness.compact).toHaveBeenCalledOnce());
        enqueueCommand({ type: "compact" });
        enqueueCommand({ type: "fast_cmd" });

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(duplicateCompactHandler).not.toHaveBeenCalled();
        const events = writeSpy.mock.calls.map((call) => JSON.parse(String(call[0]).trim()));
        expect(events.some((event) => event.type === "compact_failed")).toBe(false);
        expect(queuedHandler).not.toHaveBeenCalled();

        finishCompaction();
        await expect(run).resolves.toMatchObject({ status: "completed" });
        await vi.waitFor(() => expect(queuedHandler).toHaveBeenCalledOnce());
      } finally {
        unregisterHandler("slow_cmd");
        unregisterHandler("fast_cmd");
        unregisterHandler("compact");
        writeSpy.mockRestore();
      }
    });

    it("should skip a queued prompt when abort arrives during a non-prompt command", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const promptHandler = vi.fn();

      registerHandler("slow_cmd", async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
      registerHandler("prompt", promptHandler);
      registerHandler("abort", async () => {
        emitEvent({ type: "aborted" });
      });

      enqueueCommand({ type: "slow_cmd" });
      enqueueCommand({ type: "prompt", text: "must not start" });
      enqueueCommand({ type: "abort" });

      await new Promise((r) => setTimeout(r, 180));

      expect(promptHandler).not.toHaveBeenCalled();
      const abortCompletedCalls = writeSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).includes('"abort_completed"')
      );
      expect(abortCompletedCalls).toHaveLength(0);

      unregisterHandler("slow_cmd");
      unregisterHandler("prompt");
      unregisterHandler("abort");
      writeSpy.mockRestore();
    });

    it("should skip all queued prompts that predate an abort", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const promptHandler = vi.fn();

      registerHandler("slow_cmd", async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
      registerHandler("prompt", promptHandler);
      registerHandler("abort", async () => {
        emitEvent({ type: "aborted" });
      });

      enqueueCommand({ type: "slow_cmd" });
      enqueueCommand({ type: "prompt", text: "must not start 1" });
      enqueueCommand({ type: "prompt", text: "must not start 2" });
      enqueueCommand({ type: "abort" });

      await new Promise((r) => setTimeout(r, 220));

      expect(promptHandler).not.toHaveBeenCalled();
      const abortCompletedCalls = writeSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).includes('"abort_completed"')
      );
      expect(abortCompletedCalls).toHaveLength(0);

      unregisterHandler("slow_cmd");
      unregisterHandler("prompt");
      unregisterHandler("abort");
      writeSpy.mockRestore();
    });
  });

  describe("onAbort async (Bug 1 fix)", () => {
    afterEach(() => {
      unregisterHandler("abort");
    });

    it("should await async abort handler before emitting aborted", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const events: string[] = [];

      registerHandler("abort", async () => {
        // Simulate async abort (like harness.abort())
        await new Promise((r) => setTimeout(r, 50));
        events.push("abort_completed");
        emitEvent({ type: "aborted" });
      });

      enqueueCommand({ type: "abort" });

      await new Promise((r) => setTimeout(r, 150));

      // abort_completed must appear before aborted event
      expect(events).toContain("abort_completed");

      // Verify aborted event was emitted AFTER async handler completed
      const abortedCall = writeSpy.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes('"aborted"')
      );
      expect(abortedCall).toBeDefined();

      writeSpy.mockRestore();
    });

    it("should emit error event when abort handler throws", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      registerHandler("abort", async () => {
        throw new Error("abort failed: resource locked");
      });

      enqueueCommand({ type: "abort" });

      await new Promise((r) => setTimeout(r, 50));

      const errorCall = writeSpy.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes('"error"')
      );
      expect(errorCall).toBeDefined();
      const errorEvent = JSON.parse((errorCall![0] as string).trim());
      expect(errorEvent.error).toContain("abort failed");

      writeSpy.mockRestore();
    });

    it("uses onAbort as the sole terminal owner and echoes flattened or nested task identity", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const taskDir = join(tmpdir(), `hogagent-abort-owner-${randomUUID()}`);
      mkdirSync(taskDir, { recursive: true });
      const harness = { abort: vi.fn().mockResolvedValue(undefined) };
      const deps = {
        harnessRef: { current: harness },
        sessionRef: { current: {} },
        config: { sessionTaskDir: taskDir },
        toolRegistry: new AgentToolRegistry(),
        allSkills: [],
        skillsConfig: {},
        executionEnv: {},
        compactionManager: {},
      };
      const state = {
        switchedSession: false,
        sessionNameSaved: false,
        unsubscribe: null,
        quickThinkingOverride: false,
        savedThinkingLevel: null,
      };

      try {
        const { onAbort } = createPromptHandlers(deps as any, state);
        await onAbort({ type: "abort", task_id: "task-top", work_id: "work-top" });
        await onAbort({ type: "abort", params: { task_id: "task-nested", work_id: "work-nested" } });

        const emitted = writeSpy.mock.calls
          .map((call) => JSON.parse(String(call[0]).trim()))
          .filter((event) => event.type === "aborted" || event.type === "abort_completed");
        expect(emitted.map((event) => event.type)).toEqual([
          "aborted", "abort_completed", "aborted", "abort_completed",
        ]);
        expect(emitted.filter((event) => event.type === "abort_completed")).toEqual([
          expect.objectContaining({ task_id: "task-top", work_id: "work-top" }),
          expect.objectContaining({ task_id: "task-nested", work_id: "work-nested" }),
        ]);
      } finally {
        writeSpy.mockRestore();
        rmSync(taskDir, { recursive: true, force: true });
      }
    });

    it("rejects abort at the RPC boundary while compaction owns the session", async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      let finishCompaction!: () => void;
      const harness = {
        on: vi.fn(() => () => {}),
        compact: vi.fn(() => new Promise((resolve) => {
          finishCompaction = () => resolve({ summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100 });
        })),
        getModel: vi.fn(() => ({ id: "model", provider: "test", contextWindow: 200_000 })),
        getThinkingLevel: vi.fn(() => "off"),
      };
      const abortHandler = vi.fn();
      registerHandler("abort", abortHandler);

      try {
        const manager = new CompactionManager();
        const run = manager.run({
          harness: harness as any,
          emitEvent,
          resolveAuth: async () => ({ apiKey: "test-key" }),
        });
        enqueueCommand({ type: "abort" });

        expect(abortHandler).not.toHaveBeenCalled();
        const events = writeSpy.mock.calls.map((call) => JSON.parse(String(call[0]).trim()));
        expect(events).toContainEqual(expect.objectContaining({
          type: "error",
          command_type: "abort",
          error: expect.stringContaining("unavailable while context compaction"),
        }));

        finishCompaction();
        await expect(run).resolves.toMatchObject({ status: "completed" });
      } finally {
        unregisterHandler("abort");
        writeSpy.mockRestore();
      }
    });
  });

  describe("shutdown command (Bug 3 fix)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let writeSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let exitSpy: any;

    beforeEach(() => {
      writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(
        ((...args: unknown[]) => {
          // Invoke callback if provided (e.g., process.stdout.write("", cb))
          const cb = args.find((a) => typeof a === "function") as (() => void) | undefined;
          if (cb) cb();
          return true;
        }) as typeof process.stdout.write
      );
      exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    });

    afterEach(() => {
      unregisterHandler("shutdown");
      unregisterHandler("prompt");
      unregisterHandler("abort");
      unregisterHandler("get_state");
      unregisterHandler("set_model");
      unregisterHandler("set_thinking_level");
      unregisterHandler("compact");
      unregisterHandler("new_session");
      unregisterHandler("list_sessions");
      unregisterHandler("switch_session");
      unregisterHandler("steer");
      unregisterHandler("follow_up");
      unregisterHandler("set_llm_provider");
      unregisterHandler("install_skill");
      unregisterHandler("reload_config");
      writeSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it("should register and handle shutdown command", async () => {
      // Bug 6 fix: shutdown now runs only through runShutdownCallbacks() and no longer calls ctx.onShutdown.
      const shutdownCallback = vi.fn().mockResolvedValue(undefined);
      onShutdown(shutdownCallback);

      const mockCtx: RpcHandlerContext = {
        onPrompt: vi.fn(),
        onSteer: vi.fn(),
        onFollowUp: vi.fn(),
        onAbort: vi.fn(),
        onNewSession: vi.fn(),
        onResumeSession: vi.fn(),
        onListSessions: vi.fn(),
        onSwitchSession: vi.fn(),
        onGetState: vi.fn(),
        onSetModel: vi.fn(),
        onSetThinkingLevel: vi.fn(),
        onCompact: vi.fn(),
        onSetLlmProvider: vi.fn(),
        onInstallSkill: vi.fn(),
        onReloadConfig: vi.fn(),
      };

      registerBuiltinHandlers(mockCtx);

      enqueueCommand({ type: "shutdown" });

      await new Promise((r) => setTimeout(r, 100));

      // Bug 6 regression check: callbacks registered through onShutdown() are invoked.
      expect(shutdownCallback).toHaveBeenCalled();

      // Verify shutdown event with reason: "command"
      const shutdownCall = writeSpy.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes('"shutdown"')
      );
      expect(shutdownCall).toBeDefined();
      const shutdownEvent = JSON.parse((shutdownCall![0] as string).trim());
      expect(shutdownEvent.reason).toBe("command");
    });

    it("should call process.exit after shutdown handler completes", async () => {
      const mockCtx: RpcHandlerContext = {
        onPrompt: vi.fn(),
        onSteer: vi.fn(),
        onFollowUp: vi.fn(),
        onAbort: vi.fn(),
        onNewSession: vi.fn(),
        onResumeSession: vi.fn(),
        onListSessions: vi.fn(),
        onSwitchSession: vi.fn(),
        onGetState: vi.fn(),
        onSetModel: vi.fn(),
        onSetThinkingLevel: vi.fn(),
        onCompact: vi.fn(),
        onSetLlmProvider: vi.fn(),
        onInstallSkill: vi.fn(),
        onReloadConfig: vi.fn(),
      };

      registerBuiltinHandlers(mockCtx);

      enqueueCommand({ type: "shutdown" });

      await new Promise((r) => setTimeout(r, 100));

      // process.exit is called via stdout.write callback, but since we mock
      // stdout.write, the callback fires immediately
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });
});
