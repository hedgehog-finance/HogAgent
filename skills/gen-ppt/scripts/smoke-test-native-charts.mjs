#!/usr/bin/env node
/** Regression test for all supported editable native chart types. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pptxgen from "pptxgenjs";
import { parseViewerArgs } from "./cli-args.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
let parsedArgs;
try {
  parsedArgs = parseViewerArgs(process.argv.slice(2), { requireFile: false });
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
if (parsedArgs.help) {
  console.log("Usage: smoke-test-native-charts.mjs [--libreoffice] [--keynote] [--powerpoint]");
  process.exit(0);
}
const viewerFlags = Object.keys(parsedArgs.options).map((name) => `--${name}`);
const workDir = mkdtempSync(join(tmpdir(), "gen-ppt-native-chart-smoke-"));
const keynoteRequested = viewerFlags.includes("--keynote");
const positiveViewerFlags = viewerFlags.filter((flag) => flag !== "--keynote");

function run(command, args, expectSuccess = true) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, timeout: 300_000 });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (expectSuccess && (result.error || result.status !== 0)) throw new Error(output.trim() || result.error?.message || `${command} failed`);
  if (!expectSuccess && !result.error && result.status === 0) throw new Error(`Expected failure but command succeeded: ${command} ${args.join(" ")}`);
  return output;
}

function categoryChart(type, values = [1, 2, 3]) {
  return { layout: "chart", title: type, chart: { type, data: [{ name: type, labels: ["A", "B", "C"], values }] } };
}

try {
  const configPath = join(workDir, "all-native-charts.json");
  const outputPath = join(workDir, "all-native-charts.pptx");
  writeFileSync(configPath, JSON.stringify({
    title: "Native chart smoke test",
    slides: [
      categoryChart("bar", [1, -2, 3]),
      categoryChart("line", [1, -2, 3]),
      categoryChart("pie"),
      categoryChart("doughnut"),
      categoryChart("area", [1, -2, 3]),
      { layout: "chart", title: "scatter", chart: { type: "scatter", data: [
        { name: "Observed", xValues: [1, 2, 3], yValues: [2, 4, 3] },
        { name: "Forecast", xValues: [1, 2, 3], yValues: [1, 3, 5] },
      ] } },
      categoryChart("radar"),
    ],
  }, null, 2));

  run(process.execPath, [join(scriptDir, "gen-ppt.mjs"), configPath, outputPath]);
  const validation = run(process.execPath, [join(scriptDir, "validate-pptx.mjs"), outputPath, ...positiveViewerFlags]);
  if (!validation.includes("7 native charts")) throw new Error(`Expected seven validated native charts; got: ${validation.trim()}`);
  if (keynoteRequested) {
    const keynoteFailure = run(process.execPath, [join(scriptDir, "validate-pptx.mjs"), outputPath, "--keynote"], false);
    if (!keynoteFailure.includes("PptxGenJS deck contains 7 native chart")) {
      throw new Error(`Keynote native-chart guard failed for the wrong reason: ${keynoteFailure.trim()}`);
    }
  }

  const targetFailure = run(process.execPath, [join(scriptDir, "gen-ppt.mjs"), configPath, join(workDir, "keynote-native-charts.pptx"), "--target=keynote"], false);
  if (!targetFailure.includes("keynote compatibility mode rejects PptxGenJS native charts")) {
    throw new Error(`Keynote target policy failed for the wrong reason: ${targetFailure.trim()}`);
  }

  const badScatterPath = join(workDir, "bad-scatter.json");
  writeFileSync(badScatterPath, JSON.stringify({ slides: [categoryChart("scatter")] }));
  const scatterFailure = run(process.execPath, [join(scriptDir, "gen-ppt.mjs"), badScatterPath, join(workDir, "bad-scatter.pptx")], false);
  if (!scatterFailure.includes("Scatter chart requires")) throw new Error(`Invalid scatter failed for the wrong reason: ${scatterFailure.trim()}`);

  const rawPath = join(workDir, "unnormalized-pptxgenjs.pptx");
  const raw = new pptxgen();
  raw.addSlide().addChart("line", [{ name: "Raw", labels: ["A", "B"], values: [1, 2] }], { x: 1, y: 1, w: 8, h: 4 });
  await raw.writeFile({ fileName: rawPath });
  const rawFailure = run(process.execPath, [join(scriptDir, "validate-pptx.mjs"), rawPath], false);
  if (!rawFailure.includes("chart relationship target must be relative") && !rawFailure.includes("lineChart is missing required grouping")) {
    throw new Error(`Unnormalized PptxGenJS output failed for the wrong reason: ${rawFailure.trim()}`);
  }

  // Confirm the generated artifact remained readable after all negative tests.
  if (readFileSync(outputPath).length === 0) throw new Error("Smoke-test PPTX is empty");
  console.log(`Native chart smoke test passed${viewerFlags.length ? ` (${viewerFlags.join(", ")}; Keynote uses the expected PNG-only guard)` : ""}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
