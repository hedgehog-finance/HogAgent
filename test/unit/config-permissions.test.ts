import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPersistedLlmSettings, loadSkillApiConfig, savePersistedLlmSettings, saveSkillApiConfig, saveSystemConfig } from "../../src/config.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
});

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "HogAgent 权限 测试-"));
  vi.stubEnv("HOGAGENT_USER_DIR", root);
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const configs = [
  { file: "llm-settings.json", save: () => savePersistedLlmSettings({ apiKey: "new-fixture-key" }), load: (strict: boolean) => loadPersistedLlmSettings(strict) },
  { file: "skills_config.json", save: () => saveSkillApiConfig("hedgehog-data", { "api-key": "new-fixture-key" }), load: (strict: boolean) => loadSkillApiConfig(strict) },
];
const denied = (code: string) => Object.assign(new Error("fixture access denied"), { code });

describe("configuration access failures", () => {
  for (const config of configs) {
    it.each(["EACCES", "EPERM", "EBUSY"])(`${config.file} reports %s without treating it as absent`, code => {
      for (const strict of [false, true]) {
        vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw denied(code); });
        expect(() => config.load(strict)).toThrow(`(${code})`);
      }
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw denied(code); });
      expect(config.save).toThrow(config.file);
      expect(fs.readdirSync(root)).toEqual([]);
    });

    it.each(["EACCES", "EPERM", "EBUSY"])(`${config.file} preserves the original when replacement fails with %s`, code => {
      const path = join(root, config.file);
      fs.writeFileSync(path, '{"original":{}}');
      vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw denied(code); });
      expect(config.save).toThrow(`(${code})`);
      expect(fs.readFileSync(path, "utf8")).toBe('{"original":{}}');
      expect(fs.readdirSync(root)).toEqual([config.file]);
    });

    it(`${config.file} reports denied temporary-file creation`, () => {
      vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw denied("EACCES"); });
      expect(config.save).toThrow("file replacement");
      expect(fs.readdirSync(root)).toEqual([]);
    });

    it.runIf(process.platform === "win32")(`${config.file} preserves a real Windows read-only file`, () => {
      const path = join(root, config.file);
      fs.writeFileSync(path, "{}");
      fs.chmodSync(path, 0o400);
      try {
        expect(config.load(true)).toEqual({});
        expect(config.save).toThrow(/\((EPERM|EACCES)\)/);
        expect(fs.readFileSync(path, "utf8")).toBe("{}");
        expect(fs.readdirSync(root)).toEqual([config.file]);
      } finally { fs.chmodSync(path, 0o600); }
    });
  }

  it("system configuration uses the same replacement failure contract", () => {
    fs.writeFileSync(join(root, "hogagent.json"), '{"showCacheStats":true}');
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw denied("EPERM"); });
    expect(() => saveSystemConfig({ showCacheStats: false })).toThrow("hogagent.json (EPERM)");
    expect(fs.readFileSync(join(root, "hogagent.json"), "utf8")).toBe('{"showCacheStats":true}');
    expect(fs.readdirSync(root)).toEqual(["hogagent.json"]);
  });

  it("does not expose credential snippets from malformed JSON", () => {
    fs.writeFileSync(join(root, "llm-settings.json"), '{"apiKey":"sensitive-fixture", BROKEN}');
    expect(() => savePersistedLlmSettings({ apiKey: "replacement" })).toThrow("Invalid configuration JSON");
    try { savePersistedLlmSettings({}); } catch (error) { expect(String(error)).not.toContain("sensitive-fixture"); }
  });
});

// Actual NTFS ACL checks run on Windows CI. All changes are confined to this test's
// own temporary directory and restored in finally; no elevation or profile edits.
function changeDenyRule(path: string, right: "ReadData" | "CreateFiles", remove = false): void {
  const script = `
    $ErrorActionPreference = 'Stop'
    $path = $env:HOGAGENT_PERMISSION_TEST_PATH
    $acl = Get-Acl -LiteralPath $path
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, '${right}', 'Deny')
    $acl.${remove ? "RemoveAccessRuleSpecific" : "AddAccessRule"}($rule)
    Set-Acl -LiteralPath $path -AclObject $acl
  `;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, HOGAGENT_PERMISSION_TEST_PATH: path }, windowsHide: true, timeout: 15_000, stdio: "pipe",
  });
}

describe.runIf(process.platform === "win32")("native Windows configuration ACLs", () => {
  for (const config of configs) {
    it(`${config.file} reports denied read permission`, () => {
      const path = join(root, config.file);
      fs.writeFileSync(path, "{}");
      try {
        changeDenyRule(path, "ReadData");
        expect(() => config.load(false)).toThrow(/\((EACCES|EPERM)\)/);
        expect(() => config.load(true)).toThrow(/\((EACCES|EPERM)\)/);
        expect(config.save).toThrow(/\((EACCES|EPERM)\)/);
      } finally { changeDenyRule(path, "ReadData", true); }
      expect(fs.readFileSync(path, "utf8")).toBe("{}");
    }, 40_000);
  }

  it("rejects writes when the directory ACL denies creating a temporary file", () => {
    fs.writeFileSync(join(root, "llm-settings.json"), "{}");
    try {
      changeDenyRule(root, "CreateFiles");
      expect(() => savePersistedLlmSettings({ apiKey: "fixture" })).toThrow(/\((EACCES|EPERM)\)/);
    } finally { changeDenyRule(root, "CreateFiles", true); }
    expect(fs.readFileSync(join(root, "llm-settings.json"), "utf8")).toBe("{}");
    expect(fs.readdirSync(root)).toEqual(["llm-settings.json"]);
  }, 40_000);
});
