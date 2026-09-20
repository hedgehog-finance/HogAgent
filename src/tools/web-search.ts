/**
 * Web Search Tool
 *
 * Provides web search capability via configurable search providers.
 *
 * International providers: brave, you, tavily, serpapi, bing, google, custom
 * Chinese providers: zhipu, volcengine, bocha, metaso
 *
 * Configuration (priority: search_settings.json > env vars):
 *
 * 1. ~/.hogagent/search_settings.json:
 *    {
 *      "provider": "brave",
 *      "api_key": "your-api-key",
 *      "providers": {
 *        "brave": { "api_key": "..." },
 *        "tavily": { "api_key": "..." },
 *        "bocha": { "api_key": "...", "freshness": "noLimit", "categories": [] },
 *        "metaso": { "api_key": "...", "mode": "simple" },
 *        "zhipu": { "api_key": "...", "model": "glm-4-flash" },
 *        "volcengine": { "api_key": "...", "model": "doubao-pro-latest" },
 *        "google": { "api_key": "...", "cx": "..." }
 *      }
 *    }
 *
 * 2. Environment variables (HOGAGENT_ prefix):
 *    - HOGAGENT_SEARCH_PROVIDER: Provider name (default: custom)
 *    - HOGAGENT_SEARCH_API_KEY: Generic API key (international providers)
 *    - HOGAGENT_SEARCH_ENDPOINT: Custom endpoint URL (custom provider)
 *    - HOGAGENT_SEARCH_CX: Google Custom Search Engine ID (google provider)
 *    - HOGAGENT_ZHIPU_API_KEY / HOGAGENT_ZHIPU_MODEL / HOGAGENT_ZHIPU_BASE_URL
 *    - HOGAGENT_VOLCENGINE_API_KEY / HOGAGENT_VOLCENGINE_MODEL / HOGAGENT_VOLCENGINE_ENDPOINT
 *    - HOGAGENT_BOCHA_API_KEY / HOGAGENT_BOCHA_ENDPOINT / HOGAGENT_BOCHA_FRESHNESS / HOGAGENT_BOCHA_CATEGORIES
 *    - HOGAGENT_METASO_API_KEY / HOGAGENT_METASO_MODE / HOGAGENT_METASO_RANGE / HOGAGENT_METASO_ENDPOINT
 */

import { Type, type Static } from "@sinclair/typebox";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "../vendor/agent/types.ts";

// ─── Schema ──────────────────────────────────────────────────────────────────

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Search query string" }),
  num_results: Type.Optional(Type.Number({ description: "Number of results to return (1-10, default: 5)" })),
  language: Type.Optional(Type.String({ description: "Language preference (default: zh-CN). Use 'en-US' for English, 'ja-JP' for Japanese, etc." })),
});

type WebSearchInput = Static<typeof WebSearchParams>;

// ─── Configuration Loader ──────────────────────────────────────────────────────

interface SearchSettings {
  provider?: string;
  api_key?: string;
  endpoint?: string;
  providers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Load search settings from ~/.hogagent/search_settings.json (cached) */
let cachedSettings: SearchSettings | null = null;
let settingsLoaded = false;
let settingsPathOverride: string | undefined;

/** Reset cached settings (for testing) */
export function resetSearchSettingsCache(): void {
  cachedSettings = null;
  settingsLoaded = false;
}

/** Override settings file path (for testing) */
export function setSearchSettingsPath(path: string | undefined): void {
  settingsPathOverride = path;
  resetSearchSettingsCache();
}

function loadSearchSettings(): SearchSettings {
  if (settingsLoaded) return cachedSettings ?? {};
  settingsLoaded = true;

  const settingsPath = settingsPathOverride || join(homedir(), ".hogagent", "search_settings.json");
  if (!existsSync(settingsPath)) return {};

  try {
    const content = readFileSync(settingsPath, "utf-8");
    cachedSettings = JSON.parse(content) as SearchSettings;
    return cachedSettings;
  } catch {
    return {};
  }
}

/** Get config value: JSON settings > env var > default */
function getConfig(key: string, envVar?: string, defaultVal?: string): string | undefined {
  const settings = loadSearchSettings();

  // 1. Check JSON settings
  if (settings[key] !== undefined) return String(settings[key]);

  // 2. Check env var
  if (envVar && process.env[envVar]) return process.env[envVar];

  return defaultVal;
}

/** Get provider-specific config: JSON providers.{name}.{key} > env var > default */
function getProviderConfig(providerName: string, key: string, envVar?: string, defaultVal?: string): string | undefined {
  const settings = loadSearchSettings();

  // 1. Check JSON settings.providers.{name}.{key}
  if (settings.providers?.[providerName]?.[key] !== undefined) {
    return String(settings.providers[providerName][key]);
  }

  // 2. Check env var
  if (envVar && process.env[envVar]) return process.env[envVar];

  return defaultVal;
}

// ─── Search Provider Interface ───────────────────────────────────────────────

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

interface SearchProvider {
  search(query: string, numResults: number, language: string): Promise<SearchResult[]>;
}

// ─── International Provider Implementations ──────────────────────────────────

class BraveSearchProvider implements SearchProvider {
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }

