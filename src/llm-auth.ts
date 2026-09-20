import type { Model } from "./vendor/ai/base.ts";
import type { HogAgentConfig } from "./utils/types.ts";

export interface LlmAuth {
  apiKey: string;
  headers?: Record<string, string>;
}

/** OpenAI's client requires a non-empty key even for keyless local servers. */
const KEYLESS_CUSTOM_API_KEY = "hogagent-local-no-key";

export function resolveLlmApiKey(provider: string, apiKey?: string, fallback?: string): string {
  return apiKey || (provider === "custom" ? KEYLESS_CUSTOM_API_KEY : fallback) || "";
}

/** Keep main-model authentication identical for turns, rebuilt Harnesses, and compaction. */
export function createMainLlmAuthResolver(
  config: HogAgentConfig,
): (_model: Model<any>) => Promise<LlmAuth> {
  return async () => ({
    apiKey: resolveLlmApiKey(
      config.llmProvider.provider,
      config.llmProvider.apiKey,
      process.env["HOGAGENT_LLM_API_KEY"],
    ),
  });
}
