import { describe, expect, it } from "vitest";
import { resolveContextTokens } from "../../src/handlers/types.ts";
import { calculateContextTokens, estimateTokens } from "../../src/vendor/agent/base.ts";
import { buildSessionContext } from "../../src/vendor/agent/harness/session/session.ts";
import type { SessionTreeEntry } from "../../src/vendor/agent/harness/types.ts";

const usage = (input: number) => ({
  input,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function message(id: string, role: "user" | "assistant", text: string, input?: number): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: role === "assistant" ? {
      role,
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: usage(input ?? 100),
    } : {
      role,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  } as SessionTreeEntry;
}

describe("resolveContextTokens", () => {
  it("uses the latest provider usage before any compaction", () => {
    const entries = [message("u1", "user", "hello"), message("a1", "assistant", "world", 900)];
    expect(resolveContextTokens(entries)).toBe(calculateContextTokens(usage(900)));
  });

  it("adds messages that trail the latest provider usage", () => {
    const trailingUser = message("u2", "user", "trailing request") as Extract<SessionTreeEntry, { type: "message" }>;
    const entries = [
      message("u1", "user", "hello"),
      message("a1", "assistant", "world", 900),
      trailingUser,
    ];

    expect(resolveContextTokens(entries)).toBe(
      calculateContextTokens(usage(900)) + estimateTokens(trailingUser.message),
    );
  });

  it("ignores retained pre-compaction usage and uses a pure message estimate", () => {
    const entries: SessionTreeEntry[] = [
      message("u1", "user", "old user message"),
      message("a1", "assistant", "old assistant message", 240000),
      {
        type: "compaction",
        id: "c1",
        parentId: "a1",
        timestamp: new Date().toISOString(),
        summary: "short summary",
        firstKeptEntryId: "a1",
        tokensBefore: 240000,
      },
    ];
    const expected = buildSessionContext(entries).messages
      .reduce((total, item) => total + estimateTokens(item), 0);

    expect(resolveContextTokens(entries)).toBe(expected);
    expect(resolveContextTokens(entries)).toBeLessThan(240000);
  });

  it("trusts a successful assistant usage emitted after compaction", () => {
    const entries: SessionTreeEntry[] = [
      message("u1", "user", "old"),
      message("a1", "assistant", "old", 240000),
      {
        type: "compaction",
        id: "c1",
        parentId: "a1",
        timestamp: new Date().toISOString(),
        summary: "summary",
        firstKeptEntryId: "a1",
        tokensBefore: 240000,
      },
      message("a2", "assistant", "new", 1200),
    ];

    expect(resolveContextTokens(entries)).toBe(calculateContextTokens(usage(1200)));
  });
});
