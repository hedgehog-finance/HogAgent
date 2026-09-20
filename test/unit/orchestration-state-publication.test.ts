import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidOrchestrationStateError, persistOrchestrationState, readOrchestrationState } from '../../src/long-task-orchestrator.ts';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
const nativeFs = await vi.importActual<typeof import('node:fs')>('node:fs');
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hog-checkpoint-publish-'));
  vi.mocked(renameSync).mockImplementation(nativeFs.renameSync);
});
afterEach(() => nativeFs.rmSync(root, { recursive: true, force: true }));

it('retains the previous complete checkpoint when publication fails, then allows a later checkpoint', () => {
  const initial: Parameters<typeof persistOrchestrationState>[1] = {
    status: 'executing', classification: { optimizedPrompt: 'Compare evidence', complexity: 'complex', skipClarification: true, goals: [], acceptanceCriteria: [] },
    steps: [], groups: [], completedGroupIds: [], currentGroupIdx: 0, maxIterations: 1,
    userClarificationAnswer: 'Keep this answer', groupFilesMapData: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  persistOrchestrationState(root, initial);
  const before = readFileSync(join(root, 'orchestration-state.json'), 'utf8');
  vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('Simulated publish failure'), { code: 'ENOSPC' }); });
  const next = { ...initial, userClarificationAnswer: 'New complete answer' };
  expect(() => persistOrchestrationState(root, next)).not.toThrow();
  expect(readFileSync(join(root, 'orchestration-state.json'), 'utf8')).toBe(before);
  expect(readdirSync(root)).toEqual(['orchestration-state.json']);
  persistOrchestrationState(root, next);
  expect(readOrchestrationState(root)?.userClarificationAnswer).toBe('New complete answer');
});

function persistedState() {
  const step = { id: 'step_1', description: 'work' };
  return {
    status: 'executing',
    classification: { optimizedPrompt: 'Compare evidence', complexity: 'complex', skipClarification: true, goals: [], acceptanceCriteria: [] },
    steps: [step], groups: [{ id: 'group_1', steps: [step] }], completedGroupIds: ['group_1'],
    currentGroupIdx: 1, maxIterations: 2, userClarificationAnswer: '', groupFilesMapData: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

it('normalizes legacy checkpoints that predate cursor, retry, and tracker fields', () => {
  const legacy: Record<string, unknown> = persistedState();
  delete legacy.currentGroupIdx;
  delete legacy.maxIterations;
  delete legacy.groupFilesMapData;
  writeFileSync(join(root, 'orchestration-state.json'), JSON.stringify(legacy));
  expect(readOrchestrationState(root)).toMatchObject({
    currentGroupIdx: 1, maxIterations: 2, groupFilesMapData: {}, replyTrackerData: {}, notesTrackerData: {},
  });
});

it.each([
  ['negative retries', (state: any) => { state.maxIterations = -1; }],
  ['fractional retries', (state: any) => { state.maxIterations = 1.5; }],
  ['unsafe retries', (state: any) => { state.maxIterations = Number.MAX_SAFE_INTEGER + 1; }],
  ['cursor overflow', (state: any) => { state.currentGroupIdx = 2; }],
  ['invalid groups', (state: any) => { state.groups = {}; }],
  ['blank step description', (state: any) => { state.steps[0].description = ' '; }],
  ['mismatched grouped step', (state: any) => { state.groups[0].steps = [{ ...state.steps[0], description: 'different work' }]; }],
  ['duplicate completed group', (state: any) => { state.completedGroupIds.push('group_1'); }],
  ['invalid tracker', (state: any) => { state.groupFilesMapData = { group_1: 'file.txt' }; }],
  ['unknown tracker group', (state: any) => { state.replyTrackerData = { other_group: 'injected result' }; }],
  ['invalid delivery decision', (state: any) => { state.deliveryDecision = { mode: 'selected_files', files: [{ path: '../secret' }] }; }],
])('rejects structurally dangerous checkpoints: %s', (_label, mutate) => {
  const state = persistedState();
  mutate(state);
  writeFileSync(join(root, 'orchestration-state.json'), JSON.stringify(state));
  expect(() => readOrchestrationState(root)).toThrow(InvalidOrchestrationStateError);
});

it('keeps malformed JSON on the existing absent-state path', () => {
  writeFileSync(join(root, 'orchestration-state.json'), '{invalid');
  expect(readOrchestrationState(root)).toBeNull();
});
