import { describe, expect, it, vi } from "vitest";
import { createSkillHandlers } from "../../src/handlers/skill-handlers.ts";
import { CompactionOperationError } from "../../src/compaction-manager.ts";

function createFixture() {
  const run = vi.fn().mockResolvedValue({ status: "completed" });
  const deps = {
    harnessRef: { current: {} },
    config: { sessionTaskDir: "/tmp/hogagent-manual-compaction-test" },
    executionEnv: {},
    compactionManager: { run },
    resolveMainLlmAuth: vi.fn(),
  };
  const state = { switchedSession: false };
  return { run, deps, state };
}

describe("manual context compaction handler", () => {
  it("starts the shared manager when the session is idle and writable", async () => {
    const { run, deps, state } = createFixture();
    const { onCompact } = createSkillHandlers(deps as any, state as any);

    await onCompact({ type: "compact" });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      harness: deps.harnessRef.current,
      resolveAuth: deps.resolveMainLlmAuth,
    }));
  });

  it("rejects custom instructions with only a compact terminal event", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { run, deps, state } = createFixture();
    const { onCompact } = createSkillHandlers(deps as any, state as any);

    try {
      await onCompact({ type: "compact", custom_instructions: "keep this" });

      expect(run).not.toHaveBeenCalled();
      const events = writeSpy.mock.calls.map((call) => JSON.parse(String(call[0]).trim()));
      expect(events).toEqual([expect.objectContaining({
        type: "compact_failed",
        reason: "error",
        message: expect.stringContaining("not supported"),
      })]);
      expect(events.some((event) => event.type === "error" || event.type === "agent_end")).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("does not turn a manager-owned failure into a generic RPC failure", async () => {
    const { run, deps, state } = createFixture();
    run.mockRejectedValue(new CompactionOperationError("provider unavailable"));
    const { onCompact } = createSkillHandlers(deps as any, state as any);

    await expect(onCompact({ type: "compact" })).resolves.toBeUndefined();
  });
});
