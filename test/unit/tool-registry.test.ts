import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { AgentToolRegistry, isTopLevelOnlyTool } from "../../src/tool-registry.ts";
import type { AgentTool } from "../../src/vendor/agent/types.ts";

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: name }], details: {} })),
  };
}

describe("AgentToolRegistry", () => {
  it("keeps external MCP tools top-level only", () => {
    const base = tool("read");
    const external = tool("mcp_discover");
    const registry = new AgentToolRegistry([
      { tool: base, registration: { source: "builtin" } },
      { tool: external, registration: { source: "external_mcp", topLevelOnly: true } },
    ]);
    expect(registry.snapshotTopLevel().map((item) => item.name)).toEqual(["read", "mcp_discover"]);
    expect(registry.snapshotSubAgent().map((item) => item.name)).toEqual(["read"]);
    expect(isTopLevelOnlyTool(external)).toBe(true);
  });

  it("fails closed on name collisions", () => {
    const registry = new AgentToolRegistry();
    registry.register(tool("duplicate"), { source: "builtin" });
    expect(() => registry.register(tool("duplicate"), { source: "external_mcp", topLevelOnly: true }))
      .toThrow(/Duplicate tool name/);
  });

  it("does not activate a new tool when the harness currently exposes a scoped subset", async () => {
    const base = tool("read");
    const external = tool("mcp_discover");
    const registry = new AgentToolRegistry([
      { tool: base, registration: { source: "builtin" } },
    ]);
    let tools = [base];
    let activeTools: AgentTool[] = [];
    const harness = {
      getTools: () => tools,
      getActiveTools: () => activeTools,
      setTools: vi.fn(async (nextTools: AgentTool[], activeNames: string[]) => {
        tools = nextTools;
        activeTools = nextTools.filter((item) => activeNames.includes(item.name));
      }),
    };
    registry.register(external, { source: "external_mcp", topLevelOnly: true });
    await registry.syncHarness(harness as any, true);
    expect(activeTools).toEqual([]);
  });
});
