import { afterEach, expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('checks and regenerates contracts in a checkout with no sibling projects', () => {
  const root = mkdtempSync(join(tmpdir(), 'hogagent-standalone-build-'));
  roots.push(root);
  for (const dir of ['scripts', 'src/protocol', 'src/artifacts']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['contracts', 'scripts/generate-contracts.mjs', 'src/protocol/generated-contracts.ts', 'src/artifacts/artifact-file-facts.ts']) {
    cpSync(file, join(root, file), { recursive: true });
  }
  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/generate-contracts.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const first = run('--check');
  expect(first.status, first.stderr).toBe(0);
  const generated = join(root, 'src/protocol/generated-contracts.ts');
  const expected = readFileSync(generated, 'utf8');
  writeFileSync(generated, '// stale\n');
  expect(run('--check').status).not.toBe(0);
  expect(run().status).toBe(0);
  expect(readFileSync(generated, 'utf8')).toBe(expected);
  expect(run('--check').status).toBe(0);
});

it('initializes standalone workspace rules using only HogAgent modules, without any Gateway files', () => {
  const root = mkdtempSync(join(tmpdir(), 'hogagent-standalone-rules-'));
  roots.push(root);
  for (const file of ['workspace-instructions.ts', 'standalone-agents-template.ts']) {
    cpSync(join('src', file), join(root, file));
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import { ensureStandaloneAgents } from './workspace-instructions.ts'; ensureStandaloneAgents('./workspace');"], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOGAGENT_GATEWAY_MANAGED: '' },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(root, 'workspace', 'AGENTS.md'), 'utf8')).toContain('# HogAgent Workspace Rules');
});
