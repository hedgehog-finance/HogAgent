/**
 * LLM Live Integration Tests
 *
 * Runs end-to-end integration tests against a real LLM provider.
 * Environment variables control whether the tests run and require an API key.
 *
 * Environment variables:
 *   HOGAGENT_TEST_PROVIDER  — Provider (openai | anthropic | google | deepseek | mistral)
 *   HOGAGENT_TEST_API_KEY   — API key; all LLM tests are skipped when omitted
 *   HOGAGENT_TEST_MODEL     — Optional model ID; defaults to the provider model
 *   HOGAGENT_TEST_BASE_URL  — Optional custom base URL
 *
 * Example:
 *   HOGAGENT_TEST_PROVIDER=openai HOGAGENT_TEST_API_KEY=sk-xxx npx vitest run test/integration/llm-live.test.ts
 *   HOGAGENT_TEST_PROVIDER=anthropic HOGAGENT_TEST_API_KEY=sk-ant-xxx npx vitest run test/integration/llm-live.test.ts
 *   HOGAGENT_TEST_PROVIDER=deepseek HOGAGENT_TEST_API_KEY=sk-xxx npx vitest run test/integration/llm-live.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerBuiltInApiProviders } from "../../src/vendor/ai/providers/register-builtins.ts";
import { AgentHarness } from "../../src/vendor/agent/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/vendor/agent/harness/env/nodejs.ts";
import { Session } from "../../src/vendor/agent/harness/session/session.ts";
import { InMemorySessionStorage } from "../../src/vendor/agent/harness/session/memory-storage.ts";
import type { AgentHarnessEvent, AgentHarnessOptions } from "../../src/vendor/agent/harness/types.ts";
import type { Model } from "../../src/vendor/ai/base.ts";
import type { AgentTool, ThinkingLevel } from "../../src/vendor/agent/types.ts";
import { createMathCalcTool } from "../../src/tools/math-calc.ts";

// ─── Provider Configuration ───────────────────────────────────────────────────

const TEST_PROVIDER = process.env["HOGAGENT_TEST_PROVIDER"] ?? "";
const TEST_API_KEY = process.env["HOGAGENT_TEST_API_KEY"] ?? "";
const TEST_MODEL = process.env["HOGAGENT_TEST_MODEL"] ?? "";
const TEST_BASE_URL = process.env["HOGAGENT_TEST_BASE_URL"] ?? "";

// Whether to skip all live tests (no API key provided)
const SKIP_LIVE_TESTS = !TEST_API_KEY;

interface ProviderConfig {
  provider: string;
  baseUrl: string;
  modelId: string;
  modelContextWindow: number;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig & { api: string }> = {
  openai: {
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4o-mini",
    modelContextWindow: 128000,
  },
  anthropic: {
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-3-5-haiku-20241022",
    modelContextWindow: 200000,
  },
  google: {
    provider: "google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelId: "gemini-2.5-flash",
    modelContextWindow: 1048576,
  },
  deepseek: {
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    modelId: "deepseek-chat",
    modelContextWindow: 65536,
  },
  mistral: {
    provider: "mistral",
    api: "mistral-conversations",
    baseUrl: "https://api.mistral.ai/v1",
    modelId: "mistral-small-latest",
    modelContextWindow: 32000,
  },
};

function getTestConfig(): ProviderConfig {
  const providerName = TEST_PROVIDER || "openai";
  const base = PROVIDER_CONFIGS[providerName];
  if (!base) {
    // Custom provider via base URL
    return {
      provider: providerName,
      baseUrl: TEST_BASE_URL || "http://localhost:8080",
      modelId: TEST_MODEL || "custom-model",
      modelContextWindow: 128000,
    };
  }
  return {
    ...base,
    ...(TEST_MODEL && { modelId: TEST_MODEL }),
    ...(TEST_BASE_URL && { baseUrl: TEST_BASE_URL }),
  };
}

// ─── Harness Factory ──────────────────────────────────────────────────────────

function createTestHarness(options: {
  tools?: AgentTool[];
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
}): { harness: AgentHarness; session: Session } {
  const config = getTestConfig();
  const providerConfig = PROVIDER_CONFIGS[config.provider];

  const model: Model<any> = {
    id: config.modelId,
    name: config.modelId,
    api: providerConfig?.api ?? "openai-completions",
    provider: config.provider as Model<any>["provider"],
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.modelContextWindow,
    maxTokens: 4096,
  };

  const env = new NodeExecutionEnv({ cwd: "/tmp" });
  const storage = new InMemorySessionStorage();
  const session = new Session(storage);

  const harnessOptions: AgentHarnessOptions = {
    env,
    session,
    model,
    tools: options.tools ?? [],
    thinkingLevel: options.thinkingLevel ?? "off",
    resources: { skills: [] },
    getApiKeyAndHeaders: async () => ({ apiKey: TEST_API_KEY }),
    systemPrompt: () =>
      options.systemPrompt ??
      "You are a helpful assistant. Answer concisely. Always respond in the language the user writes in.",
  };

  const harness = new AgentHarness(harnessOptions);
  return { harness, session };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

// Ensure providers are registered
registerBuiltInApiProviders();

describe.skipIf(SKIP_LIVE_TESTS)(
  `LLM Live Integration [provider: ${TEST_PROVIDER || "openai"}]`,
  () => {
    let harness: AgentHarness;
    let session: Session;

    beforeAll(() => {
      const result = createTestHarness({});
      harness = result.harness;
      session = result.session;
      console.log(`  📡 Provider: ${getTestConfig().provider}`);
      console.log(`  🤖 Model: ${getTestConfig().modelId}`);
      console.log(`  🌐 Base URL: ${getTestConfig().baseUrl}`);
    });

    afterAll(async () => {
      await harness.abort();
    });

    // ── Test 1: Basic Prompt ─────────────────────────────────────────────
    describe("Basic Prompt", () => {
      it("should receive a text response from LLM", async () => {
        const result = await harness.prompt("Reply with exactly the word 'hello' and nothing else.");

        expect(result).toBeDefined();
        expect(result.role).toBe("assistant");
        if (result.stopReason === "error") {
          console.error("LLM Error:", result.errorMessage);
        }
        expect(result.stopReason).toBe("stop");

        const textContent = result.content.find((c) => c.type === "text");
        expect(textContent).toBeDefined();
        if (textContent && textContent.type === "text") {
          const text = textContent.text.toLowerCase();
          expect(text).toContain("hello");
        }
      }, 30000);

      it("should include usage statistics", async () => {
        const result = await harness.prompt("Say 'test'.");

        expect(result.usage).toBeDefined();
        expect(result.usage.totalTokens).toBeGreaterThan(0);
        expect(result.usage.input).toBeGreaterThan(0);
      }, 30000);
    });

    // ── Test 2: Multi-turn Conversation ──────────────────────────────────
    describe("Multi-turn Conversation", () => {
      it("should maintain conversation context", async () => {
        const r1 = await harness.prompt("My name is Alice. Remember this.");
        expect(r1.stopReason).toBe("stop");

        const r2 = await harness.prompt("What is my name? Reply with just the name.");

        const textContent = r2.content.find((c) => c.type === "text");
        expect(textContent).toBeDefined();
        if (textContent && textContent.type === "text") {
          expect(textContent.text.toLowerCase()).toContain("alice");
        }
      }, 60000);
    });

    // ── Test 3: Tool Calling ─────────────────────────────────────────────
    describe("Tool Calling", () => {
      it("should call math_calc tool and get correct result", async () => {
        const mathTool = createMathCalcTool();
        const { harness: toolHarness } = createTestHarness({ tools: [mathTool] });

        const events: AgentHarnessEvent[] = [];
        toolHarness.subscribe((e) => { events.push(e); });

        const result = await toolHarness.prompt(
          "Calculate 17 * 23 using the math_calc tool, then tell me the exact result number."
        );

        // Verify tool was called
        const toolStartEvents = events.filter((e) => e.type === "tool_execution_start");
        expect(toolStartEvents.length).toBeGreaterThan(0);

        const toolEndEvents = events.filter((e) => e.type === "tool_execution_end");
        expect(toolEndEvents.length).toBeGreaterThan(0);

        // Verify response contains the calculation result (391)
        const textContent = result.content.find((c) => c.type === "text");
        expect(textContent).toBeDefined();
        if (textContent && textContent.type === "text") {
          expect(textContent.text).toContain("391");
        }

        await toolHarness.abort();
      }, 60000);
    });

    // ── Test 4: Thinking Levels ──────────────────────────────────────────
    describe("Thinking Levels", () => {
      it("should work with off thinking level", async () => {
        const { harness: thinkHarness } = createTestHarness({ thinkingLevel: "off" });

        const result = await thinkHarness.prompt("What is 2+2? Answer with just the number.");
        expect(result.stopReason).toBe("stop");

        const textContent = result.content.find((c) => c.type === "text");
        expect(textContent).toBeDefined();

        await thinkHarness.abort();
      }, 30000);

      it("should switch thinking level at runtime", async () => {
        const { harness: switchHarness } = createTestHarness({ thinkingLevel: "off" });

        // Verify initial level
        expect(switchHarness.getThinkingLevel()).toBe("off");

        // Switch to medium (async — must await for session write + state update)
        await switchHarness.setThinkingLevel("medium");
        expect(switchHarness.getThinkingLevel()).toBe("medium");

        // Switch back
        await switchHarness.setThinkingLevel("off");
        expect(switchHarness.getThinkingLevel()).toBe("off");

        await switchHarness.abort();
      }, 10000);
    });

    // ── Test 5: Model Operations ─────────────────────────────────────────
    describe("Model Operations", () => {
      it("should get current model", () => {
        const config = getTestConfig();
        const model = harness.getModel();

        expect(model.id).toBe(config.modelId);
        expect(model.baseUrl).toBe(config.baseUrl);
      });

      it("should set a new model", async () => {
        const config = getTestConfig();
        const newModelId = config.modelId; // Same model but different object

        await harness.setModel({
          ...harness.getModel(),
          id: newModelId,
        });

        expect(harness.getModel().id).toBe(newModelId);
      });
    });

    // ── Test 6: Abort ────────────────────────────────────────────────────
    describe("Abort", () => {
      it("should abort an ongoing generation", async () => {
        const { harness: abortHarness } = createTestHarness({});

        // Start a long prompt and abort quickly
        const promptPromise = abortHarness.prompt(
          "Write a very long essay about the history of mathematics, at least 2000 words."
        );

        // Abort after a short delay
        await new Promise((r) => setTimeout(r, 1000));
        await abortHarness.abort();

        const result = await promptPromise;
        // After abort, we might get an aborted result or partial response
        expect(result.role).toBe("assistant");
      }, 15000);
    });

    // ── Test 7: Event Subscription ───────────────────────────────────────
    describe("Event Subscription", () => {
      it("should emit lifecycle events during a prompt", async () => {
        const { harness: eventHarness } = createTestHarness({});
        const events: string[] = [];

        eventHarness.subscribe((e) => { events.push(e.type); });

        await eventHarness.prompt("Say 'ok'.");

        // Verify expected event sequence
        expect(events).toContain("agent_start");
        expect(events).toContain("turn_start");
        expect(events).toContain("turn_end");
        expect(events).toContain("agent_end");

        await eventHarness.abort();
      }, 30000);
    });

    // ── Test 8: Follow-up ────────────────────────────────────────────────
    describe("Follow-up", () => {
      it("should queue a follow-up message during active generation", async () => {
        const { harness: followHarness } = createTestHarness({});

        // Start initial prompt (long enough to allow queuing)
        const p1 = followHarness.prompt(
          "Write a short paragraph about the sun, then count from 1 to 100 slowly."
        );

        // Queue a follow-up WHILE the first prompt is still running
        // followUp can only be called when harness is NOT idle
        await followHarness.followUp("Now tell me what you just counted.");

        const r1 = await p1;
        expect(r1.stopReason).toBe("stop");

        // Wait for follow-up turn to complete
        await followHarness.waitForIdle();

        await followHarness.abort();
      }, 60000);

      it("should reject follow-up when idle", async () => {
        const { harness: idleHarness } = createTestHarness({});
        // Harness starts in idle phase
        await expect(idleHarness.followUp("test")).rejects.toThrow();
        await idleHarness.abort();
      }, 10000);
    });

    // ── Test 9: Steer ────────────────────────────────────────────────────
    describe("Steer", () => {
      it("should inject steering instruction during active generation", async () => {
        const { harness: steerHarness } = createTestHarness({});

        // Start a prompt (steer can only be called when NOT idle)
        const p1 = steerHarness.prompt(
          "Write a long explanation of how computers work, at least 500 words."
        );

        // Inject steering while generation is running
        await steerHarness.steer("Be very brief, summarize in one sentence.");

        const result = await p1;
        expect(result.role).toBe("assistant");

        // Verify we got a valid response (not an error)
        if (result.stopReason === "error") {
          console.error("Steer test LLM error:", result.errorMessage);
        }
        expect(result.stopReason).toBe("stop");

        // The steering should influence the output
        const textContent = result.content.find((c) => c.type === "text");
        expect(textContent).toBeDefined();

        await steerHarness.abort();
      }, 45000);

      it("should reject steer when idle", async () => {
        const { harness: idleHarness } = createTestHarness({});
        await expect(idleHarness.steer("test")).rejects.toThrow();
        await idleHarness.abort();
      }, 10000);
    });
  }
);

// ─── Provider Config Validation (always runs) ─────────────────────────────────

describe("LLM Provider Configuration", () => {
  it("should have valid provider configs for all supported providers", () => {
    const supportedProviders = ["openai", "anthropic", "google", "deepseek", "mistral"];
    for (const p of supportedProviders) {
      expect(PROVIDER_CONFIGS[p]).toBeDefined();
      expect(PROVIDER_CONFIGS[p]!.provider).toBe(p);
      expect(PROVIDER_CONFIGS[p]!.baseUrl).toMatch(/^https?:\/\//);
      expect(PROVIDER_CONFIGS[p]!.modelId).toBeTruthy();
      expect(PROVIDER_CONFIGS[p]!.modelContextWindow).toBeGreaterThan(0);
    }
  });

  it("should resolve correct config from env vars", () => {
    const config = getTestConfig();
    expect(config.provider).toBeTruthy();
    expect(config.baseUrl).toMatch(/^https?:\/\//);
  });

  it("should create harness without API key (for offline tests)", () => {
    // This test verifies the harness can be created even without a live API key
    const config = getTestConfig();

    const model: Model<any> = {
      id: config.modelId,
      name: config.modelId,
      api: "openai-completions",
      provider: config.provider as Model<any>["provider"],
      baseUrl: config.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: config.modelContextWindow,
      maxTokens: 4096,
    };

    const env = new NodeExecutionEnv({ cwd: "/tmp" });
    const storage = new InMemorySessionStorage();
    const session = new Session(storage);

    const harness = new AgentHarness({
      env,
      session,
      model,
      tools: [],
      thinkingLevel: "off",
      resources: { skills: [] },
      getApiKeyAndHeaders: async () => ({ apiKey: "offline-test-key" }),
      systemPrompt: () => "Test prompt",
    } as AgentHarnessOptions);

    expect(harness).toBeDefined();
    expect(harness.getModel().id).toBe(config.modelId);
  });
});
