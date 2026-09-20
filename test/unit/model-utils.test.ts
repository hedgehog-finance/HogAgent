import { describe, expect, it } from "vitest";
import { configModelToAgentModel, normalizeInferenceBaseUrl, withExplicitCache } from "../../src/model-utils.ts";

describe("model runtime conversion", () => {
  it("converts full compatible endpoints back to an SDK API root", () => {
    expect(normalizeInferenceBaseUrl("custom", "http://localhost:11434/v1/chat/completions"))
      .toBe("http://localhost:11434/v1");
    expect(normalizeInferenceBaseUrl("custom", "http://localhost:11434/v1/models"))
      .toBe("http://localhost:11434/v1");
    expect(normalizeInferenceBaseUrl("anthropic", "https://api.anthropic.com/v1/messages"))
      .toBe("https://api.anthropic.com");
  });

  it("keeps a custom proxy prefix while preparing a manually entered model", () => {
    expect(configModelToAgentModel(
      { id: "local-model", name: "local-model", contextWindow: 64_000 },
      "custom",
      "https://proxy.example/private/v1/chat/completions",
    )).toMatchObject({
      id: "local-model",
      provider: "custom",
      api: "openai-completions",
      baseUrl: "https://proxy.example/private/v1",
    });
  });

  it("toggles only Qwen cache metadata and preserves thinking compatibility", () => {
    const model = {
      id: "qwen3.8-flash",
      provider: "hedgehog",
      api: "openai-completions",
      name: "Qwen",
      contextWindow: 128_000,
      maxTokens: 8_192,
      compat: { thinkingFormat: "qwen", futureCompat: true },
    } as any;

    const enabled = withExplicitCache(model, true) as any;
    expect(enabled.compat).toEqual({
      thinkingFormat: "qwen",
      futureCompat: true,
      cacheControlFormat: "anthropic",
    });
    expect((withExplicitCache(enabled, false) as any).compat).toEqual({
      thinkingFormat: "qwen",
      futureCompat: true,
    });
    expect(withExplicitCache({ ...model, id: "gpt-4o" }, true)).toBeDefined();
    expect(withExplicitCache({ ...model, id: "gpt-4o" }, true).compat).toEqual(model.compat);
  });
});
