import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const entry = new URL("../../bin/hogagent-config.ts", import.meta.url).href;
const project = fileURLToPath(new URL("../..", import.meta.url));

// Force stream chunks inside multibyte UTF-8 characters, independent of OS pipe buffering.
async function callChunks(chunks: Buffer[], systemDir: string) {
  const bootstrap = `
    import { Readable } from 'node:stream';
    const input = Readable.from(${JSON.stringify(chunks.map(chunk => chunk.toString("base64")))}.map(value => Buffer.from(value, 'base64')), {objectMode:false});
    Object.defineProperty(process, 'stdin', {value:input});
    await import(${JSON.stringify(entry)});
  `;
  return new Promise<{ code: number; response: any }>((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", bootstrap], {
      env: { ...process.env, HOGAGENT_USER_DIR: systemDir, HOGAGENT_PROJECT_ROOT: project },
      encoding: "utf8", windowsHide: true, timeout: 10_000,
    }, (error, stdout) => {
      try { resolve({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, response: JSON.parse(stdout) }); }
      catch { reject(new Error("CLI did not return JSON")); }
    });
  });
}

describe("configuration CLI text transport", () => {
  it.each([false, true])("preserves split UTF-8 characters in requests (BOM=%s)", async bom => {
    const systemDir = mkdtempSync(join(tmpdir(), "hog 配置 空格-")); roots.push(systemDir);
    const payload = Buffer.from((bom ? "\uFEFF" : "") + JSON.stringify({
      type: "save_settings", settings: { provider: "hedgehog", modelId: "中文模型🦔", apiKey: "fixture-key" },
    }) + "\r\n");
    const chunks = Array.from(payload, byte => Buffer.from([byte]));
    const result = await callChunks(chunks, systemDir);
    expect(result.code).toBe(0);
    expect(result.response).toMatchObject({ success: true, data: { settings: { modelId: "中文模型🦔" } } });
    expect(JSON.parse(readFileSync(join(systemDir, "llm-settings.json"), "utf8")).modelId).toBe("中文模型🦔");
  });
});
