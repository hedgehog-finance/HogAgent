import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openStorage: vi.fn(),
  repairTree: vi.fn(),
}));

vi.mock("../../src/session-storage.ts", () => ({
  openOrCreateSessionStorage: mocks.openStorage,
  repairSessionTree: mocks.repairTree,
}));

vi.mock("../../src/vendor/agent/harness/agent-harness.ts", () => ({
  AgentHarness: class MockAgentHarness {
    readonly abort = vi.fn().mockResolvedValue(undefined);
    readonly subscribe = vi.fn(() => vi.fn());
    readonly on = vi.fn(() => vi.fn());
    readonly options: unknown;

    constructor(options: unknown) {
      this.options = options;
    }
  },
}));

import { createSessionHandlers } from "../../src/handlers/session-handlers.ts";
import { RuntimeContextManager } from "../../src/runtime-context.ts";
import { setCurrentSessionId } from "../../src/rpc.ts";
import { AgentToolRegistry } from "../../src/tool-registry.ts";
import { JsonlSessionStorage } from "../../src/vendor/agent/harness/session/jsonl-storage.ts";
import { Session } from "../../src/vendor/agent/harness/session/session.ts";
import { InMemorySessionStorage } from "../../src/vendor/agent/harness/session/memory-storage.ts";

function createFixture(workspaceDir: string) {
  vi.stubEnv("HOGAGENT_USER_DIR", join(workspaceDir, ".native"));
  const oldSessionId = "session-old";
  const oldTaskDir = join(workspaceDir, "tasks", oldSessionId);
  mkdirSync(oldTaskDir, { recursive: true });
  const oldHarness = {
    abort: vi.fn().mockResolvedValue(undefined),
    getModel: vi.fn(() => ({ id: "mock", provider: "mock", contextWindow: 128_000 })),
    getThinkingLevel: vi.fn(() => "medium"),
  };
  const oldLogger = { close: vi.fn() };
  const oldUnsubscribe = vi.fn();
  const runtimeContext = new RuntimeContextManager({ workspaceDir, mode: "rpc" });
  runtimeContext.bindSession(oldSessionId, oldTaskDir, {
    schema_version: "1.0",
    attributes: { tenant: "old" },
  });
  setCurrentSessionId(oldSessionId);

  const deps = {
    harnessRef: { current: oldHarness },
    sessionRef: { current: { id: oldSessionId } },
    config: {
      mode: "rpc",
      sessionId: oldSessionId,
      workspaceDir,
      sessionTaskDir: oldTaskDir,
      llmProvider: { provider: "mock", apiKey: "", models: [] },
      extensions: [],
      compaction: { autoCompactThreshold: 0.75 },
    },
    activityLoggerRef: { current: oldLogger },
    auditModelObjRef: { value: null },
    allSkills: [],
    toolRegistry: new AgentToolRegistry(),
    skillsConfig: {},
    executionEnv: {},
    currentModeRef: { value: "standard" },
    getCapabilitiesFn: vi.fn(() => ({})),
    ensureSessionRef: { current: null },
    llmTracking: { sessionId: oldSessionId, workId: "", taskId: "" },
    compactionManager: { run: vi.fn() },
    resolveMainLlmAuth: vi.fn(),
    runtimeContext,
  };
  const state = {
    switchedSession: false,
    sessionNameSaved: false,
    unsubscribe: oldUnsubscribe,
    quickThinkingOverride: false,
    savedThinkingLevel: null,
  };
  return { deps, state, oldHarness, oldLogger, oldUnsubscribe, runtimeContext, oldSessionId, oldTaskDir };
}

