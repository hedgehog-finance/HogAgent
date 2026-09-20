import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { createBashTool } from "../../src/tools/builtin-tools.ts";
import type { BashRuntime } from "../../src/tools/bash-sandbox.ts";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

const runtime: BashRuntime = {
  backend: "bare-shell", workspaceDir: ".", tempDir: ".", shells: ["powershell.exe"],
  buildSpawn: (command, text) => ({ command, args: [text], cwd: ".", env: {} }),
};

it("decodes split UTF-8 characters independently on stdout and stderr", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const pending = createBashTool(runtime).execute("utf8", { command: "fixture" });
  for (const byte of Buffer.from("中文报告😀")) child.stdout.write(Buffer.from([byte]));
  for (const byte of Buffer.from("权限不足")) child.stderr.write(Buffer.from([byte]));
  child.stdout.end(); child.stderr.end(); child.emit("close", 0);
  expect(await pending).toMatchObject({ content: [{ text: "中文报告😀\n[stderr]\n权限不足" }] });
  expect(spawn).toHaveBeenCalledWith("powershell.exe", ["fixture"], expect.objectContaining({ windowsHide: true }));
});

it("returns execution permission failures without retrying in another shell", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const pending = createBashTool({ ...runtime, shells: ["powershell.exe", "bash"] }).execute("denied", { command: "fixture" });
  child.emit("error", Object.assign(new Error("EACCES: execution denied"), { code: "EACCES" }));
  expect(await pending).toMatchObject({ content: [{ text: expect.stringContaining("Command failed: EACCES") }] });
  expect(spawn).toHaveBeenCalledOnce();
});
