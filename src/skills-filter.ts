/**
 * HogAgent Skills Filter
 *
 * Filters skills by conversation mode based on skills_config.json settings.
 * - Quick Mode: no skills
 * - Standard Mode: all skills except long-task-specific ones
 * - Long Task Mode: all skills
 */

import type { Skill } from "./vendor/agent/harness/types.ts";
import type { ConversationMode } from "./utils/types.ts";
import type { SkillApiConfigEntry } from "./config.ts";

/**
 * Filter skills based on the current conversation mode.
 *
 * @param allSkills - Full list of loaded skills
 * @param mode - Current conversation mode
 * @param skillsConfig - Per-skill config from ~/.hogagent/skills_config.json
 * @returns Filtered list of skills appropriate for the mode
 */
export function filterSkillsByMode(
  allSkills: Skill[],
  mode: ConversationMode,
  skillsConfig: Record<string, SkillApiConfigEntry>
): Skill[] {
  switch (mode) {
    case "quick":
      // Quick mode: no skills at all
      return [];

    case "standard":
      // Standard mode: exclude long-task-specific skills
      return allSkills.filter(
        (s) => skillsConfig[s.name]?.isLongTaskSpecific !== true
      );

    case "long_task":
      // Long task mode: all skills available
      return allSkills;
  }
}
