import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("skills/tech-indicators/scripts/calc.mjs");
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function run(rows: Array<Record<string, unknown>>, indicators = "sma") {
  const directory = mkdtempSync(join(tmpdir(), "hogagent-tech-indicators-"));
  tempDirs.push(directory);
  const input = join(directory, "ohlcv.json");
  const output = join(directory, "result.json");
  writeFileSync(input, JSON.stringify(rows), "utf8");
  execFileSync(process.execPath, [script, input, output, `--indicators=${indicators}`], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return JSON.parse(readFileSync(output, "utf8"));
}

describe("tech-indicators market-data normalization", () => {
  it("normalizes common date aliases and reverses descending market data", () => {
    const result = run([
      { trade_date: "20240103", open: 30, high: 31, low: 29, close: 30, vol: 300 },
      { trade_date: "20240102", open: 20, high: 21, low: 19, close: 20, vol: 200 },
      { trade_date: "20240101", open: 10, high: 11, low: 9, close: 10, vol: 100 },
    ]);

    expect(result.map((row: { date: string }) => row.date)).toEqual([
      "2024-01-01", "2024-01-02", "2024-01-03",
    ]);
    expect(result.map((row: { close: number }) => row.close)).toEqual([10, 20, 30]);
  });

  it("uses a stable numeric sequence when every date is absent", () => {
    const result = run([
      { open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { open: 20, high: 21, low: 19, close: 20, volume: 200 },
    ]);

    expect(result.map((row: { date: number }) => row.date)).toEqual([1, 2]);
  });

  it("lists and executes every advertised indicator without unsupported Renko output", () => {
    const listed = execFileSync(process.execPath, [script, "--list"], { encoding: "utf8" });
    expect(listed).toContain("Total 74 indicators:");
    expect(listed.toLowerCase()).not.toContain("renko");

    const rows = Array.from({ length: 240 }, (_, index) => {
      const close = 100 + index * 0.2 + Math.sin(index / 5) * 3;
      return {
        date: `2024-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
        open: close - 0.4,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000 + index * 7,
      };
    });
    const result = run(rows, "all");
    expect(result).toHaveLength(rows.length);
    expect(result.at(-1)?.close).toBeCloseTo(rows.at(-1)?.close as number, 6);
  });
});
