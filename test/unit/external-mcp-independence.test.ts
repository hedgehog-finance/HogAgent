import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function filesRecursively(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? filesRecursively(child) : [child];
  });
}

describe("external MCP independence", () => {
  it("does not import Gateway packages or consume Gateway MCP environment variables", () => {
    const roots = [
      join(process.cwd(), "src", "mcp"),
      join(process.cwd(), "src", "extensions", "external-mcp"),
    ];
    const content = roots.flatMap(filesRecursively).map((path) => readFileSync(path, "utf8")).join("\n");
    expect(content).not.toMatch(/hedgehog-gateway|HEDGEHOG_MCP_GENERAL|59101|59102/);
  });
});
