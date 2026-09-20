import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt } from '../../src/system-prompt.ts';
import { beginInstructionSnapshot, endInstructionSnapshot } from '../../src/instruction-snapshot.ts';
import { getInstructionScope } from '../../src/instruction-scope.ts';
import { RuntimeContextManager } from '../../src/runtime-context.ts';
import { resetAllModuleState } from '../../src/agent-state.ts';
import { clearPendingOrchestration, executeLongTask, resumeOrchestrationWithUserAnswer, resumeInterruptedOrchestration, readOrchestrationState, type LongTaskDeps } from '../../src/long-task-orchestrator.ts';
import type { AssistantMessage } from '../../src/vendor/ai/types.ts';
import type { AuditClassification } from '../../src/utils/types.ts';

const audit = vi.hoisted(() => vi.fn());
vi.mock('../../src/audit-classifier.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/audit-classifier.ts')>(), auditScore: audit,
}));
const classification: AuditClassification = { optimizedPrompt: 'Compare the evidence in text; no files', complexity: 'complex', skipClarification: true, goals: [], acceptanceCriteria: [] };
const plan = JSON.stringify([1, 2].map(n => ({ id: `step_${n}`, group: `group_${n}`, description: `Compare evidence ${n}` })));
const reply = (text: string): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }) as AssistantMessage;
const groupReply = (id: string) => reply(JSON.stringify({ schema_version: '1.0', type: 'long_task_group_result', summary: id, content: `evidence-${id}`, output_files: [], notes_for_next_group: '' }));

