#!/usr/bin/env node
/** Parse every documented JSON block and generate all complete examples. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = dirname(scriptDir);
const args = process.argv.slice(2);
if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
  console.log("Usage: smoke-test-docs.mjs");
  process.exit(0);
}
if (args.length > 0) {
  console.error(`Error: unexpected argument: ${args[0]}`);
  process.exit(1);
}
const workDir = mkdtempSync(join(tmpdir(), "gen-ppt-docs-"));

function jsonBlocks(relativePath) {
  const filePath = join(skillDir, relativePath);
  const markdown = readFileSync(filePath, "utf8");
  const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  return blocks.map((block, index) => {
    try {
      return JSON.parse(block);
    } catch (error) {
      throw new Error(`${relativePath} JSON block ${index + 1} is invalid: ${error.message}`);
    }
  });
}

try {
  const examples = jsonBlocks("references/examples.md");
  jsonBlocks("references/json-schema.md");
  if (examples.length !== 6) throw new Error(`Expected 6 complete examples, found ${examples.length}`);

  for (const [index, config] of examples.entries()) {
    const configPath = join(workDir, `example-${index + 1}.json`);
    const outputPath = join(workDir, `example-${index + 1}.pptx`);
    writeFileSync(configPath, JSON.stringify(config));
    const result = spawnSync(process.execPath, [join(scriptDir, "gen-ppt.mjs"), configPath, outputPath], { encoding: "utf8", shell: false, timeout: 300_000 });
    if (result.error || result.status !== 0) {
      throw new Error(`Example ${index + 1} failed generation: ${(result.stderr || result.stdout || result.error?.message).trim()}`);
    }
  }
  console.log(`Documentation smoke test passed (${examples.length} generated examples)`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
