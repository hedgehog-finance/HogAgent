import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/audit-classifier.ts", () => ({
  auditScore: vi.fn(async () => ({
    score: 100,
    passed: true,
    feedback: "",
    retryFrom: null,
  })),
}));

import {
  clearPendingOrchestration,
  executeLongTask,
  forceNoFurtherClarification,
  hasPendingOrchestration,
  readOrchestrationState,
  resumeInterruptedOrchestration,
  runOrchestrationTurn,
  resumeOrchestrationWithUserAnswer,
} from "../../src/long-task-orchestrator.ts";
import { auditScore } from "../../src/audit-classifier.ts";
import { isHarnessFinalizationDeferred, isSuppressUserBubble, resetAllModuleState, setAbortRequested } from "../../src/agent-state.ts";
import { ContextCompactionError } from "../../src/compaction-manager.ts";

describe("Long Task recovery cursor", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `hogagent-recovery-cursor-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    vi.mocked(auditScore).mockReset();
    vi.mocked(auditScore).mockResolvedValue({
      score: 100,
      passed: true,
      feedback: "",
      retryFrom: null,
    } as any);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearPendingOrchestration();
    resetAllModuleState();
    rmSync(testDir, { recursive: true, force: true });
  });

  const classification = {
    optimizedPrompt: "Test task",
    goals: ["complete the task"],
    acceptanceCriteria: ["done"],
    complexity: "complex",
    skipClarification: false,
  } as any;

  function makeDeps(prompt: (text: string) => Promise<any>, events: any[] = []) {
    return {
      mainHarness: { getActiveTools: () => [], setActiveTools: () => {}, setResources: () => {}, prompt },
      auditModelObj: { id: "audit-model", provider: "test", api: "openai-completions" },
      auditConfig: { apiKey: "test-key", maxIterations: 1 },
      env: {},
      allTools: [],
      allSkills: [],
      skillsConfig: {},
      emitEvent: (event: any) => events.push(event),
      workspaceDir: testDir,
      sessionTaskDir: testDir,
      llmTracking: {},
      ensureContextCapacity: async () => {},
    } as any;
  }

  it.each(['gateway', 'hogagent'] as const)('retains %s artifact ownership in execution, audit and the final prompt', async owner => {
    vi.stubEnv('HOGAGENT_GATEWAY_MANAGED', owner === 'gateway' ? '1' : '');
    const project = join(testDir, 'project');
    const area = owner === 'gateway' ? 'artifacts' : 'publish';
    const relative = `${area}/final-output-report.md`;
    const output = join(project, relative);
    mkdirSync(join(project, area), { recursive: true });
    mkdirSync(join(project, '.hedgehog'));
    writeFileSync(output, 'report');
    // Old standalone registries must not override the Gateway-owned layout.
    writeFileSync(join(project, '.hedgehog', 'artifact-overrides.json'), JSON.stringify({ [relative]: { role: 'intermediate' } }));
    const prompts: string[] = [];
    const deps = makeDeps(async text => {
      prompts.push(text);
      const reply = text.includes('Current Step Group to Execute')
        ? JSON.stringify({ schema_version: '1.0', type: 'long_task_group_result', summary: 'done', content: 'result', output_files: [output], notes_for_next_group: '' })
        : text.includes('Task Execution Complete') ? 'Delivered'
        : JSON.stringify([{ id: 'step_1', group: 'group_1', description: 'report' }]);
      return { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop' };
    });
    deps.projectDir = project; deps.manifestOwner = owner;
    await executeLongTask({ ...classification, skipClarification: true }, deps);
    const finalAudit = vi.mocked(auditScore).mock.calls.find(([phase]) => phase === 'final');
    expect(finalAudit?.[6].finalOutputCheck?.includes('no current declared')).toBe(owner !== 'gateway');
    const finalPrompt = prompts.find(text => text.includes('Task Execution Complete'))!;
    expect(finalPrompt).toContain(`[${owner === 'gateway' ? 'deliverable' : 'intermediate'}] ${relative}`);
    expect(prompts.find(text => text.includes('Current Step Group to Execute'))).toContain(`${project}/${area}/`);
    expect(JSON.parse(readFileSync(join(project, '.hedgehog', 'artifact-overrides.json'), 'utf8'))[relative].role).toBe('intermediate');
  });

  it.each(["tools", "resources", "abort"])("clears final-summary display flags if preparation fails at %s", async boundary => {
    const prompt = vi.fn();
    const deps = makeDeps(prompt);
    deps.mainHarness.setActiveTools = async () => {
      if (boundary === "tools") throw new Error("tool preparation failed");
    };
    deps.mainHarness.setResources = async () => {
      if (boundary === "resources") throw new Error("resource preparation failed");
      if (boundary === "abort") setAbortRequested(true);
    };
    await expect(resumeInterruptedOrchestration({
      status: "executing", classification, steps: [], groups: [],
      completedGroupIds: [], currentGroupIdx: 0, maxIterations: 0,
      userClarificationAnswer: "", groupFilesMapData: {},
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, deps)).rejects.toThrow();
    expect(prompt).not.toHaveBeenCalled();
    expect(isSuppressUserBubble()).toBe(false);
    expect(isHarnessFinalizationDeferred()).toBe(false);
  });

  it('continues skipped audits without redoing work or claiming verification in the final prompt', async () => {
    writeFileSync(join(testDir, 'mode.json'), JSON.stringify({ mode: 'long_task' }));
    vi.mocked(auditScore).mockResolvedValue({ score: 0, passed: false, skipped: true, feedback: 'Audit timed out', retryFrom: null });
    const prompts: string[] = [];
    const events: any[] = [];
    const deps = makeDeps(async text => {
      prompts.push(text);
      const content = text.includes('Current Step Group to Execute')
        ? JSON.stringify({ schema_version: '1.0', type: 'long_task_group_result', summary: 'done', content: 'fixture result', output_files: [], notes_for_next_group: '' })
        : text.includes('Task Execution Complete') ? 'Results remain unverified'
        : JSON.stringify([{ id: 'step_1', group: 'group_1', description: 'fixture' }]);
      return { role: 'assistant', content: [{ type: 'text', text: content }], stopReason: 'stop' };
    }, events);
    await executeLongTask(classification, deps);
    expect(auditScore).toHaveBeenCalledTimes(2);
    expect(prompts).toHaveLength(3);
    expect(prompts.filter(text => text.includes('Current Step Group to Execute'))).toHaveLength(1);
    const finalPrompt = prompts.find(text => text.includes('Task Execution Complete'))!;
    expect(finalPrompt).toContain('Results remain unverified');
    expect(finalPrompt).toContain('Audit timed out');
    expect(finalPrompt).not.toContain('passed final audit');
    expect(finalPrompt).not.toContain('(0/100)');
    expect(events.some(event => event.delta?.includes('verification skipped'))).toBe(true);
    expect(events.some(event => event.delta?.includes('Final audit passed'))).toBe(false);
    const { auditResults } = JSON.parse(readFileSync(join(testDir, 'mode.json'), 'utf8'));
    expect(auditResults).toHaveLength(2);
    expect(auditResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'checkpoint', skipped: true, passed: false }),
      expect.objectContaining({ phase: 'final', skipped: true, passed: false }),
    ]));
    expect(readOrchestrationState(testDir)).toMatchObject({ status: "completed" }); // Outer finalization owns checkpoint cleanup.
  });

  it("persists the next-group cursor before skipping a failed group", async () => {
    let promptCall = 0;
    const deps = makeDeps(async () => {
      promptCall++;
      if (promptCall === 1) {
        return {
          role: "assistant",
          content: [{
            type: "text",
            text: JSON.stringify([
              { id: "step_1", group: "group_1", description: "first" },
              { id: "step_2", group: "group_2", description: "second" },
            ]),
          }],
          stopReason: "stop",
        };
      }
      if (promptCall === 2) throw new Error("transient group failure");
      return {
        role: "assistant",
        content: [{ type: "text", text: "[ASK_USER]\n1. Continue later?" }],
        stopReason: "stop",
      };
    });

    await executeLongTask(classification, deps);

    const state = readOrchestrationState(testDir);
    expect(state?.status).toBe("clarification_suspended");
    expect(state?.completedGroupIds).toEqual([]);
    expect(state?.currentGroupIdx).toBe(1);
  });

  it.each(["passed", "skipped", "exhausted"])("keeps final-summary recovery after %s audit, without changing lenient delivery", async outcome => {
    vi.mocked(auditScore).mockResolvedValue({
      score: outcome === "passed" ? 100 : 0, passed: outcome === "passed",
      skipped: outcome === "skipped", feedback: "fixture audit result", retryFrom: null,
    });
    const prompts: string[] = [];
    const deps = makeDeps(async text => {
      prompts.push(text);
      if (text.includes("Task Execution Complete")) {
        expect(readOrchestrationState(testDir)?.currentGroupIdx).toBe(1);
        return { role: "assistant", content: [], stopReason: "error", errorMessage: "summary unavailable" };
      }
      const reply = text.includes("Current Step Group to Execute")
        ? { schema_version: "1.0", type: "long_task_group_result", summary: "done", content: "result", output_files: [], notes_for_next_group: "" }
        : [{ id: "step_1", group: "group_1", description: "work" }];
      return { role: "assistant", content: [{ type: "text", text: JSON.stringify(reply) }], stopReason: "stop" };
    });
    // Exhaustion still attempts final delivery even though the audit did not pass.
    deps.auditConfig.maxIterations = 0;
    await expect(executeLongTask(classification, deps)).rejects.toThrow("summary unavailable");
    const checkpoint = readOrchestrationState(testDir)!;
    expect(checkpoint.completedGroupIds).toEqual(["group_1"]);
    expect(prompts.filter(text => text.includes("Task Execution Complete"))).toHaveLength(1);
    const resumePrompts: string[] = [];
    const resumeDeps = makeDeps(async text => {
      resumePrompts.push(text);
      return { role: "assistant", content: [{ type: "text", text: "Delivered" }], stopReason: "stop" };
    });
    await runOrchestrationTurn(resumeDeps, () => resumeInterruptedOrchestration(checkpoint, resumeDeps));
    expect(resumePrompts).toHaveLength(1);
    expect(resumePrompts[0]).toContain("Task Execution Complete");
    expect(readOrchestrationState(testDir)).toBeNull();
  });

  it("prioritizes the persisted cursor when skipped groups are absent from completed IDs", async () => {
    const prompts: string[] = [];
    const mainSequence: string[] = [];
    const events: any[] = [];
    const deps = makeDeps(async (promptText) => {
      mainSequence.push("prompt");
      prompts.push(promptText);
      if (promptText.includes("Current Step Group to Execute")) {
        return {
          role: "assistant",
          content: [{
            type: "text",
            text: '{ "schema_version": "1.0", "type": "long_task_group_result", "summary": "done", "content": "third complete", "output_files": [], "notes_for_next_group": "" }',
          }],
          stopReason: "stop",
        };
      }
      return { role: "assistant", content: [{ type: "text", text: "Delivered" }], stopReason: "stop" };
    }, events);
    deps.ensureContextCapacity = async () => { mainSequence.push("check"); };

    const steps = [
      { id: "step_1", group: "group_1", description: "first" },
      { id: "step_2", group: "group_2", description: "second" },
      { id: "step_3", group: "group_3", description: "third" },
    ];
    await resumeInterruptedOrchestration({
      status: "executing",
      classification,
      steps,
      groups: steps.map((step) => ({ id: step.group, steps: [step] })),
      completedGroupIds: ["group_1"],
      currentGroupIdx: 2,
      maxIterations: 1,
      userClarificationAnswer: "",
      groupFilesMapData: {},
      replyTrackerData: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any, deps);

    const executionPrompts = prompts.filter((prompt) => prompt.includes("Current Step Group to Execute"));
    expect(executionPrompts).toHaveLength(1);
    expect(executionPrompts[0]).toContain("group_3");
    expect(executionPrompts[0]).not.toContain("group_2\n");
    expect(events.some((event) => event.delta?.includes("Executing group 3/3"))).toBe(true);
    expect(mainSequence).toEqual(["check", "prompt", "check", "prompt"]);
  });

  it("injects the continuation directive only into the group the resume starts at", async () => {
    const prompts: string[] = [];
    const deps = makeDeps(async (promptText) => {
      prompts.push(promptText);
      if (promptText.includes("Current Step Group to Execute")) {
        return {
          role: "assistant",
          content: [{
            type: "text",
            text: '{ "schema_version": "1.0", "type": "long_task_group_result", "summary": "done", "content": "group complete", "output_files": [], "notes_for_next_group": "" }',
          }],
          stopReason: "stop",
        };
      }
      return { role: "assistant", content: [{ type: "text", text: "Delivered" }], stopReason: "stop" };
    });

    const steps = [
      { id: "step_1", group: "group_1", description: "first" },
      { id: "step_2", group: "group_2", description: "second" },
      { id: "step_3", group: "group_3", description: "third" },
    ];
    await resumeInterruptedOrchestration({
      status: "executing",
      classification,
      steps,
      groups: steps.map((step) => ({ id: step.group, steps: [step] })),
      completedGroupIds: ["group_1"],
      currentGroupIdx: 1,
      maxIterations: 1,
      userClarificationAnswer: "",
      groupFilesMapData: {},
      replyTrackerData: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any, deps, "[Continue Task]\nAdditional instructions from the user for this continuation:\nkeep chapter 3 short");

    const executionPrompts = prompts.filter((prompt) => prompt.includes("Current Step Group to Execute"));
    expect(executionPrompts).toHaveLength(2);
    expect(executionPrompts[0]).toContain("## Continuation Directive");
    expect(executionPrompts[0]).toContain("keep chapter 3 short");
    // The mandatory JSON block and the language instruction must stay the last
    // things the LLM reads, so the directive is injected above them.
    expect(executionPrompts[0].indexOf("## Continuation Directive")).toBeLessThan(executionPrompts[0].indexOf("## MANDATORY Output Format"));
    // Later groups already see the directive's effect through the resumed group's
    // output; repeating it would keep re-triggering the same instruction.
    expect(executionPrompts[1]).not.toContain("## Continuation Directive");
  });

  it("re-states the continuation directive when the resumed group is redone after a failed checkpoint", async () => {
    // The redo builds a fresh execution prompt; without the directive the redo
    // would overwrite exactly what the user's continuation instruction asked for.
    vi.mocked(auditScore).mockImplementationOnce(async () => ({
      score: 40,
      passed: false,
      feedback: "chapter 3 still too long",
      retryFrom: null,
    }) as any);

    const prompts: string[] = [];
    const deps = makeDeps(async (promptText) => {
      prompts.push(promptText);
      if (promptText.includes("Current Step Group to Execute")) {
        return {
          role: "assistant",
          content: [{
            type: "text",
            text: '{ "schema_version": "1.0", "type": "long_task_group_result", "summary": "done", "content": "group complete", "output_files": [], "notes_for_next_group": "" }',
          }],
          stopReason: "stop",
        };
      }
      return { role: "assistant", content: [{ type: "text", text: "Delivered" }], stopReason: "stop" };
    });

    const steps = [{ id: "step_1", group: "group_1", description: "first" }];
    await resumeInterruptedOrchestration({
      status: "executing",
      classification,
      steps,
      groups: steps.map((step) => ({ id: step.group, steps: [step] })),
      completedGroupIds: [],
      currentGroupIdx: 0,
      maxIterations: 1,
      userClarificationAnswer: "",
      groupFilesMapData: {},
      replyTrackerData: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any, deps, "[Continue Task]\nAdditional instructions from the user for this continuation:\nkeep chapter 3 short");

    const redoPrompts = prompts.filter((prompt) => prompt.includes("Please re-execute group group_1"));
    expect(redoPrompts).toHaveLength(1);
    expect(redoPrompts[0]).toContain("## Continuation Directive");
    expect(redoPrompts[0]).toContain("keep chapter 3 short");
  });

  it("a continuation dispatch resuming a suspended group suppresses further clarification", async () => {
    // "[Continue Task]" while suspended on [ASK_USER] means "stop asking, just
    // execute": the directive must still reach the suspended group's prompt,
    // but no clarification instruction and no further suspension may happen.
    const prompts: string[] = [];
    let groupCalls = 0;
    let planningDone = false;
    const deps = makeDeps(async (promptText) => {
      prompts.push(promptText);
      if (promptText.includes("Current Step Group to Execute")) {
        groupCalls++;
        if (groupCalls === 1) {
          return { role: "assistant", content: [{ type: "text", text: "[ASK_USER]\n1. Which chapter?" }], stopReason: "stop" };
        }
        return {
          role: "assistant",
          content: [{
            type: "text",
            text: '{ "schema_version": "1.0", "type": "long_task_group_result", "summary": "done", "content": "group complete", "output_files": [], "notes_for_next_group": "" }',
          }],
          stopReason: "stop",
        };
      }
      if (!planningDone) {
        planningDone = true;
        return {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify([{ id: "step_1", group: "group_1", description: "first" }]) }],
          stopReason: "stop",
        };
      }
      return { role: "assistant", content: [{ type: "text", text: "Delivered" }], stopReason: "stop" };
    });

    const steps = [{ id: "step_1", group: "group_1", description: "first" }];
    await executeLongTask({ ...classification, skipClarification: false } as any, deps);
    expect(hasPendingOrchestration()).toBe(true);

    forceNoFurtherClarification();
    await resumeOrchestrationWithUserAnswer("[Continuation Directive]\nstop asking and finish the group");

    // Completed instead of suspending again.
    expect(hasPendingOrchestration()).toBe(false);
    const redoPrompt = prompts.find((p) => p.includes("stop asking and finish the group"));
    expect(redoPrompt).toBeDefined();
    // No invitation to ask further questions on the resumed prompt.
    expect(redoPrompt).not.toContain("Asking Clarification Questions");
  });

  it("does not swallow a failed context checkpoint as a skipped group", async () => {
    let promptCalls = 0;
    let checks = 0;
    const events: any[] = [];
    const deps = makeDeps(async () => {
      promptCalls++;
      return {
        role: "assistant",
        content: [{
          type: "text",
          text: JSON.stringify([{ id: "step_1", group: "group_1", description: "first" }]),
        }],
        stopReason: "stop",
      };
    }, events);
    deps.ensureContextCapacity = async () => {
      checks++;
      if (checks === 2) throw new ContextCompactionError("checkpoint failed");
    };

    await expect(executeLongTask({ ...classification, skipClarification: true }, deps))
      .rejects.toBeInstanceOf(ContextCompactionError);
    expect(promptCalls).toBe(1);
    expect(events.some((event) => event.delta?.includes("execution failed"))).toBe(false);
  });

  it("checks capacity before planning, group, structured continuation, and final delivery", async () => {
    const sequence: string[] = [];
    let promptCall = 0;
    const deps = makeDeps(async () => {
      sequence.push("prompt");
      promptCall++;
      if (promptCall === 1) {
        return {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify([
            { id: "step_1", group: "group_1", description: "first" },
          ]) }],
          stopReason: "stop",
        };
      }
      if (promptCall === 2) {
        return { role: "assistant", content: [{ type: "text", text: "work finished" }], stopReason: "stop" };
      }
      if (promptCall === 3) {
        return {
          role: "assistant",
          content: [{ type: "text", text: '{ "schema_version": "1.0", "type": "long_task_group_result", "summary": "done", "content": "ok", "output_files": [], "notes_for_next_group": "" }' }],
          stopReason: "stop",
        };
      }
      return { role: "assistant", content: [{ type: "text", text: "Delivered" }], stopReason: "stop" };
    });
    deps.ensureContextCapacity = async () => { sequence.push("check"); };

    await executeLongTask({ ...classification, skipClarification: true }, deps);

    expect(sequence).toEqual([
      "check", "prompt",
      "check", "prompt",
      "check", "prompt",
      "check", "prompt",
    ]);
  });

  it("does not treat a historical final-output file as this run's primary deliverable", async () => {
    writeFileSync(join(testDir, "final-output-old.md"), "old result");
    let promptCall = 0;
    const deps = makeDeps(async () => {
      promptCall++;
      if (promptCall === 1) {
        return {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify([
            { id: "step_1", group: "group_1", description: "inspect only" },
          ]) }],
          stopReason: "stop",
        };
      }
      if (promptCall === 2) {
        return {
          role: "assistant",
          content: [{
            type: "text",
            text: '{ "schema_version": "1.0", "type": "long_task_group_result", "summary": "done", "content": "no new output", "output_files": [], "notes_for_next_group": "" }',
          }],
          stopReason: "stop",
        };
      }
      return { role: "assistant", content: [{ type: "text", text: "完成" }], stopReason: "stop" };
    });

    await executeLongTask({ ...classification, skipClarification: true }, deps);

    const finalAudit = vi.mocked(auditScore).mock.calls.find(([phase]) => phase === "final");
    expect(finalAudit?.[6]).toMatchObject({
      finalOutputCheck: expect.stringContaining("no current declared managed 'final-output-*'"),
    });
  });

  it("excludes missing or out-of-root group declarations from final audit evidence", async () => {
    let promptCall = 0;
    const deps = makeDeps(async () => {
      promptCall++;
      if (promptCall === 1) {
        return {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify([
            { id: "step_1", group: "group_1", description: "declare invalid paths" },
          ]) }],
          stopReason: "stop",
        };
      }
      if (promptCall === 2) {
        return {
          role: "assistant",
          content: [{
            type: "text",
            text: '{ "schema_version": "1.0", "type": "long_task_group_result", "summary": "done", "content": "no valid output", "output_files": ["missing.md", "../outside.md"], "notes_for_next_group": "" }',
          }],
          stopReason: "stop",
        };
      }
      return { role: "assistant", content: [{ type: "text", text: "完成" }], stopReason: "stop" };
    });

    await executeLongTask({ ...classification, skipClarification: true }, deps);

    const finalAudit = vi.mocked(auditScore).mock.calls.find(([phase]) => phase === "final");
    expect(finalAudit?.[6]).toMatchObject({ fileListContent: "(none)" });
  });
});
