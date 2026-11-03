import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPromptHandlers } from "../../src/handlers/prompt-handlers.ts";
import { RuntimeContextManager } from "../../src/runtime-context.ts";
import { AgentToolRegistry } from "../../src/tool-registry.ts";
import { resetAllModuleState } from "../../src/agent-state.ts";
import { OrchestrationAbortedError } from "../../src/utils/llm-error.ts";
import { emitEvent } from "../../src/rpc.ts";
import { executeLongTask, hasIncompleteOrchestration, readOrchestrationState } from "../../src/long-task-orchestrator.ts";
import { notifyAgentAbort, notifyBeforeAgentEnd } from "../../src/extensions/index.ts";
import { AgentHarness } from "../../src/vendor/agent/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/vendor/agent/harness/env/nodejs.ts";
import { Session } from "../../src/vendor/agent/harness/session/session.ts";
import { InMemorySessionStorage } from "../../src/vendor/agent/harness/session/memory-storage.ts";
import { AssistantMessageEventStream } from "../../src/vendor/ai/utils/event-stream.ts";
import { registerApiProvider, unregisterApiProviders } from "../../src/vendor/ai/api-registry.ts";

vi.mock("../../src/rpc.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/rpc.ts")>(), emitEvent: vi.fn(),
}));
vi.mock("../../src/audit-classifier.ts", () => ({
  classifyIntent: vi.fn(async () => ({ complexity: "complex", optimizedPrompt: "fixture task", goals: ["fixture"], acceptanceCriteria: [], skipClarification: true })),
  abortActiveAuditHarness: vi.fn(),
}));
vi.mock("../../src/long-task-orchestrator.ts", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/long-task-orchestrator.ts")>();
  return { ...original, executeLongTask: vi.fn(async () => {}), hasIncompleteOrchestration: vi.fn(original.hasIncompleteOrchestration), readOrchestrationState: vi.fn(original.readOrchestrationState) };
});
vi.mock("../../src/extensions/index.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/extensions/index.ts")>(),
  notifyAgentAbort: vi.fn(async () => {}), notifyBeforeAgentEnd: vi.fn(async () => {}),
}));

let workspace: string;
beforeEach(() => {
  resetAllModuleState(); vi.clearAllMocks();
  vi.mocked(executeLongTask).mockReset().mockResolvedValue(undefined);
  workspace = mkdtempSync(join(tmpdir(), "hog-prompt-terminal-"));
  vi.stubEnv("HOGAGENT_USER_DIR", workspace);
});
afterEach(() => { resetAllModuleState(); vi.unstubAllEnvs(); rmSync(workspace, { recursive: true, force: true }); });

function fixture(harnessOverride?: AgentHarness) {
  const taskDir = join(workspace, "task"); mkdirSync(taskDir);
  const runtimeContext = new RuntimeContextManager({ workspaceDir: workspace, mode: "rpc" });
  runtimeContext.bindSession("fixture-session", taskDir);
  const endRun = vi.spyOn(runtimeContext, "endPromptRun");
  const harness = { steer: vi.fn(async () => {}), setActiveTools: vi.fn(async () => {}), setResources: vi.fn(async () => {}), abort: vi.fn(async () => {}), getModel: () => ({ id: "mock", provider: "mock", compat: false, contextWindow: 200_000 }), prompt: vi.fn(async () => {}) };
  const deps = {
    harnessRef: { current: harnessOverride ?? harness },
    sessionRef: { current: { appendSessionName: vi.fn(), getBranch: vi.fn(async () => []), buildContext: vi.fn(async () => ({ messages: [] })) } },
    config: { mode: "rpc", sessionId: "fixture-session", workspaceDir: workspace, sessionTaskDir: taskDir, llmProvider: { provider: "mock", apiKey: "", models: [] }, auditModel: { provider: "mock", apiKey: "fixture" }, extensions: [], compaction: { autoCompactThreshold: 1 } },
    activityLoggerRef: { current: { init: vi.fn(), log: vi.fn() } }, auditModelObjRef: { value: { id: "mock" } },
    allSkills: [], toolRegistry: new AgentToolRegistry(), skillsConfig: {}, executionEnv: {}, currentModeRef: { value: "long_task" },
    getCapabilitiesFn: vi.fn(), ensureSessionRef: { current: null }, llmTracking: { sessionId: "", workId: "", taskId: "" }, runtimeContext,
  };
  return { harness, runtimeContext, endRun, ...createPromptHandlers(deps as any, { switchedSession: false, sessionNameSaved: false, unsubscribe: null, quickThinkingOverride: false, savedThinkingLevel: null }) };
}

