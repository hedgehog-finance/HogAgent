import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basenamePath, isPathAbsolute, isPathInside, normalizePath, realPathDirectChild, relativePathIfInside } from "../../src/utils/path-safety.ts";

describe("path-safety", () => {
  it("accepts children inside POSIX paths", () => {
    expect(isPathInside("/home/me/workspace", "/home/me/workspace/tasks/report.md")).toBe(true);
    expect(relativePathIfInside("/home/me/workspace", "/home/me/workspace/tasks/report.md")).toBe("tasks/report.md");
  });

  it("rejects POSIX same-prefix siblings", () => {
    expect(isPathInside("/home/me/workspace", "/home/me/workspace_evil/report.md")).toBe(false);
    expect(relativePathIfInside("/home/me/workspace", "/home/me/workspace_evil/report.md")).toBeNull();
  });

  it("accepts Windows drive children with mixed separators", () => {
    const parent = "C:\\Users\\me\\.hedgehoggateway\\agents\\hogagent\\workspace";
    const child = "C:/Users/me/.hedgehoggateway/agents/hogagent/workspace/tasks/session/report.md";

    expect(isPathAbsolute(child, parent)).toBe(true);
    expect(isPathInside(parent, child)).toBe(true);
    expect(relativePathIfInside(parent, child)).toBe("tasks\\session\\report.md");
    expect(basenamePath(child)).toBe("report.md");
  });

  it("rejects Windows drive same-prefix siblings", () => {
    const parent = "C:\\Users\\me\\workspace";
    const child = "C:\\Users\\me\\workspace_evil\\report.md";

    expect(isPathInside(parent, child)).toBe(false);
  });

  it("handles Windows UNC paths", () => {
    const parent = "\\\\server\\share\\workspace";
    const child = "\\\\server\\share\\workspace\\tasks\\report.md";

    expect(isPathAbsolute(child, parent)).toBe(true);
    expect(isPathInside(parent, child)).toBe(true);
    expect(relativePathIfInside(parent, child)).toBe("tasks\\report.md");
  });

  it("treats WSL2 mount paths as POSIX paths", () => {
    const parent = "/mnt/c/Users/me/workspace";
    const child = "/mnt/c/Users/me/workspace/tasks/report.md";

    expect(isPathInside(parent, child)).toBe(true);
    expect(relativePathIfInside(parent, child)).toBe("tasks/report.md");
  });

  it("normalizes backslash relative paths under POSIX and WSL2 parents", () => {
    expect(normalizePath("tasks\\session\\report.md", "/mnt/c/Users/me/workspace")).toBe("tasks/session/report.md");
    expect(basenamePath("tasks\\session\\report.md")).toBe("report.md");
  });

  it("rejects a direct-child alias whose real target is outside the parent", () => {
    const root = mkdtempSync(join(tmpdir(), "hogagent-path-safety-"));
    try {
      const parent = join(root, "workspace");
      const direct = join(parent, "tasks");
      const sibling = join(parent, "sibling");
      const outside = join(root, "outside");
      mkdirSync(direct, { recursive: true });
      mkdirSync(sibling, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(parent, "projects"));
      symlinkSync(sibling, join(parent, "sibling-alias"));

      expect(realPathDirectChild(parent, direct)).toBe(realpathSync(direct));
      expect(realPathDirectChild(parent, join(parent, "projects"))).toBeNull();
      expect(realPathDirectChild(parent, join(parent, "sibling-alias"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
