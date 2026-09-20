#!/usr/bin/env node

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_SKILL_NAME_LENGTH = 64;
const ALLOWED_RESOURCES = new Set(["scripts", "references", "assets"]);
const TODO_MARKER = `[${"TODO"}:`;

function fail(message) {
  console.error(`[ERROR] ${message}`);
  process.exitCode = 1;
}

function printUsage() {
  console.log("Usage: node init-skill.mjs <skill-name> --path <output-parent> [--resources scripts,references,assets] [--examples]");
}

function normalizeSkillName(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function titleCaseSkillName(value) {
  return value.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function takeOptionValue(args, index, option) {
  const argument = args[index];
  const inlinePrefix = `${option}=`;
  if (argument.startsWith(inlinePrefix)) {
    const value = argument.slice(inlinePrefix.length);
    if (!value) throw new Error(`${option} requires a value`);
    return { value, nextIndex: index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return { value, nextIndex: index + 1 };
}

function parseArgs(args) {
  if (args.length === 0) {
    printUsage();
    return null;
  }
  if (args.includes("--help") || args.includes("-h")) {
    if (args.length !== 1) throw new Error("--help cannot be combined with other arguments");
    printUsage();
    return null;
  }

  const rawName = args[0];
  if (rawName.startsWith("--")) throw new Error("skill-name must be the first argument");

  let outputParent = "";
  let rawResources = "";
  let examples = false;
  const seenOptions = new Set();

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--examples") {
      if (seenOptions.has("examples")) throw new Error("duplicate option: --examples");
      seenOptions.add("examples");
      examples = true;
      continue;
    }
    if (argument === "--path" || argument.startsWith("--path=")) {
      if (seenOptions.has("path")) throw new Error("duplicate option: --path");
      seenOptions.add("path");
      const parsed = takeOptionValue(args, index, "--path");
      outputParent = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (argument === "--resources" || argument.startsWith("--resources=")) {
      if (seenOptions.has("resources")) throw new Error("duplicate option: --resources");
      seenOptions.add("resources");
      const parsed = takeOptionValue(args, index, "--resources");
      rawResources = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }

  if (!outputParent) throw new Error("--path is required");

  const resources = [...new Set(rawResources.split(",").map((item) => item.trim()).filter(Boolean))];
  const invalidResources = resources.filter((item) => !ALLOWED_RESOURCES.has(item));
  if (invalidResources.length > 0) {
    throw new Error(`unknown resource type(s): ${invalidResources.join(", ")}; allowed: scripts, references, assets`);
  }
  if (examples && resources.length === 0) throw new Error("--examples requires --resources");

  return { rawName, outputParent, resources, examples };
}

function skillTemplate(skillName, skillTitle) {
  return `---
name: ${skillName}
description: >
    ${TODO_MARKER} Briefly describe what this skill does and when it applies.]
version: 1.0.0
---

# ${skillTitle}

${TODO_MARKER} Add the task-specific guidance HogAgent needs. Reference supporting files only when they are relevant.]
`;
}

function exampleScript(skillName) {
  return `#!/usr/bin/env node

// ${TODO_MARKER} Replace this scaffold with a deterministic helper or delete it.]
console.log("Example helper for ${skillName}");
`;
}

function exampleReference(skillTitle) {
  return `# ${skillTitle} Reference

${TODO_MARKER} Replace this scaffold with maintained, task-specific information or delete it.]
`;
}

const EXAMPLE_ASSET = `${TODO_MARKER} Replace this scaffold with an output asset or delete it.]\n`;

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function initializeSkill(options) {
  const skillName = normalizeSkillName(options.rawName);
  if (!skillName) throw new Error("skill-name must contain at least one letter or digit");
  if (skillName.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(`normalized skill name is ${skillName.length} characters; maximum is ${MAX_SKILL_NAME_LENGTH}`);
  }

  if (skillName !== options.rawName) {
    console.log(`[INFO] Normalized skill name: ${options.rawName} -> ${skillName}`);
  }

  const skillDir = resolve(options.outputParent, skillName);
  if (await pathExists(skillDir)) throw new Error(`skill directory already exists: ${skillDir}`);

  let created = false;
  try {
    await mkdir(skillDir, { recursive: true });
    created = true;
    await writeFile(resolve(skillDir, "SKILL.md"), skillTemplate(skillName, titleCaseSkillName(skillName)), "utf8");

    for (const resource of options.resources) {
      const resourceDir = resolve(skillDir, resource);
      await mkdir(resourceDir);
      if (!options.examples) continue;
      if (resource === "scripts") {
        await writeFile(resolve(resourceDir, "example.mjs"), exampleScript(skillName), "utf8");
      } else if (resource === "references") {
        await writeFile(resolve(resourceDir, "reference.md"), exampleReference(titleCaseSkillName(skillName)), "utf8");
      } else {
        await writeFile(resolve(resourceDir, "example-asset.txt"), EXAMPLE_ASSET, "utf8");
      }
    }
  } catch (error) {
    if (created) await rm(skillDir, { recursive: true, force: true });
    throw error;
  }

  console.log(`[OK] Initialized ${skillName} at ${skillDir}`);
  console.log("Next: replace TODO markers, remove unused resources, then run validate-skill.mjs.");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options) await initializeSkill(options);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  printUsage();
}
