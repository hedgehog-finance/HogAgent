import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harnessState = vi.hoisted(() => ({
  options: undefined as { systemPrompt: () => string } | undefined,
  prompt: vi.fn(),
  abort: vi.fn(),
}));

vi.mock("../../src/vendor/agent/harness/agent-harness.ts", () => ({
  AgentHarness: class {
    constructor(options: { systemPrompt: () => string }) {
      harnessState.options = options;
    }

    subscribe(): void {}

    async prompt(text: string): Promise<unknown> {
      return harnessState.prompt(text);
    }

    async abort(): Promise<void> {
      await harnessState.abort();
    }
  },
}));

import { llmChat } from "../../src/llm-chat.ts";

function createParams(systemPrompt?: string) {
  return {
    text: "hello",
    systemPrompt,
    model: {} as never,
    getApiKey: vi.fn().mockResolvedValue("test-key"),
    env: {} as never,
    emitEvent: vi.fn(),
  };
}

describe("isolated LLM chat", () => {
  beforeEach(() => {
    harnessState.options = undefined;
    harnessState.prompt.mockReset().mockResolvedValue(undefined);
    harnessState.abort.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it("uses the caller's isolated business instruction", async () => {
    await llmChat(createParams("Answer as a concise analyst."));

    expect(harnessState.options?.systemPrompt()).toBe("Answer as a concise analyst.");
    expect(harnessState.prompt).toHaveBeenCalledWith("hello");
  });

  it("uses the generic instruction when none is supplied", async () => {
    await llmChat(createParams());

    expect(harnessState.options?.systemPrompt()).toBe("You are a helpful assistant.");
  });

  it("emits a balanced terminal event when the isolated request fails", async () => {
    harnessState.prompt.mockRejectedValueOnce(new Error("provider unavailable"));
    const params = createParams();

    await llmChat(params);

    expect(params.emitEvent).toHaveBeenCalledWith({
      type: "error",
      error: "llm_chat failed: provider unavailable",
    });
    expect(params.emitEvent).toHaveBeenLastCalledWith({ type: "agent_end", message_count: 1 });
  });

  it("reports provider errors returned as terminal assistant messages", async () => {
    harnessState.prompt.mockResolvedValueOnce({ stopReason: "error", errorMessage: "provider unavailable" });
    const params = createParams();
    await llmChat(params);
    expect(params.emitEvent).toHaveBeenCalledWith({ type: "error", error: "llm_chat failed: provider unavailable" });
    expect(params.emitEvent.mock.calls.filter(([event]) => event.type === "agent_end")).toHaveLength(1);
  });

  it("aborts only the temporary harness and reports an explicit timeout", async () => {
    vi.useFakeTimers();
    let releasePrompt!: () => void;
    harnessState.prompt.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releasePrompt = resolve;
    }));
    harnessState.abort.mockImplementationOnce(async () => releasePrompt());
    const params = { ...createParams(), timeoutMs: 50 };

    const pending = llmChat(params);
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(harnessState.abort).toHaveBeenCalledTimes(1);
    expect(params.emitEvent).toHaveBeenCalledWith({
      type: "error",
      error: "llm_chat failed: llm_chat timed out after 50ms",
    });
    expect(params.emitEvent).toHaveBeenLastCalledWith({ type: "agent_end", message_count: 1 });
  });
});
