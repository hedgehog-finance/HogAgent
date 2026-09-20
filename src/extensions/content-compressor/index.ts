/**
 * Content Compressor Extension
 *
 * Manages tool result sizes to prevent context overflow.
 * Uses Pi AgentHarness "tool_result" hook to intercept results before they
 * enter the session/context. Triggers before Pi compaction.
 *
 * Compression strategies (threshold unit: tokens, default 5000):
 * - Below threshold: keep original.
 * - Structured JSON: keep the full structure, sample long arrays in place
 *   (head items + omitted-count marker + tail items) via a progressive ladder.
 * - Markdown (has headings): return a Table of Contents (progressive depth 3→2→1).
 * - Other text: head/tail preview.
 * Full content is always stored and retrievable via get_tool_details /
 * query_tool_result (or read(path, section=/offset=) for files).
 */

import { Type } from "@sinclair/typebox";
import { createLogger } from "../../utils/logger.ts";
import { estimateStringTokens, truncateByTokens } from "../../utils/token-estimation.ts";
import { truncateHead, truncateTail } from "../../vendor/agent/harness/utils/truncate.ts";
import type {
  HogAgentContext,
  IExtension,
} from "../../utils/types.ts";
import type { AgentHarness } from "../../vendor/agent/harness/agent-harness.ts";

const log = createLogger("content-compressor");

const DEFAULT_TEXT_THRESHOLD = 5000;

// Bug 17 fix: Limit max store entries to prevent unbounded memory growth in long sessions
const MAX_STORE_ENTRIES = 200;

// Tools whose results should NEVER be compressed.
// These are retrieval/query tools where the LLM explicitly requests full content.
const SKIP_COMPRESS_TOOLS = new Set([
  "get_tool_details",    // Retrieving full/paginated content from a compressed entry
  "query_tool_result",   // Querying structured data from a compressed entry
]);

interface StoredEntry {
  id: string;
  originalContent: string;
  contentType: "text" | "json";
  timestamp: string;
}

export class ContentCompressorExtension implements IExtension {
  name = "content-compressor";
  version = "1.0.0";

  private context: HogAgentContext | null = null;
  private store = new Map<string, StoredEntry>();
  private unsubscribers: Array<() => void> = [];
  /** Unsubscribe for the tool_result hook on the CURRENT harness (re-attached on session rebuild). */
  private hookUnsub: (() => void) | null = null;
  /** Can be disabled at an idle boundary; enabling again requires a new process. */
  private enabled = true;
  private entryCounter = 0;
  private textThreshold = DEFAULT_TEXT_THRESHOLD;

  async initialize(context: HogAgentContext, _config?: unknown): Promise<void> {
    this.context = context;

    // Read configurable threshold from extension config
    if (_config && typeof _config === "object" && "textThreshold" in (_config as Record<string, unknown>)) {
      const val = (_config as Record<string, unknown>).textThreshold;
      if (typeof val === "number" && val > 0) {
        this.textThreshold = val;
        log.info("Custom text threshold applied", { textThreshold: val });
      }
    }

    // Publish both retrieval tools before enabling the compression hook.
    await context.registerTool([{
      name: "get_tool_details",
      label: "Get Tool Details",
      description: "Retrieve full uncompressed tool result by entry ID. Supports pagination (lines/offset).",
      parameters: Type.Object({
        entry_id: Type.String({ description: "Entry ID from a compressed result" }),
        lines: Type.Optional(Type.Integer({ minimum: 1, description: "Positive maximum lines per page; omitted means all remaining cached lines" })),
        offset: Type.Optional(Type.Integer({ minimum: 1, description: "Starting line in the cached result (1-based); continue at the last returned line plus one" })),
      }),
      execute: async (
        _toolCallId: string,
        rawParams: unknown,
      ) => {
        const params = rawParams as { entry_id: string; lines?: number; offset?: number };
        return { ...this.getToolDetails(params.entry_id, params.lines, params.offset), details: undefined };
      },
    }, {
      name: "query_tool_result",
      label: "Query Tool Result",
      description: "Query structured data from a compressed result with filtering, sorting, and aggregation.",
      parameters: Type.Object({
        entry_id: Type.String({ description: "Entry ID from a compressed result" }),
        query: Type.Optional(Type.String({ description: "Query directives: filter:field op val | sort:field asc/desc | group:field | agg:count/sum:f/avg:f/min:f/max:f" })),
        fields: Type.Optional(Type.Array(Type.String(), { description: "Fields to include in results" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, description: "Positive maximum number of query results to return" })),
      }),
      execute: async (
        _toolCallId: string,
        rawParams: unknown,
      ) => {
        const params = rawParams as {
          entry_id: string;
          query?: string;
          fields?: string[];
          limit?: number;
        };
        return { ...this.queryToolResult(params), details: undefined };
      },
    }]);

    this.attachHook(context.getHarness());

    log.info("Initialized");
  }