  async search(query: string, numResults: number, _language: string): Promise<SearchResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(numResults));

    const response = await fetch(url.toString(), {
      headers: { "X-Subscription-Token": this.apiKey, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Brave Search API: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as { web?: { results?: Array<{ title: string; description: string; url: string }> } };
    return (data.web?.results ?? []).map((r) => ({ title: r.title, snippet: r.description, url: r.url }));
  }
}

class YouSearchProvider implements SearchProvider {
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }

  async search(query: string, numResults: number, _language: string): Promise<SearchResult[]> {
    const url = new URL("https://api.ydc.io/search");
    url.searchParams.set("query", query);
    url.searchParams.set("num_web_results", String(numResults));

    const response = await fetch(url.toString(), {
      headers: { "X-API-Key": this.apiKey },
    });
    if (!response.ok) throw new Error(`You.com Search API: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as { hits?: Array<{ title: string; snippet: string; url: string }> };
    return (data.hits ?? []).map((r) => ({ title: r.title, snippet: r.snippet, url: r.url }));
  }
}

class TavilySearchProvider implements SearchProvider {
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }

  async search(query: string, numResults: number, _language: string): Promise<SearchResult[]> {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, query, max_results: numResults }),
    });
    if (!response.ok) throw new Error(`Tavily Search API: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as { results?: Array<{ title: string; content: string; url: string }> };
    return (data.results ?? []).map((r) => ({ title: r.title, snippet: r.content, url: r.url }));
  }
}

class SerpApiProvider implements SearchProvider {
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }

  async search(query: string, numResults: number, language: string): Promise<SearchResult[]> {
    const url = new URL("https://serpapi.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(numResults));
    url.searchParams.set("hl", language.replace("-", "_"));
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("engine", "google");

    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`SerpAPI: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as { organic_results?: Array<{ title: string; snippet: string; link: string }> };
    return (data.organic_results ?? []).map((r) => ({ title: r.title, snippet: r.snippet ?? "", url: r.link }));
  }
}

class BingSearchProvider implements SearchProvider {
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }

  async search(query: string, numResults: number, _language: string): Promise<SearchResult[]> {
    const url = new URL("https://api.bing.microsoft.com/v7.0/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(numResults));

    const response = await fetch(url.toString(), {
      headers: { "Ocp-Apim-Subscription-Key": this.apiKey },
    });
    if (!response.ok) throw new Error(`Bing Search API: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as { webPages?: { value?: Array<{ name: string; snippet: string; url: string }> } };
    return (data.webPages?.value ?? []).map((r) => ({ title: r.name, snippet: r.snippet, url: r.url }));
  }
}

class GoogleCustomSearchProvider implements SearchProvider {
  private apiKey: string;
  private cx: string;
  constructor(apiKey: string, cx: string) { this.apiKey = apiKey; this.cx = cx; }

  async search(query: string, numResults: number, _language: string): Promise<SearchResult[]> {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(Math.min(numResults, 10)));
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("cx", this.cx);

    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`Google Custom Search: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as { items?: Array<{ title: string; snippet: string; link: string }> };
    return (data.items ?? []).map((r) => ({ title: r.title, snippet: r.snippet, url: r.link }));
  }
}

class CustomSearchProvider implements SearchProvider {
  private apiKey: string;
  private endpoint: string;
  constructor(apiKey: string, endpoint: string) { this.apiKey = apiKey; this.endpoint = endpoint; }

  async search(query: string, numResults: number, language: string): Promise<SearchResult[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(numResults));
    url.searchParams.set("lang", language);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) throw new Error(`Custom Search API: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as { results?: SearchResult[] };
    return data.results ?? [];
  }
}

// ─── Chinese Provider Implementations ────────────────────────────────────────

