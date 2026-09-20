import { describe, expect, it } from "vitest";
import { getMainLlmSendDelayMs } from "../../src/llm-metadata-hook.ts";

describe("getMainLlmSendDelayMs", () => {
  it.each([
    [20_000, 0],
    [20_001, 500],
    [30_000, 500],
    [30_001, 1_000],
    [40_000, 1_000],
    [40_001, 1_500],
    [50_000, 1_500],
    [50_001, 2_000],
  ])("returns the expected delay for %i context tokens", (contextTokens, expectedDelayMs) => {
    expect(getMainLlmSendDelayMs(contextTokens)).toBe(expectedDelayMs);
  });
});
