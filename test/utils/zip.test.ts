import { getZipExtractCommand, assertZipEntriesSafe } from "../../src/utils/zip.ts";
import JSZip from 'jszip';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe("zip extraction command", () => {
  it("uses PowerShell Expand-Archive on Windows", () => {
    const command = getZipExtractCommand("C:\\Temp\\skill.zip", "C:\\Temp\\out", "win32");

    expect(command.command).toBe("powershell.exe");
    expect(command.args.join(" ")).toContain("Expand-Archive");
  });

  it("uses unzip on Unix-like platforms", () => {
    const command = getZipExtractCommand("/tmp/skill.zip", "/tmp/out", "linux");

    expect(command.command).toBe("unzip");
    expect(command.args).toContain("-x");
    expect(command.args).toContain("__MACOSX/*");
  });

  it.each([0o120777, 0o020600, 0o010600])('rejects unsafe ZIP entry type %s before extraction', async unixPermissions => {
    const root = mkdtempSync(join(tmpdir(), 'hog-zip-types-'));
    try {
      const zip = new JSZip();
      zip.file('link', '../outside', { unixPermissions });
      const file = join(root, 'skill.zip');
      writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
      expect(() => assertZipEntriesSafe(file, join(root, 'dest'))).toThrow('links and special files');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
