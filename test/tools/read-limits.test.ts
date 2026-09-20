import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool } from "../../src/tools/builtin-tools.ts";
import { ContentCompressorExtension } from "../../src/extensions/content-compressor/index.ts";

describe("bounded read results", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "hogagent-read-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function read(content: string, params: Record<string, unknown> = {}) {
    writeFileSync(join(root, "input.md"), content);
    const result = await createReadTool(root).execute("read-id", { path: "input.md", ...params });
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    return { result, text, bodyLines: text.split("\n").filter(line => /^\d+│/.test(line)) };
  }

  it("keeps small files intact and exposes bounded parameter descriptions", async () => {
    const { text } = await read("hello\nworld");
    expect(text).toContain("1│hello\n2│world");
    expect(text).not.toContain("Continue:");
    const definition = createReadTool(root);
    expect(definition.description).toContain("2000 lines or 50 KiB");
    const parameters = definition.parameters as { properties: Record<string, { description: string }> };
    expect(parameters.properties.raw.description).toContain("Never bypasses");
    expect(parameters.properties.limit.description).toContain("does not guarantee the whole file");
  });

  it.each([false, true])("continues from original line numbers to EOF with raw=%s", async raw => {
    const content = Array.from({ length: 4501 }, (_, i) => `value-${i + 1}`).join("\n");
    const collected: string[] = [];
    let offset = 1;
    for (;;) {
      const page = await read(content, { offset, limit: 9000, raw });
      expect(page.bodyLines.length).toBeLessThanOrEqual(2000);
      collected.push(...page.bodyLines);
      const next = page.text.match(/Continue: read\(.*offset=(\d+),/);
      if (!next) break;
      expect(Number(next[1])).toBe(offset + page.bodyLines.length);
      offset = Number(next[1]);
    }
    expect(collected).toEqual(content.split("\n").map((line, i) => `${i + 1}│${line}`));
  });

  it("caps UTF-8 bytes including line numbers and preserves continuation hints when compression is enabled", async () => {
    const page = await read(Array.from({ length: 300 }, () => "中文🙂".repeat(50)).join("\n"));
    expect(Buffer.byteLength(page.bodyLines.join("\n"), "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(page.result.details).toEqual({ truncated: true, skipCompress: true });
    expect(page.text).toContain("Continue:");
    let hook: (event: any) => unknown = () => { throw new Error("missing hook"); };
    const extension = new ContentCompressorExtension();
    await extension.initialize({
      getHarness: () => ({ on: (_name: string, callback: typeof hook) => { hook = callback; return () => {}; } }),
      registerTool: async () => {},
    } as any, { textThreshold: 1 });
    expect(hook({ toolName: "read", input: { path: "input.md" }, ...page.result })).toBeUndefined();
    await extension.shutdown();
  });

  it("returns explicit limits for oversized sections and single lines, even in raw mode", async () => {
    expect((await read("# Huge\n" + "line\n".repeat(2001), { section: "# Huge", raw: true })).text).toContain("Section exceeds");
    expect((await read("x".repeat(51 * 1024), { raw: true })).text).toContain("Line 1 exceeds");
    expect((await read("# Small\nhello\n# Next\nbye", { section: "# Small" })).text).toContain("1│hello");
  });

  it("rejects invalid ranges and out-of-file offsets without an endless continuation", async () => {
    for (const value of [0, -1, 1.5, NaN, Infinity]) {
      expect((await read("hello", { limit: value })).text).toContain("positive integers");
    }
    expect((await read("hello", { offset: 2 })).text).toContain("beyond EOF");
    expect((await read("a\nb\nc", { limit: 1 })).text).toContain("offset=2, limit=1");
  });
});
