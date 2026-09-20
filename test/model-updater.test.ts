/**
 * Tests for src/model-updater.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("model-updater", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns models from OpenAI-compatible response", async () => {
    const mockData = {
      data: [
        { id: "gpt-4.1", name: "GPT-4.1", context_window: 1047576 },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", contextWindow: 1047576 },
      ],
    };

    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify(mockData), { status: 200 });
    }) as unknown as typeof fetch;

    const { fetchModelsForProvider } = await import("../src/model-updater.ts");
    const models = await fetchModelsForProvider("hedgehog", undefined, "sk-fixture");

    expect(models.length).toBe(2);
    expect(models[0].id).toBe("gpt-4.1");
    expect(models[1].id).toBe("gpt-4.1-mini");
  });

  it("prefers snake_case Hedgehog context window and falls back to 500k", async () => {
    const { transformHedgehogProxy } = await import("../src/model-updater.ts");
    const models = transformHedgehogProxy({
      data: [
        { id: "authoritative", context_window: 64000, contextWindow: 128000 },
        { id: "zero", context_window: 0, contextWindow: 128000 },
        { id: "small", context_window: 2048 },
        { id: "missing" },
      ],
    });

    expect(models).toEqual([
      { id: "authoritative", name: "authoritative", contextWindow: 64000 },
      { id: "zero", name: "zero", contextWindow: 500000 },
      { id: "small", name: "small", contextWindow: 500000 },
      { id: "missing", name: "missing", contextWindow: 500000 },
    ]);
  });

  it("filters OpenRouter models by popular prefixes and context length", async () => {
    const mockData = {
      data: [
        { id: "openai/gpt-4.1", name: "GPT-4.1", context_length: 1047576 },
        { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", context_length: 200000 },
        { id: "unknown/small-model", name: "Unknown", context_length: 100000 }, // filtered by prefix
        { id: "openai/tiny", name: "Tiny", context_length: 2048 }, // filtered by context < 4096
      ],
    };

    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify(mockData), { status: 200 });
    }) as unknown as typeof fetch;

    const { fetchModelsForProvider } = await import("../src/model-updater.ts");
    const models = await fetchModelsForProvider("openrouter");

    expect(models.length).toBe(2);
    const ids = models.map(m => m.id);
    expect(ids).toContain("openai/gpt-4.1");
    expect(ids).toContain("anthropic/claude-sonnet-4");
    expect(ids).not.toContain("unknown/small-model");
    expect(ids).not.toContain("openai/tiny");
  });

  it.each(["hedgehog", "openai"])("requires a key for %s model discovery", async (provider) => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { fetchModelsForProvider } = await import("../src/model-updater.ts");
    const models = await fetchModelsForProvider(provider);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(models).toEqual([]);
  });

  it("derives model URLs from custom inference endpoints", async () => {
    const { buildProviderModelUrls } = await import("../src/model-updater.ts");

    expect(buildProviderModelUrls("custom", "https://proxy.example/v1/chat/completions/"))
      .toEqual(["https://proxy.example/v1/models"]);
    expect(buildProviderModelUrls("custom", "https://proxy.example/api"))
      .toEqual([
        "https://proxy.example/api/models",
        "https://proxy.example/api/v1/models",
      ]);
    expect(buildProviderModelUrls("openai", "https://proxy.example/v1"))
      .toEqual(["https://proxy.example/v1/models"]);
  });

  it("fetches a custom provider without a key and falls back to the v1 candidate", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ name: "local-model" }],
      }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { fetchModelsForProvider } = await import("../src/model-updater.ts");
    await expect(fetchModelsForProvider("custom", "http://localhost:11434"))
      .resolves.toEqual([{ id: "local-model", name: "local-model", contextWindow: 500000 }]);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "http://localhost:11434/models",
      expect.objectContaining({ headers: {} }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "http://localhost:11434/v1/models",
      expect.objectContaining({ headers: {} }),
    );
  });

  it("uses a supplied base URL instead of the named provider preset", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "proxy-model" }],
    }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { fetchModelsForProvider } = await import("../src/model-updater.ts");
    await fetchModelsForProvider("openai", "https://proxy.example/v1", "proxy-key");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://proxy.example/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer proxy-key" } }),
    );
  });

  it("returns empty array on fetch failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Network error");
    }) as unknown as typeof fetch;

    const { fetchModelsForProvider } = await import("../src/model-updater.ts");
    const models = await fetchModelsForProvider("hedgehog", undefined, "sk-fixture");

    expect(models).toEqual([]);
  });

  it("transforms Google models response correctly", async () => {
    const mockData = {
      models: [
        { name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash", inputTokenLimit: 1048576 },
        { name: "models/gemini-1.5-pro", displayName: "Gemini 1.5 Pro", inputTokenLimit: 2097152 },
      ],
    };

    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { fetchModelsForProvider } = await import("../src/model-updater.ts");
    const models = await fetchModelsForProvider("google", undefined, "test-api-key");

    expect(models.length).toBe(2);
    expect(models[0].id).toBe("gemini-2.0-flash");
    expect(models[0].contextWindow).toBe(1048576);
    expect(models[1].id).toBe("gemini-1.5-pro");
  });

  it("uses 500k when a listed Google model omits its input limit", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: "models/gemini-dynamic", displayName: "Gemini Dynamic" }],
    }), { status: 200 })) as unknown as typeof fetch;

    const { fetchModelsForProvider } = await import("../src/model-updater.ts");
    await expect(fetchModelsForProvider("google", undefined, "test-api-key"))
      .resolves.toEqual([{ id: "gemini-dynamic", name: "Gemini Dynamic", contextWindow: 500000 }]);
  });

  it("never throws even on unexpected errors", async () => {
    globalThis.fetch = (() => {
      throw new Error("Synchronous crash");
    }) as unknown as typeof fetch;

    const { fetchModelsForProvider } = await import("../src/model-updater.ts");
    // Should not throw — returns empty array
    await expect(fetchModelsForProvider("hedgehog", undefined, "sk-fixture")).resolves.toEqual([]);
  });
});
