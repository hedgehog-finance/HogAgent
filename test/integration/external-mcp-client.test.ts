import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { ExternalMcpClientManager } from "../../src/mcp/client-manager.ts";
import { saveSystemExternalMcpConfig } from "../../src/mcp/config.ts";

describe("ExternalMcpClientManager stdio integration", () => {
  let root: string;
  let userDir: string;
  let workspaceDir: string;
  let sessionTaskDir: string;
  let manager: ExternalMcpClientManager;
  let previousUserDir: string | undefined;
  let previousSecret: string | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "hogagent-mcp-client-"));
    userDir = join(root, "user");
    workspaceDir = join(root, "workspace");
    sessionTaskDir = join(workspaceDir, "tasks", "session-a");
    mkdirSync(sessionTaskDir, { recursive: true });
    previousUserDir = process.env.HOGAGENT_USER_DIR;
    previousSecret = process.env.HOST_MCP_TEST_SECRET;
    process.env.HOGAGENT_USER_DIR = userDir;
    process.env.HOST_MCP_TEST_SECRET = "mapped-secret";
    saveSystemExternalMcpConfig({
      schemaVersion: 1,
      servers: [{
        name: "test-stdio",
        enabled: true,
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [join(process.cwd(), "test", "fixtures", "mcp-legacy-stdio-server.mjs")],
          envFromHost: { TEST_CHILD_SECRET: "HOST_MCP_TEST_SECRET" },
        },
        exposure: {
          allowedTools: ["echo", "read_env"],
          directTools: [],
          resourceUriPrefixes: ["docs://allowed/"],
          allowedPrompts: ["review"],
        },
        timeouts: { connectMs: 3000, callMs: 3000, taskForegroundMs: 0 },
        maxConcurrency: 2,
      }],
    });
    manager = new ExternalMcpClientManager(workspaceDir, () => "session-a", () => sessionTaskDir);
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.close();
    if (previousUserDir === undefined) delete process.env.HOGAGENT_USER_DIR;
    else process.env.HOGAGENT_USER_DIR = previousUserDir;
    if (previousSecret === undefined) delete process.env.HOST_MCP_TEST_SECRET;
    else process.env.HOST_MCP_TEST_SECRET = previousSecret;
    rmSync(root, { recursive: true, force: true });
  });

  it("negotiates a legacy stdio server lazily and filters model-visible capabilities", async () => {
    expect(manager.getViews()[0]?.status).toBe("disconnected");
    const probe = await manager.probe("test-stdio");
    expect(probe.catalog.protocolEra).toBe("legacy");
    expect(probe.catalog.tools.map((tool) => tool.name)).toContain("hidden");
    const visible = await manager.searchCapabilities({ kind: "tool" }) as Array<{ name: string }>;
    expect(visible.map((entry) => entry.name).sort()).toEqual(["echo", "read_env"]);
  });

  it("calls authorized tools and passes only explicitly mapped secret variables", async () => {
    const echo = await manager.callTool("test-stdio", "echo", { text: "hello" });
    expect(echo.content).toEqual([{ type: "text", text: "hello" }]);
    const env = await manager.callTool("test-stdio", "read_env", {});
    expect(env.content).toEqual([{ type: "text", text: "mapped-secret" }]);
    await expect(manager.callTool("test-stdio", "hidden", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("supports authorized resources and prompts", async () => {
    const resources = await manager.listResources("test-stdio") as Array<{ uri?: string; uriTemplate?: string }>;
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: "docs://allowed/readme" }),
      expect.objectContaining({ uriTemplate: "docs://allowed/{id}" }),
    ]));
    const resource = await manager.readResource("test-stdio", "docs://allowed/readme");
    expect(resource.content).toEqual([{ type: "text", text: "resource body" }]);
    const prompt = await manager.getPrompt("test-stdio", "review", { topic: "risk" });
    expect(prompt.content[0]).toMatchObject({ type: "text" });
    expect((prompt.content[0] as { text: string }).text).toContain("Review risk");
  });
});