  async shutdown(): Promise<void> {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.hookUnsub?.();
    this.hookUnsub = null;
    this.store.clear();
    this.context = null;
    log.info("Shutdown complete");
  }

  /**
   * Re-attach the tool_result hook when the harness is replaced
   * (new_session/resume_session) — hooks on the old harness are dead.
   * The store is kept so recent entry IDs stay retrievable in-process.
   */
  onHarnessReplaced(harness: AgentHarness): void {
    if (!this.enabled) return;
    this.attachHook(harness);
    log.info("Hook re-attached to new harness");
  }

  /** Called after the current top-level execution; an off→on transition requires restart. */
  async applyConfigUpdate(enabled: boolean, config?: unknown): Promise<void> {
    if (!enabled && this.enabled && this.context) {
      await this.context.unregisterTool("get_tool_details", "query_tool_result");
      this.enabled = false;
      this.hookUnsub?.();
      this.hookUnsub = null;
      this.store.clear();
    }
    if (enabled && !this.enabled) {
      log.info("Content compression enabling requires restart");
      return;
    }
    if (config && typeof config === "object" && "textThreshold" in (config as Record<string, unknown>)) {
      const val = (config as Record<string, unknown>).textThreshold;
      if (typeof val === "number" && val > 0) {
        this.textThreshold = val;
      }
    }
    log.info("Runtime config applied", { enabled: this.enabled, textThreshold: this.textThreshold });
  }