function events() { return vi.mocked(emitEvent).mock.calls.map(([event]) => event); }
function expectClosedBeforeTerminal(reason: string) {
  const emitted = events();
  const terminal = emitted.findIndex(event => event.type === "agent_end");
  expect(terminal).toBeGreaterThan(0);
  expect(emitted[terminal]).toMatchObject({ reason });
  expect(emitted.slice(0, terminal).some(event => event.type === "orchestration_resuming")).toBe(true);
  expect(emitted.slice(0, terminal).some(event => event.type === "orchestration_completed")).toBe(true);
  expect(emitted.filter(event => event.type === "agent_end")).toHaveLength(1);
}

describe("Prompt terminal ownership", () => {
  it.each([
    ["steer", "error"], ["follow_up", "error"], ["steer", "stop"], ["follow_up", "stop"],
  ] as const)("keeps accepted %s in its owning Prompt Run when the model returns %s", async (control, outcome) => {
    const contexts: string[] = [];
    let firstStream: AssistantMessageEventStream | undefined;
    const message = (stopReason: "stop" | "error") => ({ role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "mock",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now(), ...(stopReason === "error" ? { errorMessage: "fixture model error" } : {}) } as const);
    const stream = (_model: unknown, context: any) => {
      contexts.push(JSON.stringify(context.messages));
      const result = new AssistantMessageEventStream();
      if (contexts.length === 1) firstStream = result;
      else queueMicrotask(() => result.push({ type: "done", reason: "stop", message: message("stop") as any }));
      return result;
    };
    registerApiProvider({ api: "openai-completions", stream, streamSimple: stream }, "steering-boundary-test");
    const harness = new AgentHarness({ env: new NodeExecutionEnv({ cwd: workspace }), session: new Session(new InMemorySessionStorage()),
      model: { id: "mock", name: "fixture", api: "openai-completions", provider: "fixture", contextWindow: 200_000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any,
      tools: new AgentToolRegistry().snapshotTopLevel(), getApiKeyAndHeaders: async () => ({ apiKey: "fixture" }), systemPrompt: "fixture" });
    const handlers = fixture(harness);
    vi.mocked(executeLongTask).mockImplementation(async () => {
      const reply = await harness.prompt("task input");
      if (reply.stopReason === "error") throw new Error("fixture model error");
    });
    try {
      const original = handlers.onPrompt({ type: "prompt", text: "first task", mode: "long_task", run_context: { schema_version: "1.0", run_id: "run-1", attributes: {} } });
      await vi.waitFor(() => expect(firstStream).toBeDefined());
      const command = { type: control, text: "old-task-correction", session_id: "fixture-session", expected_run_id: "run-1" };
      await (control === "steer" ? handlers.onSteer(command) : handlers.onFollowUp(command));
      expect(events().some(event => event.type === `${control}_queued`)).toBe(true);
      firstStream!.push(outcome === "error" ? { type: "error", reason: "error", error: message("error") as any }
        : { type: "done", reason: "stop", message: message("stop") as any });
      await original;
      if (outcome === "stop") {
        expect(contexts).toHaveLength(2);
        expect(contexts[1]).toContain("old-task-correction");
        expect(handlers.runtimeContext.getSnapshot().current_run).toBeUndefined();
        return;
      }
      await handlers.onPrompt({ type: "prompt", text: "second independent task", mode: "long_task" });
      expect(contexts).toHaveLength(2);
      expect(contexts[1]).not.toContain("old-task-correction");
    } finally { unregisterApiProviders("steering-boundary-test"); }
  });
  it.each(["active", "other-run", "other-session", "finished"])("steers only the original Prompt Run: %s", async status => {
    const { onSteer, harness, runtimeContext } = fixture();
    if (status !== "finished") runtimeContext.beginPromptRun({ schema_version: "1.0", run_id: "run-1", attributes: {} });
    await onSteer({ type: "steer", text: "correction", session_id: status === "other-session" ? "other-session" : "fixture-session", expected_run_id: status === "other-run" ? "old-run" : "run-1" });
    if (status === "active") {
      expect(harness.steer).toHaveBeenCalledWith("correction");
      expect(events()).toContainEqual(expect.objectContaining({ type: "steer_queued", command_type: "steer" }));
    } else {
      expect(harness.steer).not.toHaveBeenCalled();
      expect(events()).toContainEqual(expect.objectContaining({ type: "error", code: "CONFLICT", command_type: "steer" }));
    }
    expect(events().some(event => event.type === "agent_end")).toBe(false);
  });

  it("closes orchestration on shutdown interruption even without an abort command", async () => {
    const { onPrompt, endRun } = fixture();
    vi.mocked(executeLongTask).mockRejectedValueOnce(new OrchestrationAbortedError());
    await onPrompt({ type: "prompt", text: "fixture task", mode: "long_task" });
    expect(executeLongTask).toHaveBeenCalledOnce();
    expectClosedBeforeTerminal("cancelled");
    expect(endRun).toHaveBeenCalledOnce();
  });

  it("emits only failure when successful execution cannot finalize delivery", async () => {
    const { onPrompt, endRun } = fixture();
    vi.mocked(notifyBeforeAgentEnd).mockRejectedValueOnce(new Error("delivery failed"));
    await onPrompt({ type: "prompt", text: "fixture task", mode: "long_task" });
    expectClosedBeforeTerminal("error");
    expect(events().find(event => event.type === "agent_end")).toMatchObject({ error: "delivery failed" });
    expect(endRun).toHaveBeenCalledOnce();
  });

  it("terminates recovery when a checkpoint disappears after availability checking", async () => {
    const { onPrompt } = fixture();
    vi.mocked(hasIncompleteOrchestration).mockReturnValueOnce(true);
    vi.mocked(readOrchestrationState).mockReturnValueOnce(null);
    await onPrompt({ type: "prompt", text: "continue", mode: "long_task" });
    expectClosedBeforeTerminal("error");
    expect(executeLongTask).not.toHaveBeenCalled();
  });

  it.each(["harness", "extension"])("waits for both cancellation branches when %s fails first", async first => {
    const { onAbort, harness } = fixture();
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    const error = new Error("abort hook failed");
    if (first === "extension") {
      harness.abort.mockReturnValueOnce(pending); vi.mocked(notifyAgentAbort).mockRejectedValueOnce(error);
    } else {
      harness.abort.mockRejectedValueOnce(error); vi.mocked(notifyAgentAbort).mockReturnValueOnce(pending);
    }
    const abort = onAbort({ type: "abort", task_id: "task-1", work_id: "work-1" });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(events().some(event => event.type === "abort_completed")).toBe(false);
    } finally { settle(); await abort; }
    expect(events().at(-1)).toMatchObject({ type: "abort_completed", task_id: "task-1", work_id: "work-1" });
    expect(events().some(event => event.type === "error")).toBe(true);
  });
  it.each([undefined, "hogagent"])("rejects a Gateway launch with missing/conflicting owner %s before model execution", async owner => {
    vi.stubEnv("HOGAGENT_GATEWAY_MANAGED", "1");
    const { onPrompt, harness } = fixture();
    await onPrompt({ type: "prompt", text: "run", run_context: { schema_version: "1.0", ...(owner ? { manifest_owner: owner } : {}) } });
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(events()).toContainEqual(expect.objectContaining({ type: "error", error: expect.stringContaining("manifest_owner=gateway") }));
  });

});
