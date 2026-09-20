import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildSystemPrompt,
  getPlatformCommandGuidance,
  parseGatewayProcessInstructions,
} from "../../src/system-prompt.ts";
import type { Skill } from "../../src/vendor/agent/harness/types.ts";
import type { AgentTool } from "../../src/vendor/agent/types.ts";
import type { Model } from "../../src/vendor/ai/base.ts";

function makeSkill(name: string, filePath = `/discovery-source/${name}/SKILL.md`): Skill {
  return {
    name,
    description: `${name} description`,
    content: `# ${name}`,
    filePath,
  };
}

function makeTool(name: string): AgentTool {
  return { name } as AgentTool;
}

function buildPrompt(skills: Skill[] = [], activeTools: AgentTool[] = [], workspaceDir = "/workspace"): string {
  return buildSystemPrompt({
    workspaceDir,
    sessionTaskDir: join(workspaceDir, "tasks", "session"),
    model: {} as Model<any>,
    skills,
    activeTools,
  });
}

function createWorkspaceHogMemorySkill(): { workspaceDir: string; skill: Skill; cleanup: () => void } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "hogagent-memory-prompt-"));
  const skillPath = join(workspaceDir, ".hogagent", "skills", "hog-memory", "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, "---\nname: hog-memory\ndescription: test\n---\n");
  return {
    workspaceDir,
    skill: makeSkill("hog-memory", skillPath),
    cleanup: () => rmSync(workspaceDir, { recursive: true, force: true }),
  };
}

function expectCriticalMemoryRules(prompt: string): void {
  for (const taskType of ["market_insight", "research_record", "portfolio", "review", "strategy_quant"]) {
    expect(prompt).toContain(taskType);
  }
  expect(prompt).toContain("600519.SH");
  expect(prompt).toContain("Shenwan L1 industry");
  expect(prompt).toContain("key topics");
  expect(prompt).toContain("stock codes and industry");
  expect(prompt).toContain("same stock/industry history");
}

describe("memory system prompt guidance", () => {
  it("does not advertise writable memory or Skill execution during tool-free and read-only calls", () => {
    const fixture = createWorkspaceHogMemorySkill();
    try {
      for (const tools of [[], [makeTool("read")]]) {
        const prompt = buildPrompt([fixture.skill], tools, fixture.workspaceDir);
        expect(prompt).not.toContain('<memory_guidance>');
        expect(prompt).not.toContain('<self_evolution>');
        expect(prompt).not.toContain('**Skill CLI parameters**');
      }
    } finally { fixture.cleanup(); }
  });
  it("does not inject memory guidance without an active extension or hog-memory skill", () => {
    expect(buildPrompt([makeSkill("other-skill")], [makeTool("read")])).not.toContain("<memory_guidance>");
    expect(buildPrompt([], [makeTool("memory_save")])).not.toContain("<memory_guidance>");
    const invalidSkillPrompt = buildPrompt([makeSkill("hog-memory")]);
    expect(invalidSkillPrompt).not.toContain("<memory_guidance>");
    expect(invalidSkillPrompt).not.toContain("- hog-memory:");
  });

  it("injects extension-specific guidance when both memory extension tools are active", () => {
    const prompt = buildPrompt([], [makeTool("memory_save"), makeTool("memory_search")]);

    expect(prompt).toContain("<memory_extension>");
    expect(prompt).toContain("use memory_save to save and memory_search to search");
    expectCriticalMemoryRules(prompt);
    expect(prompt).not.toContain("<hog_memory_skill>");
  });

  it("injects skill-specific guidance when the hog-memory skill is available", () => {
    const fixture = createWorkspaceHogMemorySkill();
    const prompt = buildPrompt([fixture.skill], [makeTool("read"), makeTool("bash")], fixture.workspaceDir);

    expect(prompt).toContain("<hog_memory_skill>");
    expect(prompt).toContain("hog-memory description");
    expect(prompt).toContain(join(fixture.workspaceDir, ".hogagent", "skills", "hog-memory", "SKILL.md"));
    expect(prompt).toContain("use the skill's save operation");
    expect(prompt).toContain("standing workspace policy authorizes persistence");
    expect(prompt).not.toContain("SAVE proactively");
    expect(prompt).toContain("Tags convention:");
    expect(prompt).toContain("use the skill's search operation to retrieve memories");
    expect(prompt).not.toContain("/workspace/skills/hog-memory/cli.mjs");
    expect(prompt).toContain("recall, update, delete, list");
    expectCriticalMemoryRules(prompt);
    expect(prompt).not.toContain("/discovery-source/hog-memory/SKILL.md");
    expect(prompt).not.toContain("<memory_extension>");
    fixture.cleanup();
  });

  it("prefers the extension and ignores hog-memory when both are available", () => {
    const fixture = createWorkspaceHogMemorySkill();
    const prompt = buildPrompt(
      [fixture.skill],
      [makeTool("memory_save"), makeTool("memory_search")],
      fixture.workspaceDir,
    );

    expect(prompt).toContain("<memory_extension>");
    expect(prompt).not.toContain("<hog_memory_skill>");
    expect(prompt).not.toContain("hog-memory description");
    fixture.cleanup();
  });
});

