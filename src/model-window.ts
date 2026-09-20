export const DEFAULT_CONTEXT_WINDOW = 500_000;

export function isValidContextWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 4096;
}

/** Product fallback: unknown, invalid, and legacy 200k windows use 500k. */
export function normalizeContextWindow(value: unknown): number {
  return isValidContextWindow(value) && value !== 200_000
    ? value
    : DEFAULT_CONTEXT_WINDOW;
}
