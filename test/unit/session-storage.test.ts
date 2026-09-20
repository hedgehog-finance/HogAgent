import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/vendor/agent/harness/env/nodejs.ts";
import { openOrCreateSessionStorage } from "../../src/session-storage.ts";

describe("session storage recovery", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "hogagent-storage-review-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const entry = JSON.stringify({
    type: "message", id: "message-1", parentId: null,
    timestamp: "2026-09-06T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "Keep my history" }], timestamp: 1 },
  });

  it("preserves corrupt existing history byte for byte instead of creating over it", async () => {
    const path = join(root, "session.jsonl");
    const header = JSON.stringify({
      type: "session", version: 3, id: "session", cwd: root,
      timestamp: "2026-09-06T00:00:00.000Z",
    });
    for (const original of [`${header}\n${entry}\n{truncated`, `${entry}\n{truncated`]) {
      writeFileSync(path, original);
      await expect(openOrCreateSessionStorage(new NodeExecutionEnv({ cwd: root }), path, root, "session"))
        .rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readdirSync(root)).toEqual(["session.jsonl"]);
    }
  });

  it("repairs a missing header only when all existing entries are valid", async () => {
    const path = join(root, "session.jsonl");
    writeFileSync(path, `${entry}\n`);
    const storage = await openOrCreateSessionStorage(new NodeExecutionEnv({ cwd: root }), path, root, "session");
    expect(await storage.getLeafId()).toBe("message-1");
    expect((await storage.getMetadata()).path).toBe(path);
    expect(readFileSync(path, "utf8")).toContain(`${entry}\n`);
    expect(readdirSync(root)).toEqual(["session.jsonl"]);
  });

  it("creates absent and empty sessions", async () => {
    for (const empty of [false, true]) {
      const path = join(root, `${empty}.jsonl`);
      if (empty) writeFileSync(path, "");
      const storage = await openOrCreateSessionStorage(new NodeExecutionEnv({ cwd: root }), path, root, "session");
      expect(await storage.getLeafId()).toBeNull();
      expect((await storage.getMetadata()).id).toBe("session");
    }
  });
});