/**
 * Bocha AI — Search engine built for AI/RAG, API format compatible with Bing
 * Environment variables: HOGAGENT_BOCHA_API_KEY, HOGAGENT_BOCHA_ENDPOINT,
 *                        HOGAGENT_BOCHA_FRESHNESS, HOGAGENT_BOCHA_CATEGORIES
 */
class BochaSearchProvider implements SearchProvider {
  private apiKey: string;
  private endpoint: string;
  private freshness: string;
  private categories: string[];
  constructor(apiKey: string, endpoint: string, freshness: string, categories: string[]) {
    this.apiKey = apiKey;
    this.endpoint = endpoint || "https://api.bochaai.com/v1/web-search";
    this.freshness = freshness || "noLimit";
    this.categories = categories;
  }

  async search(query: string, numResults: number, _language: string): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      query,
      freshness: this.freshness,
      count: numResults,
    };
    // Only add categories when configured (to filter non-target domain content)
    if (this.categories.length > 0) {
      body.categories = this.categories;
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Bocha Search API: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as {
      data?: { webPages?: { value?: Array<{ name: string; snippet: string; url: string }> } };
    };
    return (data.data?.webPages?.value ?? []).map((r) => ({
      title: r.name,
      snippet: r.snippet,
      url: r.url,
    }));
  }
}

/**
 * Metaso AI — Chinese Perplexity alternative, supports search/Q&A/academic modes
 * Environment variables: HOGAGENT_METASO_API_KEY, HOGAGENT_METASO_MODE, HOGAGENT_METASO_RANGE, HOGAGENT_METASO_ENDPOINT
 */
class MetasoSearchProvider implements SearchProvider {
  private apiKey: string;
  private mode: string;
  private range: string;
  private endpoint: string;
  constructor(apiKey: string, mode: string, range: string, endpoint: string) {
    this.apiKey = apiKey;
    this.mode = mode || "simple";
    this.range = range || "all_web";
    this.endpoint = endpoint || "https://api.metaso.cn/search";
  }

  async search(query: string, numResults: number, _language: string): Promise<SearchResult[]> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        mode: this.mode,
        range: this.range,
        return_format: "json",
      }),
    });
    if (!response.ok) throw new Error(`Metaso Search API: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as {
      answer?: string;
      sources?: Array<{ title?: string; url: string; snippet?: string }>;
    };

    // Use AI answer as the first result, citation sources as subsequent results
    const results: SearchResult[] = [];
    if (data.answer) {
      results.push({ title: "Metaso AI Answer", snippet: data.answer, url: "" });
    }
    if (data.sources) {
      for (const source of data.sources.slice(0, numResults)) {
        results.push({
          title: source.title || source.url,
          snippet: source.snippet || "",
          url: source.url,
        });
      }
    }
    return results;
  }
}

/**
 * Zhipu AI (GLM) — Web search via Chat Completions + web_search tool
 * Environment variables: HOGAGENT_ZHIPU_API_KEY, HOGAGENT_ZHIPU_MODEL, HOGAGENT_ZHIPU_BASE_URL
 */
class ZhipuSearchProvider implements SearchProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  constructor(apiKey: string, model: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.model = model || "glm-4-flash";
    this.baseUrl = baseUrl || "https://open.bigmodel.cn/api/paas/v4";
  }

  async search(query: string, numResults: number, _language: string): Promise<SearchResult[]> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: `Please search the following and return structured results: ${query}` }],
        tools: [{ type: "web_search" }],
      }),
    });
    if (!response.ok) throw new Error(`Zhipu AI API: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            type: string;
            function?: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    return this.parseSearchResponse(query, data, numResults);
  }

  private parseSearchResponse(
    query: string,
    data: { choices?: Array<{ message?: { content?: string } }> },
    numResults: number,
  ): SearchResult[] {
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return [{ title: `Search: ${query}`, snippet: "No search results found", url: "" }];
    }

    // Try to extract URL references from the response content
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
    const urls = content.match(urlPattern) ?? [];
    const results: SearchResult[] = [{ title: `Search: ${query}`, snippet: content.slice(0, 500), url: urls[0] || "" }];

    // If multiple URLs found, add them as separate results
    for (const url of urls.slice(1, numResults)) {
      results.push({ title: url, snippet: "", url });
    }
    return results;
  }
}

/**
 * Volcengine/Doubao — ByteDance LLM platform with built-in web search plugin
 * Environment variables: HOGAGENT_VOLCENGINE_API_KEY, HOGAGENT_VOLCENGINE_MODEL, HOGAGENT_VOLCENGINE_ENDPOINT
 */
