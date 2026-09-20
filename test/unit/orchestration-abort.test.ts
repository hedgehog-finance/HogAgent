import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { executeLongTask, cleanupAbortedOrchestration, archiveOrchestrationState, hasArchivedOrchestrationState, removeArchivedOrchestrationState, tryRestoreArchivedOrchestration, isTaskContinuationMessage, buildContinuationDirectiveBlock, extractContinuationUserDirective, wrapContinuationDirectiveAsClarification, hasIncompleteOrchestration } from "../../src/long-task-orchestrator.ts";
import { setAbortRequested, isAbortRequested, resetAllModuleState } from "../../src/agent-state.ts";
import { isBenignCompletionError, OrchestrationAbortedError } from "../../src/utils/llm-error.ts";
import { abortActiveAuditHarness } from "../../src/audit-classifier.ts";
import { ContextCompactionError } from "../../src/compaction-manager.ts";

// ─── Unit tests for the Long Task user-abort mechanism ───────────────────────
//
// Background: harness.abort() only cancels the *current* run, but the Long Task
// orchestration loop issues many sequential prompts (planning, groups, audits,
// continuation prompts). A sticky abort flag + OrchestrationAbortedError make
// the loop unwind instead of re-arming.

describe("Abort flag (agent-state)", () => {
  afterEach(() => {
    resetAllModuleState();
  });

  it("defaults to false", () => {
    expect(isAbortRequested()).toBe(false);
  });

  it("setAbortRequested(true) makes isAbortRequested() true", () => {
    setAbortRequested(true);
    expect(isAbortRequested()).toBe(true);
  });

  it("resetAllModuleState clears the flag", () => {
    setAbortRequested(true);
    resetAllModuleState();
    expect(isAbortRequested()).toBe(false);
  });
});

describe("abortActiveAuditHarness", () => {
  it("is a safe no-op when no audit harness is running", () => {
    expect(() => abortActiveAuditHarness()).not.toThrow();
  });
});

describe("Gemini benign completion errors", () => {
  const completedMessage = {
    content: [{ type: "text", text: "Task completed and files delivered." }],
  };

  it("accepts known end-of-turn misfires only after final text", () => {
    expect(isBenignCompletionError(completedMessage, "finishReason: MALFORMED_FUNCTION_CALL")).toBe(true);
    expect(isBenignCompletionError(completedMessage, "finish_reason: UNEXPECTED_TOOL_CALL")).toBe(true);
    expect(isBenignCompletionError({ content: [] }, "finishReason: MALFORMED_FUNCTION_CALL")).toBe(false);
    expect(isBenignCompletionError(completedMessage, "connection reset")).toBe(false);
  });
});

