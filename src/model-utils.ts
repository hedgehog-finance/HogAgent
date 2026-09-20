/**
 * Model Conversion Utilities
 *
 * Convert config ModelConfig to the full Model object used by AgentHarness.
 */

import type { Model } from "./vendor/ai/base.ts";
import type { ModelConfig } from "./utils/types.ts";
import { normalizeContextWindow } from "./model-window.ts";

export const HEDGEHOG_DEFAULT_MODEL_ID = "qwen3.8-flash";

/** Toggle Qwen explicit-cache metadata without discarding unrelated compat fields. */
export function withExplicitCache(model: Model<any>, enabled: boolean): Model<any> {
  if (!model.id.startsWith("qwen")) return model;
  const compat = { ...(model.compat ?? {}) } as Record<string, unknown>;
  if (enabled) compat.cacheControlFormat = "anthropic";
  else delete compat.cacheControlFormat;
  const nextCompat = Object.keys(compat).length > 0 ? compat : undefined;
  const currentCache = (model.compat as Record<string, unknown> | undefined)?.cacheControlFormat;
  if (currentCache === nextCompat?.cacheControlFormat) return model;
  return { ...model, compat: nextCompat } as Model<any>;
}

const INFERENCE_ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/completions",
  "/responses",
  "/messages",
  "/models",
];

/** Map provider name to the correct API type for the vendor layer. */
export function providerToApi(provider: string): string {
  switch (provider) {
    case "anthropic": return "anthropic-messages";
    case "google": return "google-generative-ai";
    case "mistral": return "mistral-conversations";
    // hedgehog, openai, deepseek, custom, and all others use OpenAI-compatible API
    default: return "openai-completions";
  }
}

/**
 * SDK clients expect an API root, while users commonly paste a full models or
 * inference endpoint. Normalize only known terminal paths and otherwise keep
 * custom proxy prefixes untouched.
 */
export function normalizeInferenceBaseUrl(provider: string, baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value) return value;

  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    let pathname = url.pathname.replace(/\/+$/, "");
    const suffix = INFERENCE_ENDPOINT_SUFFIXES.find((candidate) => pathname.endsWith(candidate));
    if (suffix) pathname = pathname.slice(0, -suffix.length);
    // Anthropic's SDK appends /v1/messages itself; its base is the host root.
    if (provider === "anthropic" && pathname.endsWith("/v1")) {
      pathname = pathname.slice(0, -3);
    }
    url.pathname = pathname || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

/** Select the provider's preferred model, falling back to the advertised order. */
export function selectDefaultModelConfig(
  provider: string,
  models: ModelConfig[],
): ModelConfig | undefined {
  if (provider === "hedgehog") {
    const preferred = models.find((model) => model.id === HEDGEHOG_DEFAULT_MODEL_ID);
    if (preferred) return preferred;
  }
  return models[0];
}

/** Detect thinking-model format by model ID. Returns undefined for non-thinking models. */
function detectThinkingFormat(id: string): "qwen" | "deepseek" | "openai" | undefined {
  const lower = id.toLowerCase();
  if (lower.startsWith("qwen3") || lower.startsWith("qwq")) return "qwen";
  if (lower.startsWith("deepseek-r1") || lower.startsWith("deepseek-reasoner")) return "deepseek";
  if (/^o[134]-/.test(lower)) return "openai"; // o1-*, o3-*, o4-*
  return undefined;
}

/** Convert a config ModelConfig to the full Model object used by AgentHarness. */
export function configModelToAgentModel(
  mc: ModelConfig,
  provider: string,
  baseUrl: string,
  explicitCache?: boolean,
): Model<any> {
  const thinkingFormat = detectThinkingFormat(mc.id);
  const contextWindow = normalizeContextWindow(mc.contextWindow);

  const model: Model<any> = {
    id: mc.id,
    name: mc.name,
    api: providerToApi(provider),
    provider: provider as Model<any>["provider"],
    baseUrl: normalizeInferenceBaseUrl(provider, baseUrl),
    reasoning: !!thinkingFormat,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(Math.floor(contextWindow / 4), 16384),
  };

  // Thinking models: set the correct API parameter format
  if (thinkingFormat) {
    model.compat = { ...model.compat, thinkingFormat };
  }

  // Explicit cache: only when toggle is on AND model is qwen
  if (explicitCache && mc.id.startsWith("qwen")) {
    model.compat = { ...model.compat, cacheControlFormat: "anthropic" };
  }

  return model;
}
