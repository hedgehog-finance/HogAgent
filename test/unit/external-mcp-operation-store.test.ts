import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { ExternalMcpOperationStore } from "../../src/mcp/operation-store.ts";

describe("ExternalMcpOperationStore", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hogagent-mcp-operation-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("persists operations with session isolation and owner-only permissions", () => {
    let sessionId = "session-a";
    let taskDir = join(root, "a");
    const store = new ExternalMcpOperationStore(() => sessionId, () => taskDir);
    const created = store.create({
      operationId: "op-1",
      serverName: "demo",
      kind: "input_required",
      status: "input_required",
      method: "tools/call",
      params: { name: "ask" },
      inputRequests: { question: { method: "elicitation/create" } },
    });
    expect(store.get("op-1")?.sessionId).toBe("session-a");
    expect(statSync(join(taskDir, ".hedgehog", "mcp-operations.json")).mode & 0o777).toBe(0o600);

    sessionId = "session-b";
    taskDir = join(root, "b");
    expect(store.get(created.operationId)).toBeUndefined();
  });

  it("rejects a symlinked operation control directory", () => {
    const taskDir = join(root, "unsafe-task");
    const outside = join(root, "outside");
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(taskDir, ".hedgehog"), "dir");
    const store = new ExternalMcpOperationStore(() => "session-a", () => taskDir);
    expect(() => store.create({
      operationId: "op-unsafe",
      serverName: "demo",
      kind: "task",
      status: "working",
      method: "tools/call",
      params: { name: "work" },
    })).toThrow(/control directory must be a real directory/);
  });

  it("does not let a stale Task poll resurrect a terminal operation", () => {
    const taskDir = join(root, "terminal-task");
    const store = new ExternalMcpOperationStore(() => "session-a", () => taskDir);
    store.create({
      operationId: "op-terminal",
      serverName: "demo",
      kind: "task",
      status: "working",
      method: "tools/call",
      params: { name: "work" },
    });
    store.update("op-terminal", { status: "cancelled" });
    const staleUpdate = store.update("op-terminal", { status: "working" });
    expect(staleUpdate.status).toBe("cancelled");
    expect(store.get("op-terminal")?.status).toBe("cancelled");
  });
});
