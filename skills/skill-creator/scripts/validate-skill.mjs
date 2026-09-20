#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const SUPPORTED_FRONTMATTER_KEYS = new Set(["name", "description", "version", "workflow_based"]);
const TEXT_EXTENSIONS = new Set([".md", ".mjs", ".js", ".ts", ".json", ".yaml", ".yml", ".txt", ".py", ".sh"]);
const TODO_MARKER = `[${"TODO"}:`;

function printUsage() {
  console.log("Usage: node validate-skill.mjs <skill-directory>");
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return null;

  const values = new Map();
  const keys = [];
  const duplicateKeys = [];
  let currentKey = "";

  for (const line of match[1].split(/\r?\n/)) {
    if (currentKey && /^\s+/.test(line)) {
      values.set(currentKey, `${values.get(currentKey) ?? ""} ${line.trim()}`);
      continue;
    }

    const keyValue = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!keyValue) continue;
    currentKey = keyValue[1];
    if (keys.includes(currentKey)) duplicateKeys.push(currentKey);
    else keys.push(currentKey);
    const rawValue = keyValue[2].trim();
    values.set(currentKey, rawValue === ">" || rawValue === "|" ? "" : rawValue);
  }

  return { values, keys, duplicateKeys, body: match[2] };
}

function extension(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

async function collectTextFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTextFiles(path));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extension(path))) {
      files.push(path);
    }
  }
  return files;
}

async function validateLocalLinks(skillMdPath, body) {
  const errors = [];
  const linkPattern = /\]\(([^)]+)\)/g;
  for (const match of body.matchAll(linkPattern)) {
    const target = match[1].trim().split("#", 1)[0];
    if (!/^(scripts|references|assets)\//.test(target)) continue;
    const targetPath = resolve(dirname(skillMdPath), target);
    try {
      const stats = await lstat(targetPath);
      if (!stats.isFile() && !stats.isDirectory()) errors.push(`linked resource is not a file or directory: ${target}`);
    } catch {
      errors.push(`linked resource does not exist: ${target}`);
    }
  }
  return errors;
}

async function validateSkill(skillDir) {
  const errors = [];
  const warnings = [];
  const resolvedSkillDir = resolve(skillDir);
  const skillMdPath = resolve(resolvedSkillDir, "SKILL.md");

  let stats;
  try {
    stats = await lstat(resolvedSkillDir);
  } catch {
    return { errors: [`skill directory does not exist: ${resolvedSkillDir}`], warnings };
  }
  if (!stats.isDirectory()) return { errors: [`skill path is not a directory: ${resolvedSkillDir}`], warnings };

  let content;
  try {
    content = await readFile(skillMdPath, "utf8");
  } catch {
    return { errors: [`SKILL.md not found or unreadable: ${skillMdPath}`], warnings };
  }

  const parsed = parseFrontmatter(content);
  if (!parsed) {
    errors.push("SKILL.md must begin with a valid --- frontmatter block");
    return { errors, warnings };
  }
  if (parsed.duplicateKeys.length > 0) {
    errors.push(`frontmatter contains duplicate key(s): ${[...new Set(parsed.duplicateKeys)].join(", ")}`);
  }

  const name = (parsed.values.get("name") ?? "").trim();
  const description = (parsed.values.get("description") ?? "").trim();
  const version = (parsed.values.get("version") ?? "").trim();
  const workflowBased = (parsed.values.get("workflow_based") ?? "").trim();

  if (!name) errors.push("frontmatter is missing a non-empty name");
  if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    errors.push(`name must be lowercase kebab-case: ${name}`);
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    errors.push(`name is ${name.length} characters; maximum is ${MAX_SKILL_NAME_LENGTH}`);
  }
  if (name && basename(resolvedSkillDir) !== name) {
    errors.push(`directory name '${basename(resolvedSkillDir)}' must match frontmatter name '${name}'`);
  }

  if (!description) errors.push("frontmatter is missing a non-empty description");
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description is ${description.length} characters; maximum is ${MAX_DESCRIPTION_LENGTH}`);
  }
  if (description.includes(TODO_MARKER)) errors.push("description contains an unfinished TODO marker");

  if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
    errors.push(`version must use numeric semantic versioning (for example 1.0.0): ${version}`);
  }
  if (workflowBased && !/^(true|false)$/i.test(workflowBased)) {
    errors.push(`workflow_based must be true or false: ${workflowBased}`);
  }

  const unsupportedKeys = parsed.keys.filter((key) => !SUPPORTED_FRONTMATTER_KEYS.has(key));
  if (unsupportedKeys.length > 0) {
    warnings.push(`HogAgent ignores unsupported frontmatter key(s): ${unsupportedKeys.join(", ")}`);
  }
  if (!parsed.body.trim()) errors.push("SKILL.md body is empty");

  for (const file of await collectTextFiles(resolvedSkillDir)) {
    const fileContent = await readFile(file, "utf8");
    if (fileContent.includes(TODO_MARKER)) {
      errors.push(`unfinished TODO marker in ${file.slice(resolvedSkillDir.length + 1)}`);
    }
  }

  errors.push(...await validateLocalLinks(skillMdPath, parsed.body));
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

if (process.argv.length !== 3 || process.argv[2] === "--help" || process.argv[2] === "-h") {
  printUsage();
  process.exitCode = process.argv.length === 3 ? 0 : 1;
} else {
  try {
    const result = await validateSkill(process.argv[2]);
    for (const warning of result.warnings) console.warn(`[WARN] ${warning}`);
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`[ERROR] ${error}`);
      process.exitCode = 1;
    } else {
      console.log(`[OK] Skill is valid: ${resolve(process.argv[2])}`);
    }
  } catch (error) {
    console.error(`[ERROR] Validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
