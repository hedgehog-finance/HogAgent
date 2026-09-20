import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const TEST_DIRS: string[] = [];
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_CREATOR_DIR = resolve(CURRENT_DIR, "../../skills/skill-creator");
const INIT_SCRIPT = join(SKILL_CREATOR_DIR, "scripts/init-skill.mjs");
const VALIDATE_SCRIPT = join(SKILL_CREATOR_DIR, "scripts/validate-skill.mjs");

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "hogagent-skill-creator-"));
  TEST_DIRS.push(directory);
  return directory;
}

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

afterEach(() => {
  for (const directory of TEST_DIRS.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("skill-creator scripts", () => {
  it("initializes a minimal normalized skill and validates it after authoring", () => {
    const outputParent = makeTempDir();
    const initialized = runScript(INIT_SCRIPT, [
      "Research Helper",
      "--path",
      outputParent,
      "--resources",
      "scripts,references",
    ]);

    expect(initialized.status).toBe(0);
    expect(initialized.stdout).toContain("Research Helper -> research-helper");

    const skillDir = join(outputParent, "research-helper");
    const skillMdPath = join(skillDir, "SKILL.md");
    expect(readFileSync(skillMdPath, "utf8")).toContain("name: research-helper");
    expect(existsSync(join(skillDir, "scripts"))).toBe(true);
    expect(existsSync(join(skillDir, "references"))).toBe(true);

    const authoredSkill = `---
name: research-helper
description: Research a supplied topic using the sources and boundaries selected by the user.
version: 1.0.0
---

# Research Helper

Preserve the user's scope and cite the supplied sources.
`;
    writeFileSync(skillMdPath, authoredSkill, "utf8");

    const validated = runScript(VALIDATE_SCRIPT, [skillDir]);
    expect(validated.status).toBe(0);
    expect(validated.stdout).toContain("Skill is valid");
  });

  it("rejects unfinished scaffolds and a directory/frontmatter name mismatch", () => {
    const outputParent = makeTempDir();
    const initialized = runScript(INIT_SCRIPT, ["draft-skill", "--path", outputParent]);
    expect(initialized.status).toBe(0);

    const scaffoldValidation = runScript(VALIDATE_SCRIPT, [join(outputParent, "draft-skill")]);
    expect(scaffoldValidation.status).toBe(1);
    expect(scaffoldValidation.stderr).toContain("unfinished TODO marker");

    const mismatchedDir = join(outputParent, "wrong-directory");
    mkdirSync(mismatchedDir);
    writeFileSync(join(mismatchedDir, "SKILL.md"), `---
name: right-name
description: A complete description.
version: 1.0.0
---

# Complete body
`, "utf8");

    const mismatchValidation = runScript(VALIDATE_SCRIPT, [mismatchedDir]);
    expect(mismatchValidation.status).toBe(1);
    expect(mismatchValidation.stderr).toContain("must match frontmatter name");
  });

  it("accepts CRLF frontmatter and rejects duplicate frontmatter and CLI options", () => {
    const outputParent = makeTempDir();
    const skillDir = join(outputParent, "portable-skill");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), [
      "---",
      "name: portable-skill",
      "description: A complete portable skill.",
      "version: 1.0.0",
      "---",
      "",
      "# Portable Skill",
      "",
      "Complete guidance.",
      "",
    ].join("\r\n"), "utf8");

    expect(runScript(VALIDATE_SCRIPT, [skillDir]).status).toBe(0);

    writeFileSync(join(skillDir, "SKILL.md"), `---
name: portable-skill
name: shadowed-name
description: A complete description.
---

# Duplicate
`, "utf8");
    const duplicateFrontmatter = runScript(VALIDATE_SCRIPT, [skillDir]);
    expect(duplicateFrontmatter.status).toBe(1);
    expect(duplicateFrontmatter.stderr).toContain("duplicate key(s): name");

    const duplicateOption = runScript(INIT_SCRIPT, [
      "another-skill", "--path", outputParent, "--path", outputParent,
    ]);
    expect(duplicateOption.status).toBe(1);
    expect(duplicateOption.stderr).toContain("duplicate option: --path");
  });
});
