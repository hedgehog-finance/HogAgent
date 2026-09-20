import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const chartScript = resolve("skills/gen-chart/scripts/vega-chart.mjs");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Vega-Lite chart generator", () => {
  it.each(["svg", "png"])("renders a Vega-Lite v6 specification as %s", (format) => {
    const dir = mkdtempSync(join(tmpdir(), "hogagent-vega-chart-"));
    tempDirs.push(dir);
    const specPath = join(dir, `tmp-gen-chart-${format}.json`);
    const outputPath = join(dir, `chart.${format}`);

    writeFileSync(specPath, `\uFEFF${JSON.stringify({
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      width: 320,
      height: 180,
      data: {
        values: [
          { label: "A", value: 10 },
          { label: "B", value: 20 },
        ],
      },
      mark: "bar",
      encoding: {
        x: { field: "label", type: "ordinal" },
        y: { field: "value", type: "quantitative" },
      },
    })}`);

    execFileSync(process.execPath, [chartScript, "--spec", specPath, "-o", outputPath], {
      stdio: "pipe",
    });

    expect(statSync(outputPath).size).toBeGreaterThan(100);
    if (format === "svg") {
      expect(readFileSync(outputPath, "utf8")).toContain("<svg");
    }
  }, 30_000);

  it("rejects unsafe render bounds without replacing an existing output", () => {
    const dir = mkdtempSync(join(tmpdir(), "hogagent-vega-chart-bounds-"));
    tempDirs.push(dir);
    const specPath = join(dir, "tmp-gen-chart-bounds.json");
    const outputPath = join(dir, "chart.svg");
    writeFileSync(specPath, JSON.stringify({
      width: 8192,
      height: 8192,
      data: { values: [{ label: "A", value: 1 }] },
      mark: "bar",
      encoding: {
        x: { field: "label", type: "ordinal" },
        y: { field: "value", type: "quantitative" },
      },
    }));
    writeFileSync(outputPath, "existing-output", "utf8");

    const result = spawnSync(process.execPath, [chartScript, "--spec", specPath, "-o", outputPath], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("render area exceeds");
    expect(readFileSync(outputPath, "utf8")).toBe("existing-output");
  });

  it("rejects an explicit format that disagrees with the output extension", () => {
    const result = spawnSync(process.execPath, [
      chartScript, "--spec", "unused.json", "-o", "chart.png", "--format=svg",
    ], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match output extension");
  });
});
