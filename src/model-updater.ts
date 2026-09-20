/**
 * HogAgent Model List Fetcher
 *
 * Provides per-provider model list fetching via `fetchModelsForProvider`.
 * No local caching — models are always fetched live from the provider's API.
 */

import { createLogger } from "./utils/logger.ts";
import type { ModelConfig } from "./utils/types.ts";
import { normalizeContextWindow } from "./model-window.ts";

const log = createLogger("model-updater");

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const HEDGEHOG_PROXY_URL = "https://api.ciweiai.com/api/llm/v1/models";

/** Per-request timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 15_000;

// ─── Types for remote API responses ───────────────────────────────────────────

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { modality?: string };
}

interface OpenRouterResponse {
  data?: OpenRouterModel[];
}

interface HedgehogProxyModel {
  id?: string;
  name?: string;
  context_window?: number;
  contextWindow?: number;
}

// ─── Fetch Helpers ────────────────────────────────────────────────────────────

// ─── Data Transformers ────────────────────────────────────────────────────────

/** Popular model ID prefixes to include from OpenRouter (avoid pulling 500+ models). */
const OPENROUTER_INCLUDE_PREFIXES = [
  "anthropic/",
  "openai/",
  "google/",
  "deepseek/",
  "mistralai/",
  "meta-llama/",
  "x-ai/",
];

function transformOpenRouter(data: OpenRouterResponse): ModelConfig[] {
  const models: ModelConfig[] = [];
  const seen = new Set<string>();

  for (const entry of data.data ?? []) {
    // Only include text models with tool support
    const rawContextWindow = entry.context_length;
    if (rawContextWindow !== undefined && rawContextWindow < 4096) continue;
    const contextWindow = normalizeContextWindow(rawContextWindow);

    // Filter to popular providers
    const matches = OPENROUTER_INCLUDE_PREFIXES.some((prefix) => entry.id.startsWith(prefix));
    if (!matches) continue;

    // Deduplicate
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);

    models.push({
      id: entry.id,
      name: entry.name || entry.id,
      contextWindow,
    });
  }

  return models;
}

export function transformHedgehogProxy(data: unknown): ModelConfig[] {
  const models: ModelConfig[] = [];

  // OpenAI-compatible format: { data: [{ id, ... }] }; tolerate a top-level
  // array and `{ models: [...] }` used by some compatible gateways.
  const record = data as { data?: HedgehogProxyModel[]; models?: HedgehogProxyModel[] };
  const list = Array.isArray(data) ? data : (record?.data ?? record?.models);
  if (!Array.isArray(list)) return models;

  for (const entry of list as HedgehogProxyModel[]) {
    const id = entry.id || entry.name;
    if (!id) continue;
    const contextWindow = entry.context_window ?? entry.contextWindow;
    const resolvedContextWindow = normalizeContextWindow(contextWindow);
    models.push({
      id,
      name: entry.name || id,
      contextWindow: resolvedContextWindow,
    });
  }

  return models;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Provider → API URL mapping for fetching models. */
const PROVIDER_MODELS_URL: Record<string, string> = {
  hedgehog: HEDGEHOG_PROXY_URL,
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/models",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  deepseek: "https://api.deepseek.com/v1/models",
  mistral: "https://api.mistral.ai/v1/models",
  openrouter: OPENROUTER_URL,
};

const INFERENCE_ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/completions",
  "/responses",
  "/messages",
];

function appendPath(pathname: string, suffix: string): string {
  return `${pathname.replace(/\/+$/, "")}${suffix}`;
}

/**
 * Build model-list candidates from the URL used for inference.
 *
 * The supplied URL always wins over provider presets so an
 * OpenAI-compatible proxy is never bypassed during discovery.
 */
export function buildProviderModelUrls(provider: string, baseUrl?: string): string[] {
  const suppliedBaseUrl = baseUrl?.trim();
  if (!suppliedBaseUrl) {
    return PROVIDER_MODELS_URL[provider] ? [PROVIDER_MODELS_URL[provider]!] : [];
  }

  let parsed: URL;
  try {
    parsed = new URL(suppliedBaseUrl);
  } catch {
    return [];
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];

  parsed.hash = "";
  let apiPath = parsed.pathname.replace(/\/+$/, "");
  const inferenceSuffix = INFERENCE_ENDPOINT_SUFFIXES.find((suffix) => apiPath.endsWith(suffix));
  if (inferenceSuffix) apiPath = apiPath.slice(0, -inferenceSuffix.length);

  const candidates: string[] = [];
  const addCandidate = (pathname: string) => {
    const candidate = new URL(parsed);
    candidate.pathname = pathname;
    const value = candidate.toString();
    if (!candidates.includes(value)) candidates.push(value);
  };

  if (apiPath.endsWith("/models")) {
    addCandidate(apiPath);
    return candidates;
  }

  addCandidate(appendPath(apiPath, "/models"));
  if (!/(?:^|\/)v\d+(?:[a-z0-9_-]*)?(?:\/|$)/i.test(apiPath)) {
    addCandidate(appendPath(apiPath, "/v1/models"));
  }
  return candidates;
}

