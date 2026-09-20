import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalMcpClientManager } from "../../src/mcp/client-manager.ts";
import { saveSystemExternalMcpConfig } from "../../src/mcp/config.ts";

describe("ExternalMcpClientManager modern operations", () => {
  let root: string;
  let sessionTaskDir: string;
  let manager: ExternalMcpClientManager;
  let previousUserDir: string | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "hogagent-mcp-operation-"));
    const userDir = join(root, "user");
    const workspaceDir = join(root, "workspace");
    sessionTaskDir = join(workspaceDir, "tasks", "session-modern");
    mkdirSync(sessionTaskDir, { recursive: true });
    previousUserDir = process.env.HOGAGENT_USER_DIR;
    process.env.HOGAGENT_USER_DIR = userDir;
    saveSystemExternalMcpConfig({
      schemaVersion: 1,
      servers: [{
        name: "modern",
        enabled: true,
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [join(process.cwd(), "test", "fixtures", "mcp-modern-stdio-server.mjs")],
        },
        exposure: {
          allowedTools: ["interactive", "long_task", "disconnect"],
          directTools: [],
          resourceUriPrefixes: [],
          allowedPrompts: [],
        },
        timeouts: { connectMs: 3000, callMs: 3000, taskForegroundMs: 0 },
        maxConcurrency: 2,
      }],
    });
    manager = new ExternalMcpClientManager(workspaceDir, () => "session-modern", () => sessionTaskDir);
    await manager.initialize();
    await manager.probe("modern");
  });

  afterEach(async () => {
    await manager.close();
    if (previousUserDir === undefined) delete process.env.HOGAGENT_USER_DIR;
    else process.env.HOGAGENT_USER_DIR = previousUserDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("persists and resumes a modern multi-round elicitation", async () => {
    const pending = await manager.callTool("modern", "interactive", {});
    const operation = pending.details as { operationId: string; status: string };
    expect(operation.status).toBe("input_required");
    const completed = await manager.respondOperation(operation.operationId, {
      confirmation: { action: "accept", content: { approved: true } },
    });
    expect(completed.content).toEqual([{ type: "text", text: "approved=true" }]);
  });

  it("settles an in-flight call on transport closure through the SDK", async () => {
    await expect(manager.callTool("modern", "disconnect", {})).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "Connection closed" }),
    });
    expect(manager.getViews()[0]?.status).toBe("disconnected");
  });

  it.each(["interactive", "long_task"])("rechecks revoked tool permission before responding to %s", async (toolName) => {
    const pending = await manager.callTool("modern", toolName, {});
    const operationId = (pending.details as { operationId: string }).operationId;
    if (toolName === "long_task") await manager.getOperation(operationId);
    const config = manager.getSystemConfig();
    config.servers[0]!.exposure.allowedTools = [];
    await manager.saveSystemConfig(config);
    await expect(manager.respondOperation(operationId, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("persists, polls, responds to, and completes a declared standard Task", async () => {
    const started = await manager.callTool("modern", "long_task", {});
    const operationId = (started.details as { operationId: string }).operationId;
    expect(statSync(join(sessionTaskDir, ".hedgehog", "mcp-operations.json")).mode & 0o777).toBe(0o600);

    const pending = await manager.getOperation(operationId);
    expect((pending.details as { status: string }).status).toBe("input_required");
    const resumed = await manager.respondOperation(operationId, {
      checkpoint: { action: "accept", content: { approved: true } },
    });
    expect((resumed.details as { status: string }).status).toBe("working");
    const completed = await manager.getOperation(operationId);
    expect(completed.content).toEqual([{ type: "text", text: "task complete" }]);
  });

  it("cancels a persisted remote Task", async () => {
    const started = await manager.callTool("modern", "long_task", {});
    const operationId = (started.details as { operationId: string }).operationId;
    const cancelled = await manager.cancelOperation(operationId);
    expect((cancelled.details as { status: string }).status).toBe("cancelled");
    const persisted = await manager.getOperation(operationId);
    expect((persisted.details as { status: string }).status).toBe("cancelled");
  });

  it.each([0, 1000])("preserves remote cancellation and its operation handle (foreground=%s)", async foregroundMs => {
    const config = manager.getSystemConfig();
    config.servers[0]!.timeouts!.taskForegroundMs = foregroundMs;
    await manager.saveSystemConfig(config);
    const started = await manager.callTool("modern", "long_task", { cancelOnPoll: true });
    const result = foregroundMs > 0 ? started
      : await manager.getOperation((started.details as { operationId: string }).operationId);
    expect(result.details).toMatchObject({ status: "cancelled", operationId: expect.any(String) });
    const cached = await manager.getOperation((result.details as { operationId: string }).operationId);
    expect(cached.details).toEqual(result.details);
  });

  it.each(["replacement", "legacy"])("blocks remote poll/respond/cancel for %s handles", async kind => {
    const started = await manager.callTool("modern", "long_task", {});
    const waiting = await manager.callTool("modern", "interactive", {});
    const taskId = (started.details as { operationId: string }).operationId;
    const inputId = (waiting.details as { operationId: string }).operationId;
    if (kind === "replacement") {
      const config = manager.getSystemConfig();
      if (config.servers[0]!.transport.type !== "stdio") throw new Error("Expected stdio fixture");
      config.servers[0]!.transport.args!.push("--replacement");
      await manager.saveSystemConfig(config);
    } else {
      const path = join(sessionTaskDir, ".hedgehog", "mcp-operations.json");
      const stored = JSON.parse(readFileSync(path, "utf8"));
      for (const operation of stored.operations) delete operation.connectionFingerprint;
      writeFileSync(path, JSON.stringify(stored));
    }
    const request = vi.spyOn(manager as any, "request");
    try {
      await expect(manager.getOperation(taskId)).rejects.toThrow("connection configuration");
      await expect(manager.respondOperation(inputId, {})).rejects.toThrow("connection configuration");
      await expect(manager.cancelOperation(taskId)).rejects.toThrow("connection configuration");
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });

  it("keeps a handle usable after a timeout-only configuration update", async () => {
    const pending = await manager.callTool("modern", "interactive", {});
    const config = manager.getSystemConfig();
    config.servers[0]!.timeouts!.callMs = 4000;
    await manager.saveSystemConfig(config);
    const completed = await manager.respondOperation((pending.details as { operationId: string }).operationId, {
      confirmation: { action: "accept", content: { approved: true } },
    });
    expect(completed.content).toEqual([{ type: "text", text: "approved=true" }]);
  });
});
