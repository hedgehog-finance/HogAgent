import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModelHandlers } from "../../src/handlers/model-handlers.ts";

const DEFAULT_BASE_URL = "https://api.ciweiai.com/api/llm/v1";
let userDir: string;

function createHandlers() {
  const harness = {
    getTools: vi.fn(() => [{ name: "read" }]),
    getModel: vi.fn(() => ({
      id: "old-model", name: "old-model", provider: "hedgehog",
      baseUrl: DEFAULT_BASE_URL, contextWindow: 64_000,
    })),
    getThinkingLevel: vi.fn(() => "medium"),
    setModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
  };
  const config = {
    sessionId: "session-1",
    llmProvider: {
      provider: "hedgehog", apiKey: "old-key", baseUrl: DEFAULT_BASE_URL,
      models: [{ id: "old-model", name: "old-model", contextWindow: 64_000 }],
    },
    auditModel: undefined as any,
    compaction: { autoCompactThreshold: 0.75 },
  };
  const auditModelObjRef = { value: null };
  const deps = {
    harnessRef: { current: harness }, config, currentModeRef: { value: null },
    auditModelObjRef,
  };
  const state = {
    switchedSession: false, sessionNameSaved: false, unsubscribe: null,
    quickThinkingOverride: false, savedThinkingLevel: null as string | null,
  };
  return { handlers: createModelHandlers(deps as any, state), harness, config, auditModelObjRef, state };
}

