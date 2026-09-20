import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalMcpExtension } from "../../src/extensions/external-mcp/index.ts";
import type { HogAgentContext } from "../../src/utils/types.ts";
import type { AgentTool } from "../../src/vendor/agent/types.ts";

describe("ExternalMcpExtension model exposure", () => {
  let root: string;
  let previousUserDir: string | undefined;
  let extension: ExternalMcpExtension;
  let tools: Map<string, AgentTool>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "hogagent-mcp-extension-"));
    previousUserDir = process.env.HOGAGENT_USER_DIR;
    process.env.HOGAGENT_USER_DIR = join(root, "user");
    tools = new Map();
    const workspaceDir = join(root, "workspace");
    const sessionTaskDir = join(workspaceDir, "tasks", "session-a");
    const context = {
      registerTool: async (tool: unknown) => {
        const agentTool = tool as AgentTool;
        if (tools.has(agentTool.name)) throw new Error(`Duplicate tool name: ${agentTool.name}`);
        tools.set(agentTool.name, agentTool);
      },
      unregisterTool: async (name: string) => { tools.delete(name); },
      getWorkspaceDir: () => workspaceDir,
      getSessionId: () => "session-a",
      getConfig: () => ({ sessionTaskDir }),
      getHarness: () => ({ getTools: () => [...tools.values()] }),
    } as unknown as HogAgentContext;
    extension = new ExternalMcpExtension();
    await extension.initialize(context);
  });

  afterEach(async () => {
    await extension.shutdown();
    if (previousUserDir === undefined) delete process.env.HOGAGENT_USER_DIR;
    else process.env.HOGAGENT_USER_DIR = previousUserDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("does not change the model tool set or session files when no server is configured", async () => {
    expect([...tools.keys()]).toEqual([]);
    await extension.onAgentAbort();
    expect(existsSync(join(root, "workspace", "tasks", "session-a", ".hedgehog"))).toBe(false);
  });

  it("keeps abort side-effect free when every configured server is disabled", async () => {
    await extension.saveServers({
      schemaVersion: 1,
      servers: [{
        name: "disabled",
        enabled: false,
        transport: { type: "http", url: "http://127.0.0.1:65534/mcp" },
        exposure: {
          allowedTools: [],
          directTools: [],
          resourceUriPrefixes: [],
          allowedPrompts: [],
        },
      }],
    });
    expect([...tools.keys()]).toEqual([]);
    await extension.onAgentAbort();
    expect(existsSync(join(root, "workspace", "tasks", "session-a", ".hedgehog"))).toBe(false);
  });

  it("adds meta-tools only while an effective external server is enabled", async () => {
    await extension.saveServers({
      schemaVersion: 1,
      servers: [{
        name: "external",
        enabled: true,
        transport: { type: "http", url: "http://127.0.0.1:65534/mcp" },
        exposure: {
          allowedTools: [],
          directTools: [],
          resourceUriPrefixes: [],
          allowedPrompts: [],
        },
      }],
    });
    expect([...tools.keys()].sort()).toEqual([
      "mcp_call_tool",
      "mcp_discover",
      "mcp_get_prompt",
      "mcp_operation",
      "mcp_read_resource",
    ]);

    await extension.saveServers({ schemaVersion: 1, servers: [] });
    expect([...tools.keys()]).toEqual([]);
  });
});