describe("financial services compliance system prompt", () => {
  it('requires readable Gateway workspace rules while retaining quick prompt scope', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'hogagent-required-rules-'));
    vi.stubEnv('HOGAGENT_GATEWAY_MANAGED', '1');
    try {
      expect(() => buildPrompt([], [], workspace)).toThrow('Required workspace AGENTS.md is missing');
      writeFileSync(join(workspace, 'AGENTS.md'), '   ');
      expect(() => buildPrompt([], [], workspace)).toThrow('Required workspace AGENTS.md is missing');
      writeFileSync(join(workspace, 'AGENTS.md'), '# Product rules\nfixture workspace policy');
      expect(buildPrompt([], [], workspace)).toContain('fixture workspace policy');
      const quick = buildSystemPrompt({ workspaceDir: workspace, sessionTaskDir: workspace, model: {} as Model<any>, skills: [], activeTools: [], currentMode: 'quick' });
      expect(quick).toContain('HogAgent');
      expect(quick).toContain('fixture workspace policy');
    } finally {
      vi.unstubAllEnvs();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("retains the research-focused compliance policy in quick mode", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/workspace",
      sessionTaskDir: "/workspace/tasks/session",
      model: {} as Model<any>,
      skills: [],
      activeTools: [],
      currentMode: "quick",
    });

    expect(prompt).toContain("Financial Services Compliance");
    expect(prompt).toContain("focus on logic and reasoning without aiming to recommend stocks or buy/sell points");
    expect(prompt).toContain("must include code or an explanation of the approach");
    expect(prompt).toContain("transparent and adjustable to users");
    expect(prompt).toContain("must never operate as a black box");
    expect(prompt).not.toContain("user-confirmed");
    expect(prompt).toContain("only for simulation testing for research purposes");
    expect(prompt).not.toContain("must refuse unequivocally");
  });

  it("keeps Gateway process instructions in quick mode", () => {
    const previous = process.env.HOGAGENT_GATEWAY_PROCESS_INSTRUCTIONS;
    process.env.HOGAGENT_GATEWAY_PROCESS_INSTRUCTIONS = JSON.stringify([
      "金融数据源优先使用：hedgehog (以 `hedgehog-` 开头的技能)",
    ]);
    try {
      const prompt = buildSystemPrompt({
        workspaceDir: "/workspace",
        sessionTaskDir: "/workspace/tasks/session",
        model: {} as Model<any>,
        skills: [],
        activeTools: [],
        currentMode: "quick",
      });

      expect(prompt).toContain("<gateway_process_instructions>");
      expect(prompt).toContain("金融数据源优先使用：hedgehog");
    } finally {
      if (previous === undefined) delete process.env.HOGAGENT_GATEWAY_PROCESS_INSTRUCTIONS;
      else process.env.HOGAGENT_GATEWAY_PROCESS_INSTRUCTIONS = previous;
    }
  });

  it("ignores malformed Gateway process instructions", () => {
    expect(parseGatewayProcessInstructions("not-json")).toEqual([]);
    expect(parseGatewayProcessInstructions(JSON.stringify({ instruction: "ignored" }))).toEqual([]);
  });
});