describe("session transition transaction", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  beforeEach(() => {
    mocks.openStorage.mockReset();
    mocks.repairTree.mockReset().mockResolvedValue(undefined);
  });

  it.each(['missing', 'corrupt'])("reports %s read-only history separately from active execution errors", async (failure) => {
    const workspaceDir = join(tmpdir(), `hogagent-history-error-${randomUUID()}`);
    mkdirSync(join(workspaceDir, ".native", "sessions", "default"), { recursive: true });
    const fixture = createFixture(workspaceDir);
    if (failure === 'corrupt') writeFileSync(join(workspaceDir, ".native", "sessions", "default", "target.jsonl"), "broken\n");
    vi.spyOn(JsonlSessionStorage, "open").mockRejectedValue(new Error("Invalid history"));
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const handlers = createSessionHandlers(fixture.deps as any, fixture.state as any);
      await handlers.onSwitchSession({ type: "switch_session", session_id: "target", read_only: true });
      await (fixture.deps.ensureSessionRef.current as any)(fixture.oldSessionId);
      const events = writeSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(events).toEqual([expect.objectContaining({
        type: "session_history_error", session_id: "target", read_only: true, error: expect.any(String),
      })]);
      expect(fixture.deps.harnessRef.current).toBe(fixture.oldHarness);
      expect(fixture.oldHarness.abort).not.toHaveBeenCalled();
      expect(mocks.openStorage).not.toHaveBeenCalled();
      expect(mocks.repairTree).not.toHaveBeenCalled();
    } finally { rmSync(workspaceDir, { recursive: true, force: true }); }
  });

  it.each([false, true])("restores Long Task answers across tool-only messages, multiple rounds and compaction=%s", async (compact) => {
    const workspaceDir = join(tmpdir(), `hogagent-history-presentation-${randomUUID()}`);
    const fixture = createFixture(workspaceDir);
    mkdirSync(join(workspaceDir, ".native", "sessions", "default"), { recursive: true });
    writeFileSync(join(workspaceDir, ".native", "sessions", "default", "target.jsonl"), "existing\n");
    mkdirSync(join(workspaceDir, "tasks", "target"), { recursive: true });
    writeFileSync(join(workspaceDir, "tasks", "target", "mode.json"), JSON.stringify({ mode: "long_task", complexAssistantCount: 28 }));
    const storage = new InMemorySessionStorage();
    const session = new Session(storage);
    const append = (role: string, text: string) => session.appendMessage({
      role, content: text ? [{ type: "text", text }] : [{ type: "toolCall", id: randomUUID(), name: "read", arguments: {} }],
      api: "openai-completions", provider: "mock", model: "mock", stopReason: text ? "stop" : "toolUse", timestamp: Date.now(),
    } as any);
    await append("user", "普通问题");
    await append("assistant", "普通答复");
    await append("user", "## Planning Only\nPlan this task");
    for (let i = 0; i < 28; i++) await append("assistant", i % 5 === 0 ? `内部步骤 ${i}` : "");
    await append("user", "## Task Execution Complete\nSummarize the result");
    const firstAnswer = await append("assistant", '第一轮最终答复\n{"schema_version":"1.0","type":"delivery_decision","mode":"none"}');
    await append("user", "## Overall Task Objective\nAbandoned retry");
    await append("assistant", "废弃分支内容");
    await storage.setLeafId(firstAnswer);
    await append("user", "追问");
    await append("assistant", "正常追问答复");
    await append("user", "## Planning Only\nSecond task");
    await append("assistant", "第二轮计划");
    await append("user", "Your previous response did not provide a complete, valid execution plan. Return JSON.");
    await append("assistant", "计划格式修正");
    await append("user", "## Overall Task Objective\nSecond execution");
    await append("assistant", "第二轮执行");
    await append("user", "Your previous response did not include the required structured output JSON block. Return JSON.");
    await append("assistant", "执行格式修正");
    await append("user", "## Task Execution Complete\nSecond summary");
    await append("assistant", "第二轮最终答复");
    if (compact) await session.appendCompaction("压缩摘要", firstAnswer, 1000);
    vi.spyOn(storage, "getMetadata").mockResolvedValue({ ...(await storage.getMetadata()), id: "target" });
    vi.spyOn(JsonlSessionStorage, "open").mockResolvedValue(storage as any);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createSessionHandlers(fixture.deps as any, fixture.state as any).onSwitchSession({ type: "switch_session", session_id: "target", read_only: true });
      const events = writeSpy.mock.calls.flatMap(([line]) => { try { return [JSON.parse(String(line))]; } catch { return []; } });
      const messages = events.find(event => event.type === "session_switched")?.messages;
      expect(messages).toBeDefined();
      const answers = messages.filter((message: any) => message.role === "assistant" && message.type === "message");
      expect(answers.map((message: any) => message.content)).toEqual([
        ...(!compact ? ["普通答复"] : []), "第一轮最终答复", "正常追问答复", "第二轮最终答复",
      ]);
      expect(messages.some((message: any) => message.content === "废弃分支内容")).toBe(false);
      for (const text of ["第二轮计划", "计划格式修正", "第二轮执行", "执行格式修正"]) {
        expect(messages).toContainEqual({ role: "assistant", content: text, type: "thinking" });
      }
      expect(fixture.oldHarness.abort).not.toHaveBeenCalled();
    } finally { rmSync(workspaceDir, { recursive: true, force: true }); }
  });

  it("restores consumption before compaction and on abandoned branches without replaying their text", async () => {
    const workspaceDir = join(tmpdir(), `hogagent-session-usage-${randomUUID()}`);
    mkdirSync(join(workspaceDir, ".native", "sessions", "default"), { recursive: true });
    writeFileSync(join(workspaceDir, ".native", "sessions", "default", "target.jsonl"), "existing\n");
    const fixture = createFixture(workspaceDir);
    const storage = new InMemorySessionStorage();
    const session = new Session(storage);
    const assistant = (text: string, input: number) => ({
      role: "assistant", content: [{ type: "text", text }], api: "openai-completions",
      provider: "mock", model: "mock", stopReason: "stop", timestamp: Date.now(),
      usage: { input, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: input + 5, cost: { total: 0 } },
    } as any);
    const oldId = await session.appendMessage(assistant("compacted text", 100));
    await session.appendMessage(assistant("abandoned text", 200));
    await storage.setLeafId(oldId);
    const keptId = await session.appendMessage(assistant("visible text", 300));
    await session.appendCompaction("summary", keptId, 1000);
    vi.spyOn(storage, "getMetadata").mockResolvedValue({ ...(await storage.getMetadata()), id: "target" });
    vi.spyOn(JsonlSessionStorage, "open").mockResolvedValue(storage as any);
    mocks.openStorage.mockResolvedValue(storage);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const handlers = createSessionHandlers(fixture.deps as any, fixture.state as any);
      const runtimeBefore = fixture.runtimeContext.getSnapshot();
      await handlers.onSwitchSession({ type: "switch_session", session_id: "target", read_only: true });
      // A read of another session must not invalidate the active Harness and
      // force the next follow-up through a destructive resume/rebuild.
      await (fixture.deps.ensureSessionRef.current as any)(fixture.oldSessionId);
      expect(fixture.deps.config.sessionId).toBe(fixture.oldSessionId);
      expect(fixture.deps.config.sessionTaskDir).toBe(fixture.oldTaskDir);
      expect(fixture.deps.harnessRef.current).toBe(fixture.oldHarness);
      expect(fixture.runtimeContext.getSnapshot()).toEqual(runtimeBefore);
      expect(fixture.oldHarness.abort).not.toHaveBeenCalled();
      expect(fixture.oldUnsubscribe).not.toHaveBeenCalled();
      expect(fixture.oldLogger.close).not.toHaveBeenCalled();
      expect(fixture.state.switchedSession).toBe(false);
      const events = writeSpy.mock.calls.flatMap(([chunk]) => {
        try { return [JSON.parse(String(chunk))]; } catch { return []; }
      });
      const event = events.find((item) => item.type === "session_switched");
      expect(event).toBeDefined();
      expect(mocks.openStorage).not.toHaveBeenCalled();
      expect(mocks.repairTree).not.toHaveBeenCalled();
      expect(event.usageHistory.map((usage: any) => usage.totalTokens)).toEqual([105, 205, 305]);
      expect(event.messages.map((message: any) => message.content)).toEqual(["visible text"]);
    } finally {
      writeSpy.mockRestore();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it.each(["new", "resume"])("does not inherit a Quick thinking override on %s", async (transition) => {
    const workspaceDir = join(tmpdir(), `hogagent-session-thinking-${randomUUID()}`);
    mkdirSync(join(workspaceDir, ".native", "sessions", "default"), { recursive: true });
    const fixture = createFixture(workspaceDir);
    fixture.oldHarness.getThinkingLevel.mockReturnValue("off");
    fixture.state.quickThinkingOverride = true;
    (fixture.state as { savedThinkingLevel: string | null }).savedThinkingLevel = "high";
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.openStorage.mockResolvedValue({});
    try {
      const handlers = createSessionHandlers(fixture.deps as any, fixture.state as any);
      if (transition === "resume") {
        writeFileSync(join(workspaceDir, ".native", "sessions", "default", "target.jsonl"), "existing\n");
        await handlers.onResumeSession({ type: "resume_session", session_id: "target" });
      } else {
        await handlers.onNewSession({ type: "new_session", session_id: "target" });
      }
      expect((fixture.deps.harnessRef.current as any).options.thinkingLevel).toBe("high");
      expect(fixture.state.quickThinkingOverride).toBe(false);
    } finally {
      writeSpy.mockRestore();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps the active session untouched when target preparation fails", async () => {
    const workspaceDir = join(tmpdir(), `hogagent-session-prepare-${randomUUID()}`);
    mkdirSync(join(workspaceDir, ".native", "sessions", "default"), { recursive: true });
    const fixture = createFixture(workspaceDir);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.openStorage.mockRejectedValue(new Error("storage unavailable"));

    try {
      const handlers = createSessionHandlers(fixture.deps as any, fixture.state as any);
      await handlers.onNewSession({ type: "new_session", session_id: "session-new" });
      writeFileSync(join(workspaceDir, ".native", "sessions", "default", "session-resume.jsonl"), "existing\n");
      await handlers.onResumeSession({ type: "resume_session", session_id: "session-resume" });

      expect(fixture.oldLogger.close).not.toHaveBeenCalled();
      expect(fixture.oldUnsubscribe).not.toHaveBeenCalled();
      expect(fixture.oldHarness.abort).not.toHaveBeenCalled();
      expect(fixture.deps.config.sessionId).toBe(fixture.oldSessionId);
      expect(fixture.deps.config.sessionTaskDir).toBe(fixture.oldTaskDir);
      expect(fixture.deps.harnessRef.current).toBe(fixture.oldHarness);
      expect(fixture.runtimeContext.getSnapshot().session?.session_id).toBe(fixture.oldSessionId);
    } finally {
      writeSpy.mockRestore();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("publishes a prepared new session as one committed tuple", async () => {
    const workspaceDir = join(tmpdir(), `hogagent-session-commit-${randomUUID()}`);
    mkdirSync(join(workspaceDir, ".native", "sessions", "default"), { recursive: true });
    const fixture = createFixture(workspaceDir);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.openStorage.mockResolvedValue({});

    try {
      const handlers = createSessionHandlers(fixture.deps as any, fixture.state as any);
      await handlers.onNewSession({
        type: "new_session",
        session_id: "session-new",
        session_context: {
          schema_version: "1.0",
          attributes: { tenant: "new" },
        },
      });

      expect(fixture.oldLogger.close).toHaveBeenCalledOnce();
      expect(fixture.oldUnsubscribe).toHaveBeenCalledOnce();
      expect(fixture.oldHarness.abort).toHaveBeenCalledOnce();
      expect(fixture.deps.config.sessionId).toBe("session-new");
      expect(fixture.deps.config.sessionTaskDir).toBe(join(workspaceDir, "tasks", "session-new"));
      expect(fixture.deps.harnessRef.current).not.toBe(fixture.oldHarness);
      expect(fixture.deps.llmTracking.sessionId).toBe("session-new");
      expect(fixture.runtimeContext.getSnapshot().session).toMatchObject({
        session_id: "session-new",
        attributes: { tenant: "new" },
      });
      const events = writeSpy.mock.calls.map(([line]) => JSON.parse(String(line).trim()));
      expect(events.some((event) => (
        event.type === "session_created" && event.session_id === "session-new"
      ))).toBe(true);
    } finally {
      writeSpy.mockRestore();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid resume mode before touching the active session", async () => {
    const workspaceDir = join(tmpdir(), `hogagent-session-mode-${randomUUID()}`);
    const fixture = createFixture(workspaceDir);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createSessionHandlers(fixture.deps as any, fixture.state as any).onResumeSession({
        type: "resume_session",
        session_id: "target",
        mode: "turbo",
      });
      const event = JSON.parse(String(writeSpy.mock.calls.at(-1)![0]));
      expect(event).toMatchObject({
        type: "error",
        command_type: "resume_session",
        error: expect.stringContaining("quick, standard, or long_task"),
      });
      expect(fixture.deps.harnessRef.current).toBe(fixture.oldHarness);
      expect(fixture.oldHarness.abort).not.toHaveBeenCalled();
      expect(mocks.openStorage).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses a validated requested resume mode and locks the restored session title", async () => {
    const workspaceDir = join(tmpdir(), `hogagent-session-resume-mode-${randomUUID()}`);
    mkdirSync(join(workspaceDir, ".native", "sessions", "default"), { recursive: true });
    writeFileSync(join(workspaceDir, ".native", "sessions", "default", "target.jsonl"), "existing\n");
    mkdirSync(join(workspaceDir, "tasks", "target"), { recursive: true });
    writeFileSync(join(workspaceDir, "tasks", "target", "mode.json"), JSON.stringify({ mode: "standard" }));
    const fixture = createFixture(workspaceDir);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.openStorage.mockResolvedValue({});
    try {
      await createSessionHandlers(fixture.deps as any, fixture.state as any).onResumeSession({
        type: "resume_session",
        session_id: "target",
        mode: "quick",
      });
      const events = writeSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(events.at(-1)).toMatchObject({ type: "ready", session_id: "target", mode: "quick", _resumed: true });
      expect(fixture.deps.currentModeRef.value).toBe("quick");
      expect(fixture.state.sessionNameSaved).toBe(true);
    } finally {
      writeSpy.mockRestore();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reports the active Session ID in an empty session list", () => {
    const workspaceDir = join(tmpdir(), `hogagent-session-list-${randomUUID()}`);
    const fixture = createFixture(workspaceDir);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      createSessionHandlers(fixture.deps as any, fixture.state as any).onListSessions();
      expect(JSON.parse(String(writeSpy.mock.calls.at(-1)![0]))).toMatchObject({
        type: "session_list",
        sessions: [],
        current_session_id: fixture.oldSessionId,
      });
    } finally {
      writeSpy.mockRestore();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
