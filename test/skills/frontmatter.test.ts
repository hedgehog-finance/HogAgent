import { describe, it, expect } from "vitest";
import { parseSkillFrontmatter } from "../../src/index.ts";

describe("parseSkillFrontmatter", () => {
  it("accepts Windows CRLF frontmatter and preserves the body", () => {
    const result = parseSkillFrontmatter("---\r\nname: windows-skill\r\ndescription: >\r\n  First line.\r\n  Second line.\r\nworkflow_based: true\r\n---\r\n# Body\r\n");
    expect(result).toEqual({
      name: "windows-skill", description: "First line. Second line.", workflowBased: true, body: "# Body\r\n",
    });
  });
  it("should parse valid frontmatter with name, description, and version", () => {
    const content = `---
name: gen-chart
description: Generate charts and diagrams.
version: 1.0.0
---

# GenChart`;

    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("gen-chart");
    expect(result!.description).toBe("Generate charts and diagrams.");
    expect(result!.body).toContain("# GenChart");
  });

  it("should parse multi-line description with > folded syntax", () => {
    const content = `---
name: test-skill
description: >
    Line one of description.
    Applicable: scenario A, scenario B.
    Triggers: trigger1, trigger2.
    Blocking: block1.
version: 1.0.0
---

Body content here.`;

    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("test-skill");
    expect(result!.description).toContain("Line one of description.");
    expect(result!.description).toContain("Applicable: scenario A, scenario B.");
    expect(result!.description).toContain("Triggers: trigger1, trigger2.");
    expect(result!.description).toContain("Blocking: block1.");
    // Folded: all on one line joined by spaces
    expect(result!.description).not.toContain("\n");
  });

  it("should return null when no frontmatter block exists", () => {
    const content = `# Some Skill\nNo frontmatter here.`;
    const result = parseSkillFrontmatter(content);
    expect(result).toBeNull();
  });

  it("should return empty name when frontmatter lacks name field", () => {
    const content = `---
description: Only description here.
version: 1.0.0
---

Body.`;

    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("");
    expect(result!.description).toBe("Only description here.");
  });

  it("should return empty description when frontmatter lacks description field", () => {
    const content = `---
name: only-name
version: 1.0.0
---

Body.`;

    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("only-name");
    expect(result!.description).toBe("");
  });

  it("should handle body after frontmatter correctly", () => {
    const content = `---
name: skill-a
description: Desc.
---

# Heading

## Section

Content here.`;

    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.body).toContain("# Heading");
    expect(result!.body).toContain("## Section");
    expect(result!.body).toContain("Content here.");
  });

  it("should return null when frontmatter is empty (no fields)", () => {
    const content = `---
---

Just body.`;

    const result = parseSkillFrontmatter(content);
    expect(result).toBeNull();
  });

  it("should handle description with pipe (|) literal syntax", () => {
    const content = `---
name: pipe-skill
description: |
    Preserved line breaks
    in this description.
version: 1.0.0
---

Body.`;

    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("pipe-skill");
    expect(result!.description).toContain("Preserved line breaks");
  });

  it("should trim whitespace from name and description", () => {
    const content = `---
name:   spaced-name
description:   spaced desc
---

Body.`;

    const result = parseSkillFrontmatter(content);
    expect(result!.name).toBe("spaced-name");
    expect(result!.description).toBe("spaced desc");
  });

  it("should parse workflow_based: true from frontmatter", () => {
    const content = `---
name: morning-briefing
description: Daily briefing.
version: 1.3.0
workflow_based: true
---

Body.`;

    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.workflowBased).toBe(true);
  });

  it("should default workflowBased to false when not declared", () => {
    const content = `---
name: simple-skill
description: A simple skill.
version: 1.0.0
---

Body.`;

    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.workflowBased).toBe(false);
  });

  it("should handle workflow_based: false explicitly", () => {
    const content = `---
name: test-skill
description: Test.
workflow_based: false
---

Body.`;

    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.workflowBased).toBe(false);
  });
});
