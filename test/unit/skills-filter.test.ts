import { describe, it, expect } from "vitest";
import { filterSkillsByMode } from "../../src/skills-filter.ts";
import type { Skill } from "../../src/vendor/agent/harness/types.ts";
import type { SkillApiConfigEntry } from "../../src/config.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSkill(name: string): Skill {
  return {
    name,
    description: `Skill ${name}`,
    content: `# ${name}`,
    filePath: `/skills/${name}/SKILL.md`,
  };
}

const allSkills: Skill[] = [
  makeSkill("web-search"),
  makeSkill("math-calc"),
  makeSkill("deep-analysis"),
  makeSkill("report-generator"),
];

const skillsConfig: Record<string, SkillApiConfigEntry> = {
  "deep-analysis": { isLongTaskSpecific: true },
  "report-generator": { isLongTaskSpecific: true },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("filterSkillsByMode", () => {
  it("should return empty array for quick mode", () => {
    const result = filterSkillsByMode(allSkills, "quick", skillsConfig);
    expect(result).toEqual([]);
  });

  it("should exclude long-task-specific skills for standard mode", () => {
    const result = filterSkillsByMode(allSkills, "standard", skillsConfig);
    expect(result.map((s) => s.name)).toEqual(["web-search", "math-calc"]);
  });

  it("should include all skills for long_task mode", () => {
    const result = filterSkillsByMode(allSkills, "long_task", skillsConfig);
    expect(result).toEqual(allSkills);
  });

  it("should handle empty skills config (all skills non-specific)", () => {
    const result = filterSkillsByMode(allSkills, "standard", {});
    expect(result).toEqual(allSkills);
  });

  it("should handle empty skills list", () => {
    expect(filterSkillsByMode([], "quick", skillsConfig)).toEqual([]);
    expect(filterSkillsByMode([], "standard", skillsConfig)).toEqual([]);
    expect(filterSkillsByMode([], "long_task", skillsConfig)).toEqual([]);
  });

  it("should handle isLongTaskSpecific set to false", () => {
    const config: Record<string, SkillApiConfigEntry> = {
      "web-search": { isLongTaskSpecific: false },
    };
    const result = filterSkillsByMode(allSkills, "standard", config);
    // isLongTaskSpecific: false should NOT exclude the skill
    expect(result.length).toBe(allSkills.length);
  });

  it("should handle skill not in config (treated as non-specific)", () => {
    const config: Record<string, SkillApiConfigEntry> = {
      "unknown-skill": { isLongTaskSpecific: true },
    };
    const result = filterSkillsByMode(allSkills, "standard", config);
    // No skill in allSkills is marked as long-task-specific in this config
    expect(result).toEqual(allSkills);
  });
});
