import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, createFindTool, createGrepTool, getShellCandidates } from "../../src/tools/builtin-tools.ts";
import { getShellArguments } from "../../src/tools/shell-command.ts";

describe("builtin shell tool", () => {
  it.skipIf(process.platform !== "win32")("preserves Chinese output through a real PowerShell to Node pipeline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hogagent 管道 测试 "));
    try {
      const shell = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = join(dir, "读取 参数.mjs");
      writeFileSync(script, 'process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) process.stdout.write(chunk);');
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const tool = createBashTool({
        backend: "bare-shell", workspaceDir: dir, tempDir: dir, shells: [shell],
        buildSpawn: (command, text) => ({ command, args: getShellArguments(command, text, "win32"), cwd: dir, env: process.env }),
      });
      const result = await tool.execute("pipe", { command: `Write-Output '中文报告😀' | & ${quote(process.execPath)} ${quote(script)}` });
      expect(result).toMatchObject({ content: [{ text: expect.stringContaining("中文报告😀") }] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses PowerShell then verified Git Bash and excludes cmd on Windows", () => {
    const candidates = getShellCandidates("win32").map((candidate) => candidate.command);
    expect(candidates).toEqual(["powershell.exe", "bash"]);
    expect(() => getShellArguments("cmd.exe", "echo unsupported", "win32"))
      .toThrow("cmd.exe is not supported");
  });

  it("uses bash then sh on Unix-like platforms", () => {
    const linuxCandidates = getShellCandidates("linux").map((candidate) => candidate.command);
    const macCandidates = getShellCandidates("darwin").map((candidate) => candidate.command);

    expect(linuxCandidates).toEqual(["bash", "sh"]);
    expect(macCandidates).toEqual(["bash", "sh"]);
  });
});

describe("Node-backed grep/find tools", () => {
  it("searches file contents without system grep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hogagent-grep-"));
    try {
      writeFileSync(join(dir, "a.txt"), "alpha\nneedle\n", "utf-8");
      writeFileSync(join(dir, "b.md"), "needle ignored\n", "utf-8");
      const tool = createGrepTool(dir);
      const result = await tool.execute("call-id", { pattern: "needle", include: "*.txt" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("a.txt:2:needle");
      expect(result.content[0].text).not.toContain("b.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds files without system find", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hogagent-find-"));
    try {
      writeFileSync(join(dir, "a.json"), "{}", "utf-8");
      writeFileSync(join(dir, "b.txt"), "text", "utf-8");
      const tool = createFindTool(dir);
      const result = await tool.execute("call-id", { pattern: "*.json" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toBe("a.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