describe('Long Task instruction and automation boundaries', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hog-long-prompt-'));
    mkdirSync(join(root, '.hogagent'));
    writeFileSync(join(root, 'AGENTS.md'), 'common-rules-v1');
    writeFileSync(join(root, '.hogagent/hogagent.md'), 'hog-supplement-v1');
    vi.stubEnv('HOGAGENT_GATEWAY_MANAGED', '1');
    vi.stubEnv('HOGAGENT_GATEWAY_PROCESS_INSTRUCTIONS', JSON.stringify(['process-rules-v1']));
    beginInstructionSnapshot(root);
    audit.mockReset().mockResolvedValue({ passed: true, score: 90, feedback: 'core goal met', retryFrom: null });
  });
  afterEach(() => {
    clearPendingOrchestration(); resetAllModuleState(); endInstructionSnapshot(root);
    rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
  });

  function setup(failFirstGroup = false) {
    let activeTools = ['read', 'write', 'bash'];
    const prompts: Array<{ text: string; system: string; scope: string }> = [];
    const runtime = new RuntimeContextManager({ workspaceDir: root, mode: 'rpc' });
    runtime.bindSession('session', root);
    runtime.beginPromptRun({ schema_version: '1.0', attributes: { policy_revision: 'run-v1' } });
    const mainHarness = {
      getActiveTools: () => activeTools.map(name => ({ name })),
      setActiveTools: vi.fn(async (names: string[]) => { activeTools = names; }),
      setResources: vi.fn(async () => {}),
      prompt: vi.fn(async (text: string) => {
        const scope = getInstructionScope();
        prompts.push({ text, scope, system: buildSystemPrompt({ workspaceDir: root, sessionTaskDir: root, model: {} as any, skills: [], activeTools: activeTools.map(name => ({ name })) as any, currentMode: 'long_task', runtimeContext: runtime.getSnapshot() }) });
        if (scope === 'planning') {
          writeFileSync(join(root, 'AGENTS.md'), 'common-rules-v2');
          vi.stubEnv('HOGAGENT_GATEWAY_PROCESS_INSTRUCTIONS', JSON.stringify(['process-rules-v2']));
          return reply(plan);
        }
        if (scope === 'long_task_group') {
          const id = text.includes('Current Step Group to Execute: group_1') ? 'group_1' : 'group_2';
          if (failFirstGroup && id === 'group_1') throw new Error('group execution unavailable');
          return groupReply(id);
        }
        return reply('Summary\n{"schema_version":"1.0","type":"delivery_decision","mode":"none"}');
      }),
    };
    const deps = { mainHarness, workspaceDir: root, sessionTaskDir: root, allTools: [], allSkills: [], auditConfig: { maxIterations: 0 }, emitEvent: vi.fn(), ensureContextCapacity: vi.fn(async () => {}), runtimeContext: runtime.getSnapshot() } as unknown as LongTaskDeps;
    return { deps, prompts, mainHarness };
  }

  it('keeps a fixed snapshot through planning/groups and returns to main scope for tool-free completion', async () => {
    const { deps, prompts } = setup();
    await executeLongTask(classification, deps);
    expect(prompts.map(p => p.scope)).toEqual(['planning', 'long_task_group', 'long_task_group', 'main']);
    for (const prompt of prompts) {
      expect(prompt.system).toContain('common-rules-v1');
      expect(prompt.system).toContain('hog-supplement-v1');
      expect(prompt.system).toContain('process-rules-v1');
      expect(prompt.system).not.toContain('common-rules-v2');
      expect(prompt.system).not.toContain('process-rules-v2');
      expect(prompt.system).toContain(`<invocation_scope name="${prompt.scope}">`);
    }
    expect(prompts[0].system).not.toContain('<self_evolution>');
    expect(prompts[0].system).not.toContain('**Skill CLI parameters**');
    expect(prompts[1].text).toContain('Text-only results may be returned in content');
    expect(prompts[3].system).toContain('Available tools for this invocation: none');
    expect(prompts[3].text).toContain('evidence-group_1');
    expect(prompts[3].text).toContain('evidence-group_2');
    const finalAudit = audit.mock.calls.find(call => call[0] === 'final')!;
    expect(finalAudit[6].lastLlmReply).toContain('evidence-group_1');
    expect(finalAudit[6].lastLlmReply).toContain('evidence-group_2');
    expect(finalAudit[6].runtimeContext).toBe(deps.runtimeContext);
  });

  it('reports an unfinished group honestly but lets the lenient audit judge whether the core goal was achieved', async () => {
    const { deps, prompts } = setup(true);
    await executeLongTask(classification, deps);
    const finalAudit = audit.mock.calls.find(call => call[0] === 'final')!;
    expect(finalAudit[6].lastLlmReply).toContain('group_1: NOT completed');
    expect(finalAudit[6].lastLlmReply).toContain('group_2: executed');
    expect(finalAudit[6].results).not.toContain('steps have been executed');
    expect(prompts.at(-1)!.text).toContain('passed final audit');
    expect(prompts.at(-1)!.text).toContain('group_1: NOT completed');
  });

  it('refreshes pending clarification dependencies at the next run boundary', async () => {
    const { deps, mainHarness } = setup();
    mainHarness.prompt.mockResolvedValueOnce(reply('[ASK_USER]\nWhich evidence?'));
    await executeLongTask({ ...classification, skipClarification: false }, deps);
    const currentDeps = { ...deps, runtimeContext: { ...deps.runtimeContext!, current_run: { ...deps.runtimeContext!.current_run!, attributes: { policy_revision: 'run-v2' } } } };
    await expect(resumeOrchestrationWithUserAnswer('Use the supplied evidence', { ...currentDeps, projectDir: join(root, 'another-project') })).rejects.toThrow('another execution context');
    await resumeOrchestrationWithUserAnswer('Use the supplied evidence', currentDeps);
    expect(audit.mock.calls.every(call => call[6].runtimeContext === currentDeps.runtimeContext)).toBe(true);
    expect(audit).toHaveBeenCalled();
  });

  it('does not retain the group being redone as completed when earlier execution history is sparse', async () => {
    const { deps, mainHarness, prompts } = setup(true);
    deps.auditConfig.maxIterations = 1;
    audit.mockResolvedValueOnce({ passed: false, score: 40, feedback: 'core evidence missing', retryFrom: 'group_2' });
    const originalPrompt = mainHarness.prompt.getMockImplementation()!;
    let asked = false;
    mainHarness.prompt.mockImplementation(async text => {
      if (!asked && text.includes('retry #1')) { asked = true; return reply('[ASK_USER]\nWhich source?'); }
      return originalPrompt(text);
    });
    await executeLongTask({ ...classification, skipClarification: false }, deps);
    expect(asked).toBe(true);
    await resumeOrchestrationWithUserAnswer('Use the original source', deps);
    const resumed = prompts.filter(prompt => prompt.text.includes('Current Step Group to Execute: group_2')).at(-1)!;
    expect(resumed.text).toContain('## Completed Work\n(None)');
  });

  it('uses the latest checkpoint feedback for every subsequent retry', async () => {
    const { deps, prompts } = setup();
    deps.auditConfig.maxIterations = 2;
    audit.mockResolvedValueOnce({ passed: false, score: 40, feedback: 'FIRST_FIX', retryFrom: 'group_1' })
      .mockResolvedValueOnce({ passed: false, score: 60, feedback: 'SECOND_FIX', retryFrom: 'group_1' });
    await executeLongTask(classification, deps);
    const secondRetry = prompts.find(p => p.text.includes('retry #2'))!;
    expect(secondRetry.text).toContain('Feedback: SECOND_FIX');
    expect(secondRetry.text).not.toContain('Feedback: FIRST_FIX');
  });

  it('preserves multiple planning clarifications through execution, persistence, audit and summary', async () => {
    const { deps, mainHarness, prompts } = setup();
    const persisted: string[] = [];
    audit.mockImplementation(async () => {
      persisted.push(readOrchestrationState(root)!.userClarificationAnswer);
      return { passed: true, score: 90, feedback: 'complete', retryFrom: null };
    });
    mainHarness.prompt.mockResolvedValueOnce(reply('[ASK_USER]\nWhich company?'))
      .mockResolvedValueOnce(reply('[ASK_USER]\nWhich period?'));
    await executeLongTask({ ...classification, skipClarification: false }, deps);
    await resumeOrchestrationWithUserAnswer('COMPANY_A', deps);
    await resumeOrchestrationWithUserAnswer('PERIOD_2025', deps);
    for (const marker of ['COMPANY_A', 'PERIOD_2025']) {
      for (const prompt of prompts.filter(p => p.scope !== 'planning')) expect(prompt.text).toContain(marker);
      expect(audit.mock.calls.every(call => call[6].plan.includes(marker))).toBe(true);
      expect(persisted.every(answer => answer.includes(marker))).toBe(true);
    }
    expect(persisted.length).toBeGreaterThan(0);
  });

  it('passes final-audit findings into the group being redone without carrying obsolete findings forward', async () => {
    const { deps, prompts } = setup();
    deps.auditConfig.maxIterations = 2;
    let finalCount = 0;
    audit.mockImplementation(async phase => {
      if (phase === 'final' && ++finalCount <= 2) return { passed: false, score: 40, feedback: `FINAL_FIX_${finalCount}`, retryFrom: 'group_2' };
      return { passed: true, score: 90, feedback: 'complete', retryFrom: null };
    });
    await executeLongTask(classification, deps);
    const groups = prompts.filter(p => p.text.includes('Current Step Group to Execute: group_2'));
    expect(groups).toHaveLength(3);
    expect(groups[1].text).toContain('FINAL_FIX_1');
    expect(groups[2].text).toContain('FINAL_FIX_2');
    expect(groups[2].text).not.toContain('FINAL_FIX_1');
  });

  it('audits the corrected response and removes superseded cross-group notes', async () => {
    const { deps, mainHarness, prompts } = setup();
    deps.auditConfig.maxIterations = 1;
    const original = mainHarness.prompt.getMockImplementation()!;
    let initial = true;
    mainHarness.prompt.mockImplementation(async text => {
      if (text.includes('Current Step Group to Execute: group_1')) {
        if (initial) { initial = false; return reply(JSON.stringify({ schema_version: '1.0', type: 'long_task_group_result', summary: 'old', content: 'old', output_files: [], notes_for_next_group: 'OBSOLETE_NOTES' })); }
        return reply('I will correct the output format.');
      }
      if (text.includes('previous response did not include')) return reply('CORRECTED_EVIDENCE\n' + JSON.stringify({ schema_version: '1.0', type: 'long_task_group_result', summary: 'corrected', content: '', output_files: [], notes_for_next_group: '' }));
      return original(text);
    });
    audit.mockResolvedValueOnce({ passed: false, score: 40, feedback: 'fix evidence', retryFrom: 'group_1' });
    await executeLongTask(classification, deps);
    expect(audit.mock.calls[1][6].lastLlmReply).toBe('CORRECTED_EVIDENCE');
    const nextGroup = prompts.find(p => p.text.includes('Current Step Group to Execute: group_2'))!;
    expect(nextGroup.text).not.toContain('OBSOLETE_NOTES');
    expect(nextGroup.text).toContain('CORRECTED_EVIDENCE');
  });

  it('persists accumulated planning answers when another clarification suspends the process', async () => {
    const { deps, mainHarness, prompts } = setup();
    mainHarness.prompt.mockResolvedValueOnce(reply('[ASK_USER]\nWhich company?')).mockResolvedValueOnce(reply('[ASK_USER]\nWhich period?'));
    await executeLongTask({ ...classification, skipClarification: false }, deps);
    await resumeOrchestrationWithUserAnswer('COMPANY_A', deps);
    expect(readOrchestrationState(root)?.userClarificationAnswer).toContain('COMPANY_A');
    const saved = readOrchestrationState(root)!;
    clearPendingOrchestration(); resetAllModuleState();
    await resumeInterruptedOrchestration(saved, deps, undefined, 'PERIOD_2025');
    for (const marker of ['COMPANY_A', 'PERIOD_2025']) {
      expect(prompts.at(-1)!.text).toContain(marker);
      expect(audit.mock.calls.at(-1)![6].plan).toContain(marker);
    }
  });

  it('restores group notes and consumes the current clarification after a process restart', async () => {
    const { deps, mainHarness, prompts } = setup();
    const original = mainHarness.prompt.getMockImplementation()!;
    mainHarness.prompt.mockImplementation(async text => {
      if (text.includes('Current Step Group to Execute: group_1')) return reply(JSON.stringify({ schema_version: '1.0', type: 'long_task_group_result', summary: 'done', content: 'source', output_files: [], notes_for_next_group: 'USE_COLUMN_NET_PROFIT' }));
      if (text.includes('Current Step Group to Execute: group_2')) return reply('[ASK_USER]\nWhich currency?');
      return original(text);
    });
    await executeLongTask({ ...classification, skipClarification: false }, deps);
    const saved = readOrchestrationState(root)!;
    clearPendingOrchestration(); resetAllModuleState();
    mainHarness.prompt.mockImplementation(original);
    await resumeInterruptedOrchestration(saved, deps, undefined, 'CURRENCY_CNY');
    const resumed = prompts.filter(p => p.text.includes('Current Step Group to Execute: group_2')).at(-1)!;
    expect(resumed.text).toContain('USE_COLUMN_NET_PROFIT');
    expect(resumed.text).toContain('CURRENCY_CNY');
    expect(audit.mock.calls.at(-1)![6].plan).toContain('CURRENCY_CNY');
  });
  it('retains the completed checkpoint after resumed execution until outer delivery finalization', async () => {
    const { deps } = setup();
    await executeLongTask(classification, deps);
    const checkpoint = { ...readOrchestrationState(root)!, status: 'executing' as const };
    writeFileSync(join(root, 'orchestration-state.json'), JSON.stringify(checkpoint));
    await resumeInterruptedOrchestration(checkpoint, deps);
    expect(readOrchestrationState(root)).toMatchObject({ status: 'completed', deliveryDecision: { mode: 'none' } });
  });

  it.each(['deliverables', 'raw_data', 'selected_files'] as const)('emits the recovery decision for a historical %s selection', async mode => {
    const { deps } = setup();
    await executeLongTask(classification, deps);
    const checkpoint = readOrchestrationState(root)!;
    checkpoint.deliveryDecision = { schema_version: '1.0', type: 'delivery_decision', mode, ...(mode === 'selected_files' ? { files: [] } : {}) };
    const emitEvent = vi.fn();
    await resumeInterruptedOrchestration(checkpoint, { ...deps, emitEvent });
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_end', delivery_decision: { schema_version: '1.0', type: 'delivery_decision', mode: 'none' } }));
  });

  it('resumes a completed checkpoint without calling planning, groups, audit or final-summary models', async () => {
    const { deps, mainHarness } = setup();
    await executeLongTask(classification, deps);
    const checkpoint = readOrchestrationState(root)!;
    expect(checkpoint.status).toBe('completed');
    expect(checkpoint.deliveryDecision?.mode).toBe('none');
    mainHarness.prompt.mockClear(); audit.mockClear();
    await resumeInterruptedOrchestration(checkpoint, deps);
    expect(mainHarness.prompt).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
    await expect(resumeInterruptedOrchestration({ ...checkpoint, artifactIdentity: { ...checkpoint.artifactIdentity!, owner: 'gateway' } }, deps)).rejects.toThrow('identity mismatch');
  });

});
