import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beginInstructionSnapshot, endInstructionSnapshot, getInstructionSnapshot, buildInstructionPrompt } from '../../src/instruction-snapshot.ts';
import { withInstructionScope, getInstructionScope } from '../../src/instruction-scope.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { endInstructionSnapshot(root); rmSync(root, { recursive: true, force: true }); } vi.unstubAllEnvs(); });
describe('instruction execution snapshots', () => {
  it('loads root then supplement, shares a fixed snapshot and refreshes on the next boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'hog-instructions-')); roots.push(root);
    vi.stubEnv('HOGAGENT_GATEWAY_MANAGED', '1');
    vi.stubEnv('HOGAGENT_GATEWAY_PROCESS_INSTRUCTIONS', JSON.stringify(['process-v1']));
    mkdirSync(join(root, '.hogagent')); writeFileSync(join(root, 'AGENTS.md'), 'common'); writeFileSync(join(root, '.hogagent/hogagent.md'), 'additional');
    beginInstructionSnapshot(root);
    expect(getInstructionSnapshot(root)).toMatchObject({ workspace: 'common', supplement: 'additional' });
    writeFileSync(join(root, 'AGENTS.md'), 'updated');
    vi.stubEnv('HOGAGENT_GATEWAY_PROCESS_INSTRUCTIONS', JSON.stringify(['process-v2']));
    expect(getInstructionSnapshot(root).workspace).toBe('common');
    expect(buildInstructionPrompt(root)).toContain('process-v1');
    expect(buildInstructionPrompt(root)).not.toContain('process-v2');
    endInstructionSnapshot(root); beginInstructionSnapshot(root);
    expect(getInstructionSnapshot(root).workspace).toBe('updated');
    expect(buildInstructionPrompt(root)).toContain('process-v2');
  });
  it('skips a missing supplement but fails on an unreadable supplement', () => {
    const root = mkdtempSync(join(tmpdir(), 'hog-instructions-')); roots.push(root);
    vi.stubEnv('HOGAGENT_GATEWAY_MANAGED', '1'); writeFileSync(join(root, 'AGENTS.md'), 'common');
    expect(getInstructionSnapshot(root).supplement).toBe('');
    mkdirSync(join(root, '.hogagent/hogagent.md'), { recursive: true });
    expect(() => getInstructionSnapshot(root)).toThrow();
  });
  it('isolates concurrent invocation scopes and restores the parent after failure', async () => {
    const child = withInstructionScope('sub_agent', async () => { await Promise.resolve(); return getInstructionScope(); });
    const plan = withInstructionScope('planning', async () => { await Promise.resolve(); expect(getInstructionScope()).toBe('planning'); throw new Error('fixture'); });
    expect(await child).toBe('sub_agent');
    await expect(plan).rejects.toThrow('fixture');
    expect(getInstructionScope()).toBe('main');
  });
});