describe("executeLongTask — user abort", () => {
  const testDir = join(tmpdir(), `hogagent-abort-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    setAbortRequested(false);
  });

  afterEach(() => {
    resetAllModuleState();
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeDeps(promptImpl: () => Promise<any>) {
    let promptCalls = 0;
    const mainHarness = {
      getActiveTools: () => [],
      setActiveTools: async () => {},
      setResources: () => {},
      prompt: async () => {
        promptCalls++;
        return promptImpl();
      },
    };
    const deps: any = {
      mainHarness,
      auditModelObj: { id: "audit-model", provider: "test", api: "openai-completions" },
      auditConfig: { apiKey: "test-key", maxIterations: 2 },
      env: {},
      allTools: [],
      allSkills: [],
      skillsConfig: {},
      emitEvent: () => {},
      workspaceDir: testDir,
      sessionTaskDir: testDir,
      llmTracking: {},
      ensureContextCapacity: async () => {},
    };
    return { deps, getPromptCalls: () => promptCalls };
  }

  const classification: any = {
    optimizedPrompt: "Test task",
    goals: ["g1"],
    acceptanceCriteria: ["c1"],
    complexity: "complex",
    skipClarification: true,
  };

  it("throws OrchestrationAbortedError before any prompt when the flag is already set", async () => {
    setAbortRequested(true);
    const { deps, getPromptCalls } = makeDeps(async () => ({ stopReason: "stop" }));
    await expect(executeLongTask(classification, deps)).rejects.toBeInstanceOf(OrchestrationAbortedError);
    expect(getPromptCalls()).toBe(0);
  });

  it("throws OrchestrationAbortedError when the planning prompt returns stopReason aborted", async () => {
    // Simulate: user pressed abort mid-flight — onAbort sets the sticky flag
    // while the prompt is running, and the harness resolves with an aborted placeholder
    const { deps, getPromptCalls } = makeDeps(async () => {
      setAbortRequested(true);
      return {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "aborted",
        errorMessage: "aborted",
      };
    });
    await expect(executeLongTask(classification, deps)).rejects.toBeInstanceOf(OrchestrationAbortedError);
    // Critical: no continuation prompt may follow an aborted response
    expect(getPromptCalls()).toBe(1);
  });

  it("aborted planning is NOT reported as a planning failure (no error event)", async () => {
    const events: any[] = [];
    const { deps } = makeDeps(async () => {
      setAbortRequested(true);
      return {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "aborted",
        errorMessage: "aborted",
      };
    });
    deps.emitEvent = (e: any) => events.push(e);
    await expect(executeLongTask(classification, deps)).rejects.toBeInstanceOf(OrchestrationAbortedError);
    // The abort must surface as OrchestrationAbortedError, not an "error" event
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("rechecks the sticky abort flag after a context-capacity wait", async () => {
    const { deps, getPromptCalls } = makeDeps(async () => ({ stopReason: "stop" }));
    deps.ensureContextCapacity = async () => { setAbortRequested(true); };

    await expect(executeLongTask(classification, deps)).rejects.toBeInstanceOf(OrchestrationAbortedError);
    expect(getPromptCalls()).toBe(0);
  });

  it("propagates a planning checkpoint failure before the first prompt", async () => {
    const { deps, getPromptCalls } = makeDeps(async () => ({ stopReason: "stop" }));
    deps.ensureContextCapacity = async () => {
      throw new ContextCompactionError("planning capacity check failed");
    };

    await expect(executeLongTask(classification, deps)).rejects.toBeInstanceOf(ContextCompactionError);
    expect(getPromptCalls()).toBe(0);
  });

  it("classifies a compaction rejection after sticky abort as orchestration abort", async () => {
    const { deps, getPromptCalls } = makeDeps(async () => ({ stopReason: "stop" }));
    deps.ensureContextCapacity = async () => {
      setAbortRequested(true);
      throw new ContextCompactionError("compaction aborted");
    };

    await expect(executeLongTask(classification, deps)).rejects.toBeInstanceOf(OrchestrationAbortedError);
    expect(getPromptCalls()).toBe(0);
  });
});

// ─── Abort cleanup: user abort vs shutdown abort checkpoint handling ─────────
//
// onPrompt's OrchestrationAbortedError catch delegates checkpoint cleanup to
// cleanupAbortedOrchestration(dir, userRequested). A genuine user abort (sticky
// flag set by onAbort) cancels the task — the persisted checkpoint is ARCHIVED
// (renamed to tmp-orchestration-state.json) so the next message does NOT
// auto-resume it, while an explicit "[Continue Task]" dispatch can still restore
// it. A shutdown-triggered abort (process exit, flag false) must KEEP
// orchestration-state.json so the next startup resumes from the interrupted
// group instead of re-classifying.

describe("cleanupAbortedOrchestration — checkpoint retention", () => {
  const testDir = join(tmpdir(), `hogagent-abort-cleanup-${Date.now()}`);
  const stateFile = join(testDir, "orchestration-state.json");
  const archivedFile = join(testDir, "tmp-orchestration-state.json");

  function writeCheckpoint() {
    const step = { id: "step_1", description: "Test work", group: "group_1" };
    writeFileSync(stateFile, JSON.stringify({
      status: "executing",
      classification: { optimizedPrompt: "Test task", goals: ["g1"], complexity: "complex", skipClarification: true },
      steps: [step],
      groups: [{ id: "group_1", steps: [step] }],
      completedGroupIds: ["group_1"],
      currentGroupIdx: 1,
      maxIterations: 2,
      userClarificationAnswer: "",
      groupFilesMapData: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }), "utf-8");
  }

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    writeCheckpoint();
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("user abort (userRequested=true) archives the checkpoint instead of deleting it", () => {
    cleanupAbortedOrchestration(testDir, true);
    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(archivedFile)).toBe(true);
    // Archived checkpoint must not trigger auto-resume
    expect(hasIncompleteOrchestration(testDir)).toBe(false);
  });

  it("shutdown abort (userRequested=false) preserves the checkpoint file for resume", () => {
    cleanupAbortedOrchestration(testDir, false);
    expect(existsSync(stateFile)).toBe(true);
    expect(existsSync(archivedFile)).toBe(false);
  });

  it("is a safe no-op when no checkpoint exists", () => {
    rmSync(stateFile);
    expect(() => cleanupAbortedOrchestration(testDir, true)).not.toThrow();
    expect(() => cleanupAbortedOrchestration(testDir, false)).not.toThrow();
  });
});

// ─── Archived checkpoint primitives: archive / restore / remove ────────────
//
// A user abort renames orchestration-state.json to tmp-orchestration-state.json.
// The archive is only consumable through tryRestoreArchivedOrchestration, which
// requires the "[Continue Task]" marker (Gateway work/task continue contract).

describe("archived orchestration checkpoint", () => {
  const testDir = join(tmpdir(), `hogagent-archive-test-${Date.now()}`);
  const stateFile = join(testDir, "orchestration-state.json");
  const archivedFile = join(testDir, "tmp-orchestration-state.json");
  const CONTINUE_MSG = "[Continue Task]\nCurrent task: Test";

  function writeCheckpoint() {
    const step = { id: "step_1", description: "Test work", group: "group_1" };
    writeFileSync(stateFile, JSON.stringify({
      status: "executing",
      classification: { optimizedPrompt: "Test task", goals: ["g1"], complexity: "complex", skipClarification: true },
      steps: [step],
      groups: [{ id: "group_1", steps: [step] }],
      completedGroupIds: [],
      currentGroupIdx: 0,
      maxIterations: 2,
      userClarificationAnswer: "",
      groupFilesMapData: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }), "utf-8");
  }

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("archive renames the checkpoint and overwrites a stale archive", () => {
    writeCheckpoint();
    writeFileSync(archivedFile, "stale", "utf-8");
    archiveOrchestrationState(testDir);
    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(archivedFile)).toBe(true);
    expect(hasArchivedOrchestrationState(testDir)).toBe(true);
  });

  it("archive is a safe no-op when no checkpoint exists", () => {
    expect(() => archiveOrchestrationState(testDir)).not.toThrow();
    expect(hasArchivedOrchestrationState(testDir)).toBe(false);
  });

  it("restore fires only for the [Continue Task] marker with an archive present", () => {
    writeCheckpoint();
    archiveOrchestrationState(testDir);

    // No marker — archive untouched
    expect(tryRestoreArchivedOrchestration("hello", testDir)).toBe(false);
    expect(existsSync(archivedFile)).toBe(true);

    // Marker but no archive — nothing to restore
    rmSync(archivedFile);
    expect(tryRestoreArchivedOrchestration(CONTINUE_MSG, testDir)).toBe(false);

    // Marker + archive — renamed back, resume route becomes reachable
    writeCheckpoint();
    archiveOrchestrationState(testDir);
    expect(tryRestoreArchivedOrchestration(CONTINUE_MSG, testDir)).toBe(true);
    expect(existsSync(archivedFile)).toBe(false);
    expect(existsSync(stateFile)).toBe(true);
    expect(hasIncompleteOrchestration(testDir)).toBe(true);
  });

  it("restore tolerates leading whitespace before the marker", () => {
    writeCheckpoint();
    archiveOrchestrationState(testDir);
    expect(tryRestoreArchivedOrchestration(`  ${CONTINUE_MSG}`, testDir)).toBe(true);
    expect(existsSync(stateFile)).toBe(true);
  });

  it("restore keeps a canonical checkpoint and never overwrites it with the archive", () => {
    // A shutdown-preserved canonical file is at least as recent as any archive and the
    // resume route already picks it up — restoring on top of it would lose progress.
    writeCheckpoint();
    archiveOrchestrationState(testDir);
    writeCheckpoint();
    expect(tryRestoreArchivedOrchestration(CONTINUE_MSG, testDir)).toBe(false);
    expect(existsSync(stateFile)).toBe(true);
    expect(existsSync(archivedFile)).toBe(true);
  });

  it("isTaskContinuationMessage recognizes the marker only at the start of the message", () => {
    expect(isTaskContinuationMessage(CONTINUE_MSG)).toBe(true);
    expect(isTaskContinuationMessage(`  ${CONTINUE_MSG}`)).toBe(true);
    expect(isTaskContinuationMessage("Please [Continue Task] now")).toBe(false);
    expect(isTaskContinuationMessage("generate a study plan")).toBe(false);
  });

  it("remove deletes the archive idempotently", () => {
    writeCheckpoint();
    archiveOrchestrationState(testDir);
    removeArchivedOrchestrationState(testDir);
    expect(existsSync(archivedFile)).toBe(false);
    expect(() => removeArchivedOrchestrationState(testDir)).not.toThrow();
  });

  it("buildContinuationDirectiveBlock keeps the dispatch text as an additive directive", () => {
    // The Gateway continuation message never reaches a prompt on the resume path,
    // so its user instructions and validation feedback only survive via this block.
    const block = buildContinuationDirectiveBlock(`${CONTINUE_MSG}\n\nAdditional instructions from the user for this continuation:\nkeep chapter 3 short  `);
    // The caller owns the surrounding blank lines so the block can be embedded
    // mid-prompt, ahead of the mandatory output-format section.
    expect(block.startsWith("## Continuation Directive")).toBe(true);
    expect(block).toContain("never replaces, the group requirements above");
    expect(block).toContain("keep chapter 3 short");
    expect(block.endsWith("keep chapter 3 short")).toBe(true);
  });

  it("buildContinuationDirectiveBlock caps an oversized dispatch", () => {
    // Gateway does not limit the length of the user's continuation message, so one
    // continuation must not be able to crowd out the group requirements.
    const huge = `${CONTINUE_MSG}\n${"paste ".repeat(5000)}`;
    const block = buildContinuationDirectiveBlock(huge);
    expect(block).toContain("(truncated)");
    expect(block.length).toBeLessThan(huge.length);
  });

  it("extractContinuationUserDirective returns only the user's own text", () => {
    // Mirrors the Gateway template (buildTaskContinuationMessage): the label line
    // opens the user's text and the delivery line closes it.
    const dispatch = [
      "[Continue Task]",
      "Current task: quarterly review",
      "This continues a previously interrupted execution — it is NOT a new task. Do not re-plan and do not redo completed work.",
      "",
      "Additional instructions from the user for this continuation:",
      "keep chapter 3 short",
      "and cite the 2025 filing",
      "When done, declare the final delivery decision according to the original runtime policy.",
    ].join("\n");

    expect(extractContinuationUserDirective(dispatch)).toBe("keep chapter 3 short\nand cite the 2025 filing");
  });

  it("extractContinuationUserDirective returns empty when the dispatch carries no user text", () => {
    // Planning-phase resume feeds the result in as the clarification answer, so
    // template-only dispatches must yield nothing rather than their own wording.
    expect(extractContinuationUserDirective(CONTINUE_MSG)).toBe("");
    expect(extractContinuationUserDirective("[Continue Task]\nWhen done, declare the final delivery decision according to the original runtime policy.")).toBe("");
  });

  it("extractContinuationUserDirective survives a payload that repeats the boundary lines", () => {
    // Boundary contract: first label occurrence opens the payload, last trailer
    // occurrence closes it. A user quoting either line must not truncate it.
    const label = "Additional instructions from the user for this continuation:";
    const trailer = "When done, declare the final delivery decision according to the original runtime policy.";
    const payload = `quoting the template: "${label}" and "${trailer}"\nreal ask: keep chapter 3 short`;
    const dispatch = ["[Continue Task]", "Current task: t", "", label, payload, "", trailer].join("\n");

    expect(extractContinuationUserDirective(dispatch)).toBe(payload);
  });

  it("extractContinuationUserDirective keeps the validation feedback paragraph out of the payload", () => {
    // The Gateway template puts validation feedback BEFORE the label; only the
    // user's own paragraph may reach a planning prompt as the clarification answer.
    const dispatch = [
      "[Continue Task]",
      "Current task: t",
      "",
      "This continuation must first fix:",
      "Deliverable \"report\" not found",
      "",
      "Additional instructions from the user for this continuation:",
      "keep chapter 3 short",
      "",
      "When done, declare the final delivery decision according to the original runtime policy.",
    ].join("\n");

    expect(extractContinuationUserDirective(dispatch)).toBe("keep chapter 3 short");
  });

  it("wrapContinuationDirectiveAsClarification never presents the payload as a direct answer", () => {
    // The payload slot also holds automatic Gateway continuation wording, so the
    // planner must be told to weigh it against its own clarification question.
    const wrapped = wrapContinuationDirectiveAsClarification("keep chapter 3 short");
    expect(wrapped).toContain("NOT a direct answer to your clarification question");
    expect(wrapped.endsWith("keep chapter 3 short")).toBe(true);
  });

  it("wrapContinuationDirectiveAsClarification keeps the empty-answer flow untouched", () => {
    expect(wrapContinuationDirectiveAsClarification("")).toBe("");
    expect(wrapContinuationDirectiveAsClarification("   ")).toBe("");
  });
});
