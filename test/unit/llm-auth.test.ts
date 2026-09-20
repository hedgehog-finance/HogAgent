import { describe, expect, it } from "vitest";
import { createMainLlmAuthResolver, resolveLlmApiKey } from "../../src/llm-auth.ts";

describe("LLM authentication resolution", () => {
  it("supplies an SDK placeholder without persisting a key for a keyless custom provider", async () => {
    expect(resolveLlmApiKey("custom", "")).toBeTruthy();

    const config = {
      llmProvider: { provider: "custom", apiKey: "", baseUrl: "http://localhost:11434/v1", models: [] },
    } as any;
    const auth = await createMainLlmAuthResolver(config)({} as any);
    expect(auth.apiKey).toBeTruthy();
  });

  it("does not invent credentials for listed providers", () => {
    expect(resolveLlmApiKey("openai", "")).toBe("");
    expect(resolveLlmApiKey("openai", "configured-key", "env-key")).toBe("configured-key");
  });
});