class VolcengineSearchProvider implements SearchProvider {
  private apiKey: string;
  private model: string;
  private endpoint: string;
  constructor(apiKey: string, model: string, endpoint: string) {
    this.apiKey = apiKey;
    this.model = model || "doubao-pro-latest";
    this.endpoint = endpoint || "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
  }

  async search(query: string, numResults: number, _language: string): Promise<SearchResult[]> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: `Please search the following and return structured results: ${query}` }],
        plugins: [
          {
            name: "webSearch",
            parameters: {
              trigger_mode: "always",
            },
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Volcengine API: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return [{ title: `Search: ${query}`, snippet: "No search results found", url: "" }];
    }

    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
    const urls = content.match(urlPattern) ?? [];
    const results: SearchResult[] = [{ title: `Search: ${query}`, snippet: content.slice(0, 500), url: urls[0] || "" }];
    for (const url of urls.slice(1, numResults)) {
      results.push({ title: url, snippet: "", url });
    }
    return results;
  }
}

// ─── Provider Factory ────────────────────────────────────────────────────────

/** Get provider name (normalized to lowercase) */
function getProviderName(): string {
  return (getConfig("provider", "HOGAGENT_SEARCH_PROVIDER", "custom") || "custom").toLowerCase();
}

/** Check if any search provider is configured */
function hasSearchConfig(): boolean {
  const settings = loadSearchSettings();

  // JSON settings: check top-level api_key or any provider configured
  if (settings.api_key) return true;
  if (settings.providers) {
    for (const provider of Object.values(settings.providers)) {
      if (provider.api_key) return true;
    }
  }

  // Env vars: generic key
  if (process.env["HOGAGENT_SEARCH_API_KEY"]) return true;
  // Chinese provider keys
  if (process.env["HOGAGENT_ZHIPU_API_KEY"]) return true;
  if (process.env["HOGAGENT_VOLCENGINE_API_KEY"]) return true;
  if (process.env["HOGAGENT_BOCHA_API_KEY"]) return true;
  if (process.env["HOGAGENT_METASO_API_KEY"]) return true;
  return false;
}

function createSearchProvider(): SearchProvider {
  const providerName = getProviderName();
  const genericKey = getConfig("api_key", "HOGAGENT_SEARCH_API_KEY", "") || "";

  switch (providerName) {
    // ── International providers ──
    case "brave":
      return new BraveSearchProvider(getProviderConfig("brave", "api_key", "HOGAGENT_SEARCH_API_KEY") || genericKey);
    case "you":
      return new YouSearchProvider(getProviderConfig("you", "api_key", "HOGAGENT_SEARCH_API_KEY") || genericKey);
    case "tavily":
      return new TavilySearchProvider(getProviderConfig("tavily", "api_key", "HOGAGENT_SEARCH_API_KEY") || genericKey);
    case "serpapi":
      return new SerpApiProvider(getProviderConfig("serpapi", "api_key", "HOGAGENT_SEARCH_API_KEY") || genericKey);
    case "bing":
      return new BingSearchProvider(getProviderConfig("bing", "api_key", "HOGAGENT_SEARCH_API_KEY") || genericKey);
    case "google": {
      const key = getProviderConfig("google", "api_key", "HOGAGENT_SEARCH_API_KEY") || genericKey;
      const cx = getProviderConfig("google", "cx", "HOGAGENT_SEARCH_CX") || "";
      return new GoogleCustomSearchProvider(key, cx);
    }

    // ── Chinese providers ──
    case "bocha": {
      const key = getProviderConfig("bocha", "api_key", "HOGAGENT_BOCHA_API_KEY") || genericKey;
      const ep = getProviderConfig("bocha", "endpoint", "HOGAGENT_BOCHA_ENDPOINT", "") || "";
      const freshness = getProviderConfig("bocha", "freshness", "HOGAGENT_BOCHA_FRESHNESS", "noLimit") || "noLimit";
      const catRaw = getProviderConfig("bocha", "categories", "HOGAGENT_BOCHA_CATEGORIES", "") || "";
      const categories = typeof catRaw === "string" ? catRaw.split(",").map((s) => s.trim()).filter(Boolean) : (Array.isArray(catRaw) ? catRaw : []);
      return new BochaSearchProvider(key, ep, freshness, categories);
    }
    case "metaso": {
      const key = getProviderConfig("metaso", "api_key", "HOGAGENT_METASO_API_KEY") || genericKey;
      const mode = getProviderConfig("metaso", "mode", "HOGAGENT_METASO_MODE", "simple") || "simple";
      const range = getProviderConfig("metaso", "range", "HOGAGENT_METASO_RANGE", "all_web") || "all_web";
      const ep = getProviderConfig("metaso", "endpoint", "HOGAGENT_METASO_ENDPOINT", "") || "";
      return new MetasoSearchProvider(key, mode, range, ep);
    }
    case "zhipu": {
      const key = getProviderConfig("zhipu", "api_key", "HOGAGENT_ZHIPU_API_KEY") || genericKey;
      const model = getProviderConfig("zhipu", "model", "HOGAGENT_ZHIPU_MODEL", "glm-4-flash") || "glm-4-flash";
      const baseUrl = getProviderConfig("zhipu", "base_url", "HOGAGENT_ZHIPU_BASE_URL", "") || "";
      return new ZhipuSearchProvider(key, model, baseUrl);
    }
    case "volcengine": {
      const key = getProviderConfig("volcengine", "api_key", "HOGAGENT_VOLCENGINE_API_KEY") || genericKey;
      const model = getProviderConfig("volcengine", "model", "HOGAGENT_VOLCENGINE_MODEL", "doubao-pro-latest") || "doubao-pro-latest";
      const ep = getProviderConfig("volcengine", "endpoint", "HOGAGENT_VOLCENGINE_ENDPOINT", "") || "";
      return new VolcengineSearchProvider(key, model, ep);
    }
    // ── Custom ──
    case "custom":
    default: {
      const endpoint = getConfig("endpoint", "HOGAGENT_SEARCH_ENDPOINT", "") || "";
      return new CustomSearchProvider(genericKey, endpoint);
    }
  }
}

