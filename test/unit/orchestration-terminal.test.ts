import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/extensions/index.ts", () => ({
  getDeliveryManager: () => undefined,
  notifyBeforeAgentEnd: vi.fn(async () => {}),
}));

import { notifyBeforeAgentEnd } from "../../src/extensions/index.ts";
import { runOrchestrationTurn, hasIncompleteOrchestration, hasArchivedOrchestrationState, tryRestoreArchivedOrchestration, clearPendingOrchestration, readOrchestrationState, resumeInterruptedOrchestration } from "../../src/long-task-orchestrator.ts";
import { isInternalMode, resetAllModuleState, setInternalMode } from "../../src/agent-state.ts";
import { ContextCompactionError } from "../../src/compaction-manager.ts";
import { AuditModelUnavailableError, OrchestrationAbortedError } from "../../src/utils/llm-error.ts";
import * as config from "../../src/config.ts";

describe("Long Task terminal boundary", () => {
  let dir: string;
  let events: any[];
  const checkpoint = (status: "executing" | "completed" = "executing") => ({
    status,
    classification: { optimizedPrompt: "fixture", goals: [], acceptanceCriteria: [], complexity: "complex", skipClarification: true },
    steps: [], groups: [], completedGroupIds: [], currentGroupIdx: 0, maxIterations: 1,
    userClarificationAnswer: "", groupFilesMapData: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hogagent-terminal-"));
    events = [];
    vi.mocked(notifyBeforeAgentEnd).mockClear();
    setInternalMode(true);
    writeFileSync(join(dir, "orchestration-state.json"), JSON.stringify(checkpoint()));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearPendingOrchestration();
    resetAllModuleState();
    rmSync(dir, { recursive: true, force: true });
  });
  const deps = () => ({ sessionTaskDir: dir, emitEvent: (event: any) => { events.push(event); } });

  it("does not append the stored user-message history when only updating statistics", async () => {
    writeFileSync(join(dir, "mode.json"), JSON.stringify({
      mode: "long_task", createdAt: "2026-09-06", originalUserMessages: ["first request", "second request"],
    }));
    await runOrchestrationTurn(deps(), async () => {});
    expect(config.readModeMetadata(dir)?.originalUserMessages).toEqual(["first request", "second request"]);
  });

  it.each([false, true])("keeps the original terminal lifecycle if saving statistics fails (run failed=%s)", async failed => {
    writeFileSync(join(dir, "mode.json"), JSON.stringify({ mode: "long_task", createdAt: "2026-09-06" }));
    vi.spyOn(config, "writeModeMetadata").mockImplementation(() => { throw new Error("metadata storage unavailable"); });
    await expect(runOrchestrationTurn(deps(), async () => {
      if (failed) throw new Error("original run failure");
    })).resolves.toBeUndefined();
    expect(events.map(event => event.type)).toEqual([
      ...(failed ? ["error"] : []), "internal_mode", "orchestration_completed", "agent_end",
    ]);
    if (failed) expect(events[0].error).toBe("original run failure");
    expect(events.at(-1)?.reason).toBe(failed ? "error" : "completed");
    expect(notifyBeforeAgentEnd).toHaveBeenCalledTimes(failed ? 0 : 1);
  });

  it("archives a failed run, closes the lifecycle once and does not finalize delivery", async () => {
    await runOrchestrationTurn(deps(), async () => { throw new Error("summary failed"); });
    expect(events.map(event => event.type)).toEqual(["error", "internal_mode", "orchestration_completed", "agent_end"]);
    expect(events[0].error).toBe("summary failed");
    expect(events.at(-1)).toMatchObject({ type: "agent_end", reason: "error", error: "summary failed" });
    expect(notifyBeforeAgentEnd).not.toHaveBeenCalled();
    expect(isInternalMode()).toBe(false);
    expect(hasIncompleteOrchestration(dir)).toBe(false);
    expect(hasArchivedOrchestrationState(dir)).toBe(true);
    expect(tryRestoreArchivedOrchestration("ordinary message", dir)).toBe(false);
    expect(tryRestoreArchivedOrchestration("[Continue Task]", dir)).toBe(true);
  });

  it("finalizes delivery between orchestration exit and agent end on success", async () => {
    vi.mocked(notifyBeforeAgentEnd).mockImplementationOnce(async () => {
      expect(events.map(event => event.type)).toEqual(["internal_mode", "orchestration_completed"]);
      return true;
    });
    await runOrchestrationTurn(deps(), async () => {});
    expect(notifyBeforeAgentEnd).toHaveBeenCalledTimes(1);
    expect(events.map(event => event.type)).toEqual(["internal_mode", "orchestration_completed", "agent_end"]);
  });

  it.each([new OrchestrationAbortedError(), new ContextCompactionError("capacity failed")])("leaves abort/compaction termination to the owning prompt (%s)", async error => {
    await expect(runOrchestrationTurn(deps(), async () => { throw error; })).rejects.toBe(error);
    expect(events).toEqual([]);
    expect(notifyBeforeAgentEnd).not.toHaveBeenCalled();
    expect(hasArchivedOrchestrationState(dir)).toBe(false);
  });

  it("converts a delivery finalization exception into the turn's single failure terminal", async () => {
    vi.mocked(notifyBeforeAgentEnd).mockRejectedValueOnce(new Error("delivery failed"));
    await expect(runOrchestrationTurn(deps(), async () => {})).resolves.toBeUndefined();
    expect(events.map(event => event.type)).toEqual(["internal_mode", "orchestration_completed", "error", "agent_end"]);
    expect(events.at(-1)).toMatchObject({ reason: "error", error: "delivery failed" });
  });

  it.each([false, true])("keeps a completed recovery checkpoint when delivery finalization fails (throws=%s)", async throws => {
    const finalize = runOrchestrationTurn(deps(), async () => {
      writeFileSync(join(dir, "orchestration-state.json"), JSON.stringify(checkpoint("completed")));
      if (throws) vi.mocked(notifyBeforeAgentEnd).mockRejectedValueOnce(new Error("storage failed"));
      else vi.mocked(notifyBeforeAgentEnd).mockResolvedValueOnce(false);
    });
    await finalize;
    expect(hasIncompleteOrchestration(dir)).toBe(true);
    expect(hasArchivedOrchestrationState(dir)).toBe(false);
    expect(events.filter(event => event.type === "orchestration_completed")).toHaveLength(1);
    expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "agent_end", reason: "error" });
  });

  it("replays only the saved final response and delivery decision before clearing a completed checkpoint", async () => {
    writeFileSync(join(dir, "orchestration-state.json"), JSON.stringify({
      ...checkpoint("completed"),
      finalContent: "saved final response",
      deliveryDecision: { schema_version: "1.0", type: "delivery_decision", mode: "none" },
    }));
    vi.mocked(notifyBeforeAgentEnd).mockResolvedValueOnce(true);
    const state = readOrchestrationState(dir);
    expect(state?.status).toBe("completed");

    await runOrchestrationTurn(deps(), () => resumeInterruptedOrchestration(state!, deps() as any));

    expect(events.find(event => event.type === "turn_end")).toMatchObject({
      content: "saved final response",
      delivery_decision: { schema_version: "1.0", type: "delivery_decision", mode: "none" },
    });
    expect(events.filter(event => event.type === "orchestration_completed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "agent_end", reason: "completed" });
    expect(hasIncompleteOrchestration(dir)).toBe(false);
  });

  it("preserves audit-model fallback without prematurely closing the owning prompt", async () => {
    const error = new AuditModelUnavailableError("audit unavailable");
    await expect(runOrchestrationTurn(deps(), async () => { throw error; })).rejects.toBe(error);
    expect(events.map(event => event.type)).toEqual(["internal_mode", "orchestration_completed"]);
    expect(notifyBeforeAgentEnd).not.toHaveBeenCalled();
  });
});
