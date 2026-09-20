import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beginInstructionSnapshot, endInstructionSnapshot } from '../../src/instruction-snapshot.ts';
import { RuntimeContextManager } from '../../src/runtime-context.ts';

const scenario = vi.hoisted(() => ({
  mode: 'scored', options: undefined as any, harness: undefined as any, classificationPrompt: '', auditRequest: '',
  streamSignal: undefined as AbortSignal | undefined, classificationPayload: undefined as Record<string, unknown> | undefined,
}));
vi.mock('../../src/vendor/ai/stream.ts', () => ({
  streamSimple: (_model: unknown, context: { systemPrompt: string }, options?: { signal?: AbortSignal }) => {
    scenario.classificationPrompt = context.systemPrompt;
    scenario.streamSignal = options?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        if (scenario.mode === 'classification-timeout') await new Promise(() => {});
        if (scenario.mode === 'classification-abort-aware') {
          await new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true }));
        }
        if (scenario.mode === 'classification-error') {
          yield { type: 'error', reason: 'error', error: { errorMessage: 'service unavailable', usage: { input: 3, output: 2 } } };
          return;
        }
        yield { type: 'text_delta', delta: JSON.stringify(scenario.classificationPayload
          ?? { optimizedPrompt: 'Compare evidence in text', complexity: 'complex', skipClarification: true, goals: [], acceptanceCriteria: [] }) };
      },
      result: async () => ({ usage: {} }),
    };
  },
}));
vi.mock('../../src/vendor/agent/harness/agent-harness.ts', () => ({
  AgentHarness: class {
    listeners: Array<(event: any) => void> = [];
    private options: any;
    constructor(options: any) { this.options = options; scenario.options = options; scenario.harness = this; }
    on() { return () => {}; }
    subscribe(listener: (event: any) => void) { this.listeners.push(listener); return () => {}; }
    async abort() {}
    async prompt(text: string) {
      scenario.auditRequest = text;
      if (scenario.mode === 'error') return { stopReason: 'error', errorMessage: 'service unavailable' };
      if (scenario.mode === 'key') throw new Error('401 Invalid API key');
      if (scenario.mode === 'turn-limit') {
        for (let turn = 0; turn < 101; turn++) this.listeners.forEach(listener => listener({ type: 'turn_start' }));
        return { stopReason: 'stop' };
      }
      if (scenario.mode === 'timeout') return new Promise(() => {});
      await this.options.tools.find((tool: any) => tool.name === 'submit_score').execute('score', {
        score: scenario.mode === 'failed' ? 40 : 90, passed: scenario.mode !== 'failed', feedback: 'verified fixture', retryFrom: 'group_1',
      });
      return { stopReason: 'stop' };
    }
  },
}));

import { abortActiveAuditHarness, auditScore, classifyIntent } from '../../src/audit-classifier.ts';
import { resetAllModuleState, setMainTurnStarted } from '../../src/agent-state.ts';
import { createReadTool } from '../../src/tools/builtin-tools.ts';
import { OrchestrationAbortedError } from '../../src/utils/llm-error.ts';

