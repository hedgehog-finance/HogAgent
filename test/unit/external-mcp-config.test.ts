import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  ExternalMcpConfigError,
  loadEffectiveExternalMcpServers,
  parseExternalMcpConfig,
  saveSystemExternalMcpConfig,
} from "../../src/mcp/config.ts";

function configFor(name: string, url: string) {
  return {
    schemaVersion: 1 as const,
    servers: [{
      name,
      enabled: true,
      transport: { type: "http" as const, url, bearerTokenEnv: "EXTERNAL_MCP_TOKEN" },
      exposure: {
        allowedTools: ["search"],
        directTools: ["search"],
        resourceUriPrefixes: ["docs://"],
        allowedPrompts: ["review"],
      },
      timeouts: { connectMs: 10000, callMs: 60000, taskForegroundMs: 30000 },
      maxConcurrency: 4,
    }],
  };
}

describe("external MCP configuration", () => {
  let root: string;
  let userDir: string;
  let workspaceDir: string;
  let previousUserDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hogagent-mcp-config-"));
    userDir = join(root, "user");
    workspaceDir = join(root, "workspace");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".hogagent"), { recursive: true });
    previousUserDir = process.env.HOGAGENT_USER_DIR;
    process.env.HOGAGENT_USER_DIR = userDir;
  });

  afterEach(() => {
    if (previousUserDir === undefined) delete process.env.HOGAGENT_USER_DIR;
    else process.env.HOGAGENT_USER_DIR = previousUserDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects the legacy array shape instead of silently migrating it", () => {
    try {
      parseExternalMcpConfig([{ name: "old", url: "http://localhost" }]);
      throw new Error("Expected legacy configuration to be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "CONFIG" });
      expect(error).toHaveProperty("message", expect.stringMatching(/legacy server arrays are not supported/));
    }
  });

  it("rejects direct tools that are not explicitly allowed", () => {
    const value = configFor("demo", "http://127.0.0.1:3000/mcp");
    value.servers[0]!.exposure.directTools = ["write"];
    expect(() => parseExternalMcpConfig(value)).toThrow(/subset of allowedTools/);
  });

  it("rejects raw or unknown credential fields", () => {
    const value = configFor("demo", "http://127.0.0.1:3000/mcp") as any;
    value.servers[0].transport.bearerToken = "plaintext-secret";
    expect(() => parseExternalMcpConfig(value)).toThrow(ExternalMcpConfigError);
  });

  it("rejects credentials embedded in an HTTP URL", () => {
    expect(() => parseExternalMcpConfig(configFor("demo", "https://user:secret@example.com/mcp")))
      .toThrow(/may not embed credentials/);
  });

  it("writes system config atomically with owner-only permissions", () => {
    const saved = saveSystemExternalMcpConfig(configFor("demo", "http://127.0.0.1:3000/mcp"));
    const path = join(userDir, "mcp-servers.json");
    expect(saved.servers[0]?.name).toBe("demo");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(saved);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("lets workspace entries override system entries by name", () => {
    saveSystemExternalMcpConfig(configFor("demo", "http://127.0.0.1:3000/mcp"));
    writeFileSync(
      join(workspaceDir, ".hogagent", "mcp-servers.json"),
      JSON.stringify(configFor("demo", "http://127.0.0.1:4000/mcp")),
    );
    const effective = loadEffectiveExternalMcpServers(workspaceDir);
    expect(effective).toHaveLength(1);
    expect(effective[0]?.source).toBe("workspace");
    expect(effective[0]?.transport).toMatchObject({ url: "http://127.0.0.1:4000/mcp" });
  });
});
