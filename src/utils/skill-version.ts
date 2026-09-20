/**
 * Skill version reading and comparison utilities.
 *
 * Extracts the version from SKILL.md frontmatter for installation safeguards:
 * newer versions may replace older versions, while older versions are rejected.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the version field from the skill directory's SKILL.md frontmatter.
 * Returns '0.0.0' when the file or field is absent, treating the skill as replaceable.
 */
export function readSkillVersion(skillDir: string): string {
  try {
    const mdPath = join(skillDir, "SKILL.md");
    if (!existsSync(mdPath)) return "0.0.0";
    const content = readFileSync(mdPath, "utf-8");
    // Parse YAML frontmatter: --- ... ---
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return "0.0.0";
    const frontmatter = match[1];
    // Extract the version field.
    const versionMatch = frontmatter.match(/^version:\s*(.+)$/m);
    if (!versionMatch) return "0.0.0";
    return versionMatch[1].trim().replace(/^['"]|['"]$/g, "");
  } catch {
    return "0.0.0";
  }
}

/**
 * Compares semver values by splitting them into numeric segments.
 * @returns -1 (a < b), 0 (a == b), 1 (a > b)
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.isFinite(pa[i]) ? pa[i] as number : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i] as number : 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
