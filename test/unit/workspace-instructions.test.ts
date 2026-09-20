import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStandaloneAgents, mergeStandaloneAgents } from "../../src/workspace-instructions.ts";
import { STANDALONE_AGENTS_TEMPLATE, STANDALONE_AGENTS_VERSION } from "../../src/standalone-agents-template.ts";

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

describe("standalone workspace instructions", () => {
  let workspace: string;
  let path: string;
  beforeEach(() => {
    vi.stubEnv("HOGAGENT_GATEWAY_MANAGED", "");
    workspace = fs.mkdtempSync(join(tmpdir(), "hogagent-instructions-"));
    path = join(workspace, "AGENTS.md");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("creates a versioned template and a trailing user section without host-specific rules", () => {
    ensureStandaloneAgents(workspace);
    const content = fs.readFileSync(path, "utf8");
    expect(content).toContain(`version: ${STANDALONE_AGENTS_VERSION}`);
    expect(content).toContain(STANDALONE_AGENTS_TEMPLATE.trimEnd());
    expect(content.indexOf("# User Rules")).toBeGreaterThan(content.indexOf("managed-agents:end"));
    expect(content).not.toMatch(/Gateway|ciwei-ai|以下是补充|\.hedgehog|managed_node|workspace-contract/);
  });

  it.each(["", "# 我的规则\r\n\r\n请用中文。  \r\n", "\uFEFF# Existing rules\nNo final newline"])("preserves an unmarked file verbatim at the end: %j", (userRules) => {
    fs.writeFileSync(path, userRules);
    ensureStandaloneAgents(workspace);
    const content = fs.readFileSync(path, "utf8");
    expect(content).toBe(mergeStandaloneAgents(userRules));
    expect(content.endsWith(userRules)).toBe(true);
    expect(content).toContain("# User Rules / 用户自定义规则");
  });

  it("upgrades only an older managed section, preserving prefix and trailing rules byte for byte", () => {
    const prefix = "<!-- existing user preface -->\r\n";
    const suffix = "\r\n\r\n# User Rules\r\nversion: mine\r\n中文规则，保留空格。  ";
    const old = `${prefix}<!-- hogagent:managed-agents:start -->\r\n# Old template\r\nversion: 0.10.9\r\nObsolete rule\r\n<!-- hogagent:managed-agents:end -->${suffix}`;
    fs.writeFileSync(path, old);
    ensureStandaloneAgents(workspace);
    const content = fs.readFileSync(path, "utf8");
    expect(content.startsWith(prefix)).toBe(true);
    expect(content.endsWith(suffix)).toBe(true);
    expect(content).not.toContain("Obsolete rule");
    expect(content).toContain(`version: ${STANDALONE_AGENTS_VERSION}`);
    expect(fs.readdirSync(workspace)).toEqual(["AGENTS.md"]);
  });

  it.each([STANDALONE_AGENTS_VERSION, "1.10.0", "2.0.0"])("does not rewrite or downgrade version %s", (version) => {
    const content = mergeStandaloneAgents("Personal rule").replace(`version: ${STANDALONE_AGENTS_VERSION}`, `version: ${version}`).replace("## Working Principles", "## Edited managed heading");
    fs.writeFileSync(path, content);
    const write = vi.spyOn(fs, "writeFileSync");
    ensureStandaloneAgents(workspace);
    expect(fs.readFileSync(path, "utf8")).toBe(content);
    expect(write).not.toHaveBeenCalled();
  });

  it("upgrades a UTF-8 BOM/CRLF managed file without changing its user section or BOM", () => {
    const original = "\uFEFF" + mergeStandaloneAgents("中文规则\r\n").replace(/(?<!\r)\n/g, "\r\n");
    fs.writeFileSync(path, original.replace(`version: ${STANDALONE_AGENTS_VERSION}`, "version: 0.1.0"));
    ensureStandaloneAgents(workspace);
    const content = fs.readFileSync(path, "utf8");
    expect(content.startsWith("\uFEFF<!-- hogagent:managed-agents:start -->")).toBe(true);
    expect(content.slice(content.indexOf("<!-- hogagent:managed-agents:end -->"))).toBe(original.slice(original.indexOf("<!-- hogagent:managed-agents:end -->")));
    expect(content).toContain(`version: ${STANDALONE_AGENTS_VERSION}`);
  });

  it.each([
    "<!-- hogagent:managed-agents:start -->\nversion: 0.1.0\nUser rules",
    "<!-- hogagent:managed-agents:end -->\nUser rules",
    "<!-- hogagent:managed-agents:end -->\n<!-- hogagent:managed-agents:start -->",
    mergeStandaloneAgents() + "\n<!-- hogagent:managed-agents:start -->",
    mergeStandaloneAgents().replace(`version: ${STANDALONE_AGENTS_VERSION}`, "version: unknown"),
    mergeStandaloneAgents().replace(`version: ${STANDALONE_AGENTS_VERSION}`, "version: 0.1.0\nversion: 0.2.0"),
    mergeStandaloneAgents().replace(`version: ${STANDALONE_AGENTS_VERSION}`, ""),
  ])("fails without changing malformed managed instructions: %j", (content) => {
    fs.writeFileSync(path, content);
    expect(() => ensureStandaloneAgents(workspace)).toThrow(/AGENTS\.md/);
    expect(fs.readFileSync(path, "utf8")).toBe(content);
    expect(fs.readdirSync(workspace)).toEqual(["AGENTS.md"]);
  });

  it("leaves managed workspaces entirely to their host", () => {
    vi.stubEnv("HOGAGENT_GATEWAY_MANAGED", "1");
    const missing = join(workspace, "missing");
    ensureStandaloneAgents(missing);
    expect(fs.existsSync(missing)).toBe(false);
    fs.writeFileSync(path, "Gateway-owned rules\n以下是补充：\nKeep this.");
    const read = vi.spyOn(fs, "readFileSync");
    ensureStandaloneAgents(workspace);
    expect(read).not.toHaveBeenCalled();
    expect(fs.readFileSync(path, "utf8")).toBe("Gateway-owned rules\n以下是补充：\nKeep this.");
  });

  it("preserves the old file and removes temporary output if replacement fails", () => {
    fs.writeFileSync(path, "Personal instructions");
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("locked"), { code: "EACCES" }); });
    expect(() => ensureStandaloneAgents(workspace)).toThrow("locked");
    expect(fs.readFileSync(path, "utf8")).toBe("Personal instructions");
    expect(fs.readdirSync(workspace)).toEqual(["AGENTS.md"]);
  });

  it("refuses to overwrite an edit detected during initialization", () => {
    fs.writeFileSync(path, "Original");
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      write(...args);
      write(path, "User's concurrent edit");
    });
    expect(() => ensureStandaloneAgents(workspace)).toThrow("changed during initialization");
    expect(fs.readFileSync(path, "utf8")).toBe("User's concurrent edit");
    expect(fs.readdirSync(workspace)).toEqual(["AGENTS.md"]);
  });

  it("does not treat read failures as a missing file", () => {
    fs.writeFileSync(path, "Personal instructions");
    vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(() => ensureStandaloneAgents(workspace)).toThrow("denied");
    vi.restoreAllMocks();
    expect(fs.readFileSync(path, "utf8")).toBe("Personal instructions");
    expect(fs.readdirSync(workspace)).toEqual(["AGENTS.md"]);
  });

  it("refuses non-regular files without replacing them", () => {
    fs.mkdirSync(path);
    expect(() => ensureStandaloneAgents(workspace)).toThrow("non-regular");
    expect(fs.statSync(path).isDirectory()).toBe(true);
  });
});
