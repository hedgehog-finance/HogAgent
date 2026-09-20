import { ContentCompressorExtension } from "../../src/extensions/content-compressor/index.ts";
import type { HogAgentContext, RpcEvent, HogAgentConfig } from "../../src/utils/types.ts";

function createMockContext(): HogAgentContext & {
  events: RpcEvent[];
  tools: Map<string, unknown>;
  listeners: Map<string, Set<(...args: unknown[]) => void>>;
  harnessHandlers: Map<string, Array<(event: unknown) => unknown>>;
} {
  const events: RpcEvent[] = [];
  const tools = new Map<string, unknown>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const harnessHandlers = new Map<string, Array<(event: unknown) => unknown>>();

  const mockHarness = {
    getActiveTools: () => [...tools.values()],
    setActiveTools: async () => {},
    on(type: string, handler: (event: unknown) => unknown): () => void {
      if (!harnessHandlers.has(type)) harnessHandlers.set(type, []);
      harnessHandlers.get(type)!.push(handler);
      return () => {
        const handlers = harnessHandlers.get(type);
        if (handlers) {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        }
      };
    },
  };

  return {
    events,
    tools,
    listeners,
    harnessHandlers,
    registerTool(tool: unknown): Promise<void> {
      for (const item of Array.isArray(tool) ? tool : [tool]) {
        const t = item as { name: string };
        tools.set(t.name, item);
      }
      return Promise.resolve();
    },
    unregisterTool(name: string, ...additionalNames: string[]): Promise<void> {
      for (const toolName of [name, ...additionalNames]) tools.delete(toolName);
      return Promise.resolve();
    },
    on(event: string, handler: (...args: unknown[]) => void): () => void {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    emitEvent(event: RpcEvent): void {
      events.push(event);
    },
    getConfig: () => ({} as HogAgentConfig),
    getSessionId: () => "test-session",
    getWorkspaceDir: () => "/tmp/test-workspace",
    getHarness: () => mockHarness as any,
    getLlmTracking: () => ({ sessionId: "test-session", workId: "", taskId: "" }),
    getRuntimeContext: () => ({ process: {} as any }),
  };
}

describe("ContentCompressorExtension", () => {
  let ext: ContentCompressorExtension;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(async () => {
    ext = new ContentCompressorExtension();
    ctx = createMockContext();
    await ext.initialize(ctx);
  });

  afterEach(async () => {
    await ext.shutdown();
  });

  it("should have correct name and version", () => {
    expect(ext.name).toBe("content-compressor");
    expect(ext.version).toBe("1.0.0");
  });

  it("should register get_tool_details and query_tool_result tools", () => {
    expect(ctx.tools.has("get_tool_details")).toBe(true);
    expect(ctx.tools.has("query_tool_result")).toBe(true);
  });

  it("removes tools and hooks on disable, stays disabled after replacement and requires restart to enable", async () => {
    const retrieve = ctx.tools.get("get_tool_details") as any;
    const hook = ctx.harnessHandlers.get("tool_result")![0];
    const compressed = hook({ toolName: "bash", toolCallId: "large", content: [{ type: "text", text: "abc ".repeat(8000) }] }) as any;
    const id = compressed.content[0].text.match(/Entry ID: (\S+)/)[1];
    await ext.applyConfigUpdate(false);
    expect(ctx.tools.size).toBe(0);
    expect(ctx.harnessHandlers.get("tool_result")).toHaveLength(0);
    expect((await retrieve.execute("old", { entry_id: id })).content[0].text).toContain("Entry not found");
    await ext.applyConfigUpdate(false);
    await ext.applyConfigUpdate(true);
    ext.onHarnessReplaced(ctx.getHarness());
    expect(ctx.tools.size).toBe(0);
    expect(ctx.harnessHandlers.get("tool_result")).toHaveLength(0);
  });

  it("rolls back removed tools and keeps compression active when disabling fails", async () => {
    ctx.unregisterTool = async () => { throw new Error("sync failed"); };
    await expect(ext.applyConfigUpdate(false)).rejects.toThrow("sync failed");
    expect([...ctx.tools.keys()].sort()).toEqual(["get_tool_details", "query_tool_result"]);
    expect(ctx.harnessHandlers.get("tool_result")).toHaveLength(1);
    expect(ctx.harnessHandlers.get("tool_result")![0]({ toolName: "bash", content: [{ type: "text", text: "abc ".repeat(8000) }] })).toBeDefined();
  });

  describe("text compression", () => {
    it.each([{ isError: true }, { details: { error: "read failed" } }])("preserves errors and recovery instructions at low thresholds: %j", async metadata => {
      await ext.applyConfigUpdate(true, { textThreshold: 1 });
      const result = ctx.harnessHandlers.get("tool_result")![0]({
        toolName: "read", input: { path: "large.md" },
        content: [{ type: "text", text: "Error: Line 1 exceeds the 50-KiB read limit. Use Bash/script extraction." }],
        ...metadata,
      });
      expect(result).toBeUndefined();
      expect(ctx.events).toEqual([]);
    });

    it("should pass through text below threshold unchanged", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      const shortText = "Short text content";
      const result = handler({
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: shortText }],
        details: undefined,
        isError: false,
      });
      expect(result).toBeUndefined();
    });

    it("should compress text above threshold", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      // 25000 ASCII chars ≈ 6250 tokens, exceeds default 5000 token threshold
      const longText = "x".repeat(25000);
      const result = handler({
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: longText }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      expect(result.content[0].text).toContain("Compressed");
      expect(result.content[0].text).toContain("Entry ID");
      expect(result.content[0].text).toContain("get_tool_details");
    });
  });

  describe("get_tool_details", () => {
    it("validates pagination consistently with its schema and reports out-of-range offsets", async () => {
      await ext.applyConfigUpdate(true, { textThreshold: 1 });
      const content = "first\nsecond\nthird";
      const compressed = ctx.harnessHandlers.get("tool_result")![0]({ toolName: "bash", content: [{ type: "text", text: content }] }) as any;
      const entry_id = compressed.content[0].text.match(/Entry ID: (\S+)/)[1];
      const retrieve = ctx.tools.get("get_tool_details") as any;
      expect(retrieve.parameters.properties.offset).toMatchObject({ type: "integer", minimum: 1 });
      for (const value of [0, -1, 1.5, NaN, Infinity]) {
        for (const name of ["lines", "offset"]) {
          expect((await retrieve.execute("id", { entry_id, [name]: value })).content[0].text).toContain("positive integers");
        }
        expect((await (ctx.tools.get("query_tool_result") as any).execute("id", { entry_id, limit: value })).content[0].text).toContain("positive integer");
      }
      expect((await retrieve.execute("id", { entry_id, offset: 4 })).content[0].text).toContain("beyond the cached result");
      const pages = await Promise.all([1, 2, 3].map(offset => retrieve.execute("id", { entry_id, offset, lines: 1 })));
      expect(pages.map(page => page.content[0].text.split("\n").slice(1).join("\n")).join("\n")).toBe(content);
    });

    it("should retrieve full content by entry ID", async () => {
      // First, trigger compression to store content
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      // 24000 chars ≈ 6000 tokens, exceeds 5000 token threshold
      const longText = "Hello ".repeat(4000);
      const compressed = handler({
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: longText }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      // Extract entry ID from the compressed text
      const entryIdMatch = compressed.content[0].text.match(/Entry ID: (entry_\d+_\d+)/);
      expect(entryIdMatch).toBeTruthy();
      const entryId = entryIdMatch![1];

      // Call get_tool_details
      const tool = ctx.tools.get("get_tool_details") as { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> };
      const result = await tool.execute("call-id", { entry_id: entryId });
      expect(result.content[0].text).toBe(longText);
    });

    it("should return error for non-existent entry", async () => {
      const tool = ctx.tools.get("get_tool_details") as { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> };
      const result = await tool.execute("call-id", { entry_id: "nonexistent" });
      expect(result.content[0].text).toContain("Entry not found");
    });
  });

  describe("JSON structure compression", () => {
    it("should not compress JSON arrays below threshold", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      const jsonData = JSON.stringify([
        { id: 1, name: "Alice", price: 100 },
        { id: 2, name: "Bob", price: 200 },
        { id: 3, name: "Charlie", price: 300 },
      ]);
      const result = handler({
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: jsonData }],
        details: undefined,
        isError: false,
      });
      // Should pass through unchanged (below 5000 tokens)
      expect(result).toBeUndefined();
    });

    it("should keep the structure and sample arrays in place above threshold", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      const items = Array.from({ length: 120 }, (_, i) => ({
        id: i + 1,
        name: `User_${i}_with_long_name_padding_for_token_test`,
        price: 100 + i,
        description: `A detailed description for item ${i} that adds more characters to exceed the token threshold and must be long enough for testing with extra padding data here`,
      }));
      const jsonData = JSON.stringify(items);
      const result = handler({
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: jsonData }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      const text = result.content[0].text;
      expect(text).toContain("Structured JSON compressed");
      expect(text).toContain("__omitted__");
      expect(text).toContain("query_tool_result");
      // Head sample must retain the first record verbatim
      expect(text).toContain('"id": 1');
    });

    it("should preserve the wrapper structure when sampling nested arrays", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      const items = Array.from({ length: 120 }, (_, i) => ({
        id: i + 1, name: `Item_${i}_with_long_name_padding`, price: 100 + i,
        description: `A detailed description for item ${i} that adds more characters to exceed the token threshold and needs to be quite long for testing`,
      }));
      const wrapped = JSON.stringify({ status: "ok", result: items });
      const result = handler({
        type: "tool_result",
        toolCallId: "call-wrap-1",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: wrapped }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      const text = result.content[0].text;
      expect(text).toContain("Structured JSON compressed");
      expect(text).toContain('"status": "ok"');
      expect(text).toContain('"result"');
      expect(text).toContain("__omitted__");
    });

    it("should progressively shrink head/tail to the 1-item floor", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      // 5 records, each huge — only the 1-item floor fits under threshold
      const items = Array.from({ length: 5 }, (_, i) => {
        const item: Record<string, string | number> = { id: i };
        for (let f = 0; f < 20; f++) item[`field_${f}`] = "x".repeat(600);
        return item;
      });
      const jsonData = JSON.stringify(items);
      const result = handler({
        type: "tool_result",
        toolCallId: "call-floor",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: jsonData }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      const text = result.content[0].text;
      expect(text).toContain("Structured JSON compressed");
      // 5 items, head 1 + tail 0 → 4 omitted
      expect(text).toContain('"__omitted__": 4');
    });

    it("should fall back to text compression for array-free JSON objects", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      // 25000 chars ≈ 6250 tokens > 5000; no arrays to sample
      const obj = { status: "ok", message: "x".repeat(25000) };
      const result = handler({
        type: "tool_result",
        toolCallId: "call-wrap-4",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: JSON.stringify(obj) }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      expect(result.content[0].text).toContain("Compressed");
      expect(result.content[0].text).not.toContain("Structured JSON compressed");
    });
  });

  describe("markdown TOC compression", () => {
    it("should return a table of contents for large markdown", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      let md = "";
      for (let i = 0; i < 40; i++) {
        md += `# Chapter ${i}\n` + "Lorem ipsum dolor sit amet consectetur. ".repeat(30) + "\n";
        md += `## Section ${i}.1\n` + "More detailed content goes here. ".repeat(20) + "\n";
      }
      const result = handler({
        type: "tool_result",
        toolCallId: "call-md",
        toolName: "read",
        input: {},
        content: [{ type: "text", text: md }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      const text = result.content[0].text;
      expect(text).toContain("Table of Contents");
      expect(text).toContain("Chapter 0");
      expect(text).toContain("Entry ID");
      // read-specific retrieval hint
      expect(text).toContain('section=');
    });

    it("should reduce heading depth when the TOC itself exceeds threshold", async () => {
      const smallExt = new ContentCompressorExtension();
      const smallCtx = createMockContext();
      await smallExt.initialize(smallCtx, { textThreshold: 300 });
      const handlers = smallCtx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      let md = "";
      for (let i = 0; i < 40; i++) {
        md += `# H1 ${i}\ncontent line here padding padding\n`;
        md += `## H2 ${i}\ncontent line here padding padding\n`;
        md += `### H3 ${i}\ncontent line here padding padding\n`;
      }
      const result = handler({
        type: "tool_result",
        toolCallId: "call-md-deep",
        toolName: "read",
        input: {},
        content: [{ type: "text", text: md }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      // Depth degrades all the way to level 1 under the tight 300-token budget
      expect(result.content[0].text).toContain("headings up to level 1");
      await smallExt.shutdown();
    });

    it("should not emit an empty TOC when only deep headings exist", async () => {
      const smallExt = new ContentCompressorExtension();
      const smallCtx = createMockContext();
      await smallExt.initialize(smallCtx, { textThreshold: 300 });
      const handlers = smallCtx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      // Document with ONLY level-3 headings: degrading below level 3 would drop
      // every heading, so the ladder must clamp at the shallowest present level.
      let md = "";
      for (let i = 0; i < 40; i++) {
        md += `### Sub ${i}\ncontent line here padding padding padding\n`;
      }
      const result = handler({
        type: "tool_result",
        toolCallId: "call-md-deeponly",
        toolName: "read",
        input: { path: "/docs/deep.md" },
        content: [{ type: "text", text: md }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      const text = result.content[0].text;
      expect(text).toContain("headings up to level 3");
      // TOC must still list the headings (non-empty), not degrade to nothing.
      expect(text).toContain("Sub 0");
      await smallExt.shutdown();
    });

    it("should skip compression for section reads (explicit slice request)", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      // A large section read output: even above threshold and containing headings,
      // it must NOT be re-compressed into a TOC because the caller already narrowed.
      let body = "";
      for (let i = 0; i < 40; i++) {
        body += `### Sub ${i}\n` + "section body content padding padding padding. ".repeat(20) + "\n";
      }
      const result = handler({
        type: "tool_result",
        toolCallId: "call-section",
        toolName: "read",
        input: { section: "## Heading" },
        content: [{ type: "text", text: `File: /doc.md \u2014 Section: ## Heading (5 lines)\n\n${body}` }],
        details: undefined,
        isError: false,
      });
      expect(result).toBeUndefined();
    });

    it("should NOT treat a '#'-commented code file read as markdown", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      // A large Python file whose comment lines start with '# ' would match the
      // heading regex; the .py extension must route it to the text preview instead.
      let py = "";
      for (let i = 0; i < 200; i++) {
        py += `# Section ${i}: configuration block for the pipeline stage with extra padding words here\n`;
        py += `def step_${i}(payload):\n    return process(payload, ${i})  # inline note here padding padding padding words\n`;
      }
      const result = handler({
        type: "tool_result",
        toolCallId: "call-py",
        toolName: "read",
        input: { path: "/repo/pipeline.py" },
        content: [{ type: "text", text: `File: /repo/pipeline.py (${py.split("\n").length} lines total)\n\n${py}` }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      // Text preview path, NOT a markdown TOC.
      expect(result.content[0].text).not.toContain("Table of Contents");
      expect(result.content[0].text).toContain("Compressed");
    });

    it("should treat a .md file read as markdown (TOC)", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      let md = "";
      for (let i = 0; i < 40; i++) {
        md += `# Chapter ${i}\n` + "Lorem ipsum dolor sit amet consectetur. ".repeat(30) + "\n";
      }
      const result = handler({
        type: "tool_result",
        toolCallId: "call-mdfile",
        toolName: "read",
        input: { path: "/docs/report.md" },
        content: [{ type: "text", text: `File: /docs/report.md (${md.split("\n").length} lines total)\n\n${md}` }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      expect(result.content[0].text).toContain("Table of Contents");
    });
  });

  describe("line-number prefix handling", () => {
    it("should detect markdown and use real line numbers from read output", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      const bodyLines: string[] = [];
      for (let i = 0; i < 40; i++) {
        bodyLines.push(`# Chapter ${i}`);
        for (let j = 0; j < 20; j++) bodyLines.push("Lorem ipsum dolor sit amet consectetur adipiscing elit.");
      }
      const numbered = bodyLines.map((l, i) => `${i + 1}│${l}`).join("\n");
      const readOutput = `File: /doc.md (${bodyLines.length} lines total)\n\n${numbered}`;
      const result = handler({
        type: "tool_result",
        toolCallId: "call-md-ln",
        toolName: "read",
        input: {},
        content: [{ type: "text", text: readOutput }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      const text = result.content[0].text;
      expect(text).toContain("Table of Contents");
      // First heading sits at real line 1 (prefix stripped, real number used)
      expect(text).toContain("(line 1,");
    });

    it("should detect JSON in read output with line-number prefixes", () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      const items = Array.from({ length: 120 }, (_, i) => ({
        id: i + 1, name: `User_${i}_with_long_name_padding`, price: 100 + i,
        description: `A detailed description for item ${i} that adds more characters to exceed the token threshold and needs to be quite long for testing`,
      }));
      const json = JSON.stringify(items, null, 2);
      const bodyLines = json.split("\n");
      const numbered = bodyLines.map((l, i) => `${i + 1}│${l}`).join("\n");
      const readOutput = `File: /data.json (${bodyLines.length} lines total)\n\n${numbered}`;
      const result = handler({
        type: "tool_result",
        toolCallId: "call-json-ln",
        toolName: "read",
        input: {},
        content: [{ type: "text", text: readOutput }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      const text = result.content[0].text;
      expect(text).toContain("Structured JSON compressed");
      expect(text).toContain("__omitted__");
    });
  });

  describe("query_tool_result with wrapper", () => {
    it("should query records from wrapped JSON", async () => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      const items = Array.from({ length: 120 }, (_, i) => ({
        id: i + 1,
        name: `User_${i}_with_long_name_padding`,
        price: i === 1 ? 9999 : 100 + i,
        description: `A detailed description for item ${i} that adds more characters to exceed the token threshold and needs to be quite long for testing`,
      }));
      const wrapped = JSON.stringify({ status: "ok", result: items });
      const compResult = handler({
        type: "tool_result",
        toolCallId: "call-qwrap",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: wrapped }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };
      const match = compResult.content[0].text.match(/Entry ID: (entry_\d+_\d+)/);
      const entryId = match![1];

      const tool = ctx.tools.get("query_tool_result") as { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> };
      const queryResult = await tool.execute("call-id", { entry_id: entryId, query: "filter:price == 9999" });
      const parsed = JSON.parse(queryResult.content[0].text);
      expect(parsed.length).toBe(1);
      expect(parsed[0].name).toContain("User_1");
    });
  });

  describe("query_tool_result", () => {
    let entryId: string;

    beforeEach(() => {
      const handlers = ctx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      // Generate enough data to exceed 5000 tokens (~20000 chars)
      const items = Array.from({ length: 120 }, (_, i) => ({
        id: i + 1,
        name: `User_${i}_with_long_name_padding`,
        price: i === 1 ? 9999 : i === 49 ? 50 : 100 + i,
        description: `A detailed description for item ${i} that adds more characters to exceed the token threshold and needs to be quite long for testing`,
      }));
      const jsonData = JSON.stringify(items);
      const result = handler({
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: jsonData }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };
      const match = result.content[0].text.match(/Entry ID: (entry_\d+_\d+)/);
      entryId = match![1];
    });

    it("should filter results", async () => {
      const tool = ctx.tools.get("query_tool_result") as { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> };
      const result = await tool.execute("call-id", { entry_id: entryId, query: "filter:price == 9999" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.length).toBe(1);
    });

    it("should sort results", async () => {
      const tool = ctx.tools.get("query_tool_result") as { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> };
      const result = await tool.execute("call-id", { entry_id: entryId, query: "sort:price desc" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].price).toBe(9999);
      expect(parsed[parsed.length - 1].price).toBe(50);
    });

    it("should limit results", async () => {
      const tool = ctx.tools.get("query_tool_result") as { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> };
      const result = await tool.execute("call-id", { entry_id: entryId, limit: 2 });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.length).toBe(2);
    });

    it("should combine filter, sort and limit", async () => {
      const tool = ctx.tools.get("query_tool_result") as { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> };
      const result = await tool.execute("call-id", {
        entry_id: entryId,
        query: "filter:price > 100 | sort:price asc",
        limit: 5,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.length).toBeLessThanOrEqual(5);
      // All results should have price > 100
      for (const item of parsed) {
        expect(item.price).toBeGreaterThan(100);
      }
      // Should be sorted ascending
      for (let i = 1; i < parsed.length; i++) {
        expect(parsed[i].price).toBeGreaterThanOrEqual(parsed[i - 1].price);
      }
    });

    it("should return error for missing entry_id", async () => {
      const tool = ctx.tools.get("query_tool_result") as { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> };
      const result = await tool.execute("call-id", {});
      expect(result.content[0].text).toContain("entry_id");
      expect(result.content[0].text).toContain("required");
    });
  });

  describe("custom textThreshold config", () => {
    it("should compress text above custom threshold", async () => {
      const customExt = new ContentCompressorExtension();
      const customCtx = createMockContext();
      // custom threshold: 1000 tokens (≈ 4000 ASCII chars)
      await customExt.initialize(customCtx, { textThreshold: 1000 });

      const handlers = customCtx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      // 5500 chars ≈ 1375 tokens: above custom threshold 1000 but below default 5000
      const longText = "y".repeat(5500);
      const result = handler({
        type: "tool_result",
        toolCallId: "call-custom-1",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: longText }],
        details: undefined,
        isError: false,
      }) as unknown as { content: Array<{ type: string; text: string }> };

      expect(result).toBeDefined();
      expect(result.content[0].text).toContain("Compressed");
      await customExt.shutdown();
    });

    it("should not compress text below custom threshold", async () => {
      const customExt = new ContentCompressorExtension();
      const customCtx = createMockContext();
      // custom threshold: 1000 tokens
      await customExt.initialize(customCtx, { textThreshold: 1000 });

      const handlers = customCtx.harnessHandlers.get("tool_result")!;
      const handler = handlers[0];
      // 3000 chars ≈ 750 tokens: below custom threshold 1000
      const shortText = "z".repeat(3000);
      const result = handler({
        type: "tool_result",
        toolCallId: "call-custom-2",
        toolName: "test",
        input: {},
        content: [{ type: "text", text: shortText }],
        details: undefined,
        isError: false,
      });

      expect(result).toBeUndefined();
      await customExt.shutdown();
    });
  });
});
