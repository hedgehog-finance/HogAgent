import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillHandlers } from "../../src/handlers/skill-handlers.ts";
import { RuntimeContextManager } from "../../src/runtime-context.ts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const mocks = vi.hoisted(() => ({ loadSkills: vi.fn(), llmChat: vi.fn() }));
vi.mock("../../src/skill-loader.ts", () => ({ loadSkillsFromDirs: mocks.loadSkills }));
vi.mock("../../src/llm-chat.ts", () => ({ llmChat: mocks.llmChat }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn(() => { throw new Error('Unexpected process launch'); }),
}));

function fixture(mode = "standard", workspaceDir = "/tmp") {
  const allSkills = [{ name: "old" }];
  const skillsConfig = {};
  const harness = { setResources: vi.fn().mockResolvedValue(undefined), getModel: vi.fn(), getTools: vi.fn(() => []) };
  const deps = {
    config: { workspaceDir, sessionId: "active" },
    harnessRef: { current: harness }, allSkills, skillsConfig,
    currentModeRef: { value: mode },
    runtimeContext: new RuntimeContextManager({ workspaceDir: "/tmp", mode: "rpc" }),
  };
  return { handlers: createSkillHandlers(deps as any, {} as any), allSkills, skillsConfig, harness };
}

describe("Skill refresh and isolated validation", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each(['..git', '...git', 'demo..git'])('rejects unsafe Git-derived names before filesystem mutation: %s', async name => {
    const root = mkdtempSync(join(tmpdir(), 'hog-skill-handler-'));
    try {
      const { handlers } = fixture('standard', root);
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.mocked(execFileSync).mockClear();
      await handlers.onInstallSkillFromGit({ type: 'install_skill_from_git', url: `https://example.test/${name}` });
      expect(write.mock.calls.some(([line]) => String(line).includes('Invalid skill name'))).toBe(true);
      expect(execFileSync).not.toHaveBeenCalled();
      expect(existsSync(join(root, '.hogagent'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["standard", "quick"])("refreshes the shared inventory while preserving %s mode", async (mode) => {
    const { handlers, allSkills, harness } = fixture(mode);
    const skills = [{ name: "installed" }];
    mocks.loadSkills.mockReturnValue(skills);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await handlers.onReloadConfig();
    expect(allSkills).toEqual(skills);
    expect(harness.setResources).toHaveBeenCalledWith({ skills: mode === "quick" ? [] : skills });
  });

  it("refreshes the existing skill-config reference before Standard filtering", async () => {
    const root = mkdtempSync(join(tmpdir(), "hog-skill-reload-"));
    vi.stubEnv("HOGAGENT_USER_DIR", root);
    writeFileSync(join(root, "skills_config.json"), JSON.stringify({
      longOnly: { isLongTaskSpecific: true },
      standard: { isLongTaskSpecific: false },
    }));
    const { handlers, skillsConfig, harness } = fixture("standard", root);
    mocks.loadSkills.mockReturnValue([{ name: "longOnly" }, { name: "standard" }]);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await handlers.onReloadConfig();
      expect(skillsConfig).toEqual({
        longOnly: { isLongTaskSpecific: true },
        standard: { isLongTaskSpecific: false },
      });
      expect(harness.setResources).toHaveBeenCalledWith({ skills: [{ name: "standard" }] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes unusual persisted names without changing the shared config prototype", async () => {
    const root = mkdtempSync(join(tmpdir(), "hog-skill-reload-prototype-"));
    vi.stubEnv("HOGAGENT_USER_DIR", root);
    writeFileSync(join(root, "skills_config.json"), '{"__proto__":{"isLongTaskSpecific":true}}');
    const { handlers, skillsConfig } = fixture("standard", root);
    const originalPrototype = Object.getPrototypeOf(skillsConfig);
    mocks.loadSkills.mockReturnValue([]);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await handlers.onReloadConfig();
      expect(Object.getPrototypeOf(skillsConfig)).toBe(originalPrototype);
      expect(Object.prototype.hasOwnProperty.call(skillsConfig, "__proto__")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { text: null },
    { text: 123 },
    { text: "hello", run_context: { schema_version: "unsupported" } },
  ])("closes invalid isolated requests without leaking conversation events: %j", async (input) => {
    const { handlers } = fixture();
    mocks.llmChat.mockClear();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await handlers.onLlmChat({ type: "llm_chat", session_id: "accounting-owner", ...input });
    const events = writeSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events.map(event => event.type)).toEqual(["error", "agent_end"]);
    expect(events.every(event => event.internal === true && event.session_id === "accounting-owner")).toBe(true);
    expect(mocks.llmChat).not.toHaveBeenCalled();
  });
});
