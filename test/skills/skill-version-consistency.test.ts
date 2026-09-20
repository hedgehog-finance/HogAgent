import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED: Record<string, string> = {
  "company-valuation": "3.0.5",
  "doc-convert": "2.1.2",
  "fin-calc": "1.0.4",
  "gen-chart": "2.4.2",
  "gen-ppt": "2.4.3",
  "skill-creator": "1.0.1",
  "table-convert": "1.1.2",
  "tech-indicators": "1.1.2",
};

describe("bundled Skill versions", () => {
  it("keeps package, SKILL frontmatter, and lockfile root versions aligned", () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const directory = resolve("skills", name);
      const packagePath = resolve(directory, "package.json");
      if (existsSync(packagePath)) {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
        expect(packageJson.version, packagePath).toBe(expected);
      }

      const skillPath = resolve(directory, "SKILL.md");
      const skillText = readFileSync(skillPath, "utf8");
      expect(skillText, skillPath).toMatch(new RegExp(`^version: ${expected.replaceAll(".", "\\.")}$`, "m"));
      if (name === "gen-ppt") {
        expect(skillText, skillPath).toContain(`GenPPT \`v${expected}\``);
      }

      const lockPath = resolve(directory, "package-lock.json");
      if (existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        expect(lock.version, lockPath).toBe(expected);
        expect(lock.packages[""].version, lockPath).toBe(expected);
      }
    }
  });
});
