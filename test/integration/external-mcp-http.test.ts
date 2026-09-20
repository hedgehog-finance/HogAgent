import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalMcpClientManager } from "../../src/mcp/client-manager.ts";
import { saveSystemExternalMcpConfig } from "../../src/mcp/config.ts";

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

describe("ExternalMcpClientManager Streamable HTTP integration", () => {
  let root: string;
  let manager: ExternalMcpClientManager;
  let previousUserDir: string | undefined;
  let previousToken: string | undefined;
  let previousTenant: string | undefined;
  let observedAuthorization: string | undefined;
  let observedTenant: string | undefined;
  let cancelledUndeclaredTask = false;
  let activeSlowCalls = 0;
  let peakSlowCalls = 0;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    observedAuthorization = request.headers.authorization;
    observedTenant = typeof request.headers["x-test-tenant"] === "string"
      ? request.headers["x-test-tenant"]
      : undefined;
    const message = await readJson(request);
    const method = message["method"];
    const id = message["id"];
    if (id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: Record<string, unknown> | undefined;
    if (method === "server/discover") {
      result = {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "test-http-mcp", version: "1.0.0" } },
      };
    } else if (method === "tools/list") {
      result = {
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
        tools: [
          { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
          { name: "remote_error", inputSchema: { type: "object", properties: {} } },
          { name: "rogue_task", inputSchema: { type: "object", properties: {} } },
          { name: "slow", inputSchema: { type: "object", properties: {} } },
        ],
      };
    } else if (method === "resources/list") {
      result = { resultType: "complete", ttlMs: 0, cacheScope: "private", resources: [] };
    } else if (method === "resources/templates/list") {
      result = { resultType: "complete", ttlMs: 0, cacheScope: "private", resourceTemplates: [] };
    } else if (method === "prompts/list") {
      result = { resultType: "complete", ttlMs: 0, cacheScope: "private", prompts: [] };
    } else if (method === "tools/call") {
      const params = message["params"] as Record<string, unknown>;
      if (params["name"] === "rogue_task") {
        result = { resultType: "task", taskId: "undeclared-task" };
      } else if (params["name"] === "slow") {
        activeSlowCalls++;
        peakSlowCalls = Math.max(peakSlowCalls, activeSlowCalls);
        await new Promise((resolve) => setTimeout(resolve, 50));
        activeSlowCalls--;
        result = {
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "private",
          content: [{ type: "text", text: "slow-complete" }],
        };
      } else if (params["name"] === "remote_error") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `remote leaked ${process.env.HTTP_MCP_TEST_TOKEN}` },
        }));
        return;
      } else {
        const args = params["arguments"] as Record<string, unknown>;
        result = {
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "private",
          content: [{ type: "text", text: String(args["text"] ?? "") }],
        };
      }
    } else if (method === "tasks/cancel") {
      cancelledUndeclaredTask = true;
      result = { status: "cancelled" };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result
      ? { jsonrpc: "2.0", id, result }
      : { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
  });

  beforeEach(async () => {
    cancelledUndeclaredTask = false;
    activeSlowCalls = 0;
    peakSlowCalls = 0;
    root = mkdtempSync(join(tmpdir(), "hogagent-mcp-http-"));
    const userDir = join(root, "user");
    const workspaceDir = join(root, "workspace");
    const sessionTaskDir = join(workspaceDir, "tasks", "http-session");
    mkdirSync(sessionTaskDir, { recursive: true });
    previousUserDir = process.env.HOGAGENT_USER_DIR;
    previousToken = process.env.HTTP_MCP_TEST_TOKEN;
    previousTenant = process.env.HTTP_MCP_TEST_TENANT;
    process.env.HOGAGENT_USER_DIR = userDir;
    process.env.HTTP_MCP_TEST_TOKEN = "http-secret-token";
    process.env.HTTP_MCP_TEST_TENANT = "tenant-a";
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port");
    saveSystemExternalMcpConfig({
      schemaVersion: 1,
      servers: [{
        name: "http-test",
        enabled: true,
        transport: {
          type: "http",
          url: `http://127.0.0.1:${address.port}/mcp`,
          bearerTokenEnv: "HTTP_MCP_TEST_TOKEN",
          headersFromEnv: { "X-Test-Tenant": "HTTP_MCP_TEST_TENANT" },
        },
        exposure: {
          allowedTools: ["echo", "remote_error", "rogue_task", "slow"],
          directTools: [],
          resourceUriPrefixes: [],
          allowedPrompts: [],
        },
        timeouts: { connectMs: 3000, callMs: 3000, taskForegroundMs: 0 },
        maxConcurrency: 1,
      }],
    });
    manager = new ExternalMcpClientManager(workspaceDir, () => "http-session", () => sessionTaskDir);
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousUserDir === undefined) delete process.env.HOGAGENT_USER_DIR;
    else process.env.HOGAGENT_USER_DIR = previousUserDir;
    if (previousToken === undefined) delete process.env.HTTP_MCP_TEST_TOKEN;
    else process.env.HTTP_MCP_TEST_TOKEN = previousToken;
    if (previousTenant === undefined) delete process.env.HTTP_MCP_TEST_TENANT;
    else process.env.HTTP_MCP_TEST_TENANT = previousTenant;
    rmSync(root, { recursive: true, force: true });
  });

  it("connects with environment-referenced HTTP credentials and calls a tool", async () => {
    await manager.probe("http-test");
    const result = await manager.callTool("http-test", "echo", { text: "hello-http" });
    expect(result.content).toEqual([{ type: "text", text: "hello-http" }]);
    expect(observedAuthorization).toBe("Bearer http-secret-token");
    expect(observedTenant).toBe("tenant-a");
  });

  it("does not return a remote error body that contains credentials", async () => {
    await manager.probe("http-test");
    await expect(manager.callTool("http-test", "remote_error", {})).rejects.toMatchObject({
      code: "REMOTE",
      message: "External MCP request failed",
    });
  });

  it("rejects and cancels a Task from a server that did not declare the Tasks extension", async () => {
    await manager.probe("http-test");
    await expect(manager.callTool("http-test", "rogue_task", {})).rejects.toMatchObject({ code: "PROTOCOL" });
    expect(cancelledUndeclaredTask).toBe(true);
  });

  it("enforces per-server concurrency without oversubscribing a released slot", async () => {
    await manager.probe("http-test");
    const results = await Promise.all([
      manager.callTool("http-test", "slow", {}),
      manager.callTool("http-test", "slow", {}),
      manager.callTool("http-test", "slow", {}),
    ]);
    expect(results).toHaveLength(3);
    expect(peakSlowCalls).toBe(1);
  });
});
