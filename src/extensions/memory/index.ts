/**
 * Memory Extension
 *
 * Provides cross-session persistent memory via Gateway MCP Server.
 * Registers 2 tools: memory_save, memory_search.
 *
 * Communication: HTTP JSON-RPC 2.0 to Gateway KB MCP Server (port 59101).
 * Configuration: hogagent.json memory section (enabled, mcpKbUrl).
 *
 * Stock codes use exchange-suffixed format (e.g. "600519.SH", "000001.SZ").
 * Industry tags use localized Shenwan Level-1 classification labels.
 */

import { Type } from "@sinclair/typebox";
import { createLogger } from "../../utils/logger.ts";
import type { HogAgentContext, IExtension } from "../../utils/types.ts";

const log = createLogger("memory");

// ─── Task Types ──────────────────────────────────────────────────────────────

const TASK_TYPES = [
  "market_insight",   // Macro news, industry trends, major stock events
  "research_record",  // Stock analysis conclusions, sector research, valuations
  "portfolio",        // Current positions, rebalance logic, allocation
  "review",           // Trade reviews, P&L analysis, lessons learned
  "strategy_quant",   // Quant strategies, backtest results, signal rules
  "other",            // Memories not in the above categories
] as const;

const TASK_TYPE_DESC = TASK_TYPES.join("/");

// ─── JSON-RPC Client ─────────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

/**
 * Call Gateway KB MCP Server via HTTP JSON-RPC 2.0.
 * Returns parsed text content or throws on error.
 */
async function callMcp(mcpUrl: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
    // Bound the request so an unresponsive MCP server cannot hang the tool call.
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`MCP HTTP error: ${resp.status} ${resp.statusText}`);
  }

  const result = (await resp.json()) as JsonRpcResponse;
  if (result.error) {
    throw new Error(`MCP error ${result.error.code}: ${result.error.message}`);
  }

  const text = result.result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── Extension Class ─────────────────────────────────────────────────────────

export class MemoryExtension implements IExtension {
  name = "memory";
  version = "1.0.0";

  private mcpUrl = "";
  private getSessionId: () => string = () => "";
  private getWorkId: () => string = () => "";

  async initialize(context: HogAgentContext, _config?: unknown): Promise<void> {
    const config = context.getConfig();

    // Check if memory is enabled
    if (!config.memory?.enabled) {
      log.info("Memory extension disabled (config.memory.enabled=false)");
      return;
    }

    if (!config.memory?.mcpKbUrl) {
      log.warn("Memory extension: mcpKbUrl not configured, skipping registration");
      return;
    }

    this.mcpUrl = config.memory.mcpKbUrl;
    this.getSessionId = () => context.getSessionId();
    this.getWorkId = () => context.getLlmTracking().workId;

    log.info("Memory extension initializing", { mcpUrl: this.mcpUrl });

    // Register memory_save
    await context.registerTool({
      name: "memory_save",
      label: "Save Memory",
      description:
        "Save a persistent memory entry for cross-session recall. " +
        "Use task_type to categorize. Tags MUST include relevant stock codes (e.g. \"600519.SH\"), " +
        "Shenwan L1 industry (e.g. \"食品饮料\"), and key topics. " +
        "The current trusted work_id is attached automatically when available and omitted otherwise.",
      parameters: Type.Object({
        content: Type.String({ description: "Memory content (Markdown supported)" }),
        task_type: Type.String({
          description: `Category: ${TASK_TYPE_DESC}`,
          default: "other",
        }),
        tags: Type.Array(
          Type.String({ description: "Tag: stock code (600519.SH), Shenwan L1 industry, or keyword" }),
          { description: "Tags for efficient retrieval" },
        ),
        task_desc: Type.Optional(Type.String({ description: "Brief description of the originating task" })),
      }),
      execute: async (
        _toolCallId: string,
        params: { content: string; task_type?: string; tags: string[]; task_desc?: string },
      ) => {
        return this.saveMemory(params);
      },
    });

    // Register memory_search
    await context.registerTool({
      name: "memory_search",
      label: "Search Memory",
      description:
        "Search persistent memories by query, task type, stock codes, or industry. " +
        "Use stock_codes for stock-specific lookup (e.g. [\"600519.SH\"]) and industry for Shenwan L1 sector filtering. " +
        "Returns slim entries (content, content_type, task_type, task_desc, tags, source_session, source_work_id, created_at) to save tokens.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Full-text search query" })),
        task_type: Type.Optional(Type.String({ description: `Filter by category: ${TASK_TYPE_DESC}` })),
        stock_codes: Type.Optional(
          Type.Array(Type.String(), { description: "Stock codes (e.g. [\"600519.SH\"])" }),
        ),
        industry: Type.Optional(
          Type.String({ description: "Shenwan Level-1 industry (e.g. \"食品饮料\")" }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), { description: "Filter by arbitrary tags" }),
        ),
        limit: Type.Optional(Type.Number({ description: "Max results (1-50, default 10)", default: 10, minimum: 1, maximum: 50 })),
      }),
      execute: async (
        _toolCallId: string,
        params: {
          query?: string;
          task_type?: string;
          stock_codes?: string[];
          industry?: string;
          tags?: string[];
          limit?: number;
        },
      ) => {
        return this.searchMemory(params);
      },
    });

    log.info("Memory extension initialized: 2 tools registered");
  }

  // ─── Tool Implementations ──────────────────────────────────────────────────

  private async saveMemory(params: {
    content: string;
    task_type?: string;
    tags: string[];
    task_desc?: string;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      const args: Record<string, unknown> = {
        content: params.content,
        task_type: params.task_type || "other",
        tags: params.tags,
        task_desc: params.task_desc,
        source_session: this.getSessionId(),
      };
      const workId = this.getWorkId().trim();
      // Only forward a work ID supplied by the current Gateway task context.
      // Omit the field when unavailable; never synthesize an association.
      if (workId) args["work_id"] = workId;

      const result = await callMcp(this.mcpUrl, "kb_memory_create", args);
      log.info("Memory saved", { result });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("memory_save failed", { error: msg });
      return {
        content: [{ type: "text", text: `Error saving memory: ${msg}` }],
      };
    }
  }

  private async searchMemory(params: {
    query?: string;
    task_type?: string;
    stock_codes?: string[];
    industry?: string;
    tags?: string[];
    limit?: number;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      // Build args, omitting undefined values
      const args: Record<string, unknown> = {};
      if (params.query) args["query"] = params.query;
      if (params.task_type) args["task_type"] = params.task_type;
      if (params.stock_codes?.length) args["stock_codes"] = params.stock_codes;
      if (params.industry) args["industry"] = params.industry;
      if (params.tags?.length) args["tags"] = params.tags;
      // Clamp limit to the Gateway's accepted range [1,50] to avoid a hard schema rejection.
      if (params.limit) args["limit"] = Math.min(Math.max(1, Math.floor(params.limit)), 50);

      const result = await callMcp(this.mcpUrl, "kb_memory_search", args);
      const memories = Array.isArray(result) ? result : [];
      log.info("Memory search completed", { count: memories.length });
      return {
        content: [{ type: "text", text: JSON.stringify(memories, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("memory_search failed", { error: msg });
      return {
        content: [{ type: "text", text: `Error searching memories: ${msg}` }],
      };
    }
  }
}
