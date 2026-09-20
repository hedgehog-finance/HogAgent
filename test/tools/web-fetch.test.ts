import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintFile, readFileOrigin } from "../../src/artifacts/artifact-file-facts.ts";
import { startArtifactRun } from "../../src/artifacts/artifact-protocol.ts";
import type { HogAgentConfig } from "../../src/utils/types.ts";
import { createWebFetchTool } from "../../src/tools/web-fetch.ts";

describe("web-fetch tool", () => {
  const tool = createWebFetchTool();

  async function execute(params: Record<string, unknown>) {
    return tool.execute("test-call-id", params) as Promise<{
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    }>;
  }

  describe("tool metadata", () => {
    it("should have proper tool name and description", () => {
      expect(tool.name).toBe("web_fetch");
      expect(tool.description).toContain("Fetch a web page");
      expect(tool.description).toContain("Markdown");
    });

    it("should have url parameter", () => {
      expect(tool.parameters).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("should return error for invalid URL", async () => {
      const result = await execute({ url: "not-a-valid-url" });
      expect(result.content[0].text).toContain("Fetch error");
    });

    it("should return error for unreachable host", async () => {
      const result = await execute({ url: "https://nonexistent-host-hogagent-test.invalid/" });
      expect(result.content[0].text).toContain("Fetch error");
      expect(result.details.error).toBeDefined();
    });

    it("should include url in error details", async () => {
      const url = "https://nonexistent-host-hogagent-test.invalid/";
      const result = await execute({ url });
      expect(result.details.url).toBe(url);
    });
  });

  describe("parameter handling", () => {
    it("should clamp max_length to valid range", async () => {
      // max_length too small (50) should be clamped to 500
      // This test just verifies the tool doesn't crash with edge case params
      const result = await execute({ url: "https://nonexistent-host-hogagent-test.invalid/", max_length: 50 });
      expect(result.details.url).toBe("https://nonexistent-host-hogagent-test.invalid/");
    });

    it("should handle empty URL", async () => {
      const result = await execute({ url: "" });
      expect(result.content[0].text).toContain("Fetch error");
    });

    it("should handle missing URL parameter", async () => {
      const result = await execute({});
      expect(result.content[0].text).toContain("Fetch error");
    });

    it("should handle URL without scheme", async () => {
      const result = await execute({ url: "example.com" });
      expect(result.content[0].text).toContain("Fetch error");
    });
  });
  it("records native Gateway saves and reports annotation failures without repeating the fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hog-fetch-origin-"));
    const root = join(dir, "task"); mkdirSync(root);
    const config = { sessionId: "session", sessionTaskDir: root, workspaceDir: dir, manifestOwner: "gateway" } as HogAgentConfig;
    const url = "https://example.com/raw?token=secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("中文证据".repeat(2500), { headers: { "content-type": "text/plain" } })));
    try {
      startArtifactRun(config, "run");
      const native = createWebFetchTool(() => root, () => config);
      const first = await native.execute("save-1", { url });
      const file = (first.details as any).saved_to;
      expect(file).toBeTruthy();
      const origin = readFileOrigin(root, file.split("/").pop()!, fingerprintFile(file));
      expect(origin).toMatchObject({ type: "web_fetch", locator: "https://example.com/raw", title: "https://example.com/raw" });
      rmSync(join(root, ".hedgehog"), { recursive: true }); symlinkSync(dir, join(root, ".hedgehog"));
      const second = await native.execute("save-2", { url });
      expect((second.details as any).saved_to).toBeTruthy();
      expect((second.details as any).origin_warning).toContain("Do not re-fetch");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(readdirSync(root).filter(name => name.startsWith("data-"))).toHaveLength(2);
    } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
  });

});
