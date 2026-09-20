import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startWebServer } from "../../src/web/server.ts";

it("rejects corrupt saved settings before creating an empty configuration session", async () => {
  const root = mkdtempSync(join(tmpdir(), "hogagent-invalid-llm-"));
  vi.stubEnv("HOGAGENT_USER_DIR", root);
  writeFileSync(join(root, "llm-settings.json"), '{invalid-json');
  const server = await startWebServer({ port: 0, defaultWorkspace: join(root, "workspace") });
  const base = `http://127.0.0.1:${server.port}`;
  let ws: WebSocket | undefined;
  try {
    const token = (await (await fetch(base)).text()).match(/name="hogagent-web-token" content="([^"]+)"/)![1];
    ws = new WebSocket(`ws://127.0.0.1:${server.port}/?user=default&token=${encodeURIComponent(token)}`, { origin: base });
    const error = await new Promise<any>((resolve, reject) => {
      ws!.once('message', data => resolve(JSON.parse(data.toString())));
      ws!.once('error', reject);
    });
    expect(error).toMatchObject({ type: 'error', error: expect.stringContaining('Invalid configuration JSON') });
    expect(server.sessions.size).toBe(0);
  } finally {
    ws?.terminate(); await server.shutdown(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it("prefills persisted credentials and returns a fresh snapshot after the child confirms saving", async () => {
  const root = mkdtempSync(join(tmpdir(), "hogagent-llm-form-"));
  vi.stubEnv("HOGAGENT_USER_DIR", root);
  const path = join(root, "llm-settings.json");
  const initial = { provider: "hedgehog", apiKey: "fixture-main-key", modelId: "saved-main", providerApiKeys: { hedgehog: "fixture-main-key", openai: "fixture-other-key" }, audit: { provider: "close" } };
  writeFileSync(path, JSON.stringify(initial));
  const child = join(root, "fixture.mjs");
  // The bridge should read disk after acknowledgement, never echo the submitted
  // values as if the child had persisted them. Handler persistence is tested separately.
  writeFileSync(child, `import { createInterface } from 'node:readline';
    createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({type:'settings_saved',success:true,provider:'hedgehog'})));`);
  const server = await startWebServer({ port: 0, defaultWorkspace: join(root, "workspace"), hogagentPath: child });
  const base = `http://127.0.0.1:${server.port}`;
  let ws: WebSocket | undefined;
  try {
    const html = await (await fetch(base)).text();
    const token = html.match(/name="hogagent-web-token" content="([^"]+)"/)![1];
    ws = new WebSocket(`ws://127.0.0.1:${server.port}/?user=default&token=${encodeURIComponent(token)}`, { origin: base });
    const nextEvent = (type: string) => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { ws!.off('message', listener); reject(new Error(`Missing ${type}`)); }, 5000);
      const listener = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString());
        if (message.event?.type === type) { clearTimeout(timer); ws!.off('message', listener); resolve(message.event); }
      };
      ws!.on('message', listener);
    });
    const ready = await nextEvent('ready');
    expect(ready.capabilities.llmProvider).toMatchObject({ apiKey: initial.apiKey, providerApiKeys: initial.providerApiKeys });
    expect(ready.capabilities.auditModel.configured).toBe(false);
    const persisted = { ...initial, apiKey: "merged-key", modelId: "merged-model" };
    writeFileSync(path, JSON.stringify(persisted));
    const saved = nextEvent('settings_saved');
    ws.send(JSON.stringify({ type: 'rpc_command', command: { type: 'save_settings', modelId: 'submitted-model' } }));
    expect((await saved).settings).toEqual(persisted);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(persisted);
  } finally {
    ws?.terminate();
    await server.shutdown();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