describe("model handler compatibility", () => {
  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), "hogagent-model-handler-"));
    mkdirSync(userDir, { recursive: true });
    process.env["HOGAGENT_USER_DIR"] = userDir;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    delete process.env["HOGAGENT_USER_DIR"];
    rmSync(userDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps set_llm_provider provider/model behavior", async () => {
    const { handlers, harness, config } = createHandlers();
    await handlers.onSetLlmProvider({
      type: "set_llm_provider",
      provider: {
        provider: "openai", apiKey: "new-key", baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-custom", name: "GPT Custom", contextWindow: 128_000 }],
      },
    });

    expect(config.llmProvider.provider).toBe("openai");
    expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
      id: "gpt-custom", contextWindow: 128_000,
    }));
  });

  it("uses cached credentials for a new provider without reusing the previous main or audit endpoint", async () => {
    const { handlers, config } = createHandlers();
    writeFileSync(join(userDir, "llm-settings.json"), JSON.stringify({
      provider: "hedgehog", apiKey: "old-key", baseUrl: DEFAULT_BASE_URL,
      providerApiKeys: { openai: "personal-key" },
      audit: { provider: "hedgehog", apiKey: "old-audit-key", baseUrl: DEFAULT_BASE_URL, modelId: "old-audit" },
    }));
    await handlers.onSaveSettings({ type: "save_settings", provider: "openai", modelId: "new-main",
      audit: { provider: "openai", modelId: "new-audit" } });
    expect(config.llmProvider).toMatchObject({ provider: "openai", apiKey: "personal-key", baseUrl: "" });
    expect(config.auditModel).toMatchObject({ provider: "openai", apiKey: "personal-key", baseUrl: "", modelId: "new-audit" });
    const saved = JSON.parse(readFileSync(join(userDir, "llm-settings.json"), "utf8"));
    expect(saved.apiKey).toBe(config.llmProvider.apiKey);
    expect(process.env.HOGAGENT_LLM_API_KEY).toBe("personal-key");
    await handlers.onSaveSettings({ type: "save_settings", apiKey: "", audit: { apiKey: "" } });
    expect(config.llmProvider.apiKey).toBe("");
    expect(config.auditModel).toBeUndefined();
    expect(JSON.parse(readFileSync(join(userDir, "llm-settings.json"), "utf8")).audit)
      .toMatchObject({ provider: "openai", apiKey: "", modelId: "new-audit" });
  });

  it("does not implicitly enable compression when only its threshold is saved", async () => {
    const { handlers } = createHandlers();
    await handlers.onSaveSettings({ type: "save_settings", systemConfig: { compressThreshold: 6000 } });
    expect(JSON.parse(readFileSync(join(userDir, "hogagent.json"), "utf8")).extensions)
      .toContainEqual({ name: "content-compressor", enabled: false, config: { textThreshold: 6000 } });
  });

  it("echoes an inline model-list target using the existing refresh_models command", async () => {
    const { handlers } = createHandlers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({data:[{id:"qwen3-test"}]}), {status:200}));
    await handlers.onRefreshModels({type:"refresh_models",provider:"custom",baseUrl:"https://fixture.test/v1",apiKey:"fixture-key",target:"composer-models-1"});
    expect(fetchMock).toHaveBeenCalledWith("https://fixture.test/v1/models", expect.objectContaining({headers:{Authorization:"Bearer fixture-key"}}));
    const events = vi.mocked(process.stdout.write).mock.calls.map(([line]) => {
      try { return JSON.parse(String(line)); } catch { return null; }
    });
    expect(events).toContainEqual(expect.objectContaining({type:"models_refreshed",provider:"custom",target:"composer-models-1",models:[expect.objectContaining({id:"qwen3-test"})]}));
  });

  it("applies inline model/thinking settings while preserving active credentials and audit settings", async () => {
    const { handlers, config, harness } = createHandlers();
    await handlers.onSaveSettings({type:"save_settings",audit:{provider:"custom",apiKey:"audit-key",modelId:"audit-model",baseUrl:"https://audit.test/v1"}});
    await handlers.onSaveSettings({type:"save_settings",provider:"hedgehog",modelId:"qwen3-test",thinkingLevel:"low"});
    expect(harness.setModel).toHaveBeenLastCalledWith(expect.objectContaining({id:"qwen3-test",provider:"hedgehog"}));
    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith("low");
    expect(config.llmProvider).toMatchObject({apiKey:"old-key",baseUrl:DEFAULT_BASE_URL});
    const saved = JSON.parse(readFileSync(join(userDir, "llm-settings.json"), "utf8"));
    expect(saved).toMatchObject({apiKey:"old-key",baseUrl:DEFAULT_BASE_URL,modelId:"qwen3-test",thinkingLevel:"low",audit:{apiKey:"audit-key",modelId:"audit-model"}});
  });

  it("persists Gateway Hedgehog credentials for subsequent standalone use", async () => {
    vi.stubEnv("HOGAGENT_GATEWAY_MANAGED", "1");
    vi.stubEnv("HOGAGENT_LLM_API_KEY", "live-gateway-key");
    const { handlers, harness, config } = createHandlers();
    config.llmProvider.apiKey = "live-gateway-key";

    await handlers.onSaveSettings({
      type: "save_settings",
      provider: "hedgehog",
      modelId: "gateway-model",
      thinkingLevel: "high",
    });

    const saved = JSON.parse(readFileSync(join(userDir, "llm-settings.json"), "utf8"));
    expect(saved).toMatchObject({ provider: "hedgehog", modelId: "gateway-model", thinkingLevel: "high" });
    expect(saved.apiKey).toBe("live-gateway-key");
    expect(config.llmProvider.apiKey).toBe("live-gateway-key");
    expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "gateway-model" }));
  });

  it.each(["replacement-key", ""])("keeps the provider cache and live key consistent when changing only the key to %j", async (apiKey) => {
    writeFileSync(join(userDir, "llm-settings.json"), JSON.stringify({
      provider: "hedgehog", apiKey: "old-key", providerApiKeys: { hedgehog: "old-key", openai: "personal-key" },
    }));
    const { handlers, config } = createHandlers();
    await handlers.onSaveSettings({ type: "save_settings", apiKey });
    const saved = JSON.parse(readFileSync(join(userDir, "llm-settings.json"), "utf8"));
    expect(saved.apiKey).toBe(apiKey);
    expect(saved.providerApiKeys).toEqual(apiKey ? { hedgehog: apiKey, openai: "personal-key" } : { openai: "personal-key" });
    expect(config.llmProvider.apiKey).toBe(apiKey);
  });

  it("prefers qwen3.8-flash when selecting the Hedgehog provider", async () => {
    const { handlers, harness } = createHandlers();
    await handlers.onSetLlmProvider({
      type: "set_llm_provider",
      provider: {
        provider: "hedgehog", apiKey: "new-key", baseUrl: DEFAULT_BASE_URL,
        models: [
          { id: "qwen3.8-max", name: "Qwen 3.8 Max", contextWindow: 500_000 },
          { id: "qwen3.8-flash", name: "Qwen 3.8 Flash", contextWindow: 500_000 },
        ],
      },
    });

    expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
      id: "qwen3.8-flash",
    }));
  });

  it("switches an unknown model without remote discovery using the 500k default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { handlers, harness } = createHandlers();
    await handlers.onSetModel({ type: "set_model", model_id: "unknown-model" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
      id: "unknown-model", contextWindow: 500_000,
    }));
  });

  it("allows save_settings provider changes without metadata or remote validation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { handlers } = createHandlers();
    await handlers.onSaveSettings({ type: "save_settings", provider: "openai", apiKey: "sk-test" });

    const saved = JSON.parse(readFileSync(join(userDir, "llm-settings.json"), "utf8"));
    expect(saved.provider).toBe("openai");
    expect(saved).not.toHaveProperty("modelMetadata");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("persists the Bash sandbox mode only in hogagent.json", async () => {
    const { handlers } = createHandlers();
    await handlers.onSaveSettings({
      type: "save_settings",
      systemConfig: { sandboxMode: "fallback" },
    });

    expect(JSON.parse(readFileSync(join(userDir, "hogagent.json"), "utf8"))).toMatchObject({
      sandboxMode: "fallback",
    });
    expect(() => readFileSync(join(userDir, "llm-settings.json"), "utf8")).toThrow();
  });

  it("rejects an invalid Bash sandbox mode", async () => {
    const { handlers } = createHandlers();
    await expect(handlers.onSaveSettings({
      type: "save_settings",
      systemConfig: { sandboxMode: "sometimes" },
    })).rejects.toThrow("sandboxMode must be enabled, fallback, or disabled");
  });

  it("rejects invalid mixed settings before persisting any LLM changes", async () => {
    const { handlers, harness, config } = createHandlers();
    await expect(handlers.onSaveSettings({
      type: "save_settings", modelId: "new-model", apiKey: "new-key",
      systemConfig: { sandboxMode: "sometimes" },
    })).rejects.toThrow("sandboxMode");
    expect(existsSync(join(userDir, "llm-settings.json"))).toBe(false);
    expect(harness.setModel).not.toHaveBeenCalled();
    expect(config.llmProvider.apiKey).toBe("old-key");
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid audit maxIterations before persisting: %s",
    async (maxIterations) => {
      const { handlers, harness } = createHandlers();
      await expect(handlers.onSaveSettings({
        type: "save_settings",
        audit: { provider: "custom", modelId: "audit-model", maxIterations },
      })).rejects.toThrow("audit.maxIterations must be a non-negative safe integer");
      expect(existsSync(join(userDir, "llm-settings.json"))).toBe(false);
      expect(harness.setModel).not.toHaveBeenCalled();
    },
  );

  it("accepts zero audit retries", async () => {
    const { handlers, config } = createHandlers();
    await handlers.onSaveSettings({
      type: "save_settings",
      audit: { provider: "custom", modelId: "audit-model", maxIterations: 0 },
    });
    expect(config.auditModel?.maxIterations).toBe(0);
    expect(JSON.parse(readFileSync(join(userDir, "llm-settings.json"), "utf8")).audit.maxIterations).toBe(0);
  });

  it("repairs an invalid historical retry count when audit settings are next saved", async () => {
    writeFileSync(join(userDir, "llm-settings.json"), JSON.stringify({
      provider: "hedgehog",
      modelId: "old-model",
      audit: { provider: "custom", modelId: "audit-model", maxIterations: null },
    }));
    const { handlers, config } = createHandlers();
    await handlers.onSaveSettings({
      type: "save_settings",
      audit: { provider: "custom", modelId: "audit-model" },
    });
    expect(config.auditModel?.maxIterations).toBe(2);
    expect(JSON.parse(readFileSync(join(userDir, "llm-settings.json"), "utf8")).audit.maxIterations).toBe(2);
  });

  it.each(["command", "settings"])("keeps explicit main thinking changes made during Quick via %s", async (source) => {
    const { handlers, state } = createHandlers();
    state.quickThinkingOverride = true;
    state.savedThinkingLevel = "medium";
    if (source === "command") await handlers.onSetThinkingLevel({ type: "set_thinking_level", level: "high" });
    else await handlers.onSaveSettings({ type: "save_settings", thinkingLevel: "high" });
    expect(state.savedThinkingLevel).toBe("high");
  });

  it("rejects a malformed system config payload", async () => {
    const { handlers } = createHandlers();
    await expect(handlers.onSaveSettings({
      type: "save_settings",
      systemConfig: null,
    })).rejects.toThrow("systemConfig must be an object");
  });

  it("preserves in-memory main and audit keys when WebUI omits hidden environment credentials", async () => {
    const { handlers, config } = createHandlers();
    config.llmProvider.provider = "openai";
    config.llmProvider.apiKey = "environment-main-key";
    config.auditModel = {
      provider: "openai",
      apiKey: "environment-audit-key",
      baseUrl: "https://api.openai.com/v1",
      modelId: "old-audit-model",
      minPassScore: 70,
      maxIterations: 2,
    };

    await handlers.onSaveSettings({
      type: "save_settings",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      modelId: "new-main-model",
      audit: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        modelId: "new-audit-model",
      },
    });

    const saved = JSON.parse(readFileSync(join(userDir, "llm-settings.json"), "utf8"));
    expect(saved.apiKey).toBe("environment-main-key");
    expect(saved.audit.apiKey).toBe("environment-audit-key");
  });

  it("rejects stale credential notifications and applies a fresh snapshot without rewriting the shared file", async () => {
    const { handlers, config } = createHandlers();
    const path = join(userDir, "llm-settings.json");
    const latest = {
      provider: "hedgehog", apiKey: "rotated", modelId: "latest-model", providerApiKeys: { hedgehog: "rotated" },
      audit: { provider: "hedgehog", apiKey: "rotated", modelId: "audit-model" },
    };
    writeFileSync(path, JSON.stringify(latest));
    await expect(handlers.onSaveSettings({ type: "save_settings", reloadPersistedLlm: true,
      provider: "hedgehog", apiKey: "stale", modelId: "old-model", audit: { provider: "close" } }))
      .rejects.toThrow("credentials changed");
    expect(config.llmProvider.apiKey).toBe("old-key");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(latest);
    await handlers.onSaveSettings({ type: "save_settings", reloadPersistedLlm: true, ...latest });
    expect(config.llmProvider.apiKey).toBe("rotated");
    expect(config.auditModel.apiKey).toBe("rotated");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(latest);
  });

  it("allows a keyless custom provider to clear a previous API key", async () => {
    const { handlers, config } = createHandlers();
    await handlers.onSaveSettings({
      type: "save_settings",
      provider: "custom",
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
      modelId: "local-model",
    });

    const saved = JSON.parse(readFileSync(join(userDir, "llm-settings.json"), "utf8"));
    expect(saved).toMatchObject({
      provider: "custom",
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
      modelId: "local-model",
    });
    expect(config.llmProvider.apiKey).toBe("");
  });

  it("keeps a keyless custom audit provider active", async () => {
    const { handlers, config, auditModelObjRef } = createHandlers();
    await handlers.onSaveSettings({
      type: "save_settings",
      audit: {
        provider: "custom",
        apiKey: "",
        baseUrl: "http://localhost:11434/v1",
        modelId: "local-audit-model",
      },
    });

    expect(config.auditModel).toMatchObject({
      provider: "custom",
      apiKey: "",
      modelId: "local-audit-model",
    });
    expect(auditModelObjRef.value).toMatchObject({ id: "local-audit-model", provider: "custom" });
  });

  it("applies a Gateway main and audit settings snapshot before the next turn", async () => {
    const { handlers, harness, config, auditModelObjRef } = createHandlers();
    await handlers.onSaveSettings({
      type: "save_settings",
      provider: "custom",
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
      modelId: "local-main-model",
      thinkingLevel: "high",
      audit: {
        provider: "custom",
        apiKey: "",
        baseUrl: "http://localhost:11434/v1",
        modelId: "local-audit-model",
        minPassScore: 80,
        maxIterations: 3,
      },
    });

    expect(config.llmProvider).toMatchObject({
      provider: "custom",
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
      id: "local-main-model",
      provider: "custom",
      baseUrl: "http://localhost:11434/v1",
    }));
    expect(harness.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(config.auditModel).toMatchObject({
      provider: "custom",
      apiKey: "",
      modelId: "local-audit-model",
      minPassScore: 80,
      maxIterations: 3,
    });
    expect(auditModelObjRef.value).toMatchObject({ id: "local-audit-model", provider: "custom" });
  });
});
