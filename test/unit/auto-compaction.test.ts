import { describe, expect, it, vi } from "vitest";
import { maybeAutoCompact } from "../../src/handlers/types.ts";
import { ContextCompactionError } from "../../src/compaction-manager.ts";
import { setAbortRequested } from "../../src/agent-state.ts";

const assistantEntry = {
  type: "message",
  id: "a1",
  parentId: null,
  timestamp: new Date().toISOString(),
  message: {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 9000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 9100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  },
};

function makeDeps(run: ReturnType<typeof vi.fn>) {
  return {
    sessionRef: { current: { getBranch: vi.fn(async () => [assistantEntry]) } },
    harnessRef: { current: { getModel: () => ({ id: "test", contextWindow: 10000 }) } },
    config: { compaction: { autoCompactThreshold: 0.75 } },
    compactionManager: { run },
    resolveMainLlmAuth: vi.fn(),
  } as any;
}

describe("maybeAutoCompact", () => {
  it("triggers the shared manager above threshold", async () => {
    const run = vi.fn(async (_options: any) => ({ status: "completed" }));
    await maybeAutoCompact(makeDeps(run));
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      harness: expect.any(Object),
      resolveAuth: expect.any(Function),
    }));
  });

  it("includes the immediately following prompt in the capacity check", async () => {
    const run = vi.fn(async () => ({ status: "completed" }));
    const deps = makeDeps(run);
    deps.sessionRef.current.getBranch = vi.fn(async () => [{
      ...assistantEntry,
      message: {
        ...assistantEntry.message,
        usage: {
          ...assistantEntry.message.usage,
          input: 7300,
          output: 100,
          totalTokens: 7400,
        },
      },
    }]);

    await maybeAutoCompact(deps, { nextPrompt: "x".repeat(800) });

    expect(run).toHaveBeenCalledOnce();
  });

  it("fails closed at Long Task checkpoints", async () => {
    const run = vi.fn(async (_options: any) => { throw new Error("provider failed"); });
    await expect(maybeAutoCompact(makeDeps(run), {
      emitEvent: () => {},
    })).rejects.toBeInstanceOf(ContextCompactionError);
  });

  it("fails the owning turn when compaction fails", async () => {
    const run = vi.fn(async (_options: any) => { throw new Error("provider failed"); });
    const events: any[] = [];
    await expect(maybeAutoCompact(makeDeps(run), {
      emitEvent: (event) => events.push(event),
    })).rejects.toBeInstanceOf(ContextCompactionError);
    expect(events).toEqual([]);
  });

  it("fails closed when completed compaction still cannot fit the next prompt", async () => {
    const run = vi.fn(async () => ({ status: "completed" }));
    const deps = makeDeps(run);
    deps.sessionRef.current.getBranch = vi.fn(async () => [{
      ...assistantEntry,
      message: {
        ...assistantEntry.message,
        usage: {
          ...assistantEntry.message.usage,
          input: 12000,
          totalTokens: 12100,
        },
      },
    }]);

    await expect(maybeAutoCompact(deps)).rejects.toThrow(/remains too large/i);
  });

  it("does not compact the same settled history twice", async () => {
    const run = vi.fn(async (_options: any) => ({ status: "skipped" }));
    const deps = makeDeps(run);

    await maybeAutoCompact(deps);
    await maybeAutoCompact(deps);

    expect(run).toHaveBeenCalledOnce();
  });

  it("does not arm compaction when abort arrives during the branch read", async () => {
    let resolveBranch!: (entries: unknown[]) => void;
    let aborted = false;
    const run = vi.fn(async () => ({ status: "completed" }));
    const deps = makeDeps(run);
    deps.sessionRef.current.getBranch = vi.fn(() => new Promise((resolve) => { resolveBranch = resolve; }));

    const check = maybeAutoCompact(deps, {
      isAbortRequested: () => aborted,
      emitEvent: () => {},
    });
    aborted = true;
    resolveBranch([assistantEntry]);

    await expect(check).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the sticky abort guard for normal turn-end branch reads", async () => {
    let resolveBranch!: (entries: unknown[]) => void;
    const run = vi.fn(async () => ({ status: "completed" }));
    const deps = makeDeps(run);
    deps.sessionRef.current.getBranch = vi.fn(() => new Promise((resolve) => { resolveBranch = resolve; }));
    setAbortRequested(false);

    try {
      const check = maybeAutoCompact(deps);
      setAbortRequested(true);
      resolveBranch([assistantEntry]);

      await expect(check).resolves.toBeUndefined();
      expect(run).not.toHaveBeenCalled();
    } finally {
      setAbortRequested(false);
    }
  });

  it("lets an outer abort win over a concurrent compaction failure", async () => {
    let rejectCompaction!: (error: Error) => void;
    const run = vi.fn(() => new Promise((_resolve, reject) => { rejectCompaction = reject; }));
    const deps = makeDeps(run);
    setAbortRequested(false);

    try {
      const check = maybeAutoCompact(deps);
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      setAbortRequested(true);
      rejectCompaction(new Error("provider failed"));

      await expect(check).resolves.toBeUndefined();
    } finally {
      setAbortRequested(false);
    }
  });

});