// ─── Format Results ──────────────────────────────────────────────────────────

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No results found.";
  }

  return results
    .map((r, i) => {
      const urlPart = r.url ? `\n   URL: ${r.url}` : "";
      return `${i + 1}. **${r.title}**\n   ${r.snippet}${urlPart}`;
    })
    .join("\n\n");
}

// ─── All Provider Names ──────────────────────────────────────────────────────

const ALL_PROVIDERS = [
  "brave", "you", "tavily", "serpapi", "bing", "google", "custom",
  "zhipu", "volcengine", "bocha", "metaso",
];

// ─── Tool Factory ────────────────────────────────────────────────────────────

export function createWebSearchTool(): AgentTool {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for current information. Returns titles, snippets, and URLs.",
    parameters: WebSearchParams,
    execute: async (
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      const params = rawParams as WebSearchInput;
      const { query, num_results: rawNumResults, language } = params;
      const numResults = Math.min(Math.max(rawNumResults ?? 5, 1), 10);
      const lang = language ?? "zh-CN";
      const providerName = getProviderName();

      // Check configuration — need either generic key or provider-specific key
      if (!hasSearchConfig()) {
        const message = [
          "Web search is not configured.",
          "",
          "To enable web search, set the following environment variables:",
          `  HOGAGENT_SEARCH_PROVIDER=<${ALL_PROVIDERS.join("|")}>`,
          "",
          "For international providers (brave/you/tavily/serpapi/bing):",
          "  HOGAGENT_SEARCH_API_KEY=<your-api-key>",
          "",
          "For 'google' provider:",
          "  HOGAGENT_SEARCH_API_KEY + HOGAGENT_SEARCH_CX=<custom-search-engine-id>",
          "For 'custom' provider:",
          "  HOGAGENT_SEARCH_API_KEY + HOGAGENT_SEARCH_ENDPOINT=<search-api-url>",
          "",
          "For Chinese providers (use HOGAGENT_ prefix):",
          "  bocha:     HOGAGENT_BOCHA_API_KEY (+FRESHNESS/CATEGORIES optional)",
          "  metaso:    HOGAGENT_METASO_API_KEY (+MODE/RANGE optional)",
          "  zhipu:     HOGAGENT_ZHIPU_API_KEY (+MODEL/BASE_URL optional)",
          "  volcengine: HOGAGENT_VOLCENGINE_API_KEY (+MODEL/ENDPOINT optional)",
        ].join("\n");

        return {
          content: [{ type: "text", text: message }],
          details: { error: "not_configured", query },
        };
      }

      try {
        const provider = createSearchProvider();
        const results = await provider.search(query, numResults, lang);
        const formatted = formatResults(results);

        return {
          content: [{ type: "text", text: formatted }],
          details: { query, num_results: results.length, language: lang, provider: providerName },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Search error: ${message}` }],
          details: { error: message, query, provider: providerName },
        };
      }
    },
  };
}
