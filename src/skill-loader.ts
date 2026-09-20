/**
 * Skill Loading & Frontmatter Parsing
 *
 * Discovers and loads skills from workspace directories, parsing
 * YAML frontmatter from SKILL.md files.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverSkills } from "./config.ts";
import { createLogger } from "./utils/logger.ts";
import type { Skill } from "./vendor/agent/harness/types.ts";

const log = createLogger("core");

function loadSkillsFromDirs(workspaceDir: string): Skill[] {
  const skills: Skill[] = [];
  const descriptors = discoverSkills(workspaceDir);

  for (const descriptor of descriptors) {
    const skillMdPath = join(descriptor.path, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    try {
      const content = readFileSync(skillMdPath, "utf-8");
      const parsed = parseSkillFrontmatter(content);

      // Skip skills without valid frontmatter (must have name + description)
      if (!parsed || !parsed.name || !parsed.description) {
        log.warn("Skipping skill without frontmatter", { path: skillMdPath });
        continue;
      }

      skills.push({
        name: parsed.name,
        description: parsed.description,
        content: parsed.body,
        filePath: skillMdPath,
        workflowBased: parsed.workflowBased,
      });
    } catch {
      // Skip unreadable skills
    }
  }

  return skills;
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Supports multi-line values using YAML `>` (folded) syntax.
 * Returns null if no frontmatter block is found.
 */
export function parseSkillFrontmatter(content: string): { name: string; description: string; body: string; workflowBased: boolean } | null {

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
  if (!match) return null;

  const fmLines = match[1]!.split(/\r?\n/);
  const body = match[2]!;
  const result: Record<string, string> = {};
  let currentKey = "";

  for (const line of fmLines) {
    // Continuation line (indented, belongs to previous key)
    if (currentKey && /^\s+/.test(line)) {
      result[currentKey] = (result[currentKey] ?? "") + " " + line.trim();
      continue;
    }

    // New key-value pair
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;

    currentKey = kv[1]!;
    const rawValue = kv[2]!.trim();

    // `>` folded scalar: value continues on next indented lines
    if (rawValue === ">" || rawValue === "|") {
      result[currentKey] = "";
      continue;
    }

    result[currentKey] = rawValue;
  }

  return {
    name: result.name?.trim() ?? "",
    description: result.description?.trim() ?? "",
    body,
    workflowBased: result.workflow_based?.trim().toLowerCase() === "true",
  };
}

export { loadSkillsFromDirs };
