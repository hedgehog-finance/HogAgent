import { beforeEach, describe, expect, it, vi } from "vitest";

const { vendorCompact } = vi.hoisted(() => ({ vendorCompact: vi.fn() }));

vi.mock("../../src/vendor/agent/base.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/vendor/agent/base.ts")>();
  return { ...original, compact: vendorCompact };
});

import {
  COMPACTION_TIMEOUT_MS,
  CompactionManager,
} from "../../src/compaction-manager.ts";
import type { AgentHarness } from "../../src/vendor/agent/harness/agent-harness.ts";
import type { RpcEvent } from "../../src/utils/types.ts";

const compactResult = {
  summary: "summary",
  firstKeptEntryId: "entry-1",
  tokensBefore: 12000,
};

function fakeHarness(options: {
  nothing?: boolean;
  beforeHook?: Promise<void>;
  beforeCommit?: () => void;
  commit?: Promise<void>;
} = {}): AgentHarness {
  let hook: ((event: any) => Promise<any>) | undefined;
  return {
    on: (_type: string, handler: (event: any) => Promise<any>) => {
      hook = handler;
      return () => { hook = undefined; };
    },
    compact: async (customInstructions?: string) => {
      await options.beforeHook;
      if (options.nothing) throw new Error("Nothing to compact");
      const provided = await hook?.({
        type: "session_before_compact",
        preparation: {},
        branchEntries: [],
        customInstructions,
        signal: new AbortController().signal,
      });
      if (!provided?.compaction) throw new Error("Compaction hook did not provide a result");
      options.beforeCommit?.();
      await options.commit;
      return provided.compaction;
    },
    getModel: () => ({ id: "model", provider: "test", contextWindow: 100000 }),
    getThinkingLevel: () => "off",
  } as unknown as AgentHarness;
}

function createOptions(harness: AgentHarness, events: RpcEvent[]) {
  return {
    harness,
    emitEvent: (event: RpcEvent) => events.push(event),
    resolveAuth: async () => ({ apiKey: "test-key" }),
  };
}

describe("CompactionManager", () => {
  beforeEach(() => {
    vendorCompact.mockReset();
  });

  it("emits exactly one start and one completed terminal event", async () => {
    vendorCompact.mockResolvedValue({ ok: true, value: compactResult });
    const events: RpcEvent[] = [];
    const outcome = await new CompactionManager().run(createOptions(fakeHarness(), events));

    expect(outcome.status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual(["compact_started", "compact_completed"]);
    expect(events[0]).not.toHaveProperty("operation_id");
    expect(events[1]).not.toHaveProperty("operation_id");
    expect(events[0]).not.toHaveProperty("trigger");
    expect(events[1]).not.toHaveProperty("trigger");
    expect(events[1]).not.toHaveProperty("status");
    expect(events.some((event) => event.type === "agent_end")).toBe(false);
  });

  it("settles Nothing to compact as skipped", async () => {
    const events: RpcEvent[] = [];
    const outcome = await new CompactionManager().run(createOptions(fakeHarness({ nothing: true }), events));

    expect(outcome.status).toBe("skipped");
    expect(events.map((event) => [event.type, event.status])).toEqual([
      ["compact_started", undefined],
      ["compact_completed", "skipped"],
    ]);
  });

  it("emits one error terminal when the provider rejects", async () => {
    vendorCompact.mockResolvedValue({ ok: false, error: new Error("provider unavailable") });
    const events: RpcEvent[] = [];

    await expect(new CompactionManager().run(createOptions(fakeHarness(), events)))
      .rejects.toMatchObject({ reason: "error" });
    expect(events.map((event) => event.type)).toEqual(["compact_started", "compact_failed"]);
    expect(events[1]).toMatchObject({ reason: "error", message: "provider unavailable" });
    expect(events.filter((event) => event.type === "compact_failed")).toHaveLength(1);
  });

  it("fails the owning conversation after the five-minute provider deadline", async () => {
    vi.useFakeTimers();
    try {
      vendorCompact.mockImplementation(() => new Promise(() => {}));
      const events: RpcEvent[] = [];
      const run = new CompactionManager().run(createOptions(fakeHarness(), events));
      const rejection = expect(run).rejects.toMatchObject({ reason: "error" });

      await vi.waitFor(() => expect(vendorCompact).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(COMPACTION_TIMEOUT_MS);
      await rejection;

      expect(events.map((event) => event.type)).toEqual(["compact_started", "compact_failed"]);
      expect(events[1]).toMatchObject({ reason: "error" });
      expect(events[1]?.message).toContain("5 minutes");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the same deadline while provider credentials are resolving", async () => {
    vi.useFakeTimers();
    try {
      const events: RpcEvent[] = [];
      const options = createOptions(fakeHarness(), events);
      options.resolveAuth = async () => new Promise(() => {});
      const run = new CompactionManager().run(options);
      const rejection = expect(run).rejects.toMatchObject({ reason: "error" });

      await vi.advanceTimersByTimeAsync(COMPACTION_TIMEOUT_MS);
      await rejection;

      expect(vendorCompact).not.toHaveBeenCalled();
      expect(events.map((event) => event.type)).toEqual(["compact_started", "compact_failed"]);
      expect(events[1]?.message).toContain("5 minutes");
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces concurrent requests for the same Harness", async () => {
    vendorCompact.mockResolvedValue({ ok: true, value: compactResult });
    const harness = fakeHarness();
    const events: RpcEvent[] = [];
    const manager = new CompactionManager();
    const first = manager.run(createOptions(harness, events));
    const second = manager.run(createOptions(harness, events));

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(events.filter((event) => event.type === "compact_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "compact_completed")).toHaveLength(1);
  });
});