describe("workspace and application-project prompt boundaries", () => {
  it("allows focused verification and complete Skill reads without loading DIY details", () => {
    const prompt = buildPrompt([], [makeTool("get_tool_details"), makeTool("query_tool_result"), makeTool("read")]);
    expect(prompt).toContain("run focused checks");
    for (const heading of ["## Core Capabilities", "## Guidelines", "## Working Principles", "## Working Directories", "## MANDATORY FILE DELIVERY PROTOCOL"]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain("continue to EOF");
    expect(prompt).not.toContain("skill docs < 500 lines");
    expect(prompt).not.toContain("## Research Project Contract");
    expect(prompt).not.toContain("project_resource_execute");
    expect(prompt).not.toContain("dashboard/page.json");
  });

  it("labels the workspace instructions without implying they replace project-scoped rules", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "hogagent-workspace-prompt-"));
    try {
      writeFileSync(join(workspaceDir, "AGENTS.md"), "Workspace convention for this test.");
      const prompt = buildPrompt([], [makeTool("write")], workspaceDir);
      expect(prompt).toContain("<workspace_instructions>\nWorkspace convention for this test.");
      expect(prompt).not.toContain("<project_context>");
      expect(prompt).toContain("HogAgent installation fallback");
      expect(prompt).toContain("neither file grants directory permissions");
      expect(prompt).not.toContain("Workspace version OVERRIDES project-root version");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("preserves native artifact areas without assuming application context support", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/workspace",
      sessionTaskDir: "/workspace/tasks/session",
      projectDir: "/workspace/native-project",
      model: {} as Model<any>,
      skills: [],
      activeTools: [],
    });
    expect(prompt).toContain("artifact area: publish/ deliverables, src/ code, data/ raw data");
    expect(prompt).toContain("does not enable an application context");
    expect(prompt).toContain("internal run state only");
    expect(prompt).not.toContain("log.txt, mode.json");
    expect(prompt).not.toContain("direct child of the current Agent workspace's");
    expect(prompt).toContain("Never emulate a rejected context");
  });
});

describe("platform command guidance", () => {
  it("warns Windows against nested inline JSON without claiming a sandbox", () => {
    const guidance = getPlatformCommandGuidance("win32", "x64");

    expect(guidance).toContain("never inline nested JSON");
    expect(guidance).toContain("PowerShell can strip embedded quotes");
    expect(guidance).toContain("cmd.exe is unsupported");
  });

  it("gives every platform the same flat-or-file Skill CLI rule", () => {
    const prompt = buildPrompt([], [makeTool("write"), makeTool("bash")]);

    expect(prompt).toContain("top-level string/finite-number/boolean values");
    expect(prompt).toContain("named arguments");
    expect(prompt).toContain("tmp-<skill-name>-<id>.json");
    expect(prompt).toContain("Never inline nested JSON or mix payload sources");
  });
});


describe("partial retrieval tool catalogues", () => {
  it.each(["get_tool_details", "query_tool_result"])("advertises only the available %s retrieval tool", name => {
    const prompt = buildPrompt([], [makeTool(name)]);
    const guidance = prompt.split("<data_access_strategies>")[1].split("</data_access_strategies>")[0];
    expect(guidance).toContain(name + "(");
    expect(guidance).not.toContain((name === "get_tool_details" ? "query_tool_result" : "get_tool_details") + "(");
    expect(guidance).not.toContain("read(");
  });
});
