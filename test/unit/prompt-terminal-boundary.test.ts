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
  workspace = mkdtempSync(join(tmpdir(), "hog-prompt-terminal-"));
  vi.stubEnv("HOGAGENT_USER_DIR", workspace);
});
afterEach(() => { resetAllModuleState(); vi.unstubAllEnvs(); rmSync(workspace, { recursive: true, force: true }); });

function fixture() {
  const taskDir = join(workspace, "task"); mkdirSync(taskDir);
  const runtimeContext = new RuntimeContextManager({ workspaceDir: workspace, mode: "rpc" });
  runtimeContext.bindSession("fixture-session", taskDir);
  const endRun = vi.spyOn(runtimeContext, "endPromptRun");
  const harness = { setActiveTools: vi.fn(async () => {}), setResources: vi.fn(async () => {}), abort: vi.fn(async () => {}), getModel: () => ({ id: "mock", provider: "mock", compat: false, contextWindow: 200_000 }), prompt: vi.fn(async () => {}) };
  const deps = {
    harnessRef: { current: harness },
    sessionRef: { current: { appendSessionName: vi.fn(), getBranch: vi.fn(async () => []), buildContext: vi.fn(async () => ({ messages: [] })) } },
    config: { mode: "rpc", sessionId: "fixture-session", workspaceDir: workspace, sessionTaskDir: taskDir, llmProvider: { provider: "mock", apiKey: "", models: [] }, auditModel: { provider: "mock", apiKey: "fixture" }, extensions: [], compaction: { autoCompactThreshold: 1 } },
    activityLoggerRef: { current: { init: vi.fn(), log: vi.fn() } }, auditModelObjRef: { value: { id: "mock" } },
    allSkills: [], toolRegistry: new AgentToolRegistry(), skillsConfig: {}, executionEnv: {}, currentModeRef: { value: "long_task" },
    getCapabilitiesFn: vi.fn(), ensureSessionRef: { current: null }, llmTracking: { sessionId: "", workId: "", taskId: "" }, runtimeContext,
  };
  return { harness, endRun, ...createPromptHandlers(deps as any, { switchedSession: false, sessionNameSaved: false, unsubscribe: null, quickThinkingOverride: false, savedThinkingLevel: null }) };
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
