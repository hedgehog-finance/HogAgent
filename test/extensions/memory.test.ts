import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryExtension } from "../../src/extensions/memory/index.ts";
import type { LlmTrackingContext } from "../../src/llm-metadata-hook.ts";

describe("memory extension", () => {
  let registeredTools: Array<{ name: string; execute: Function }>;
  let tracking: LlmTrackingContext;

  beforeEach(async () => {
    registeredTools = [];
    tracking = { sessionId: "session-1", workId: "", taskId: "task-1" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify({ id: "memory-1" }) }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const context = {
      getConfig: () => ({
        memory: { enabled: true, mcpKbUrl: "http://127.0.0.1:59101" },
      }),
      registerTool: (tool: { name: string; execute: Function }) => {
        registeredTools.push(tool);
      },
      getSessionId: () => "session-1",
      getLlmTracking: () => tracking,
      getRuntimeContext: () => ({ process: {} as any }),
    };

    await new MemoryExtension().initialize(context as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function getCreateArguments(): Record<string, unknown> {
    const fetchMock = vi.mocked(fetch);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(body.params.name).toBe("kb_memory_create");
    return body.params.arguments;
  }

  it("forwards the trusted current work_id when saving memory", async () => {
    tracking.workId = "work-123";
    const saveTool = registeredTools.find((tool) => tool.name === "memory_save")!;

    await saveTool.execute("call-1", { content: "结论", task_type: "other", tags: [] });

    expect(getCreateArguments()).toMatchObject({
      source_session: "session-1",
      work_id: "work-123",
    });
  });

  it("omits work_id when the current task context does not provide one", async () => {
    tracking.workId = "   ";
    const saveTool = registeredTools.find((tool) => tool.name === "memory_save")!;

    await saveTool.execute("call-2", { content: "结论", task_type: "other", tags: [] });

    expect(getCreateArguments()).not.toHaveProperty("work_id");
  });
});
