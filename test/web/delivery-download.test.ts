import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWebServer } from '../../src/web/server.ts';
import { getSessionsDir } from '../../src/config.ts';
import { FileDelivery } from '../../src/artifacts/file-delivery.ts';
import { startArtifactRun } from '../../src/artifacts/artifact-protocol.ts';
import type { HogAgentConfig, HogAgentContext } from '../../src/utils/types.ts';

afterEach(() => vi.unstubAllEnvs());
describe('durable native delivery downloads', () => {
  it('uses the parent Markdown receipt for referenced images without granting unrelated file access', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hog-md-download-'));
    const workspace = join(dir, 'workspace'); const root = join(workspace, 'tasks', 'session-md'); mkdirSync(root, { recursive: true });
    vi.stubEnv('HOGAGENT_USER_DIR', join(dir, 'system'));
    const mock = join(dir, 'agent.mjs'); writeFileSync(mock, 'process.stdin.resume();');
    const server = await startWebServer({ port: 0, defaultWorkspace: workspace, hogagentPath: mock });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const html = await (await fetch(base)).text(); const token = html.match(/name="hogagent-web-token" content="([^"]+)"/)![1];
      const headers = { Authorization: `Bearer ${token}` };
      const config = { workspaceDir: workspace, sessionTaskDir: root, sessionId: 'session-md' } as HogAgentConfig;
      startArtifactRun(config, 'run-md');
      writeFileSync(join(root, 'report.md'), '![图表](chart.png)');
      writeFileSync(join(root, 'chart.png'), 'image fixture');
      writeFileSync(join(root, 'private.png'), 'not referenced');
      const result = await new FileDelivery({ getConfig: () => config } as HogAgentContext).prepare([{ path: 'tasks/session-md/report.md' }], 'explicit');
      mkdirSync(getSessionsDir(), { recursive: true });
      writeFileSync(join(getSessionsDir(), 'session-md.jsonl'), JSON.stringify({ type: 'custom', customType: 'hogagent.file-delivery', data: result }) + '\n');
      const url = `${base}/api/download?session=session-md&path=tasks/session-md/report.md&receipt=${result.files[0].id}`;
      const image = await fetch(url + '&resource=chart.png', { headers });
      expect(image.status).toBe(200); expect(image.headers.get('content-type')).toBe('image/png');
      expect(await image.text()).toBe('image fixture');
      expect((await fetch(url + '&resource=private.png', { headers })).status).toBe(403);
      expect((await fetch(url + '&resource=chart.png')).status).toBe(401);
      expect((await fetch(`${base}/api/download?session=session-md&path=tasks/session-md/chart.png`, { headers })).status).toBe(403);
      writeFileSync(join(root, 'report.md'), '![新的引用](private.png)');
      expect((await fetch(url + '&resource=private.png', { headers })).status).toBe(409);
    } finally { await server.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps each card on its original receipt, Session and file contents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hog-receipt-download-'));
    const workspace = join(dir, 'workspace'); const root = join(workspace, 'tasks', 'session-1'); mkdirSync(root, { recursive: true });
    vi.stubEnv('HOGAGENT_USER_DIR', join(dir, 'system'));
    const mock = join(dir, 'agent.mjs'); writeFileSync(mock, 'process.stdin.resume();');
    const server = await startWebServer({ port: 0, defaultWorkspace: workspace, hogagentPath: mock });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const html = await (await fetch(base)).text(); const token = html.match(/name="hogagent-web-token" content="([^"]+)"/)![1];
      const config = { workspaceDir: workspace, sessionTaskDir: root, sessionId: 'session-1' } as HogAgentConfig;
      startArtifactRun(config, 'run-1'); writeFileSync(join(root, 'report.txt'), 'first');
      const delivery = new FileDelivery({ getConfig: () => config } as HogAgentContext);
      const first = await delivery.prepare([{ path: 'tasks/session-1/report.txt' }], 'explicit');
      const history = [{ type: 'message', message: { role: 'toolResult', toolName: 'deliver_files', details: first } }];
      mkdirSync(getSessionsDir(), { recursive: true }); const historyPath = join(getSessionsDir(), 'session-1.jsonl');
      const save = () => writeFileSync(historyPath, history.map(entry => JSON.stringify(entry)).join('\n') + '\n'); save();
      const download = (id?: string, session = 'session-1', path = 'tasks/session-1/report.txt') => fetch(`${base}/api/download?session=${session}&path=${encodeURIComponent(path)}${id ? `&receipt=${id}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(await (await download(first.files[0].id)).text()).toBe('first');
      writeFileSync(join(root, 'report.txt'), 'second');
      expect((await download(first.files[0].id)).status).toBe(409);
      startArtifactRun(config, 'run-2'); const second = await delivery.prepare([{ path: 'tasks/session-1/report.txt' }], 'explicit');
      history.push({ type: 'message', message: { role: 'toolResult', toolName: 'deliver_files', details: second } }); save();
      expect((await download(first.files[0].id)).status).toBe(409);
      expect(await (await download(second.files[0].id)).text()).toBe('second');
      expect((await download()).status).toBe(403);
      expect((await download(second.files[0].id, 'session-other')).status).toBe(403);
      expect((await download(second.files[0].id, 'session-1', '.hedgehog/artifact-manifest.json')).status).toBe(403);
      rmSync(join(root, 'report.txt')); writeFileSync(join(workspace, 'report.txt'), 'wrong root');
      expect((await download(second.files[0].id)).status).toBe(404);
    } finally { await server.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  });
});
