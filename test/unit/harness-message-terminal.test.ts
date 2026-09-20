import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHarness } from "../../src/vendor/agent/harness/agent-harness.ts";
import type { AgentHarnessEvent } from "../../src/vendor/agent/harness/types.ts";
import type { ActivityLogger } from "../../src/utils/activity-logger.ts";
import type { HogAgentConfig, RpcEvent } from "../../src/utils/types.ts";

vi.mock("../../src/rpc.ts", () => ({ emitEvent: vi.fn() }));
vi.mock("../../src/extensions/index.ts", () => ({ notifyBeforeAgentEnd: vi.fn(async () => {}) }));

import { emitEvent } from "../../src/rpc.ts";
import { resetAllModuleState, setHarnessFinalizationDeferred } from "../../src/agent-state.ts";
import { subscribeToHarnessEvents } from "../../src/harness-events.ts";

describe("assistant message_end terminal protocol", () => {
  let listener: ((event: AgentHarnessEvent) => void | Promise<void>) | undefined;

  beforeEach(() => {
    vi.mocked(emitEvent).mockReset();
    resetAllModuleState();
    listener = undefined;

    const harness = {
      subscribe: (handler: (event: AgentHarnessEvent) => void | Promise<void>) => {
        listener = handler;
        return () => {};
      },
    } as unknown as AgentHarness;
    const activityLogger = {
      setStatus: vi.fn(),
      updateLastOutput: vi.fn(),
    } as unknown as ActivityLogger;

    subscribeToHarnessEvents(harness, activityLogger, {} as HogAgentConfig);
  });

  const emittedEvents = (): RpcEvent[] => vi.mocked(emitEvent).mock.calls.map(([event]) => event);

  it("emits an error terminal message_end and keeps the independent error event", () => {
    listener?.({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider unavailable",
        content: [],
      },
    } as unknown as AgentHarnessEvent);

    expect(emittedEvents()).toEqual([
      {
        type: "message_end",
        role: "assistant",
        terminal_status: "error",
        stop_reason: "error",
        error_message: "provider unavailable",
      },
      { type: "error", error: "LLM call failed: provider unavailable" },
    ]);
  });

  it("marks a benign tail error as success without emitting an independent error", () => {
    listener?.({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "finishReason: MALFORMED_FUNCTION_CALL",
        content: [{ type: "text", text: "完整内容" }],
      },
    } as unknown as AgentHarnessEvent);

    expect(emittedEvents()).toEqual([{
      type: "message_end",
      role: "assistant",
      terminal_status: "success",
      stop_reason: "error",
      error_message: "finishReason: MALFORMED_FUNCTION_CALL",
    }]);
  });

  it("defers the nested final-summary agent_end to the outer long_task lifecycle", async () => {
    setHarnessFinalizationDeferred(true);
    await listener?.({
      type: "agent_end",
      messages: [],
    } as unknown as AgentHarnessEvent);

    expect(emittedEvents()).toEqual([]);
  });

  it.each([
    [{ stopReason: "error", errorMessage: "provider unavailable", content: [] }, "error"],
    [{ stopReason: "aborted", content: [] }, "cancelled"],
    [{ stopReason: "error", errorMessage: "finishReason: MALFORMED_FUNCTION_CALL", content: [{ type: "text", text: "完整内容" }] }, "completed"],
    [{ stopReason: "stop", content: [{ type: "text", text: "recovered" }] }, "completed"],
  ])("carries the final assistant outcome on run boundaries: %j", async (fields, reason) => {
    const message = { role: "assistant", ...fields };
    await listener?.({ type: "turn_end", message, toolResults: [] } as unknown as AgentHarnessEvent);
    await listener?.({ type: "agent_end", messages: [
      { role: "toolResult", isError: true, content: [{ type: "text", text: "earlier tool failure" }] }, message,
    ] } as unknown as AgentHarnessEvent);
    expect(emittedEvents().filter(event => event.type === "turn_end" || event.type === "agent_end"))
      .toEqual([expect.objectContaining({ type: "turn_end", reason }), expect.objectContaining({ type: "agent_end", reason })]);
    if (reason === "error") expect(emittedEvents().at(-1)?.error).toBe("provider unavailable");
    if (reason === "completed") expect(emittedEvents().at(-1)?.error).toBeUndefined();
  });
});