describe('audit verification status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    scenario.mode = 'scored';
    scenario.classificationPayload = undefined;
    scenario.streamSignal = undefined;
    resetAllModuleState();
  });
  afterEach(() => { vi.useRealTimers(); resetAllModuleState(); });

  it('retains provider-reported usage when intent classification fails before stream.result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hog-classification-usage-'));
    scenario.mode = 'classification-error';
    const events: any[] = [];
    try {
      const tracking = { sessionId: 'original-session', taskId: 'original-task', workId: 'original-work' };
      const pending = classifyIntent({} as any, 'fixture', 'hello', root, {} as any, event => events.push(event), [], root, tracking);
      Object.assign(tracking, { sessionId: 'next-session', taskId: 'next-task' });
      await pending;
      expect(events.filter(event => event.source === 'audit')).toEqual([
        expect.objectContaining({ session_id: 'original-session', task_id: 'original-task', work_id: 'original-work',
          usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } }),
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('bounds classification and falls back to the original request when the provider ignores abort', async () => {
    const events: any[] = [];
    scenario.mode = 'classification-timeout';
    const pending = classifyIntent({} as any, 'fixture', 'original request', '/unused', {} as any, event => events.push(event));
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toMatchObject({ optimizedPrompt: 'original request', complexity: 'simple' });
    expect(scenario.streamSignal?.aborted).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'warning', message: expect.stringContaining('timed out after 60s') }));
  });

  it('does not register a classification timer before synchronous prompt setup succeeds', async () => {
    setMainTurnStarted(true);
    await expect(classifyIntent(
      {} as any,
      'fixture',
      'original request',
      '/unused',
      {} as any,
      () => { throw new Error('event sink unavailable'); },
    )).rejects.toThrow('event sink unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['classification-timeout', 'classification-abort-aware'])('cancels classification immediately instead of degrading an explicit user abort (%s)', async mode => {
    scenario.mode = mode;
    const pending = classifyIntent({} as any, 'fixture', 'original request', '/unused', {} as any);
    abortActiveAuditHarness();
    await expect(pending).rejects.toBeInstanceOf(OrchestrationAbortedError);
    expect(scenario.streamSignal?.aborted).toBe(true);
  });

  it('keeps only non-empty strings from classification arrays', async () => {
    scenario.classificationPayload = {
      optimizedPrompt: 'normalized', complexity: 'complex', skipClarification: false,
      goals: ['goal', 42, '', null], acceptanceCriteria: ['criterion', {}], clarificationQuestions: [false, 'question'],
    };
    await expect(classifyIntent({} as any, 'fixture', 'original', '/unused', {} as any)).resolves.toMatchObject({
      goals: ['goal'], acceptanceCriteria: ['criterion'], clarificationQuestions: ['question'],
    });
  });

  it('records audit requests before and after timeout once, with the original accounting owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hog-audit-usage-'));
    const tracking = { sessionId: 'original-session', taskId: 'original-task', workId: 'original-work' };
    const events: any[] = [];
    scenario.mode = 'timeout';
    try {
      const pending = auditScore('final', {} as any, { apiKey: 'fixture', minPassScore: 70 } as any,
        {} as any, [], [], { goals: [], criteria: [], results: '', plan: '', sessionTaskDir: root,
          workspaceDir: root, lastLlmReply: '', fileListContent: '(none)' }, event => events.push(event), tracking);
      const report = () => scenario.harness.listeners.forEach((listener: any) => listener({
        type: 'message_end', message: { role: 'assistant', usage: { input: 7, output: 3, totalTokens: 10 } },
      }));
      report();
      expect(events.filter(event => event.source === 'audit')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(180_000);
      expect((await pending).skipped).toBe(true);
      Object.assign(tracking, { sessionId: 'next-session', taskId: 'next-task' });
      report();
      const usages = events.filter(event => event.source === 'audit');
      expect(usages).toHaveLength(2);
      for (const event of usages) expect(event).toMatchObject({ session_id: 'original-session', task_id: 'original-task', work_id: 'original-work', usage: { totalTokens: 10 } });
      const records = JSON.parse(readFileSync(join(root, 'audit-usage.json'), 'utf8'));
      expect(records.reduce((sum: number, row: any) => sum + row.usage.totalTokens, 0)).toBe(20);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['error', 'key', 'turn-limit', 'timeout', 'scored', 'failed'])('%s preserves a truthful verdict', async mode => {
    scenario.mode = mode;
    const pending = auditScore('final', {} as any, { minPassScore: 70, apiKey: 'fixture' } as any,
      {} as any, [], [], {
        goals: ['fixture'], criteria: ['fixture'], results: 'fixture', plan: 'fixture',
        sessionTaskDir: '/unused', workspaceDir: '/unused', lastLlmReply: '', fileListContent: '(none)',
      });
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(180_000);
    const result = await pending;
    if (mode === 'scored' || mode === 'failed') {
      expect(result.skipped).not.toBe(true);
      expect(result.passed).toBe(mode === 'scored');
      expect(result.score).toBe(mode === 'scored' ? 90 : 40);
    } else {
      expect(result).toMatchObject({ skipped: true, passed: false, score: 0, retryFrom: null });
      expect(result.feedback).toBeTruthy();
    }
  });

  it('never substitutes a different task file when a normalized declaration is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hog-audit-path-'));
    const taskDir = join(root, 'tasks', 'session');
    mkdirSync(join(taskDir, 'tasks', 'session'), { recursive: true });
    writeFileSync(join(taskDir, 'tasks', 'session', 'result.txt'), 'unrelated historical result');
    try {
      scenario.mode = 'scored';
      await auditScore('final', {} as any, { apiKey: 'fixture', minPassScore: 70 } as any, {} as any, [], [], {
        goals: [], criteria: [], results: '', plan: '', sessionTaskDir: taskDir, workspaceDir: root, lastLlmReply: '',
        fileListContent: 'tasks/session/result.txt\ntasks/session',
      });
      expect(scenario.auditRequest).toContain('[MISSING] tasks/session/result.txt');
      expect(scenario.auditRequest).toContain('[UNVERIFIED] tasks/session — not a regular file');
      expect(scenario.auditRequest).not.toContain('[EXISTS]');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('allows only exact declared regular files through the audit read proxy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hog-audit-allowlist-'));
    const outside = mkdtempSync(join(tmpdir(), 'hog-audit-outside-'));
    const declared = join(root, 'declared.txt');
    const sibling = join(root, 'sibling.txt');
    const external = join(outside, 'external.txt');
    const alias = join(root, 'alias.txt');
    const realDir = join(root, 'real-dir');
    const directoryAlias = join(root, 'directory-alias');
    writeFileSync(declared, 'declared content');
    writeFileSync(sibling, 'sibling content');
    writeFileSync(external, 'external content');
    symlinkSync(declared, alias);
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'nested.txt'), 'nested content');
    symlinkSync(realDir, directoryAlias);
    try {
      await auditScore('final', {} as any, { apiKey: 'fixture', minPassScore: 70 } as any, {} as any,
        [createReadTool(root), ...['grep', 'find', 'ls', 'write'].map(name => ({ name }))] as any, [], {
          goals: [], criteria: [], results: '', plan: '', sessionTaskDir: root, workspaceDir: root,
          lastLlmReply: '', fileListContent: `declared.txt\n${external}\nalias.txt\ndirectory-alias/nested.txt`,
        });
      expect(scenario.options.tools.map((tool: any) => tool.name)).toEqual(['read', 'submit_score']);
      expect(scenario.auditRequest).toContain(`[UNVERIFIED] ${external} — outside the current artifact roots`);
      expect(scenario.auditRequest).toContain('[UNVERIFIED] alias.txt — symbolic link aliases are not allowed');
      expect(scenario.auditRequest).toContain('[UNVERIFIED] directory-alias/nested.txt — symbolic link aliases are not allowed');
      const read = scenario.options.tools.find((tool: any) => tool.name === 'read');
      const relative = await read.execute('relative', { path: 'declared.txt' });
      const absolute = await read.execute('absolute', { path: declared });
      expect(relative.content[0].text).toContain('declared content');
      expect(absolute.content[0].text).toContain('declared content');
      for (const path of [sibling, external, alias, root, 'directory-alias/nested.txt']) {
        const denied = await read.execute('denied', { path });
        expect(denied.details).toEqual({ error: 'audit_read_denied' });
      }
      expect((await read.execute('invalid', null)).details).toEqual({ error: 'audit_read_denied' });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('classification and read-only audits inherit frozen rules, run policy and their own output scopes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hog-audit-rules-'));
    vi.stubEnv('HOGAGENT_GATEWAY_MANAGED', '1');
    vi.stubEnv('HOGAGENT_GATEWAY_PROCESS_INSTRUCTIONS', JSON.stringify(['process-frozen']));
    mkdirSync(join(root, '.hogagent'));
    writeFileSync(join(root, 'AGENTS.md'), 'common-frozen');
    writeFileSync(join(root, '.hogagent/hogagent.md'), 'supplement-frozen');
    const runtime = new RuntimeContextManager({ workspaceDir: root, mode: 'rpc' });
    runtime.bindSession('session', root);
    runtime.beginPromptRun({ schema_version: '1.0', attributes: { locked_policy: 'fixture-policy' } });
    try {
      beginInstructionSnapshot(root);
      writeFileSync(join(root, 'AGENTS.md'), 'common-next-run');
      await classifyIntent({} as any, 'fixture', 'Compare evidence', root, {} as any, undefined, [], root, undefined, undefined, runtime.getSnapshot());
      scenario.mode = 'scored';
      await auditScore('final', {} as any, { apiKey: 'fixture', minPassScore: 70 } as any, {} as any,
        ['read', 'write', 'bash', 'memory_save'].map(name => ({ name })) as any, [], {
          goals: [], criteria: [], results: '', plan: '', sessionTaskDir: root, workspaceDir: root, lastLlmReply: '', fileListContent: '(none)', runtimeContext: runtime.getSnapshot(),
        });
      const auditPrompt = scenario.options.systemPrompt();
      for (const prompt of [auditPrompt, scenario.classificationPrompt]) {
        for (const rule of ['common-frozen', 'supplement-frozen', 'process-frozen', 'fixture-policy']) expect(prompt).toContain(rule);
        expect(prompt).not.toContain('common-next-run');
        expect(prompt).toContain('Do not append delivery_decision');
      }
      expect(scenario.classificationPrompt).toContain('<invocation_scope name="classification">');
      expect(scenario.classificationPrompt).toContain('complexity alone never requires files');
      expect(auditPrompt).toContain('<invocation_scope name="audit">');
      expect(auditPrompt).toContain('use lenient, outcome-based judgment');
      expect(auditPrompt).toContain('relative to workspaceDir, never relative to sessionTaskDir/projectDir');
      expect(scenario.auditRequest).toContain(`base for relative declarations): ${root}`);
      expect(scenario.options.tools.map((tool: any) => tool.name)).toEqual(['read', 'submit_score']);
    } finally { endInstructionSnapshot(root); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
  });
});