  /**
   * Register the "tool_result" hook on the given harness, replacing any
   * previously attached hook (idempotent — safe to call on every rebuild).
   */
  private attachHook(harness: AgentHarness): void {
    this.hookUnsub?.();
    this.hookUnsub = harness.on("tool_result", (event) => {
      // Runtime disable: pass results through untouched
      if (!this.enabled) return undefined;

      // Preserve failures and their recovery instructions, including built-in
      // tools that report errors through details instead of throwing.
      if (event.isError || (event.details && typeof event.details === "object"
        && (event.details as Record<string, unknown>).error !== undefined)) return undefined;

      // Skip compression for retrieval/query tools (they fetch from store, compressing again = infinite loop)
      if (SKIP_COMPRESS_TOOLS.has(event.toolName)) {
        return undefined;
      }

      // Skip compression when LLM explicitly requests raw content via raw=true parameter
      if (event.input?.["raw"] === true) {
        return undefined;
      }

      // Skip compression for targeted reads (offset/limit/section = LLM intentionally
      // reading a specific slice, not the whole file — re-compressing it into a TOC
      // would contradict the explicit narrowing the caller asked for).
      if (event.toolName === "read" && event.input) {
        const hasOffset = event.input["offset"] !== undefined;
        const hasLimit = event.input["limit"] !== undefined;
        const hasSection = event.input["section"] !== undefined;
        if (hasOffset || hasLimit || hasSection) {
          return undefined;
        }
      }

      // Skip compression when tool result explicitly opts out via details.skipCompress
      if (event.details && typeof event.details === "object" && (event.details as Record<string, unknown>).skipCompress === true) {
        return undefined;
      }

      const content = event.content;
      const textBlocks = content.filter(
        (block): block is { type: "text"; text: string } =>
          block.type === "text" && typeof block.text === "string",
      );

      if (textBlocks.length === 0) return undefined;

      const fullText = textBlocks.map((b) => b.text).join("\n");
      const fullTextTokens = estimateStringTokens(fullText);

      // Below threshold: keep original
      if (fullTextTokens < this.textThreshold) return undefined;

      // Normalize for analysis: strip an optional read-tool header and per-line
      // number prefixes ("123│") so both read(with line numbers) and API(no line
      // numbers) results are detected and located correctly.
      const analysis = this.normalizeForAnalysis(fullText);

      const emitCompressed = (compressed: { content: Array<{ type: "text"; text: string }> }) => {
        this.context?.emitEvent({
          type: "content_compressed",
          tool_call_id: event.toolCallId,
          original_length: fullText.length,
          compressed_length: compressed.content[0]!.text.length,
        });
        return { content: compressed.content };
      };

      // 1. Structured JSON → keep full structure, sample long arrays in place
      const jsonData = this.tryParseJson(analysis.cleanText);
      if (jsonData !== null) {
        return emitCompressed(this.compressJson(jsonData, analysis.cleanText));
      }

      // 2. Markdown (has headings) → return a Table of Contents.
      // Gate on the file type so source files that merely use '#' for comments
      // (Python/shell/YAML/Ruby/TOML/…) are NOT mistaken for markdown documents.
      const hasHeadings = analysis.lines.some((l) => /^#{1,6}\s/.test(l));
      if (hasHeadings && this.isMarkdownDocument(event.toolName, event.input)) {
        return emitCompressed(this.compressMarkdownToc(analysis, fullText, event.toolName));
      }

      // 3. Other plain text → head/tail preview
      return emitCompressed(this.compressText(fullText, event.toolName));
    });
  }

  /** Generate a unique entry ID. */
  private generateEntryId(): string {
    this.entryCounter++;
    return `entry_${Date.now()}_${this.entryCounter}`;
  }

  /** Evict oldest entries when store exceeds MAX_STORE_ENTRIES (FIFO). */
  private pruneStore(): void {
    while (this.store.size > MAX_STORE_ENTRIES) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  /** Try to parse text as JSON. Returns parsed value or null. */
  private tryParseJson(text: string): unknown {
    try {
      const trimmed = text.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        return JSON.parse(trimmed);
      }
    } catch {
      // Not valid JSON
    }
    return null;
  }

  /**
   * Decide whether a heading-bearing result should be treated as a markdown
   * document (TOC) rather than plain text. For `read` we trust the file
   * extension: only genuine markdown files (.md/.markdown/.mdx) become a TOC, so
   * code files that use '#' for comments fall through to the text preview. When
   * no path is available (non-read tools or synthetic input) we keep the heading
   * heuristic, since those payloads have no reliable extension to check.
   */
  private isMarkdownDocument(toolName: string, input: Record<string, unknown> | undefined): boolean {
    if (toolName === "read") {
      const path = input?.["path"];
      if (typeof path === "string") return /\.(md|markdown|mdx)$/i.test(path);
    }
    return true;
  }

  /** Compress plain text content. Tool-specific hints guide the LLM to use the right retrieval strategy. */
  private compressText(fullText: string, toolName?: string): { content: Array<{ type: "text"; text: string }> } {
    const entryId = this.generateEntryId();
    this.store.set(entryId, {
      id: entryId,
      originalContent: fullText,
      contentType: "text",
      timestamp: new Date().toISOString(),
    });
    this.pruneStore();

    const lineCount = fullText.split("\n").length;
    const fullTextTokens = estimateStringTokens(fullText);
    // Preview: Head+Tail strategy (70% head + 30% tail) for better context
    const headBudget = Math.floor(this.textThreshold * 0.7) * 4; // token→bytes rough estimate
    const tailBudget = Math.floor(this.textThreshold * 0.3) * 4;
    const headResult = truncateHead(fullText, { maxBytes: headBudget });
    let previewText: string;
    if (headResult.truncated) {
      const tailResult = truncateTail(fullText, { maxBytes: tailBudget });
      // Check for overlap: if head+tail covers entire content, no real omission
      if (headResult.outputBytes + tailResult.outputBytes >= headResult.totalBytes) {
        previewText = fullText;
      } else {
        previewText = headResult.content + "\n\n[... middle omitted ...]\n\n" + tailResult.content;
      }
    } else {
      previewText = fullText;
    }
    const suggestedChunk = Math.min(100, lineCount);

    // Tool-specific retrieval hint
    let retrievalHint: string;
    if (toolName === "read") {
      const hintParts = [
        `This read result was compressed. Use read() parameters to access specific parts and follow any continuation offsets:`,
        `  - Line range: read(path, offset=N, limit=M) — offset is 1-based line number`,
        `  - Markdown section: read(path, section="## Heading")`,
        `  - Bounded text: read(path, raw=true) — skips optional compression, never the read limit; follow next offsets`,
        `DO NOT call read() again without offset/limit/section/raw — it will be compressed again.`,
      ];
      // Add available section headings for markdown content
      const headings = fullText.split("\n")
        .filter(l => /^#{1,3}\s/.test(l))
        .slice(0, 8)
        .map(l => l.trim());
      if (headings.length > 0) {
        hintParts.push(`Available sections: ${headings.join(" | ")}`);
      }
      retrievalHint = hintParts.join("\n");
    } else {
      retrievalHint = [
        `IMPORTANT: The full content is already stored. Use get_tool_details to read it.`,
        `DO NOT re-fetch or re-execute the same tool — use the entry ID above instead.`,
        `  - Paginated: get_tool_details("${entryId}", lines=${suggestedChunk}, offset=1), then offset=${suggestedChunk + 1} to continue without overlap`,
        `  - Full at once: get_tool_details("${entryId}")`,
      ].join("\n");
    }

    const summary = [
      `[Compressed: ${fullText.length} chars, ${fullTextTokens} tokens, ${lineCount} lines]`,
      `Entry ID: ${entryId}`,
      "",
      "Preview:",
      previewText,
      "",
      retrievalHint,
    ].join("\n");

    log.info("Text compressed", { entryId, originalLength: fullText.length });

    return {
      content: [{ type: "text", text: summary }],
    };
  }

  /**
   * Extract the record array from common JSON wrapper patterns.
   * Supports up to 3 levels of nesting:
   * - Level 0: Top-level array [{...}, ...]
   * - Level 1: { result: [...] }
   * - Level 2: { result: { data: [...] } }
   * - Level 3: { result: { data: { items: [...] } } }
   * Returns the extracted records + the dot-path used, or null if no record array found.
   */
  private extractRecordArray(jsonData: unknown): { records: unknown[]; path: string } | null {
    // Candidate field names commonly used for record arrays
    const ARRAY_KEYS = ["result", "data", "records", "items", "rows", "entries", "list", "results"];
    const MAX_DEPTH = 3;

    // Validate that an array contains record-like objects
    const isRecordArray = (arr: unknown): arr is unknown[] =>
      Array.isArray(arr) && arr.length > 0 && typeof arr[0] === "object" && arr[0] !== null;

    // Recursive search: try each candidate key, descend if value is a plain object
    const search = (obj: unknown, pathParts: string[], depth: number): { records: unknown[]; path: string } | null => {
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
      const record = obj as Record<string, unknown>;

      for (const key of ARRAY_KEYS) {
        const val = record[key];
        if (isRecordArray(val)) {
          return { records: val, path: [...pathParts, key].join(".") };
        }
      }

      // Descend into nested objects (up to MAX_DEPTH)
      if (depth < MAX_DEPTH) {
        for (const key of ARRAY_KEYS) {
          const val = record[key];
          if (typeof val === "object" && val !== null && !Array.isArray(val)) {
            const found = search(val, [...pathParts, key], depth + 1);
            if (found) return found;
          }
        }
      }

      return null;
    };

    // Level 0: top-level array
    if (isRecordArray(jsonData)) {
      return { records: jsonData, path: "" };
    }

    return search(jsonData, [], 1);
  }

  /**
   * Normalize a tool result for structural analysis.
   * Strips an optional read-tool header line ("File: ... (N lines total)") and
   * per-line number prefixes ("123│"). When a prefix is present its captured
   * number is used as the real line number; otherwise the 1-based sequence is used.
   */
  private normalizeForAnalysis(text: string): { lines: string[]; lineNumbers: number[]; cleanText: string } {
    let rawLines = text.split("\n");
    // Drop a leading read-tool header + following blank line(s)
    if (rawLines.length > 0 && /^File: .* \(\d+ lines total\)/.test(rawLines[0]!)) {
      rawLines = rawLines.slice(1);
      while (rawLines.length > 0 && rawLines[0]!.trim() === "") rawLines = rawLines.slice(1);
    }
    const lines: string[] = [];
    const lineNumbers: number[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      const m = rawLines[i]!.match(/^(\d+)│(.*)$/);
      if (m) {
        lines.push(m[2]!);
        lineNumbers.push(parseInt(m[1]!, 10));
      } else {
        lines.push(rawLines[i]!);
        lineNumbers.push(i + 1);
      }
    }
    return { lines, lineNumbers, cleanText: lines.join("\n") };
  }

  /**
   * Compress structured JSON: keep the full object/array structure and sample
   * every long array in place. Each array with length > head+tail is replaced by
   * [...first `head`, { __omitted__: N }, ...last `tail`]. A progressive ladder
   * shrinks head/tail until the serialized result fits under the threshold.
   */
  private compressJson(jsonData: unknown, cleanText: string): { content: Array<{ type: "text"; text: string }> } {
    const entryId = this.generateEntryId();

    // Progressive ladder: [head, tail] per array.
    const ladder: Array<[number, number]> = [[50, 5], [20, 2], [5, 1], [1, 1], [1, 0]];
    let summary = "";
    let used: [number, number] = ladder[ladder.length - 1]!;
    let fits = false;
    for (const level of ladder) {
      const sampled = this.sampleJsonArrays(jsonData, level[0], level[1]);
      const tailNote = level[1] > 0 ? ` + last ${level[1]}` : "";
      summary = [
        `[Structured JSON compressed]`,
        `Entry ID: ${entryId}`,
        "",
        `Structure preview (long arrays sampled: first ${level[0]}${tailNote} items; { "__omitted__": N } marks skipped items):`,
        JSON.stringify(sampled, null, 2),
        "",
        `Full data stored. Use query_tool_result("${entryId}", query="filter:field op val | sort:field asc/desc | agg:count/sum:f") to filter/sort/aggregate, or get_tool_details("${entryId}") for the raw JSON.`,
      ].join("\n");
      used = level;
      if (estimateStringTokens(summary) < this.textThreshold) {
        fits = true;
        break;
      }
    }

    // Array sampling could not bring it under threshold (e.g. array-free object
    // with huge scalar fields) — fall back to a head/tail text preview.
    if (!fits) {
      return this.compressText(cleanText);
    }

    // Store the clean (valid) JSON so query_tool_result / get_tool_details work.
    this.store.set(entryId, {
      id: entryId,
      originalContent: cleanText,
      contentType: "json",
      timestamp: new Date().toISOString(),
    });
    this.pruneStore();
    log.info("Structured JSON compressed", { entryId, head: used[0], tail: used[1] });
    return { content: [{ type: "text", text: summary }] };
  }

  /**
   * Deep-clone a JSON value, sampling every array whose length exceeds head+tail
   * into [...first `head`, { __omitted__: N }, ...last `tail`]. Nested arrays and
   * objects are sampled recursively; scalars are returned as-is.
   */
  private sampleJsonArrays(value: unknown, head: number, tail: number): unknown {
    if (Array.isArray(value)) {
      const mapped = value.map((v) => this.sampleJsonArrays(v, head, tail));
      if (value.length > head + tail) {
        const omitted = value.length - head - tail;
        const front = mapped.slice(0, head);
        const back = tail > 0 ? mapped.slice(value.length - tail) : [];
        return [...front, { __omitted__: omitted }, ...back];
      }
      return mapped;
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.sampleJsonArrays(v, head, tail);
      }
      return out;
    }
    return value;
  }

  /**
   * Compress a markdown document into a Table of Contents. Progressive depth:
   * headings up to level 3, then 2, then 1, until the TOC fits under threshold.
   * Each entry lists heading level, text, its real start line, and section length.
   */
  private compressMarkdownToc(
    analysis: { lines: string[]; lineNumbers: number[] },
    fullText: string,
    toolName?: string,
  ): { content: Array<{ type: "text"; text: string }> } {
    const entryId = this.generateEntryId();
    this.store.set(entryId, {
      id: entryId,
      originalContent: fullText,
      contentType: "text",
      timestamp: new Date().toISOString(),
    });
    this.pruneStore();

    const { lines, lineNumbers } = analysis;
    const totalLines = lines.length;
    const headings: Array<{ level: number; text: string; startLine: number; index: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^(#{1,6})\s+(.+)$/);
      if (m) headings.push({ level: m[1]!.length, text: m[2]!.trim(), startLine: lineNumbers[i]!, index: i });
    }

    const buildToc = (maxLevel: number): string => {
      const kept = headings.filter((h) => h.level <= maxLevel);
      return kept.map((h, idx) => {
        const next = kept[idx + 1];
        const rows = (next ? next.index : totalLines) - h.index;
        const indent = "  ".repeat(h.level - 1);
        return `${indent}- ${"#".repeat(h.level)} ${h.text} (line ${h.startLine}, ${rows} lines)`;
      }).join("\n");
    };

    const retrievalHint = toolName === "read"
      ? [
          `Expand a section with:`,
          `  - read(path, section="## Heading") — extract one section`,
          `  - read(path, offset=N, limit=M) — read a line range (start lines shown above)`,
          `  - read(path, raw=true) — bounded text without optional compression; follow next offsets`,
          `DO NOT call read() again without section/offset/limit/raw.`,
        ].join("\n")
      : [
          `Full content is stored. Use get_tool_details("${entryId}", offset=N, lines=M) to read a range.`,
          `DO NOT re-fetch or re-execute the same tool — use the entry ID above instead.`,
        ].join("\n");

    let summary = "";
    // Progressive depth, clamped to the heading levels that actually exist so we
    // never degrade to a level with zero headings (which would emit an empty TOC).
    const minLevel = Math.min(...headings.map((h) => h.level));
    const candidateLevels = [3, 2, 1].filter((l) => l >= minLevel);
    const levels = candidateLevels.length > 0 ? candidateLevels : [minLevel];
    for (const maxLevel of levels) {
      summary = [
        `[Compressed Markdown: ${fullText.length} chars, ${estimateStringTokens(fullText)} tokens, ${totalLines} lines]`,
        `Entry ID: ${entryId}`,
        "",
        `Table of Contents (headings up to level ${maxLevel}):`,
        buildToc(maxLevel),
        "",
        retrievalHint,
      ].join("\n");
      if (maxLevel === levels[levels.length - 1] || estimateStringTokens(summary) < this.textThreshold) break;
    }

    log.info("Markdown compressed to TOC", { entryId, headings: headings.length });
    return { content: [{ type: "text", text: summary }] };
  }

  /** Retrieve full tool details by entry ID. */
  private getToolDetails(
    entryId: string,
    lines?: number,
    offset?: number,
  ): { content: Array<{ type: "text"; text: string }> } {
    if ([lines, offset].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) {
      return { content: [{ type: "text", text: "Error: lines and offset must be positive integers" }] };
    }
    const entry = this.store.get(entryId);
    if (!entry) {
      return {
        content: [{ type: "text", text: `Error: Entry not found: ${entryId}` }],
      };
    }

    let result = entry.originalContent;

    if (lines !== undefined || offset !== undefined) {
      const allLines = result.split("\n");
      // offset is 1-based (consistent with read tool); convert to 0-based internally
      const start = Math.max(0, (offset ?? 1) - 1);
      if (start >= allLines.length) {
        return { content: [{ type: "text", text: `Error: offset ${start + 1} is beyond the cached result (${allLines.length} lines)` }] };
      }
      const count = lines ?? allLines.length;
      const sliced = allLines.slice(start, start + count);
      const hasMore = start + count < allLines.length;
      const header = `[Lines ${start + 1}-${start + sliced.length} of ${allLines.length}${hasMore ? `, ${allLines.length - start - sliced.length} more remaining` : ''}]`;
      result = header + "\n" + sliced.join("\n");
    }

    return {
      content: [{ type: "text", text: result }],
    };
  }

  /** Query structured data with filtering, sorting, aggregation via unified query string. */
  private queryToolResult(params: {
    entry_id: string;
    query?: string;
    fields?: string[];
    limit?: number;
  }): { content: Array<{ type: "text"; text: string }> } {
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) {
      return { content: [{ type: "text", text: "Error: limit must be a positive integer" }] };
    }
    if (!params.entry_id) {
      return {
        content: [{ type: "text", text: "Error: 'entry_id' parameter is required. Use the Entry ID from a compressed tool result." }],
      };
    }
    const entry = this.store.get(params.entry_id);
    if (!entry) {
      return {
        content: [{ type: "text", text: `Error: Entry not found: ${params.entry_id}` }],
      };
    }

    let data: unknown[];
    try {
      const parsed = JSON.parse(entry.originalContent);
      // Use same extraction logic as compression to handle wrapper patterns
      const extracted = this.extractRecordArray(parsed);
      data = extracted ? extracted.records : (Array.isArray(parsed) ? parsed : [parsed]);
    } catch {
      return {
        content: [{ type: "text", text: "Error: Entry content is not valid JSON" }],
      };
    }

    // Parse query directives
    const directives = this.parseQuery(params.query);

    // Apply filter
    if (directives.filter) {
      data = this.applyFilter(data, directives.filter);
    }

    // Apply sorting
    if (directives.sortBy) {
      data = this.applySort(data, directives.sortBy, directives.sortOrder ?? "asc");
    }

    // Apply field selection
    if (params.fields && params.fields.length > 0) {
      data = this.selectFields(data, params.fields);
    }

    // Apply aggregation
    if (directives.aggregate) {
      const aggregateResult = this.applyAggregate(data, directives.aggregate, directives.groupBy);
      return {
        content: [{ type: "text", text: JSON.stringify(aggregateResult, null, 2) }],
      };
    }

    // Apply limit
    const limit = params.limit ?? directives.limit;
    if (limit !== undefined && limit > 0) {
      data = data.slice(0, limit);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  /**
   * Parse a query string into structured directives.
   * Syntax: "filter:field op val | sort:field asc/desc | group:field | agg:count/sum:f/avg:f/min:f/max:f | limit:N"
   */
  private parseQuery(query?: string): {
    filter?: string;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    groupBy?: string;
    aggregate?: string;
    limit?: number;
  } {
    if (!query) return {};

    const result: {
      filter?: string;
      sortBy?: string;
      sortOrder?: "asc" | "desc";
      groupBy?: string;
      aggregate?: string;
      limit?: number;
    } = {};

    const parts = query.split("|").map((s) => s.trim());
    for (const part of parts) {
      const colonIdx = part.indexOf(":");
      if (colonIdx === -1) continue;
      const directive = part.slice(0, colonIdx).trim().toLowerCase();
      const value = part.slice(colonIdx + 1).trim();

      switch (directive) {
        case "filter":
          result.filter = value;
          break;
        case "sort": {
          const tokens = value.split(/\s+/);
          result.sortBy = tokens[0];
          result.sortOrder = (tokens[1]?.toLowerCase() === "desc" ? "desc" : "asc") as "asc" | "desc";
          break;
        }
        case "group":
          result.groupBy = value;
          break;
        case "agg":
          result.aggregate = value;
          break;
        case "limit": {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n > 0) result.limit = n;
          break;
        }
      }
    }

    return result;
  }

  /** Simple filter implementation supporting basic comparisons. */
  private applyFilter(data: unknown[], filter: string): unknown[] {
    // Support basic expressions: "field > value", "field == value", "field contains value"
    const match = filter.match(/^(\w+)\s*(==|!=|>|<|>=|<=|contains)\s*(.+)$/);
    if (!match) return data;

    const [, field, operator, rawValue] = match;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, "");

    return data.filter((item) => {
      if (typeof item !== "object" || item === null) return false;
      const record = item as Record<string, unknown>;
      const fieldValue = record[field];

      switch (operator) {
        case "==": return String(fieldValue) === value;
        case "!=": return String(fieldValue) !== value;
        case ">": return Number(fieldValue) > Number(value);
        case "<": return Number(fieldValue) < Number(value);
        case ">=": return Number(fieldValue) >= Number(value);
        case "<=": return Number(fieldValue) <= Number(value);
        case "contains": return String(fieldValue).includes(value);
        default: return true;
      }
    });
  }

  /** Sort data by a field. */
  private applySort(data: unknown[], sortBy: string, order: "asc" | "desc"): unknown[] {
    return [...data].sort((a, b) => {
      if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return 0;
      const aVal = (a as Record<string, unknown>)[sortBy];
      const bVal = (b as Record<string, unknown>)[sortBy];

      let cmp = 0;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else {
        cmp = String(aVal ?? "").localeCompare(String(bVal ?? ""));
      }

      return order === "desc" ? -cmp : cmp;
    });
  }

  /** Select specific fields from data. */
  private selectFields(data: unknown[], fields: string[]): unknown[] {
    return data.map((item) => {
      if (typeof item !== "object" || item === null) return item;
      const record = item as Record<string, unknown>;
      const selected: Record<string, unknown> = {};
      for (const field of fields) {
        if (field in record) {
          selected[field] = record[field];
        }
      }
      return selected;
    });
  }

  /** Apply aggregation to data. */
  private applyAggregate(
    data: unknown[],
    aggregate: string,
    groupBy?: string,
  ): unknown {
    if (groupBy) {
      const groups = new Map<string, unknown[]>();
      for (const item of data) {
        if (typeof item !== "object" || item === null) continue;
        const key = String((item as Record<string, unknown>)[groupBy] ?? "undefined");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(item);
      }

      const result: Record<string, unknown> = {};
      for (const [key, groupItems] of groups) {
        result[key] = this.computeAggregate(groupItems, aggregate);
      }
      return result;
    }

    return this.computeAggregate(data, aggregate);
  }

  /** Compute a single aggregate value. */
  private computeAggregate(data: unknown[], aggregate: string): unknown {
    if (aggregate === "count") {
      return data.length;
    }

    const sumMatch = aggregate.match(/^sum:(\w+)$/);
    if (sumMatch) {
      const field = sumMatch[1];
      return data.reduce<number>((acc, item) => {
        if (typeof item !== "object" || item === null) return acc;
        const val = (item as Record<string, unknown>)[field];
        return acc + (typeof val === "number" ? val : 0);
      }, 0);
    }

    const avgMatch = aggregate.match(/^avg:(\w+)$/);
    if (avgMatch) {
      const field = avgMatch[1];
      if (data.length === 0) return 0;
      const sum = data.reduce<number>((acc, item) => {
        if (typeof item !== "object" || item === null) return acc;
        const val = (item as Record<string, unknown>)[field];
        return acc + (typeof val === "number" ? val : 0);
      }, 0);
      return sum / data.length;
    }

    const minMatch = aggregate.match(/^min:(\w+)$/);
    if (minMatch) {
      const field = minMatch[1];
      let min = Infinity;
      for (const item of data) {
        if (typeof item !== "object" || item === null) continue;
        const val = (item as Record<string, unknown>)[field];
        if (typeof val === "number" && val < min) min = val;
      }
      return min === Infinity ? null : min;
    }

    const maxMatch = aggregate.match(/^max:(\w+)$/);
    if (maxMatch) {
      const field = maxMatch[1];
      let max = -Infinity;
      for (const item of data) {
        if (typeof item !== "object" || item === null) continue;
        const val = (item as Record<string, unknown>)[field];
        if (typeof val === "number" && val > max) max = val;
      }
      return max === -Infinity ? null : max;
    }

    return { error: `Unknown aggregate: ${aggregate}` };
  }
}
