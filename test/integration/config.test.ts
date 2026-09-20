import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { rmSync } from "node:fs";
import {
  loadConfig,
  discoverSkills,
  getSystemDir,
  getDefaultWorkspaceDir,
  getSessionsDir,
  loadSkillApiConfig,
  readModeMetadata,
  saveSkillApiConfig,
  saveSystemConfig,
  writeModeMetadata,
} from "../../src/config.ts";

describe("config module", () => {
  let tempDir: string;
  let tempSystemDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hogagent-config-"));
    tempSystemDir = mkdtempSync(join(tmpdir(), "hogagent-system-"));
    // Redirect user config dir to temp so tests never touch ~/.hogagent
    process.env["HOGAGENT_USER_DIR"] = tempSystemDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(tempSystemDir, { recursive: true, force: true });
    // Clean up env vars
    delete process.env["HOGAGENT_USER_DIR"];
    delete process.env["HOGAGENT_LLM_API_KEY"];
    delete process.env["HOGAGENT_LLM_PROVIDER"];
    delete process.env["HOGAGENT_LLM_BASE_URL"];
    delete process.env["HOGAGENT_AUDIT_PROVIDER"];
    delete process.env["HOGAGENT_AUDIT_API_KEY"];
    delete process.env["HOGAGENT_AUDIT_BASE_URL"];
    delete process.env["HOGAGENT_AUDIT_MODEL_ID"];
    delete process.env["HOGAGENT_AUDIT_MIN_PASS_SCORE"];
    delete process.env["HOGAGENT_AUDIT_MAX_ITERATIONS"];
    delete process.env["HOGAGENT_PROJECT_ROOT"];
  });

  describe("default configuration loading", () => {
    it("should return default config with rpc mode", () => {
      const config = loadConfig({ workspaceDir: tempDir });
      expect(config.mode).toBe("rpc");
    });

    it("should have a valid sessionId", () => {
      const config = loadConfig({ workspaceDir: tempDir });
      expect(config.sessionId).toBeDefined();
      expect(config.sessionId.length).toBeGreaterThan(0);
    });

    it("should have default LLM provider", () => {
      const config = loadConfig({ workspaceDir: tempDir });
      expect(config.llmProvider.provider).toBe("hedgehog");
      expect(config.llmProvider.models.length).toBeGreaterThan(0);
      expect(config.llmProvider.models[0]?.id).toBe("qwen3.8-flash");
    });
  });

  describe("environment variable override", () => {
    it("lets persisted keyless custom settings clear an inherited API key", () => {
      process.env["HOGAGENT_LLM_API_KEY"] = "inherited-key";
      process.env["HOGAGENT_LLM_BASE_URL"] = "https://old.example/v1";
      writeFileSync(join(tempSystemDir, "llm-settings.json"), JSON.stringify({
        provider: "custom",
        apiKey: "",
        baseUrl: "http://localhost:11434/v1",
        modelId: "local-model",
      }));

      const config = loadConfig({ workspaceDir: tempDir });

      expect(config.llmProvider).toMatchObject({
        provider: "custom",
        apiKey: "",
        baseUrl: "http://localhost:11434/v1",
      });
      expect(process.env["HOGAGENT_LLM_API_KEY"]).toBe("");
    });

    it("lets a persisted keyless custom audit model override inherited audit credentials", () => {
      process.env["HOGAGENT_AUDIT_PROVIDER"] = "openai";
      process.env["HOGAGENT_AUDIT_API_KEY"] = "inherited-audit-key";
      process.env["HOGAGENT_AUDIT_BASE_URL"] = "https://old.example/v1";
      process.env["HOGAGENT_AUDIT_MODEL_ID"] = "old-audit-model";
      writeFileSync(join(tempSystemDir, "llm-settings.json"), JSON.stringify({
        audit: {
          provider: "custom",
          apiKey: "",
          baseUrl: "http://localhost:11434/v1",
          modelId: "local-audit-model",
        },
      }));

      const config = loadConfig({ workspaceDir: tempDir });

      expect(config.auditModel).toMatchObject({
        provider: "custom",
        apiKey: "",
        baseUrl: "http://localhost:11434/v1",
        modelId: "local-audit-model",
      });
    });

    it("should use 70 as the default audit passing score", () => {
      process.env["HOGAGENT_AUDIT_PROVIDER"] = "openai";
      process.env["HOGAGENT_AUDIT_API_KEY"] = "audit-key";
      process.env["HOGAGENT_AUDIT_MODEL_ID"] = "audit-model";

      const config = loadConfig({ workspaceDir: tempDir });

      expect(config.auditModel?.minPassScore).toBe(70);
    });

    it.each(["-1", "1.5", "NaN", "9007199254740992"])(
      "falls back to two retries for invalid audit maxIterations %s",
      (maxIterations) => {
        process.env["HOGAGENT_AUDIT_PROVIDER"] = "openai";
        process.env["HOGAGENT_AUDIT_API_KEY"] = "audit-key";
        process.env["HOGAGENT_AUDIT_MODEL_ID"] = "audit-model";
        process.env["HOGAGENT_AUDIT_MAX_ITERATIONS"] = maxIterations;
        expect(loadConfig({ workspaceDir: tempDir }).auditModel?.maxIterations).toBe(2);
      },
    );

    it("accepts zero audit retries from the environment", () => {
      process.env["HOGAGENT_AUDIT_PROVIDER"] = "openai";
      process.env["HOGAGENT_AUDIT_API_KEY"] = "audit-key";
      process.env["HOGAGENT_AUDIT_MODEL_ID"] = "audit-model";
      process.env["HOGAGENT_AUDIT_MAX_ITERATIONS"] = "0";
      expect(loadConfig({ workspaceDir: tempDir }).auditModel?.maxIterations).toBe(0);
    });

    it("treats an explicit null historical retry count as invalid instead of falling through to the environment", () => {
      process.env["HOGAGENT_AUDIT_MAX_ITERATIONS"] = "7";
      writeFileSync(join(tempSystemDir, "llm-settings.json"), JSON.stringify({
        audit: { provider: "custom", apiKey: "", modelId: "audit-model", maxIterations: null },
      }));
      expect(loadConfig({ workspaceDir: tempDir }).auditModel?.maxIterations).toBe(2);
    });

    it("should override API key from env", () => {
      process.env["HOGAGENT_LLM_API_KEY"] = "test-api-key";
      const config = loadConfig({ workspaceDir: tempDir });
      expect(config.llmProvider.apiKey).toBe("test-api-key");
    });

    it("should override LLM provider from env", () => {
      process.env["HOGAGENT_LLM_PROVIDER"] = "openai";
      const config = loadConfig({ workspaceDir: tempDir });
      expect(config.llmProvider.provider).toBe("openai");
    });

    it("should override LLM base URL from env", () => {
      process.env["HOGAGENT_LLM_BASE_URL"] = "http://custom-llm:8080/v1";
      const config = loadConfig({ workspaceDir: tempDir });
      expect(config.llmProvider.baseUrl).toBe("http://custom-llm:8080/v1");
    });
  });

  describe("CLI args override", () => {
    it("should override mode from CLI", () => {
      const config = loadConfig({ mode: "interactive", workspaceDir: tempDir });
      expect(config.mode).toBe("interactive");
    });

    it("should override session ID from CLI", () => {
      const config = loadConfig({ sessionId: "cli-session", workspaceDir: tempDir });
      expect(config.sessionId).toBe("cli-session");
    });
  });

  describe("system config loading", () => {
    it("should load extensions from hogagent.json", () => {
      // Write hogagent.json with extensions field to system dir
      writeFileSync(
        join(tempSystemDir, "hogagent.json"),
        JSON.stringify({
          explicitCache: false,
          extensions: [{ name: "test-ext", enabled: true, config: { key: "value" } }],
        }),
      );

      const config = loadConfig({ workspaceDir: tempDir });
      const ext = config.extensions.find((e) => e.name === "test-ext");
      expect(ext).toBeDefined();
      expect(ext!.enabled).toBe(true);
    });

    it("reports system config persistence failures", () => {
      const blockedSystemDir = join(tempSystemDir, "not-a-directory");
      writeFileSync(blockedSystemDir, "blocked");
      process.env["HOGAGENT_USER_DIR"] = blockedSystemDir;

      expect(() => saveSystemConfig({ sandboxMode: "disabled" }))
        .toThrow(`Cannot write configuration file ${join(blockedSystemDir, "hogagent.json")}`);
    });
  });

  describe("skill discovery", () => {
    it("should discover workspace skills", () => {
      const wsSkillsDir = join(tempDir, ".hogagent", "skills");
      mkdirSync(join(wsSkillsDir, "my-skill"), { recursive: true });
      mkdirSync(join(wsSkillsDir, "another-skill"), { recursive: true });

      const skills = discoverSkills(tempDir);
      const wsSkills = skills.filter((s) => s.source === "workspace");
      expect(wsSkills.length).toBe(2);
      expect(wsSkills.map((s) => s.name)).toContain("my-skill");
      expect(wsSkills.map((s) => s.name)).toContain("another-skill");
    });

    it("should return no workspace skills when workspace skills directory is absent", () => {
      const skills = discoverSkills(tempDir);
      const wsSkills = skills.filter((s) => s.source === "workspace");
      expect(wsSkills).toEqual([]);
    });
  });

  describe("graceful fallback", () => {
    it("should handle missing config gracefully", () => {
      // loadConfig with a non-existent workspace should still return defaults
      const config = loadConfig({ workspaceDir: "/nonexistent/path" });
      expect(config).toBeDefined();
      expect(config.mode).toBe("rpc");
    });

    it("should handle invalid JSON in config files", () => {
      const wsConfigDir = join(tempDir, ".hogagent");
      mkdirSync(wsConfigDir, { recursive: true });
      writeFileSync(join(wsConfigDir, "extensions.json"), "{ invalid json }");

      // Should not throw
      const config = loadConfig({ workspaceDir: tempDir });
      expect(config).toBeDefined();
    });

    it("treats an invalid persisted conversation mode as missing without rewriting it", () => {
      const taskDir = join(tempDir, "tasks", "invalid-mode");
      mkdirSync(taskDir, { recursive: true });
      const path = join(taskDir, "mode.json");
      const raw = JSON.stringify({ mode: "turbo", optimizedPrompt: "keep me" });
      writeFileSync(path, raw);

      expect(readModeMetadata(taskDir)).toBeNull();
      expect(readFileSync(path, "utf-8")).toBe(raw);
    });

    it("freezes legacy mode title fallbacks when the next prompt updates metadata", () => {
      const promptDir = join(tempDir, "tasks", "legacy-prompt");
      mkdirSync(promptDir, { recursive: true });
      writeFileSync(join(promptDir, "mode.json"), JSON.stringify({
        mode: "standard", optimizedPrompt: "original prompt",
      }));
      writeModeMetadata(promptDir, {
        mode: "standard", optimizedPrompt: "later follow-up", createdAt: new Date().toISOString(),
      });
      expect(readModeMetadata(promptDir)).toMatchObject({
        firstOptimizedPrompt: "original prompt",
        optimizedPrompt: "later follow-up",
      });

      const goalsDir = join(tempDir, "tasks", "legacy-goals");
      mkdirSync(goalsDir, { recursive: true });
      writeFileSync(join(goalsDir, "mode.json"), JSON.stringify({
        mode: "long_task", goals: ["original goal"],
      }));
      writeModeMetadata(goalsDir, {
        mode: "long_task", optimizedPrompt: "later follow-up", createdAt: new Date().toISOString(),
      });
      expect(readModeMetadata(goalsDir)).toMatchObject({
        firstGoals: ["original goal"],
        optimizedPrompt: "later follow-up",
      });
      expect(readModeMetadata(goalsDir)?.firstOptimizedPrompt).toBeUndefined();
    });

    it("normalizes legacy skill boolean strings in memory without migrating the file", () => {
      const path = join(tempSystemDir, "skills_config.json");
      const raw = JSON.stringify({
        legacyLong: { isLongTaskSpecific: "true" },
        legacyStandard: { isLongTaskSpecific: "false" },
        invalid: { isLongTaskSpecific: "yes" },
        malformedNull: null,
        malformedScalar: "long-task",
      });
      writeFileSync(path, raw);

      expect(loadSkillApiConfig()).toEqual({
        legacyLong: { isLongTaskSpecific: true },
        legacyStandard: { isLongTaskSpecific: false },
        invalid: {},
      });
      expect(readFileSync(path, "utf-8")).toBe(raw);

      writeFileSync(path, '"malformed-root"');
      expect(loadSkillApiConfig()).toEqual({});
      expect(readFileSync(path, "utf-8")).toBe('"malformed-root"');
    });

    it("persists unusual skill names as own data without mutating object prototypes", () => {
      writeFileSync(join(tempSystemDir, "skills_config.json"), '{}');
      saveSkillApiConfig("__proto__", { isLongTaskSpecific: true });
      const parsed = JSON.parse(readFileSync(join(tempSystemDir, "skills_config.json"), "utf-8"));
      expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
      expect(parsed.__proto__).toEqual({ isLongTaskSpecific: true });
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    });
  });

  describe("getSystemDir", () => {
    it("should return HOGAGENT_USER_DIR when set", () => {
      const dir = getSystemDir();
      expect(dir).toBe(tempSystemDir);
    });

    it("should default to ~/.hogagent when env var is not set", () => {
      delete process.env["HOGAGENT_USER_DIR"];
      const dir = getSystemDir();
      expect(dir).toContain(".hogagent");
      // Re-set for subsequent tests
      process.env["HOGAGENT_USER_DIR"] = tempSystemDir;
    });
  });

  describe("getDefaultWorkspaceDir", () => {
    it("should honor HOGAGENT_USER_DIR for the default workspace", () => {
      const dir = getDefaultWorkspaceDir();
      expect(dir).toBe(join(tempSystemDir, "workspace"));
    });

    it("should be an absolute path", () => {
      const dir = getDefaultWorkspaceDir();
      expect(isAbsolute(dir)).toBe(true);
    });
  });

  describe("getSessionsDir", () => {
    it("stores native histories under the native user directory", () => {
      const dir = getSessionsDir("user-a");
      expect(dir).toBe(join(tempSystemDir, "sessions", "user-a"));
    });

    it("should work with default workspace", () => {
      const dir = getSessionsDir();
      expect(dir).toBe(join(tempSystemDir, "sessions", "default"));
    });
  });

  describe("default workspace", () => {
    it("should default workspaceDir to ~/.hogagent/workspace when no workspaceDir passed", () => {
      const config = loadConfig({});
      expect(config.workspaceDir).toBe(getDefaultWorkspaceDir());
    });

    it("should compute sessionTaskDir under default workspace", () => {
      const config = loadConfig({});
      expect(config.sessionTaskDir).toContain(getDefaultWorkspaceDir());
      expect(config.sessionTaskDir).toContain(config.sessionId);
    });
  });
});
