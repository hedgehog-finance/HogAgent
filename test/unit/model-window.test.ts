import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_WINDOW, normalizeContextWindow } from "../../src/model-window.ts";

describe("normalizeContextWindow", () => {
  it("uses 500k for missing, invalid, too-small, and legacy 200k values", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(500_000);
    expect(normalizeContextWindow(undefined)).toBe(500_000);
    expect(normalizeContextWindow(Number.NaN)).toBe(500_000);
    expect(normalizeContextWindow(2048)).toBe(500_000);
    expect(normalizeContextWindow(200_000)).toBe(500_000);
  });

  it("preserves other explicit valid windows", () => {
    expect(normalizeContextWindow(65_536)).toBe(65_536);
    expect(normalizeContextWindow(128_000)).toBe(128_000);
    expect(normalizeContextWindow(1_048_576)).toBe(1_048_576);
  });
});
