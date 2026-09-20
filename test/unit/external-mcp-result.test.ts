import { describe, expect, it } from "vitest";
import { projectExternalMcpResult } from "../../src/mcp/client-manager.ts";

describe("external MCP result projection", () => {
  it("preserves supported content without copying unknown payload fields", () => {
    const projected = projectExternalMcpResult({
      resultType: "complete",
      privateDiagnostic: "remote-secret",
    });
    expect(projected.content).toEqual([{
      type: "text",
      text: "[External MCP result contained no supported content]",
    }]);
    expect(JSON.stringify(projected)).not.toContain("remote-secret");
  });

  it("maps resource reads and prompt messages into HogAgent content", () => {
    const resource = projectExternalMcpResult({
      contents: [{ uri: "docs://guide", mimeType: "text/plain", text: "Guide text" }],
    });
    expect(resource.content).toEqual([{ type: "text", text: "Guide text" }]);

    const prompt = projectExternalMcpResult({
      messages: [{ role: "user", content: { type: "text", text: "Review this" } }],
    });
    expect(prompt.content).toEqual([{ type: "text", text: "[user] Review this" }]);
  });
});
