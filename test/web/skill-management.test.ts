import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import WebSocket from 'ws';
import { startWebServer } from '../../src/web/server.ts';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});
const nativeFs = await vi.importActual<typeof import('node:fs')>('node:fs');
beforeEach(() => { vi.mocked(rmSync).mockImplementation(nativeFs.rmSync); });

describe('Skill install directory boundaries', () => {
  it('rejects root-like names and preserves unrelated temporary-looking Skills during ZIP updates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hog-skill-install-'));
    const previousUserDir = process.env.HOGAGENT_USER_DIR;
    process.env.HOGAGENT_USER_DIR = join(root, 'system');
    const workspace = join(root, 'workspace');
    const server = await startWebServer({ port: 0, defaultWorkspace: workspace, hogagentPath: join(root, 'unused.mjs') });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const html = await (await fetch(base)).text();
      const token = html.match(/<meta name="hogagent-web-token" content="([^"]+)">/)![1];
      const authorization = { Authorization: `Bearer ${token}` };
      for (const name of ['.', '..', 'demo.']) {
        const response = await fetch(`${base}/api/skills/install`, {
          method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'git', url: 'https://invalid.example/demo.git', name }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'Invalid skill name' });
      }
      const zip = new JSZip();
      zip.file('SKILL.md', '---\nname: demo\ndescription: Test skill\nversion: 2.0.0\n---\nUpdated skill');
      const bytes = await zip.generateAsync({ type: 'uint8array', platform: 'UNIX' });
      const upload = async (name: string, payload = bytes) => {
        const form = new FormData();
        form.set('file', new Blob([new Uint8Array(payload)]), name);
        return fetch(`${base}/api/skills/install`, { method: 'POST', headers: authorization, body: form });
      };
      expect((await upload('..zip')).status).toBe(400);
      const skills = join(workspace, '.hogagent', 'skills');
      expect((await upload('broken.zip', new TextEncoder().encode('not a zip'))).ok).toBe(false);
      expect(existsSync(join(skills, 'broken'))).toBe(false);
      const wrong = new JSZip(); wrong.file('README.md', 'Missing Skill entry');
      expect((await upload('not-a-skill.zip', await wrong.generateAsync({ type: 'uint8array' }))).ok).toBe(false);
      expect(existsSync(join(skills, 'not-a-skill'))).toBe(false);
      for (const name of ['demo', 'demo.tmp', 'demo.bak']) {
        mkdirSync(join(skills, name), { recursive: true });
        writeFileSync(join(skills, name, 'SKILL.md'), '---\nname: ' + name + '\nversion: 1.0.0\n---\nKeep this');
      }
      const response = await upload('demo.zip');
      expect(response.status).toBe(200);
      expect(readFileSync(join(skills, 'demo', 'SKILL.md'), 'utf8')).toContain('2.0.0');
      for (const name of ['demo.tmp', 'demo.bak']) expect(readFileSync(join(skills, name, 'SKILL.md'), 'utf8')).toContain('Keep this');
      vi.mocked(rmSync).mockImplementation((path, options) => {
        if (String(path).includes('/.upload-')) throw new Error('Simulated ZIP cleanup failure');
        return nativeFs.rmSync(path, options);
      });
      const committed = await upload('cleanup-test.zip');
      expect(committed.status).toBe(200);
      expect(readFileSync(join(skills, 'cleanup-test/SKILL.md'), 'utf8')).toContain('2.0.0');
    } finally {
      await server.shutdown();
      if (previousUserDir === undefined) delete process.env.HOGAGENT_USER_DIR; else process.env.HOGAGENT_USER_DIR = previousUserDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists the long-task flag as a boolean and broadcasts the existing reload command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hog-skill-config-'));
    const previousUserDir = process.env.HOGAGENT_USER_DIR;
    process.env.HOGAGENT_USER_DIR = join(root, 'system');
    const workspace = join(root, 'workspace');
    const mockAgent = join(root, 'mock-agent.mjs');
    writeFileSync(mockAgent, [
      'import { createInterface } from "node:readline";',
      'process.stdout.write(JSON.stringify({type:"ready",session_id:process.argv[5],capabilities:{builtin_tools:[]}})+"\\n");',
      'createInterface({input:process.stdin}).on("line", line => {',
      '  const command = JSON.parse(line);',
      '  if (command.type === "reload_config") process.stdout.write(JSON.stringify({type:"config_reloaded"})+"\\n");',
      '});',
    ].join('\n'));
    const server = await startWebServer({ port: 0, defaultWorkspace: workspace, hogagentPath: mockAgent });
    const base = `http://127.0.0.1:${server.port}`;
    let socket: WebSocket | undefined;
    let secondSocket: WebSocket | undefined;
    try {
      const html = await (await fetch(base)).text();
      const token = html.match(/<meta name="hogagent-web-token" content="([^"]+)">/)![1];
      const authorization = { Authorization: `Bearer ${token}` };
      socket = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${encodeURIComponent(token)}`, { origin: base });
      const received: any[] = [];
      socket.on('message', data => received.push(JSON.parse(String(data))));
      await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });

      const saved = await fetch(`${base}/api/skills/report/config?user=default`, {
        method: 'PUT', headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { isLongTaskSpecific: true } }),
      });
      expect(saved.status).toBe(200);
      await vi.waitFor(() => expect(received.some(message => message.event?.type === 'config_reloaded')).toBe(true));
      expect(JSON.parse(readFileSync(join(root, 'system', 'skills_config.json'), 'utf8')))
        .toEqual({ report: { isLongTaskSpecific: true } });

      const rejected = await fetch(`${base}/api/skills/report/config?user=default`, {
        method: 'PUT', headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { isLongTaskSpecific: 'true' } }),
      });
      expect(rejected.status).toBe(400);
      expect(JSON.parse(readFileSync(join(root, 'system', 'skills_config.json'), 'utf8')))
        .toEqual({ report: { isLongTaskSpecific: true } });

      const malformed = await fetch(`${base}/api/skills/report/config?user=default`, {
        method: 'PUT', headers: { ...authorization, 'Content-Type': 'application/json' },
        body: 'null',
      });
      expect(malformed.status).toBe(400);

      secondSocket = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${encodeURIComponent(token)}`, { origin: base });
      const secondReceived: any[] = [];
      secondSocket.on('message', data => secondReceived.push(JSON.parse(String(data))));
      await new Promise<void>((resolve, reject) => {
        secondSocket!.once('open', resolve);
        secondSocket!.once('error', reject);
      });
      await vi.waitFor(() => expect(server.sessions.size).toBe(2));
      const staleInput = [...server.sessions.values()][0]!.child!.stdin!;
      vi.spyOn(staleInput, 'write').mockImplementationOnce((() => {
        throw new Error('stale child');
      }) as any);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const isolated = await fetch(`${base}/api/skills/report/config?user=default`, {
        method: 'PUT', headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { isLongTaskSpecific: false } }),
      });
      expect(isolated.status).toBe(200);
      await vi.waitFor(() => expect(secondReceived.some(message => message.event?.type === 'config_reloaded')).toBe(true));
      expect(JSON.parse(readFileSync(join(root, 'system', 'skills_config.json'), 'utf8')))
        .toEqual({ report: { isLongTaskSpecific: false } });
    } finally {
      socket?.close();
      secondSocket?.close();
      await server.shutdown();
      if (previousUserDir === undefined) delete process.env.HOGAGENT_USER_DIR; else process.env.HOGAGENT_USER_DIR = previousUserDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
