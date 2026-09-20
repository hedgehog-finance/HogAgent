import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, loadPersistedLlmSettings, loadSkillApiConfig, savePersistedLlmSettings, saveSkillApiConfig } from "../../src/config.ts";

describe("llm-settings persistence", () => {
  let userDir: string;
  let previousUserDir: string | undefined;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), "hogagent-settings-test-"));
    previousUserDir = process.env.HOGAGENT_USER_DIR;
    process.env.HOGAGENT_USER_DIR = userDir;
  });

  afterEach(() => {
    if (previousUserDir === undefined) delete process.env.HOGAGENT_USER_DIR;
    else process.env.HOGAGENT_USER_DIR = previousUserDir;
    rmSync(userDir, { recursive: true, force: true });
  });

  it("preserves unknown fields during atomic merge writes", () => {
    const path = join(userDir, "llm-settings.json");
    writeFileSync(path, JSON.stringify({
      futureField: { enabled: true },
    }));

    savePersistedLlmSettings({ thinkingLevel: "high" });
    const saved = JSON.parse(readFileSync(path, "utf-8"));
    expect(saved.futureField).toEqual({ enabled: true });
    expect(saved.thinkingLevel).toBe("high");
  });

  it("reads Windows UTF-8 BOM configuration in both runtime and strict management paths", () => {
    const llm = { provider: "hedgehog", apiKey: "fixture-llm", modelId: "中文模型", audit: { provider: "close" } };
    writeFileSync(join(userDir, "llm-settings.json"), "\uFEFF" + JSON.stringify(llm) + "\r\n");
    writeFileSync(join(userDir, "skills_config.json"), "\uFEFF" + JSON.stringify({ "hedgehog-data": { "api-key": "fixture-api", label: "中文配置" } }) + "\r\n");
    expect(loadPersistedLlmSettings()).toMatchObject(llm);
    expect(loadPersistedLlmSettings(true)).toEqual(llm);
    expect(loadSkillApiConfig()["hedgehog-data"]["api-key"]).toBe("fixture-api");
    expect(loadSkillApiConfig(true)["hedgehog-data"].label).toBe("中文配置");
    savePersistedLlmSettings({ thinkingLevel: "high" });
    saveSkillApiConfig("hedgehog-data", { "api-key": "renewed-api" });
    expect(loadPersistedLlmSettings(true)).toMatchObject({ ...llm, thinkingLevel: "high" });
    expect(loadSkillApiConfig(true)["hedgehog-data"]).toEqual({ "api-key": "renewed-api", label: "中文配置" });
  });

  it.each(["llm-settings.json", "skills_config.json"])("does not overwrite malformed %s", (filename) => {
    const path = join(userDir, filename);
    writeFileSync(path, "{broken");
    expect(() => filename === "llm-settings.json"
      ? savePersistedLlmSettings({ apiKey: "replacement" })
      : saveSkillApiConfig("hedgehog-data", { "api-key": "replacement" })).toThrow();
    expect(readFileSync(path, "utf-8")).toBe("{broken");
  });

  it("replaces an invalid persisted compaction threshold with the explicit default", () => {
    writeFileSync(join(userDir, "llm-settings.json"), JSON.stringify({
      compaction: { autoCompactThreshold: 1.2 },
    }));
    expect(loadConfig().compaction.autoCompactThreshold).toBe(0.75);
  });

  it("also rejects an invalid threshold from a custom config file", () => {
    const configPath = join(userDir, "custom.json");
    writeFileSync(configPath, JSON.stringify({
      compaction: { autoCompactThreshold: 0 },
    }));

    expect(loadConfig({ configPath }).compaction.autoCompactThreshold).toBe(0.75);
  });
});

describe('Gateway and standalone credential compatibility', () => {
  it('reads both persisted keys in either mode instead of replacing them with process values', async () => {
    const { loadPersistedLlmSettings, loadSkillApiConfig, saveSkillApiConfig } = await import('../../src/config.ts');
    const { vi } = await import('vitest');
    const root = mkdtempSync(join(tmpdir(), 'hog-shared-credentials-'));
    vi.stubEnv('HOGAGENT_USER_DIR', root);
    vi.stubEnv('HOGAGENT_GATEWAY_MANAGED', '1');
    vi.stubEnv('HOGAGENT_LLM_API_KEY', 'stale-env-llm');
    vi.stubEnv('CIWEIAI_API_KEY', 'stale-env-api');
    try {
      savePersistedLlmSettings({ provider: 'hedgehog', apiKey: 'shared-llm', audit: { provider: 'hedgehog', apiKey: 'shared-llm' } });
      saveSkillApiConfig('hedgehog-data', { 'api-key': 'shared-api', isLongTaskSpecific: true });
      expect(loadPersistedLlmSettings().apiKey).toBe('shared-llm');
      expect(loadSkillApiConfig()['hedgehog-data']['api-key']).toBe('shared-api');
      vi.stubEnv('HOGAGENT_GATEWAY_MANAGED', '');
      vi.stubEnv('HOGAGENT_LLM_API_KEY', '');
      vi.stubEnv('CIWEIAI_API_KEY', '');
      expect(loadConfig().llmProvider.apiKey).toBe('shared-llm');
      expect(loadSkillApiConfig()['hedgehog-data']).toEqual({ 'api-key': 'shared-api', isLongTaskSpecific: true });
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });
});