function addProviderAuth(url: string, provider: string, apiKey?: string): {
  url: string;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  if (!apiKey) return { url, headers };

  if (provider === "google") {
    const parsed = new URL(url);
    parsed.searchParams.set("key", apiKey);
    return { url: parsed.toString(), headers };
  }
  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return { url, headers };
}

async function readProviderError(response: Response): Promise<string> {
  try {
    const errorBody = await response.json() as Record<string, unknown>;
    const err = errorBody.error as Record<string, unknown> | string | undefined;
    if (typeof err === "object" && err?.message) return String(err.message);
    if (typeof err === "string") return err;
    if (errorBody.message) return String(errorBody.message);
  } catch {
    // The response body may not be JSON.
  }
  return response.statusText;
}

/**
 * Fetch models for a specific provider.
 * Supports all providers that expose an OpenAI-compatible `/models` endpoint.
 *
 * Hedgehog provider rules:
 *   - Uses `https://api.ciweiai.com/api/llm/v1/models` (OpenAI-compatible format).
 *   - Response: `{ data: [{ id, name, context_window? }] }`.
 *   - This is the same format as OpenAI, DeepSeek, Mistral, etc.
 *   - Any new provider following the OpenAI `/v1/models` convention
 *     can be supported by setting baseUrl + `/models`.
 *
 * A supplied baseUrl takes priority over provider defaults. API roots, versioned
 * roots, full inference URLs, and an existing `/models` URL are normalized.
 * Returns empty array on failure.
 */
export async function fetchModelsForProvider(
  provider: string,
  baseUrl?: string,
  apiKey?: string,
): Promise<ModelConfig[]> {
  try {
    const urls = buildProviderModelUrls(provider, baseUrl);
    if (urls.length === 0) {
      log.warn("No models URL for provider", { provider });
      return [];
    }

    // Providers that require API key (no public model listing)
    const requiresApiKey = ["hedgehog", "openai", "anthropic", "deepseek", "mistral", "google"];
    if (requiresApiKey.includes(provider) && !apiKey) {
      log.info("Provider requires API key for model listing, skipping", { provider });
      return [];
    }

    let lastError = "";
    for (const [index, candidateUrl] of urls.entries()) {
      const request = addProviderAuth(candidateUrl, provider, apiKey);
      log.info("Fetching models for provider", {
        provider,
        url: candidateUrl,
        candidate: index + 1,
        hasApiKey: !!apiKey,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(request.url, { signal: controller.signal, headers: request.headers });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (index < urls.length - 1) continue;
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const errorDetail = await readProviderError(response);
        lastError = `${provider} API error ${response.status}: ${errorDetail}`;
        log.warn("HTTP error fetching provider models", {
          provider,
          status: response.status,
          errorDetail,
          candidate: index + 1,
        });
        if (index < urls.length - 1 && (response.status === 404 || response.status === 405)) continue;
        throw new Error(lastError);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (index < urls.length - 1) continue;
        throw err;
      }

      let models: ModelConfig[];
      if (provider === "openrouter") {
        models = transformOpenRouter(data as OpenRouterResponse);
      } else if (provider === "google") {
        models = transformGoogleModels(data);
      } else {
        models = transformHedgehogProxy(data);
      }

      if (models.length > 0) return models;
      lastError = `${provider} returned no models`;
      log.warn("Response parsed but no models found", {
        provider,
        responseType: typeof data,
        candidate: index + 1,
      });
    }

    if (lastError) log.warn("All model URL candidates failed", { provider, error: lastError });
    return [];
  } catch (err) {
    log.warn("Failed to fetch models for provider", {
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Transform Google Gemini models response. */
function transformGoogleModels(data: unknown): ModelConfig[] {
  const models: ModelConfig[] = [];

  // Google format: { models: [{ name, displayName, ... }] }
  // Also handle potential wrapper or alternate formats
  let list: Array<Record<string, unknown>> | undefined;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.models)) {
      list = d.models as Array<Record<string, unknown>>;
    } else if (Array.isArray(d.data)) {
      list = d.data as Array<Record<string, unknown>>;
    } else if (Array.isArray(d)) {
      list = d;
    }
  }

  if (!list || !Array.isArray(list)) {
    log.warn("Google models response has unexpected format", {
      keys: data && typeof data === "object" ? Object.keys(data) : typeof data,
    });
    return models;
  }

  for (const entry of list) {
    const name = entry.name as string | undefined;
    if (!name) continue;
    // Google model names start with "models/"
    const id = name.replace(/^models\//, "");
    if (!id) continue;
    const displayName = (entry.displayName as string) || id;
    const rawContextWindow = entry.inputTokenLimit;
    const contextWindow = normalizeContextWindow(rawContextWindow);
    models.push({ id, name: displayName, contextWindow });
  }

  log.info("Google models transformed", { count: models.length });
  return models;
}
