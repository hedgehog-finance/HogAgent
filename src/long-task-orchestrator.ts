import { isDeliveryDecision, parseDeliveryDecision, stripDeliveryDecision } from "./protocol/agent-result-schema.ts";
import { withInstructionScope, type InstructionScope } from "./instruction-scope.ts";
import type { DeepReadonly, RuntimeContextSnapshot } from "./runtime-context.ts";
import { projectDeliverablesDirectory } from "./gateway-project.ts";
/**
 * HogAgent Long Task Orchestrator
 *
 * Implements the mixed dispatch state machine for Long Task mode:
 * 1. Planning: main harness receives optimized prompt + planning instructions → outputs step JSON
 * 2. Grouping: steps are grouped by logical unit (every 2-3 steps or by `group` field)
 * 3. Execution + Checkpoint Audit: dispatch groups one by one, audit after each group
 * 4. Final Audit: full deliverable verification after all groups complete
 */

import type { AgentHarness } from "./vendor/agent/harness/agent-harness.ts";
import type { AgentTool } from "./vendor/agent/types.ts";
import type { Skill } from "./vendor/agent/harness/types.ts";
import type { ExecutionEnv } from "./vendor/agent/harness/types.ts";
import type { Model } from "./vendor/ai/base.ts";
import type { AssistantMessage, TextContent } from "./vendor/ai/types.ts";
import type {
  AuditClassification,
  AuditModelConfig,
  ArtifactRunPolicy,
  RpcEvent,
  ScoreResult,
} from "./utils/types.ts";
import type { SkillApiConfigEntry } from "./config.ts";
import { auditScore } from "./audit-classifier.ts";
import {
  DEFAULT_AUDIT_MAX_ITERATIONS,
  appendAuditResult,
  isValidAuditMaxIterations,
  readModeMetadata,
  writeModeMetadata,
} from "./config.ts";
import {
  setHarnessFinalizationDeferred,
  setInternalMode,
  setSuppressUserBubble,
  isAbortRequested,
  getComplexAssistantCount,
} from "./agent-state.ts";
import { statSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createLogger } from "./utils/logger.ts";
import { truncateByTokens } from "./utils/token-estimation.ts";
import { AuditModelUnavailableError, isBenignCompletionError, isLlmKeyOrQuotaError, MainLlmFatalError, OrchestrationAbortedError } from "./utils/llm-error.ts";
import { getDeliveryManager, notifyBeforeAgentEnd } from "./extensions/index.ts";
import { basenamePath, relativePathIfInside } from "./utils/path-safety.ts";
import { ContextCompactionError } from "./compaction-manager.ts";
import { parseLongTaskGroupResult, stripLongTaskGroupResult } from "./protocol/agent-result-schema.ts";
import { resolveArtifactFile } from "./artifacts/artifact-protocol.ts";
import { recoveryDeliveryDecision } from "./artifacts/artifact-policy.ts";

const log = createLogger("long-task");

// ─── Language Detection ──────────────────────────────────────────────────────

/** Detect primary language from text: "zh" if Chinese chars dominant, else "en". */
function detectLanguage(text: string): "zh" | "en" {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return chineseChars > 3 ? "zh" : "en";
}

/** Build a language instruction string based on detected language. */
function langInstruction(lang: "zh" | "en"): string {
  return lang === "zh"
    ? "\n\nIMPORTANT: You MUST write ALL output text (including step descriptions, file content, reports, and replies) in **Chinese**. Do not use English unless the content specifically requires it (e.g. code, formulas)."
    : "\n\nIMPORTANT: You MUST write ALL output text in **English**. Do not use other languages unless the content specifically requires it.";
}

// ─── Clarification Instruction (appended to main LLM prompts when !skipClarification) ──

const CLARIFICATION_INSTRUCTION = `

## Asking Clarification Questions
If at ANY point during this task you need clarification from the user to proceed effectively, output:
[ASK_USER]
1. Your first question
2. Your second question (if any)

Rules:
- You may ask questions at any stage (planning, execution, review)
- Be concise and specific in your questions
- Only ask when genuinely stuck or when user input would significantly improve results`;

// ─── Orchestration Suspension (for mid-execution clarification) ───────────────

class OrchestrationSuspendedError extends Error {
  readonly question: string;
  readonly classification: AuditClassification;
  constructor(question: string, classification: AuditClassification) {
    super("Orchestration suspended for user clarification");
    this.name = "OrchestrationSuspendedError";
    this.question = question;
    this.classification = classification;
  }
}


interface PendingOrchestration {
  classification: AuditClassification;
  deps: LongTaskDeps;
  /** Continuation: call with user's answer to resume orchestration */
  continuation: (answer: string) => Promise<void>;
  clarificationRounds: number;
}

let _pendingOrchestration: PendingOrchestration | null = null;
let _clarificationRounds = 0;

/**
 * Set when a "[Continue Task]" dispatch resumes an orchestration that is
 * suspended on a clarification question: the dispatch means "stop asking,
 * just execute", so no further [ASK_USER] suspension may happen within this
 * orchestration. The classification captured in the suspended continuation
 * closure is immutable, hence a module-level override. Reset wherever the
 * pending orchestration is cleared and at every fresh orchestration start.
 */
let _forceNoClarification = false;

export function forceNoFurtherClarification(): void {
  _forceNoClarification = true;
}
const MAX_CLARIFICATION_ROUNDS = 5;

export function hasPendingOrchestration(): boolean {
  return _pendingOrchestration !== null;
}

export function clearPendingOrchestration(): void {
  _pendingOrchestration = null;
  _clarificationRounds = 0;
  _forceNoClarification = false;
}

// ─── Orchestration State Persistence (for crash/restart recovery) ─────────────

/**
 * Persisted orchestration state — written to sessionTaskDir/orchestration-state.json
 * so that an interrupted long_task can be resumed after process restart.
 */
interface OrchestrationState {
  artifactIdentity?: { sessionId?: string; root: string; owner: string; runId?: string };
  deliveryDecision?: import("./utils/types.ts").DeliveryDecision;
  finalContent?: string;
  status: "executing" | "clarification_suspended" | "completed";
  classification: AuditClassification;
  steps: Step[];
  groups: StepGroup[];
  completedGroupIds: string[];
  currentGroupIdx: number;
  maxIterations: number;
  userClarificationAnswer: string;
  groupFilesMapData: GroupFilesTracker;
  replyTrackerData?: GroupReplyTracker;
  notesTrackerData?: GroupNotesTracker;
  createdAt: string;
  updatedAt: string;
}

function orchestrationArtifactIdentity(deps: LongTaskDeps): NonNullable<OrchestrationState["artifactIdentity"]> {
  return { sessionId: deps.runtimeContext?.session?.session_id, root: deps.sessionTaskDir,
    owner: deps.manifestOwner ?? "hogagent", runId: deps.runtimeContext?.current_run?.run_id ?? deps.runtimeContext?.current_run?.prompt_run_id };
}

const ORCHESTRATION_STATE_FILE = "orchestration-state.json";

// Archived checkpoint left behind by a user abort. Kept under a different name so
// hasIncompleteOrchestration (auto-resume) never sees it; only an explicit
// "[Continue Task]" message may restore it (see tryRestoreArchivedOrchestration).
const ARCHIVED_STATE_FILE = "tmp-orchestration-state.json";

export class InvalidOrchestrationStateError extends Error {
  constructor(reason: string) {
    super(`Invalid orchestration checkpoint: ${reason}`);
    this.name = "InvalidOrchestrationStateError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStep(value: unknown): value is Step {
  return isRecord(value)
    && typeof value.id === "string" && value.id.trim().length > 0
    && typeof value.description === "string" && value.description.trim().length > 0
    && (value.group === undefined || typeof value.group === "string")
    && (value.skill === undefined || typeof value.skill === "string")
    && (value.workflowStage === undefined || typeof value.workflowStage === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isFileTracker(value: unknown): value is GroupFilesTracker {
  return isRecord(value) && Object.values(value).every(isStringArray);
}

function normalizeOrchestrationState(value: unknown): OrchestrationState {
  if (!isRecord(value)) throw new InvalidOrchestrationStateError("root must be an object");
  const status = value.status;
  if (status !== "executing" && status !== "clarification_suspended" && status !== "completed") {
    throw new InvalidOrchestrationStateError("unsupported status");
  }
  if (!isRecord(value.classification)
    || typeof value.classification.optimizedPrompt !== "string"
    || (value.classification.complexity !== "simple" && value.classification.complexity !== "complex")
    || typeof value.classification.skipClarification !== "boolean") {
    throw new InvalidOrchestrationStateError("invalid classification");
  }
  const goals = value.classification.goals ?? [];
  const acceptanceCriteria = value.classification.acceptanceCriteria ?? [];
  const clarificationQuestions = value.classification.clarificationQuestions;
  if (!isStringArray(goals) || !isStringArray(acceptanceCriteria)
    || (clarificationQuestions !== undefined && !isStringArray(clarificationQuestions))) {
    throw new InvalidOrchestrationStateError("classification lists must contain strings");
  }
  if (!Array.isArray(value.steps) || !value.steps.every(isStep)) {
    throw new InvalidOrchestrationStateError("steps must be a valid array");
  }
  if (!Array.isArray(value.groups) || !value.groups.every((group) => (
    isRecord(group) && typeof group.id === "string" && group.id.length > 0
    && Array.isArray(group.steps) && group.steps.every(isStep)
  ))) {
    throw new InvalidOrchestrationStateError("groups must be a valid array");
  }
  const steps = value.steps as Step[];
  const groups = value.groups as StepGroup[];
  if (new Set(steps.map((step) => step.id)).size !== steps.length
    || new Set(groups.map((group) => group.id)).size !== groups.length) {
    throw new InvalidOrchestrationStateError("step and group IDs must be unique");
  }
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const groupedStepIds = new Set<string>();
  for (const group of groups) {
    if (group.steps.length === 0) throw new InvalidOrchestrationStateError("groups cannot be empty");
    for (const groupedStep of group.steps) {
      const sourceStep = stepsById.get(groupedStep.id);
      if (!sourceStep || groupedStepIds.has(groupedStep.id)
        || sourceStep.description !== groupedStep.description
        || sourceStep.group !== groupedStep.group
        || sourceStep.skill !== groupedStep.skill
        || sourceStep.workflowStage !== groupedStep.workflowStage) {
        throw new InvalidOrchestrationStateError("group steps must exactly partition the declared steps");
      }
      groupedStepIds.add(groupedStep.id);
    }
  }
  if (groupedStepIds.size !== steps.length) {
    throw new InvalidOrchestrationStateError("group steps must exactly partition the declared steps");
  }
  if (!isStringArray(value.completedGroupIds)
    || new Set(value.completedGroupIds).size !== value.completedGroupIds.length
    || value.completedGroupIds.some((id) => !groups.some((group) => group.id === id))) {
    throw new InvalidOrchestrationStateError("completedGroupIds must reference known groups");
  }
  const completedGroupIds = value.completedGroupIds;
  const currentGroupIdx = value.currentGroupIdx === undefined
    ? resolveResumeGroupIndex(groups, completedGroupIds, 0)
    : value.currentGroupIdx;
  if (!Number.isSafeInteger(currentGroupIdx) || (currentGroupIdx as number) < 0 || (currentGroupIdx as number) > groups.length) {
    throw new InvalidOrchestrationStateError("currentGroupIdx is outside the group range");
  }
  const maxIterations = value.maxIterations === undefined ? DEFAULT_AUDIT_MAX_ITERATIONS : value.maxIterations;
  if (!isValidAuditMaxIterations(maxIterations)) {
    throw new InvalidOrchestrationStateError("maxIterations must be a non-negative safe integer");
  }
  const groupFilesMapData = value.groupFilesMapData ?? {};
  const replyTrackerData = value.replyTrackerData ?? {};
  const notesTrackerData = value.notesTrackerData ?? {};
  if (!isFileTracker(groupFilesMapData) || !isStringRecord(replyTrackerData) || !isStringRecord(notesTrackerData)) {
    throw new InvalidOrchestrationStateError("group trackers have invalid values");
  }
  const groupIds = new Set(groups.map((group) => group.id));
  if ([groupFilesMapData, replyTrackerData, notesTrackerData]
    .some((tracker) => Object.keys(tracker).some((id) => !groupIds.has(id)))) {
    throw new InvalidOrchestrationStateError("group trackers must reference known groups");
  }
  if (value.userClarificationAnswer !== undefined && typeof value.userClarificationAnswer !== "string") {
    throw new InvalidOrchestrationStateError("userClarificationAnswer must be a string");
  }
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new InvalidOrchestrationStateError("timestamps are required");
  }
  if (value.finalContent !== undefined && typeof value.finalContent !== "string") {
    throw new InvalidOrchestrationStateError("finalContent must be a string");
  }
  if (value.deliveryDecision !== undefined && !isDeliveryDecision(value.deliveryDecision)) {
    throw new InvalidOrchestrationStateError("deliveryDecision is invalid");
  }
  if (value.artifactIdentity !== undefined && (!isRecord(value.artifactIdentity)
    || typeof value.artifactIdentity.root !== "string"
    || typeof value.artifactIdentity.owner !== "string"
    || (value.artifactIdentity.sessionId !== undefined && typeof value.artifactIdentity.sessionId !== "string")
    || (value.artifactIdentity.runId !== undefined && typeof value.artifactIdentity.runId !== "string"))) {
    throw new InvalidOrchestrationStateError("artifactIdentity is invalid");
  }
  return {
    ...value,
    status,
    classification: { ...value.classification, goals, acceptanceCriteria } as unknown as AuditClassification,
    steps,
    groups,
    completedGroupIds,
    currentGroupIdx: currentGroupIdx as number,
    maxIterations,
    userClarificationAnswer: (value.userClarificationAnswer as string | undefined) ?? "",
    groupFilesMapData,
    replyTrackerData,
    notesTrackerData,
  } as OrchestrationState;
}

// Contract with Gateway buildTaskContinuationMessage: its first line carries this
// marker when work/task "continue" re-dispatches on the original session.
const TASK_CONTINUATION_MARKER = "[Continue Task]";

function getOrchestrationStatePath(sessionTaskDir: string): string {
  return join(sessionTaskDir, ORCHESTRATION_STATE_FILE);
}

function getArchivedOrchestrationStatePath(sessionTaskDir: string): string {
  return join(sessionTaskDir, ARCHIVED_STATE_FILE);
}

/** Write orchestration state to disk (best-effort, logs warning on failure). */
export function persistOrchestrationState(sessionTaskDir: string, state: OrchestrationState): void {
  const path = getOrchestrationStatePath(sessionTaskDir);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf-8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (err) {
    log.warn("Failed to persist orchestration state", { error: String(err) });
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Preserve the original persistence diagnostic. */ }
  }
}

/**
 * Read orchestration state from disk. Missing or syntactically corrupt JSON uses
 * the existing absent-state path; a parsed but unsafe structure is a hard
 * recovery error and must never enter the execution loop.
 */
export function readOrchestrationState(sessionTaskDir: string): OrchestrationState | null {
  let parsed: unknown;
  try {
    const filePath = getOrchestrationStatePath(sessionTaskDir);
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return normalizeOrchestrationState(parsed);
}

/** Delete orchestration state file (called after successful completion). */
export function clearOrchestrationState(sessionTaskDir: string): void {
  try {
    const filePath = getOrchestrationStatePath(sessionTaskDir);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // File may not exist — that's fine
  }
}

/**
 * Archive the orchestration state file instead of deleting it (user abort path).
 * Renames orchestration-state.json to tmp-orchestration-state.json so the next
 * message cannot auto-resume (the resume check only reads the canonical file),
 * while an explicit "[Continue Task]" dispatch can still restore the checkpoint.
 */
export function archiveOrchestrationState(sessionTaskDir: string): void {
  try {
    const filePath = getOrchestrationStatePath(sessionTaskDir);
    if (!existsSync(filePath)) return;
    const archivedPath = getArchivedOrchestrationStatePath(sessionTaskDir);
    if (existsSync(archivedPath)) unlinkSync(archivedPath);
    renameSync(filePath, archivedPath);
  } catch (err) {
    log.warn("Failed to archive orchestration state", { error: String(err) });
  }
}

/** Whether an archived (user-aborted) checkpoint exists. */
export function hasArchivedOrchestrationState(sessionTaskDir: string): boolean {
  try {
    return existsSync(getArchivedOrchestrationStatePath(sessionTaskDir));
  } catch {
    return false;
  }
}

/** Permanently delete the archived checkpoint (idempotent). */
export function removeArchivedOrchestrationState(sessionTaskDir: string): void {
  try {
    const archivedPath = getArchivedOrchestrationStatePath(sessionTaskDir);
    if (existsSync(archivedPath)) unlinkSync(archivedPath);
  } catch {
    // File may not exist — that's fine
  }
}

/**
 * Whether a message is an explicit Gateway continuation dispatch (its first line
 * carries the "[Continue Task]" marker). Such a message is a control command, not
 * task content — it must never be replayed as a task or fed in as a clarification
 * answer.
 */
export function isTaskContinuationMessage(text: string): boolean {
  return text.trimStart().startsWith(TASK_CONTINUATION_MARKER);
}

/**
 * Token ceiling for one continuation directive. The Gateway dispatch embeds
 * free-form user input that is not length-limited upstream, so cap it here to
 * keep a single continuation from crowding out the group requirements.
 */
const MAX_CONTINUATION_DIRECTIVE_TOKENS = 800;

/**
 * Fixed lines of the Gateway continuation template (`buildTaskContinuationMessage`
 * in hedgehog-gateway/src/workflow/task-executor.ts). Together with
 * TASK_CONTINUATION_MARKER they form the cross-module contract: the label marks
 * where the user's own text starts and the trailer marks where it ends.
 * Changing either wording requires changing it on both sides.
 */
const CONTINUATION_USER_DIRECTIVE_LABEL = "Additional instructions from the user for this continuation:";
const CONTINUATION_TRAILER = "When done, declare the final delivery decision according to the original runtime policy.";

/**
 * Extract the user's own instructions from a "[Continue Task]" dispatch, or ""
 * when it carries none. The planning-phase resume route feeds the result —
 * wrapped by wrapContinuationDirectiveAsClarification — in as the clarification
 * answer, where the surrounding template wording ("this is NOT a new task",
 * "do not re-plan") would contradict the re-planning it must do.
 * Note the payload is whatever the orchestrator put in that slot: usually the
 * user's own text, but an automatic Gateway continuation (provider rate limit /
 * terminated retry) puts its own resume note there.
 * Boundary behaviour: the first label occurrence opens the payload and the last
 * trailer occurrence closes it, so a payload that itself repeats either line is
 * still extracted whole.
 */
export function extractContinuationUserDirective(text: string): string {
  const labelIdx = text.indexOf(CONTINUATION_USER_DIRECTIVE_LABEL);
  if (labelIdx < 0) return "";
  let body = text.slice(labelIdx + CONTINUATION_USER_DIRECTIVE_LABEL.length);
  const trailerIdx = body.lastIndexOf(CONTINUATION_TRAILER);
  if (trailerIdx >= 0) body = body.slice(0, trailerIdx);
  return body.trim();
}

/**
 * Neutral wrapper applied when a continuation payload is fed into the
 * planning-phase resume route as the clarification answer. The payload is
 * whatever the orchestrator put in that slot — the user's own note, or an
 * automatic Gateway continuation's resume wording — so it must never be
 * presented as a direct answer to the planning phase's clarification question;
 * the planner has to judge how it relates to the question itself.
 * Returns "" for an empty payload so the default empty-answer flow is unchanged.
 */
export function wrapContinuationDirectiveAsClarification(payload: string): string {
  const directive = payload.trim();
  if (!directive) return "";
  return `Supplementary instruction attached when continuing the task (this is NOT a direct answer to your clarification question — weigh it against the question itself and the original request before planning):\n${directive}`;
}

/**
 * Format an explicit continuation dispatch as a directive section of the execution
 * prompt for the group we resume at. Gateway continuation messages carry the user's
 * own instructions and validation feedback; on the resume path the raw message
 * reaches no prompt at all, so without this section it would be dropped.
 */
export function buildContinuationDirectiveBlock(text: string): string {
  const directive = truncateByTokens(text.trim(), MAX_CONTINUATION_DIRECTIVE_TOKENS).text;
  return [
    "## Continuation Directive",
    "This group execution was re-started by the following instruction. Honor it while completing the current group; it adds to, and never replaces, the group requirements above.",
    "Its wording may mention final delivery — that part does not apply here: file delivery stays disabled during group execution (see below).",
    "",
    directive,
  ].join("\n");
}

/**
 * Restore an archived checkpoint for an explicit continuation request.
 * Only fires when the incoming message starts with the "[Continue Task]" marker
 * (Gateway work/task continue) and an archive exists; renames the archive back
 * to orchestration-state.json so the standard resume route takes over. This is
 * the sole consumer of the archived file — no other path may read it.
 * Returns true when a restore happened.
 */
export function tryRestoreArchivedOrchestration(text: string, sessionTaskDir: string): boolean {
  if (!isTaskContinuationMessage(text)) return false;
  if (!hasArchivedOrchestrationState(sessionTaskDir)) return false;
  // A canonical checkpoint always wins: it is at least as recent as the archive and
  // the resume route below already picks it up — never overwrite it with stale state.
  if (existsSync(getOrchestrationStatePath(sessionTaskDir))) return false;
  try {
    renameSync(getArchivedOrchestrationStatePath(sessionTaskDir), getOrchestrationStatePath(sessionTaskDir));
    log.info("Restored archived orchestration checkpoint for explicit continuation");
    return true;
  } catch (err) {
    log.warn("Failed to restore archived orchestration state", { error: String(err) });
    return false;
  }
}

/**
 * Clean up after an aborted orchestration turn.
 * Only a genuine user abort (userRequested=true, sticky flag set by onAbort)
 * cancels the task — the checkpoint is ARCHIVED (renamed to tmp) rather than
 * deleted, so the next message must NOT auto-resume it, but an explicit
 * "[Continue Task]" dispatch can still restore and resume it. A shutdown-
 * triggered abort (process exit, userRequested false) keeps
 * orchestration-state.json so the next startup can resume from the
 * interrupted group via hasIncompleteOrchestration.
 */
export function cleanupAbortedOrchestration(sessionTaskDir: string, userRequested: boolean): void {
  if (userRequested) {
    archiveOrchestrationState(sessionTaskDir);
  }
}

/** Check whether an incomplete orchestration exists on disk (for crash/restart recovery). */
export function hasIncompleteOrchestration(sessionTaskDir: string): boolean {
  const state = readOrchestrationState(sessionTaskDir);
  if (!state) return false;
  return state.status === "executing" || state.status === "clarification_suspended" || state.status === "completed";
}

/** Resolve the next group cursor, including skipped groups and legacy state files. */
export function resolveResumeGroupIndex(
  groups: readonly { id: string }[],
  completedGroupIds: readonly string[],
  currentGroupIdx: number,
): number {
  const completedCursor = completedGroupIds.reduce((cursor, groupId) => {
    const completedIndex = groups.findIndex((group) => group.id === groupId);
    return completedIndex >= 0 ? Math.max(cursor, completedIndex + 1) : cursor;
  }, 0);
  const persistedCursor = Number.isInteger(currentGroupIdx) ? currentGroupIdx : 0;
  return Math.min(groups.length, Math.max(completedCursor, persistedCursor));
}

/**
 * Resume an interrupted orchestration from the persisted state.
 * Reconstructs executed groups from completedGroupIds and re-enters
 * executeGroupsFrom at the correct position.
 * `continuationDirective` carries the raw Gateway "[Continue Task]" dispatch so the
 * instructions it holds reach the resumed group's execution prompt (see
 * buildContinuationDirectiveBlock); omit it for crash/restart recovery.
 */
export async function resumeInterruptedOrchestration(
  state: OrchestrationState,
  deps: LongTaskDeps,
  continuationDirective?: string,
  userInput?: string,
): Promise<void> {
  const { emitEvent } = deps;
  const identity = orchestrationArtifactIdentity(deps);
  if (state.artifactIdentity && (state.artifactIdentity.root !== identity.root || state.artifactIdentity.owner !== identity.owner
    || state.artifactIdentity.sessionId !== identity.sessionId)) throw new Error("Orchestration recovery artifact identity mismatch");
  if (state.status === "completed") {
    await getDeliveryManager()?.restoreCompletedDelivery(state.deliveryDecision, state.artifactIdentity?.runId);
    emitEvent({ type: "status_update", message: "上次编排已完成，仅恢复已声明的文件交付。" });
    emitEvent({ type: "turn_end", has_tool_results: false, content: state.finalContent ?? "",
      delivery_decision: recoveryDeliveryDecision(state.deliveryDecision) });
    return;
  }
  const clarification = userInput ? appendClarification(state.userClarificationAnswer, userInput) : state.userClarificationAnswer;
  if (state.status === 'clarification_suspended' && state.groups.length === 0) {
    await executeLongTask(state.classification, deps, continuationDirective
      ? appendClarification(clarification, wrapContinuationDirectiveAsClarification(extractContinuationUserDirective(continuationDirective)))
      : clarification);
    return;
  }

  // Reconstruct executed groups from completedGroupIds. currentGroupIdx is the
  // persisted next-group cursor; the completed IDs keep older state files
  // compatible, where currentGroupIdx pointed at the group just completed.
  const executedGroups = state.groups.filter((g) => state.completedGroupIds.includes(g.id));
  const startGroupIdx = resolveResumeGroupIndex(state.groups, state.completedGroupIds, state.currentGroupIdx);

  // Activate delivery restriction during resumed orchestration
  const deliveryManager = getDeliveryManager();
  deliveryManager?.setDeliveryRestricted(true);

  emitEvent({
    type: "thinking",
    role: "assistant",
    delta: startGroupIdx < state.groups.length
      ? `[Long Task] Resuming from group ${startGroupIdx + 1}/${state.groups.length}...`
      : "[Long Task] All groups were processed; resuming final audit...",
  });

  try {
    // Re-enter the group execution + final audit loop
    await executeGroupsFrom(
      state.classification,
      deps,
      state.steps,
      state.groups,
      startGroupIdx,
      executedGroups,
      clarification,
      state.maxIterations,
      state.groupFilesMapData ? { ...state.groupFilesMapData } : {},
      state.replyTrackerData ? { ...state.replyTrackerData } : {},
      state.notesTrackerData ? { ...state.notesTrackerData } : {},
      continuationDirective,
    );
  } finally {
    deliveryManager?.setDeliveryRestricted(false);
  }

  // The outer runOrchestrationTurn owns checkpoint cleanup after delivery hooks.
  // Resumed execution must keep the same recovery boundary as fresh execution.
}

// ─── Clarification Helpers ──────────────────────────────────────────────────

/** Detect [ASK_USER] marker in LLM response text. */
function hasAskUserMarker(text: string): boolean {
  return /\[ASK_USER\]/.test(text);
}


/** Strip [ASK_USER] marker and everything after it from text. */
function stripAskUserMarker(text: string): string {
  return text.replace(/\[ASK_USER\][\s\S]*/, "").trim();
}

/** Extract question text after [ASK_USER] marker. */
function extractQuestion(text: string): string {
  const idx = text.indexOf("[ASK_USER]");
  if (idx === -1) return "";
  return text.slice(idx + "[ASK_USER]".length).trim();
}

/**
 * Format the user clarification answer as context for subsequent prompts.
 * Deliberately neutral wording: this slot also carries the wrapped continuation
 * directive on the planning-phase resume route, which explicitly is NOT a direct
 * answer to any question — an asserting frame ("here is their answer") would
 * contradict that wrapper and mislabel automatic continuation wording.
 */
function buildUserClarificationContext(answer: string): string {
  return `\n\n[User Input]\nThe user provided the following input — weigh it appropriately and incorporate it into your work:\n${answer}`;
}

function appendClarification(previous: string, latest: string): string {
  return previous ? `${previous}\n\n[Latest user clarification; takes precedence if it changes an earlier answer]\n${latest}` : latest;
}

function clarifiedObjective(classification: AuditClassification, answers: string): string {
  return classification.optimizedPrompt + (answers ? buildUserClarificationContext(answers) : '');
}

/**
 * Wrapper around mainHarness.prompt that:
 * - Appends CLARIFICATION_INSTRUCTION when allowClarification=true
 * - Detects [ASK_USER] marker and suspends orchestration
 * - Injects user's previous clarification answer into subsequent prompts
 */
async function ensureContextCapacityOrAbort(deps: LongTaskDeps, nextPrompt: string): Promise<void> {
  if (isAbortRequested()) throw new OrchestrationAbortedError();
  try {
    await deps.ensureContextCapacity(nextPrompt);
  } catch (error) {
    if (isAbortRequested()) throw new OrchestrationAbortedError();
    throw error;
  }
  if (isAbortRequested()) throw new OrchestrationAbortedError();
}

async function promptAllowingClarification(
  deps: LongTaskDeps,
  basePrompt: string,
  classification: AuditClassification,
  userClarificationAnswer: string,
  scope: InstructionScope = "long_task_group",
): Promise<AssistantMessage> {
  // User abort: stop BEFORE issuing the next prompt — harness.abort() only
  // cancels the currently running run, so without this check the orchestration
  // loop would keep re-arming with fresh LLM calls.
  if (isAbortRequested()) {
    throw new OrchestrationAbortedError();
  }

  const allowClarification = !classification.skipClarification && !_forceNoClarification;
  let prompt = basePrompt;

  if (allowClarification) {
    prompt += CLARIFICATION_INSTRUCTION;
  }
  // Decoupled from allowClarification: a continuation dispatch that suppressed
  // further questions still has to deliver its directive as the answer payload.
  if (userClarificationAnswer) {
    prompt += buildUserClarificationContext(userClarificationAnswer);
  }

  const response = await withInstructionScope(scope, async () => {
    await ensureContextCapacityOrAbort(deps, prompt);
    await deps.mainHarness.setResources({ skills: deps.allSkills });
    if (isAbortRequested()) throw new OrchestrationAbortedError();
    return deps.mainHarness.prompt(prompt);
  });

  // User abort: the run was cancelled mid-flight — the response is an empty
  // aborted placeholder. Throw immediately; otherwise ensureStructuredOutput
  // would fire continuation prompts and the loop would effectively undo the abort.
  if (response?.stopReason === "aborted" || isAbortRequested()) {
    throw new OrchestrationAbortedError();
  }

  // Fail fast on unrecoverable main-LLM errors (invalid key / quota exhausted).
  // The harness surfaces LLM failures as stopReason "error" messages instead of
  // throwing — without this check the orchestrator would loop continuation
  // prompts and audit retries against a dead key.
  if (response?.stopReason === "error" && isLlmKeyOrQuotaError(response.errorMessage)) {
    throw new MainLlmFatalError(`Main LLM key unavailable or quota exhausted: ${response.errorMessage}`);
  }

  if (allowClarification) {
    const text = extractTextFromResponse(response);
    if (hasAskUserMarker(text)) {
      if (_clarificationRounds < MAX_CLARIFICATION_ROUNDS) {
        _clarificationRounds++;
        suspendForClarification(text, classification, deps, userClarificationAnswer);
      } else {
        // Max rounds reached — strip the marker
        const strippedText = stripAskUserMarker(text);
        return { ...response, content: [{ type: "text", text: strippedText }] };
      }
    }
  }

  return response;
}

/** Emit question as chat bubble, save state, and throw to suspend orchestration. */
function suspendForClarification(
  responseText: string,
  classification: AuditClassification,
  deps: LongTaskDeps,
  userClarificationAnswer: string,
): never {
  // Abort wins over suspension: do NOT persist a clarification_suspended state,
  // otherwise the next user message would wrongly resume the aborted task.
  if (isAbortRequested()) {
    throw new OrchestrationAbortedError();
  }

  const question = extractQuestion(responseText);
  const header = "\u2753 I need to clarify something:\n\n";
  const fullText = header + question;

  // Exit internal mode FIRST so the frontend renders this as a chat bubble,
  // not a collapsed thinking section. executeLongTask's finally block will
  // also emit internal_mode:false, but that happens AFTER these events.
  deps.emitEvent({ type: "internal_mode", active: false } as RpcEvent);
  setInternalMode(false);

  // Emit as chat bubble
  deps.emitEvent({ type: "message_start", role: "assistant" } as RpcEvent);
  deps.emitEvent({ type: "message_update", role: "assistant", delta: fullText } as RpcEvent);
  deps.emitEvent({ type: "message_end" } as RpcEvent);
  // Signal agent turn complete so frontend re-enables the send button
  deps.emitEvent({ type: "agent_end", message_count: 1 } as RpcEvent);

  // Save state — continuation will be set by the caller
  _pendingOrchestration = {
    classification,
    deps,
    continuation: async () => {},
    clarificationRounds: _clarificationRounds,
  };

  // Persist suspended state for crash/restart recovery
  const _suspendedState = readOrchestrationState(deps.sessionTaskDir);
  if (_suspendedState) {
    _suspendedState.status = "clarification_suspended";
    _suspendedState.userClarificationAnswer = userClarificationAnswer;
    _suspendedState.updatedAt = new Date().toISOString();
    persistOrchestrationState(deps.sessionTaskDir, _suspendedState);
  } else {
    // Planning-phase suspension: no state file exists yet (it is first written after
    // Phase 2 grouping). Persist a minimal record (empty steps/groups) so restart
    // detection (hasIncompleteOrchestration) knows a clarification is pending.
    persistOrchestrationState(deps.sessionTaskDir, {
      artifactIdentity: orchestrationArtifactIdentity(deps),
      status: "clarification_suspended",
      classification,
      steps: [],
      groups: [],
      completedGroupIds: [],
      currentGroupIdx: 0,
      maxIterations: deps.auditConfig.maxIterations,
      userClarificationAnswer,
      groupFilesMapData: {},
      replyTrackerData: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  throw new OrchestrationSuspendedError(question, classification);
}

/** Resume orchestration with user's answer. Called from index.ts. */
export async function resumeOrchestrationWithUserAnswer(answer: string, currentDeps?: LongTaskDeps): Promise<void> {
  const pending = _pendingOrchestration;
  if (!pending) return;

  if (currentDeps) {
    if (pending.deps.workspaceDir !== currentDeps.workspaceDir
      || pending.deps.sessionTaskDir !== currentDeps.sessionTaskDir
      || pending.deps.projectDir !== currentDeps.projectDir
      || pending.deps.manifestOwner !== currentDeps.manifestOwner) {
      throw new Error('Pending Long Task belongs to another execution context; start a new session');
    }
    // The continuation closes over this object. Refresh it at the new outer run
    // boundary so it cannot retain old tools, credentials or locked delivery policy.
    Object.assign(pending.deps, currentDeps);
  }

  _clarificationRounds = pending.clarificationRounds;
  _pendingOrchestration = null;

  // Re-activate delivery restriction for the resumed orchestration
  const deliveryManager = getDeliveryManager();
  deliveryManager?.setDeliveryRestricted(true);

  setInternalMode(true);
  pending.deps.emitEvent({ type: "internal_mode", active: true } as RpcEvent);
  pending.deps.emitEvent({ type: "orchestration_resuming", session_task_dir: pending.deps.sessionTaskDir } as RpcEvent);

  try {
    await runOrchestrationTurn(pending.deps, () => pending.continuation(answer));
  } finally {
    deliveryManager?.setDeliveryRestricted(false);
  }
}

/** Own the terminal boundary for fresh, interrupted and clarification runs. */
export async function runOrchestrationTurn(
  deps: Pick<LongTaskDeps, "emitEvent" | "sessionTaskDir">,
  run: () => Promise<void>,
): Promise<void> {
  let succeeded = false;
  let failureDetail: string | undefined;
  let callerOwnsTermination = false;
  let deferAgentEndToCaller = false;
  try {
    await run();
    succeeded = true;
  } catch (err) {
    if (err instanceof OrchestrationAbortedError || err instanceof ContextCompactionError) {
      callerOwnsTermination = true;
      throw err;
    }
    if (err instanceof AuditModelUnavailableError) {
      deferAgentEndToCaller = true;
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    failureDetail = message;
    log.error("Long Task orchestration failed", { error: message });
    clearPendingOrchestration();
    // Reuse explicit Continue Task recovery; ordinary messages do not retry failures.
    archiveOrchestrationState(deps.sessionTaskDir);
    deps.emitEvent({ type: "error", error: message });
  } finally {
    try {
      const metadata = readModeMetadata(deps.sessionTaskDir);
      if (metadata) {
        writeModeMetadata(deps.sessionTaskDir, {
          ...metadata,
          // This is a statistics update, not another batch of user messages.
          originalUserMessages: undefined,
          complexAssistantCount: getComplexAssistantCount(),
        });
      }
    } catch (error) {
      // Auxiliary statistics must not mask the run's result or prevent termination.
      log.warn("Failed to persist orchestration statistics", { error: String(error) });
    }
    if (!callerOwnsTermination && !hasPendingOrchestration() && !isAbortRequested()) {
      setInternalMode(false);
      deps.emitEvent({ type: "internal_mode", active: false });
      // This closes orchestration mode, not the run. The following agent_end
      // carries its outcome; only a successful run may finalize delivery.
      deps.emitEvent({ type: "orchestration_completed" });
      if (!deferAgentEndToCaller) {
        // Finalization failure retains the completed checkpoint and is converted
        // here into the turn's single error boundary. The next recovery retries
        // delivery without rerunning planning, execution, or audit.
        if (succeeded) {
          let finalized = true;
          try {
            finalized = (await notifyBeforeAgentEnd()) !== false;
          } catch (error) {
            finalized = false;
            failureDetail = error instanceof Error ? error.message : String(error);
          }
          if (finalized) {
            clearOrchestrationState(deps.sessionTaskDir);
            removeArchivedOrchestrationState(deps.sessionTaskDir);
          } else {
            succeeded = false;
            failureDetail ??= "Long Task delivery finalization failed; completed checkpoint retained for recovery";
            log.error("Long Task delivery finalization failed", { error: failureDetail });
            deps.emitEvent({ type: "error", error: failureDetail });
          }
        }
        deps.emitEvent({ type: "agent_end", message_count: 1,
          reason: succeeded ? "completed" : "error", ...(failureDetail ? { error: failureDetail } : {}) });
      }
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LongTaskDeps {
  mainHarness: AgentHarness;
  auditModelObj: Model<any>;
  auditConfig: AuditModelConfig;
  env: ExecutionEnv;
  allTools: AgentTool[];
  allSkills: Skill[];
  skillsConfig: Record<string, SkillApiConfigEntry>;
  /** Event emitter with the orchestration's session_id pre-bound by the caller
   *  (see processLongTaskMessage) — events emitted here are already routed to
   *  the originating session even if the active session switches mid-run. */
  emitEvent: (event: RpcEvent) => void;
  workspaceDir: string;
  sessionTaskDir: string;
  /** Authoritative project directory for this run. Project files stay there; only explicit chat downloads use delivery events. */
  projectDir?: string;
  /** Preserve the owner's artifact rules through execution, retries and audit. */
  manifestOwner: "gateway" | "hogagent" | undefined;
  /** Run-scoped delivery and mutation authority. */
  artifactRunPolicy?: ArtifactRunPolicy;
  runtimeContext?: DeepReadonly<RuntimeContextSnapshot>;
  /** LLM request tracking context for metadata injection */
  llmTracking: import("./llm-metadata-hook.ts").LlmTrackingContext;
  /** Fail-closed context check bound to this orchestration's Harness and Session. */
  ensureContextCapacity: (nextPrompt?: string) => Promise<void>;
}

interface Step {
  id: string;
  group?: string;
  description: string;
  skill?: string;
  workflowStage?: string;
  [key: string]: unknown;
}

interface StepGroup {
  id: string;
  steps: Step[];
}

/** Execution history can be sparse after non-fatal group errors. */
function completedGroupsBefore(groups: StepGroup[], completed: StepGroup[], index: number): StepGroup[] {
  const precedingIds = new Set(groups.slice(0, index).map(group => group.id));
  return completed.filter(group => precedingIds.has(group.id));
}

// ─── Structured Output Parsing ───────────────────────────────────────────────

/**
 * Parse structured JSON output from group execution LLM reply.
 * Accepts only a complete discriminator-backed object at the reply tail.
 * Returns the parsed output or a fallback with the raw text as content.
 */
function parseGroupOutput(rawText: string): { summary: string; content: string; output_files: string[]; notes_for_next_group: string } {
  const fallback = { summary: "", content: rawText, output_files: [] as string[], notes_for_next_group: "" };
  return parseLongTaskGroupResult(rawText) ?? fallback;
}

/** Strip the structured output JSON block from raw text, returning clean content for audit context. */
function stripStructuredJson(rawText: string): string {
  return stripLongTaskGroupResult(rawText).trim();
}

/** Check if the reply ends with a valid long_task_group_result object. */
function hasStructuredOutput(rawText: string): boolean {
  return parseLongTaskGroupResult(rawText) !== undefined;
}

/** Maximum continuation prompts before giving up */
const MAX_CONTINUATION_PROMPTS = 2;

/**
 * Continuation guard: if LLM produced no structured output JSON, send continuation prompts.
 * Returns the final rawText and parsed result after guard completes.
 */
async function ensureStructuredOutput(
  deps: LongTaskDeps,
  classification: AuditClassification,
  userClarificationAnswer: string,
  group: StepGroup,
  initialRawText: string,
): Promise<{ rawText: string; parsed: ReturnType<typeof parseGroupOutput> }> {
  const { emitEvent } = deps;
  let rawText = initialRawText;
  let parsed = parseGroupOutput(rawText);

  for (let cont = 0; cont < MAX_CONTINUATION_PROMPTS && !hasStructuredOutput(rawText); cont++) {
    log.info("LLM produced no structured output, sending continuation prompt", { group: group.id, attempt: cont + 1 });
    emitEvent({ type: "thinking", role: "assistant", delta: `[Long Task] ${group.id}: no structured output detected, prompting continuation...` });

    const contPrompt = `Your previous response did not include the required structured output JSON block.\n` +
      `Please either:\n` +
      `1. Execute any remaining steps and generate files only if required, then end with the required JSON block.\n` +
      `2. If all steps are already complete, end your response with this exact JSON block at the bottom:\n` +
      `\`\`\`
{ "schema_version": "1.0", "type": "long_task_group_result", "summary": "Brief description", "content": "text result", "output_files": [], "notes_for_next_group": "" }
\`\`\`

` +
      `Current group: ${group.id}\n` +
      group.steps.map((s, i) => `${i + 1}. [${s.id}] ${s.description}`).join("\n");

    const contResponse = await promptAllowingClarification(deps, contPrompt, classification, userClarificationAnswer);
    rawText = extractTextFromResponse(contResponse);
    parsed = parseGroupOutput(rawText);
  }

  if (!hasStructuredOutput(rawText)) {
    throw new Error(`Group ${group.id} did not produce a valid long_task_group_result after ${MAX_CONTINUATION_PROMPTS} continuation prompts`);
  }

  return { rawText, parsed };
}

// ─── Group Files Tracker ────────────────────────────────────────────────────

/**
 * Per-group file tracker — the single source of truth for file ownership.
 * Key: group ID, Value: array of files declared by that group.
 * Design: accumulatedFiles is always DERIVED from this tracker via flattenGroupFiles(),
 * eliminating the need to manually synchronize a flat array with executedGroups.
 */
type GroupFilesTracker = Record<string, string[]>;

/** Tracks each group's lastLlmReply for cross-group context injection. */
type GroupReplyTracker = Record<string, string>;

/** Tracks each group's notes_for_next_group for supplementary cross-group hints.
 *  Intentionally NOT persisted to OrchestrationState — notes are supplementary
 *  and losing them on crash recovery is acceptable (replyTracker provides the main context). */
type GroupNotesTracker = Record<string, string>;

/** Max tokens of lastLlmReply to include per group in completedSummary. */
const MAX_REPLY_CONTEXT_PER_GROUP = 2000;

/** Derive a flat array of all files from the tracker (pure function, no mutation). */
function flattenGroupFiles(tracker: GroupFilesTracker): string[] {
  return [...new Set(Object.values(tracker).flat())];
}

/** Keep group declarations on the same real-file boundary used by Manifest and delivery. */
function normalizeGroupOutputFiles(files: string[], deps: LongTaskDeps, groupId: string): string[] {
  const normalized: string[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (typeof file !== "string" || !file.trim()) continue;
    const artifact = resolveArtifactFile(file, deps);
    if (!artifact) {
      rejected.push(file);
      continue;
    }
    const declaredPath = artifact.workspaceRelative ?? artifact.absolutePath;
    if (!normalized.includes(declaredPath)) normalized.push(declaredPath);
  }
  if (rejected.length > 0) {
    log.warn("Group declared output_files outside managed artifact roots or missing on disk", {
      group: groupId,
      files: rejected,
    });
  }
  return normalized;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Detect whether the user explicitly requests workflow-based execution.
 * Returns the matched skill name (for injection into planning instruction), or null.
 *
 * Rule 1: prompt contains a formatted [<skill-name> workflow] expression.
 * Rule 2: prompt mentions a skill name AND that skill's SKILL.md declares `workflow_based: true`.
 */
function detectWorkflowBasedSkill(prompt: string, allSkills: Skill[]): string | null {
  const lower = prompt.toLowerCase();

  // Rule 1: formatted expression [<skill-name> workflow]
  const formattedMatch = prompt.match(/\[([^\]]+)\s+workflow\]/i);
  if (formattedMatch) {
    const extracted = formattedMatch[1].trim();
    const knownSkill = allSkills.find((s) => s.name.toLowerCase() === extracted.toLowerCase());
    return knownSkill ? knownSkill.name : null;
  }

  // Rule 2: user mentions a skill name whose SKILL.md declares workflow_based: true
  // Prefer longest match to avoid substring ambiguity (e.g. "hedgehog-stock" vs "hedgehog-stock-research")
  const matched = allSkills
    .filter((s) => s.workflowBased && lower.includes(s.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return matched ? matched.name : null;
}

function buildPlanningInstruction(lang: "zh" | "en", workflowBasedSkill: string | null): string {
  // Top-level hint — only present when workflow-based mode is triggered
  const workflowBasedHint = workflowBasedSkill
    ? `IMPORTANT: The user has explicitly requested workflow-based execution for the "${workflowBasedSkill}" skill. You MUST follow Path A.\n`
    : "";

  // Path A condition line
  const pathACondition = workflowBasedSkill
    ? `User has requested workflow-based execution for "${workflowBasedSkill}".`
    : `Not applicable for this task.`;

  const base = `\n\n## Skill Workflow Discovery (Before Planning)
${workflowBasedHint}Before creating the execution plan, scan the <available_skills> section in your system prompt. For any skill whose name or description suggests it provides a workflow, step-by-step guide, or operation instructions relevant to the task objective:
1. Use the read tool to read that skill's full document (SKILL.md) at the listed file path.
2. Determine the planning mode by evaluating the following conditions IN ORDER:

### Path A — Stage-Based Workflow Execution
Condition: ${pathACondition}
When this path applies, after reading the SKILL.md:
- Identify the distinct workflow stages/phases defined in the skill
- Create a **multi-group plan** where each workflow stage becomes a separate group
- Each group will have its own independent checkpoint audit
- Steps within each group describe the specific actions for that stage
- Each step MUST include a "workflowStage" field with the exact stage/phase name from the SKILL.md (e.g., "数据准备", "核心工作流", "强制验证")
- Sub-agent affinity rule: If a stage heavily depends on sub-agent orchestration (sessions_spawn/sessions_yield), those stages MUST be kept in the SAME group. Do NOT split sub-agent-dependent stages across different groups, as each group runs in an isolated LLM session and cannot access runtime state of sub-agents spawned in a previous group. Stages involving mandatory verification of sub-agent outputs must be in the same group as the sub-agent spawning stage.
- Example:
  [
    {"id":"step_1","group":"group_1_data_collection","description":"Stage 1: ...","skill":"${workflowBasedSkill || ""}","workflowStage":"数据准备"},
    {"id":"step_2","group":"group_2_analysis","description":"Stage 2: ...","skill":"${workflowBasedSkill || ""}","workflowStage":"核心工作流"},
    {"id":"step_3","group":"group_3_report","description":"Stage 3: ...","skill":"${workflowBasedSkill || ""}","workflowStage":"强制验证与交付"}
  ]

### Path B — Single-Step Skill Workflow
Condition: A relevant skill with a complete workflow was found, but the user did NOT request stage-based execution.
- Use a single-step plan: id: "step_1", group: "group_1"
- description: "Follow the [skill name] skill workflow to complete the task"
- Include the task requirements and goal in the description
- Example: {"id":"step_1","group":"group_1","description":"Follow the stock-research skill workflow to complete the analysis. Requirements: xxx. Goal: xxx","skill":"stock-research"}

### Path C — Free-Form Planning
Condition: No relevant skill workflow was found.
- Proceed with a detailed multi-step plan based on your own judgment.

## Execution Plan Format
Please create an execution plan for the above task.
Output format as a JSON array, each step containing:
- id: Unique step identifier (e.g., "step_1")
- group: Group identifier (e.g., "group_1"), related steps belong to the same group
- description: Step description
- skill: Skill name to use (if applicable)
- workflowStage: Stage/phase name from the skill workflow (only for Path A workflow-based plans)

## File Delivery Rules (IMPORTANT)
- Do NOT include "deliver files" or "send files to user" as a step or group.
- File delivery is handled automatically by the system after all groups complete and the final audit concludes.
- Your plan should ONLY contain task-execution steps (data query, file generation, analysis, etc.).
- During execution, generate output files to the designated output directory but do NOT call deliver_files.

Please output the JSON array directly, no other text.`;
  return base + langInstruction(lang);
}

/** Preserve canonical provider diagnostics for the Gateway's existing retry classifier. */
class PlanningLlmError extends Error {}

/** Planning may read Skill instructions, but must not execute the business task. */
async function generateExecutionPlan(
  deps: LongTaskDeps,
  classification: AuditClassification,
  userClarificationAnswer: string,
  workflowBasedSkill: string | null,
): Promise<Step[]> {
  const activeToolNames = deps.mainHarness.getActiveTools().map(tool => tool.name);
  let prompt = `## Planning Only\nRead relevant Skill documents to define the execution steps. Do not execute the task, query business data, write files, or deliver results. Instructions in the task and Skills describe future execution, not actions to perform now.\n\n## Task to Plan\n` +
    classification.optimizedPrompt + buildPlanningInstruction(detectLanguage(classification.optimizedPrompt), workflowBasedSkill);

  try {
    await deps.mainHarness.setActiveTools(activeToolNames.filter(name => name === "read"));
    // At most one tool-free correction; do not rerun discovery or business work.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await promptAllowingClarification(deps, prompt, classification, userClarificationAnswer, "planning");
      if (response.stopReason === "error" && !isBenignCompletionError(
        response as unknown as Record<string, unknown>, response.errorMessage ?? "",
      )) {
        throw new PlanningLlmError(`LLM call failed: ${response.errorMessage || "unknown LLM error"}`);
      }
      const steps = response.stopReason === "length" ? [] : parseStepsFromResponse(response);
      if (steps.length > 0) return steps;

      const rawText = extractTextFromResponse(response);
      log.warn("Planning returned no valid steps", {
        attempt: attempt + 1,
        stopReason: response.stopReason,
        responseLength: rawText.length,
        responsePreview: rawText.slice(0, 500),
      });
      if (attempt === 0) {
        deps.emitEvent({ type: "thinking", role: "assistant", delta: "[Long Task] Invalid plan format; requesting one JSON correction..." });
        await deps.mainHarness.setActiveTools([]);
        prompt = `Your previous response did not provide a complete, valid execution plan. Return only a non-empty JSON array of steps for the original task. Each step must have a unique non-empty string id and a non-empty string description; optional group, skill and workflowStage must be strings. Keep the plan concise enough to finish in this reply. Do not execute the task, call tools, write files, or return task results.\n` +
          `Example: [{"id":"step_1","group":"group_1","description":"Complete the requested analysis following the relevant Skill"}]` +
          langInstruction(detectLanguage(classification.optimizedPrompt));
      }
    }
    return [];
  } finally {
    // Restore the exact execution surface, including on abort/failure/clarification.
    await deps.mainHarness.setActiveTools(activeToolNames);
  }
}

/**
 * Build execution prompt with explicit context (goal + completed work + current group).
 * Does NOT include the full plan — avoids reliance on conversation history that may be compacted.
 */
function buildExecutionPrompt(
  classification: AuditClassification,
  completedGroups: StepGroup[],
  currentGroup: StepGroup,
  workspaceDir: string,
  sessionTaskDir: string,
  replyTracker: GroupReplyTracker,
  groupFilesTracker: GroupFilesTracker,
  notesTracker: GroupNotesTracker,
  allSkills: Skill[],
  projectDir?: string,
  continuationDirective?: string,
): string {
  // Build skill workflow context for workflow-based groups
  const skillStep = currentGroup.steps.find((s) => s.skill);
  let skillWorkflowContext = "";
  if (skillStep) {
    const skillName = skillStep.skill!;
    const skill = allSkills.find((s) => s.name === skillName);
    if (skill) {
      const stageName = skillStep.workflowStage || skillStep.description;
      skillWorkflowContext = `\n## Skill Workflow Context\nThis group is part of the **${skillName}** skill workflow execution.\n- Skill document: \`${skill.filePath}\`\n- Current stage: **${stageName}**\n\n**IMPORTANT**: Before executing, use the read tool to read \`${skill.filePath}\` to understand the full workflow. Focus on the section corresponding to the current stage above and follow ALL requirements, rules, and constraints specified in that section.\n`;
    }
  }
  const completedSummary = completedGroups.length > 0
    ? completedGroups.map((g, idx) => {
        const desc = g.steps.map((s) => s.description).join("; ");
        const files = groupFilesTracker[g.id];
        const filesLine = files?.length ? `\n  Output files: ${files.join(", ")}` : "";
        const notes = notesTracker[g.id];
        const notesLine = notes ? `\n  Notes: ${notes}` : "";
        // Token optimization: only the most recent completed group carries its full
        // reply text. Earlier groups keep only desc + output files + notes, since
        // those (not the verbose reply) are what later groups actually need.
        const isLast = idx === completedGroups.length - 1;
        if (!isLast) {
          return `- ${g.id}: ${desc}${filesLine}${notesLine}`;
        }
        const reply = replyTracker[g.id];
        const replySnippet = reply
          ? truncateByTokens(reply, MAX_REPLY_CONTEXT_PER_GROUP).text
          : "(no reply captured)";
        return `- ${g.id}: ${desc}${filesLine}${notesLine}\n  Result: ${replySnippet}`;
      }).join("\n")
    : "(None)";

  const directoryRules = projectDir
    ? [
        `- Follow the Working Directories rules from the system prompt`,
        `- All working files (reports, charts, data, drafts, etc.) MUST be written to the project directory (${projectDir})`,
        `- Business deliverables, when the task requires them, MUST be written to \`${projectDir}/${projectDeliverablesDirectory()}/\`; name the primary one \`final-output-<short_title>.<ext>\` unless the request or Skill specifies an exact different name. Pure source/config/raw-data tasks must not create a placeholder deliverable`,
        `- Do NOT write files directly in the workspace root directory (${workspaceDir})`,
        `- Text-only results may be returned in content with an empty output_files array. Persist files only when the request or applicable Skill requires them; never create placeholder files`,
        `- If the output content is large and needs to be written in multiple passes to the same file, use partial section editing or replacement (edit tool) to avoid truncation or loss from single-pass writes`,
      ].join("\n")
    : [
        `- All output files (reports, charts, data, etc.) must be saved to the session task directory (${sessionTaskDir})`,
        `- Do not write files directly in the workspace root directory (${workspaceDir})`,
        `- Text-only results may be returned in content with an empty output_files array. Persist files only when the request or applicable Skill requires them; never create placeholder files`,
        `- If the output content is large and needs to be written in multiple passes to the same file, use partial section editing or replacement (edit tool) to avoid truncation or loss from single-pass writes`,
      ].join("\n");

  const outputPathRule = `\`output_files\` = array of absolute project file paths or session file paths **relative to workspaceDir** (${workspaceDir}). ` +
    `For session task dir files: "tasks/<session-id>/<filename>"; name raw evidence \`data-<short_title>.<ext>\` so it remains distinguishable from intermediate and final results. ` +
    (projectDir
      ? `For project files, use absolute paths under the current project directory and store raw evidence under \`data/\`.`
      : `Example: "tasks/<session-id>/final-output-<short_title>.<ext>"`);

  // Placed before the output-format section so the mandatory JSON block and the
  // language instruction stay the last things the LLM reads.
  const continuationDirectiveSection = continuationDirective
    ? `\n${buildContinuationDirectiveBlock(continuationDirective)}\n`
    : "";

  return `## Overall Task Objective
${classification.optimizedPrompt}

## Completed Work
${completedSummary}

## Output File Requirements
${directoryRules}

${skillWorkflowContext}
## Current Step Group to Execute: ${currentGroup.id}
${currentGroup.steps.map((s, i) => `${i + 1}. [${s.id}] ${s.description}`).join("\n")}

Please complete each step of the current group in order.
${continuationDirectiveSection}
## File Delivery Restriction (IMPORTANT)
- Do NOT call deliver_files during group execution.
- File delivery is handled automatically by the system after final audit.
- Focus ONLY on executing the steps and producing the requested results.

## MANDATORY Output Format
After completing all steps, your final reply MUST end with this JSON block at the very bottom:
\`\`\`
{ "schema_version": "1.0", "type": "long_task_group_result", "summary": "Brief description of what this group accomplished", "content": "text result", "output_files": [], "notes_for_next_group": "" }
\`\`\`

**Fields:**
- \`summary\`: A brief description (1-2 sentences) of what this group accomplished
- \`content\`: concise result text or a brief summary of the declared files. It may be non-empty together with \`output_files\`.
- ${outputPathRule}
- \`notes_for_next_group\` (required string; recommended when producing data files):
  - Data files: path, record count, fields, date range, key stats (min/max)
  - Decisions: rationale that the next group needs to know
  - Keep concise (maximum 2000 chars; aim for < 500). Leave empty string if nothing to pass on.
- Do NOT add any text after the JSON block${langInstruction(detectLanguage(classification.optimizedPrompt))}`;
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────

/**
 * Execute a Long Task through the mixed dispatch state machine.
 */
export async function executeLongTask(
  classification: AuditClassification,
  deps: LongTaskDeps,
  initialClarificationAnswer = "",
): Promise<void> {
  _clarificationRounds = 0;
  _forceNoClarification = false;
  const { emitEvent } = deps;

  // A fresh orchestration supersedes any archived checkpoint from a previously
  // aborted run in this session dir — drop it so a later "[Continue Task]"
  // cannot resurrect stale state of a superseded/redo task.
  removeArchivedOrchestrationState(deps.sessionTaskDir);

  // Activate delivery restriction: block deliver_files during orchestration
  const deliveryManager = getDeliveryManager();
  deliveryManager?.setDeliveryRestricted(true);

  emitEvent({ type: "internal_mode", active: true } as RpcEvent);
  try {
    await _executeLongTaskInner(classification, deps, initialClarificationAnswer);
  } finally {
    emitEvent({ type: "internal_mode", active: false } as RpcEvent);
    deliveryManager?.setDeliveryRestricted(false);
  }
}

async function _executeLongTaskInner(
  classification: AuditClassification,
  deps: LongTaskDeps,
  initialClarificationAnswer = "",
): Promise<void> {
  const { emitEvent, auditConfig } = deps;
  const maxIterations = auditConfig.maxIterations;
  let userClarificationAnswer = initialClarificationAnswer;

  // Keep the sticky post-classification check for the narrow race after the
  // abortable classification settles but before orchestration starts.
  if (isAbortRequested()) {
    throw new OrchestrationAbortedError();
  }

  // ═══ Phase 1: Planning ═══
  emitEvent({ type: "thinking", role: "assistant", delta: "[Long Task] Planning..." });
  log.info("Long Task: starting planning phase");

  const workflowBasedSkill = detectWorkflowBasedSkill(classification.optimizedPrompt, deps.allSkills);
  if (workflowBasedSkill) {
    log.info("Long Task: workflow-based mode detected", { skill: workflowBasedSkill });
  }
  let steps: Step[];

  try {
    steps = await generateExecutionPlan(deps, classification, userClarificationAnswer, workflowBasedSkill);
  } catch (err) {
    if (err instanceof OrchestrationAbortedError) {
      // User abort — rethrow so the top-level abort handler owns the lifecycle
      // (emitting an "error" event here would be a false signal).
      throw err;
    }
    if (err instanceof ContextCompactionError) throw err;
    if (err instanceof OrchestrationSuspendedError) {
      // Pass the user's answer into the re-entry call — assigning a local variable
      // here would be lost because the re-entered function re-declares it.
      _pendingOrchestration!.continuation = async (answer: string) => {
        await _executeLongTaskInner(classification, deps, appendClarification(userClarificationAnswer, answer));
      };
      return;
    }
    log.error("Planning failed", { error: String(err) });
    const planErrMsg = err instanceof MainLlmFatalError
      ? `Main LLM unavailable: ${err.message}`
      : err instanceof Error ? err.message : `Planning phase failed: ${String(err)}`;
    throw new Error(planErrMsg);
  }

  if (steps.length === 0) {
    log.warn("Main model did not generate valid execution plan");
    throw new Error("Main model did not generate a valid execution plan after one format correction. Expected a non-empty JSON array of steps with unique string ids and non-empty descriptions.");
  }

  // ═══ Phase 2: Grouping ═══
  const groups = groupSteps(steps);
  emitEvent({
    type: "thinking",
    role: "assistant",
    delta: `[Long Task] Plan: ${steps.length} steps, ${groups.length} groups`,
  });
  log.info("Long Task: steps grouped", { stepCount: steps.length, groupCount: groups.length });

  try {
    writeFileSync(join(deps.sessionTaskDir, "plan.json"), JSON.stringify(steps, null, 2), "utf-8");
  } catch (err) {
    log.warn("Failed to write plan.json", { error: String(err) });
  }

  // Persist orchestration state for crash/restart recovery
  persistOrchestrationState(deps.sessionTaskDir, {
      artifactIdentity: orchestrationArtifactIdentity(deps),
    status: "executing",
    classification,
    steps,
    groups,
    completedGroupIds: [],
    currentGroupIdx: 0,
    maxIterations,
    userClarificationAnswer,
    groupFilesMapData: {},
    replyTrackerData: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // ═══ Phases 3 & 4: Execution + Audits ═══
  await executeGroupsFrom(classification, deps, steps, groups, 0, [], userClarificationAnswer, maxIterations);
}

/**
 * Execute groups only (Phase 3: execution + checkpoint audit).
 * Does NOT run final audit — caller handles that.
 * Keeps internalMode = true throughout (no premature bubble display).
 */
async function executeGroupsOnly(
  classification: AuditClassification,
  deps: LongTaskDeps,
  steps: Step[],
  groups: StepGroup[],
  startGroupIdx: number,
  executedGroupsInit: StepGroup[],
  initUserClarification: string,
  maxIterations: number,
  groupFilesTracker: GroupFilesTracker,
  replyTracker: GroupReplyTracker,
  notesTracker: GroupNotesTracker,
  continuationDirective?: string,
): Promise<{ lastLlmReply: string; executedGroups: StepGroup[]; userClarificationAnswer: string }> {
  const { emitEvent } = deps;
  const executedGroups: StepGroup[] = [...executedGroupsInit];
  let userClarificationAnswer = initUserClarification;
  let groupIndex = startGroupIdx;
  let lastLlmReply = "";

  while (groupIndex < groups.length) {
    // User abort: stop before the next group (covers post-audit loop re-entry)
    if (isAbortRequested()) {
      throw new OrchestrationAbortedError();
    }

    const group = groups[groupIndex]!;

    emitEvent({
      type: "thinking",
      role: "assistant",
      delta: `[Long Task] Executing group ${groupIndex + 1}/${groups.length}: ${group.id}`,
    });

    const executionPrompt = buildExecutionPrompt(classification, executedGroups, group, deps.workspaceDir, deps.sessionTaskDir, replyTracker, groupFilesTracker, notesTracker, deps.allSkills, deps.projectDir, groupIndex === startGroupIdx ? continuationDirective : undefined);
    let executionFailed = false;
    let groupFiles: string[] = [];
    try {
      const response = await promptAllowingClarification(deps, executionPrompt, classification, userClarificationAnswer);
      const rawText = extractTextFromResponse(response);

      // Continuation guard: ensure LLM produced structured output
      const { parsed, rawText: correctedText } = await ensureStructuredOutput(deps, classification, userClarificationAnswer, group, rawText);
      lastLlmReply = parsed.content || stripStructuredJson(correctedText);
      replyTracker[group.id] = lastLlmReply;
      if (parsed.notes_for_next_group) notesTracker[group.id] = parsed.notes_for_next_group;
      else delete notesTracker[group.id];

      // Track this group's declared files in the tracker (isolated per group)
      groupFiles = normalizeGroupOutputFiles(parsed.output_files, deps, group.id);
      groupFilesTracker[group.id] = [...groupFiles];

      if (groupFiles.length > 0) {
        log.info("Group output files declared", { group: group.id, files: groupFiles });
      }

      executedGroups.push(group);
    } catch (err) {
      if (err instanceof OrchestrationAbortedError) {
        // User abort — unwind the whole orchestration, not just this group
        throw err;
      }
      if (err instanceof ContextCompactionError) throw err;
      if (err instanceof OrchestrationSuspendedError) {
        const resumeIdx = groupIndex;
        const resumeExecuted = [...executedGroups];
        const resumeTracker = { ...groupFilesTracker };
        const resumeReplyTracker = { ...replyTracker };
        const resumeNotesTracker = { ...notesTracker };
        // The clarification answer re-runs this very group: keep the continuation
        // directive alive for it, or the instruction that re-started the task would
        // be dropped the moment the group asks a question.
        const resumeDirective = resumeIdx === startGroupIdx ? continuationDirective : undefined;
        _pendingOrchestration!.continuation = async (answer: string) => {
          await executeGroupsFrom(classification, deps, steps, groups, resumeIdx, resumeExecuted, appendClarification(userClarificationAnswer, answer), maxIterations, resumeTracker, resumeReplyTracker, resumeNotesTracker, resumeDirective);
        };
        return { lastLlmReply, executedGroups, userClarificationAnswer };
      }
      if (err instanceof MainLlmFatalError) {
        // Main LLM key/quota is dead — fail the conversation immediately instead of
        // continuing to the next groups / audit retries against an unusable key.
        log.error("Main LLM fatal error, aborting orchestration", { group: group.id, error: err.message });
        clearOrchestrationState(deps.sessionTaskDir);
        throw err;
      }
      executionFailed = true;
      log.error("Group execution failed", { group: group.id, error: String(err) });
      emitEvent({ type: "thinking", role: "assistant", delta: `[Long Task] Group ${group.id} execution failed: ${String(err)}` });
    }

    // TASK-003: Skip audit when execution threw an exception — audit on error context is meaningless
    if (executionFailed) {
      // Persist the next-group cursor before silently skipping. Without this,
      // a process restart retries the failed group instead of continuing.
      const existingState = readOrchestrationState(deps.sessionTaskDir);
      persistOrchestrationState(deps.sessionTaskDir, {
      artifactIdentity: orchestrationArtifactIdentity(deps),
        status: "executing",
        classification,
        steps,
        groups,
        completedGroupIds: executedGroups.map((executedGroup) => executedGroup.id),
        currentGroupIdx: groupIndex + 1,
        maxIterations,
        userClarificationAnswer,
        groupFilesMapData: { ...groupFilesTracker },
        replyTrackerData: { ...replyTracker },
        notesTrackerData: { ...notesTracker },
        createdAt: existingState?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      groupIndex++;
      continue;
    }

    // Checkpoint audit (uses this group's isolated file list)
    let checkpointResult = await runCheckpointAudit(group, classification, deps, executedGroups, lastLlmReply, groupFiles, userClarificationAnswer);
    appendAuditResult(deps.sessionTaskDir, { phase: "checkpoint", groupId: group.id, timestamp: new Date().toISOString(), ...checkpointResult });
    emitEvent({ type: "thinking", role: "assistant", delta: formatAuditProgress("Checkpoint", checkpointResult) });

    if (!checkpointResult.passed && !checkpointResult.skipped) {
      for (let retry = 1; retry <= maxIterations; retry++) {
        emitEvent({ type: "thinking", role: "assistant", delta: `[Audit] Redoing group ${group.id} (${retry}/${maxIterations}): ${checkpointResult.feedback}` });
        log.info("Retrying group", { group: group.id, retry, maxIterations });

        const outputRoot = deps.projectDir ?? deps.sessionTaskDir;
        const fileReminder = groupFiles.length > 0 ? "" : `\n⚠️ Important reminder: No output files were declared for this group. If the task requires files, save them to ${outputRoot} and declare them in output_files. A text-only result may keep output_files empty; do not create placeholder files.`;
        // Exclude current group from completed list to avoid contradictory "completed" + "re-execute" signals
        const completedForRetry = executedGroups.filter((g) => g.id !== group.id);
        // The redo replaces this group's execution prompt wholesale, so the
        // continuation directive has to be re-stated: dropping it here would let the
        // redo overwrite the very output the user's instruction asked for.
        const retryPrompt = `Please re-execute group ${group.id} (retry #${retry}):\nFeedback: ${checkpointResult.feedback}${fileReminder}\n${buildExecutionPrompt(classification, completedForRetry, group, deps.workspaceDir, deps.sessionTaskDir, replyTracker, groupFilesTracker, notesTracker, deps.allSkills, deps.projectDir, groupIndex === startGroupIdx ? continuationDirective : undefined)}`;
        try {
          const retryResponse = await promptAllowingClarification(deps, retryPrompt, classification, userClarificationAnswer);
          const retryRawText = extractTextFromResponse(retryResponse);

          // Continuation guard: ensure retry response has structured output
          const { parsed: retryParsed, rawText: correctedText } = await ensureStructuredOutput(deps, classification, userClarificationAnswer, group, retryRawText);
          lastLlmReply = retryParsed.content || stripStructuredJson(correctedText);
          replyTracker[group.id] = lastLlmReply;
          if (retryParsed.notes_for_next_group) notesTracker[group.id] = retryParsed.notes_for_next_group;
          else delete notesTracker[group.id];

          // Update group files from retry
          groupFiles = normalizeGroupOutputFiles(retryParsed.output_files, deps, group.id);
          groupFilesTracker[group.id] = [...groupFiles];
        } catch (err) {
          if (err instanceof OrchestrationAbortedError) {
            // User abort — unwind the whole orchestration, not just this retry
            throw err;
          }
          if (err instanceof ContextCompactionError) throw err;
          if (err instanceof OrchestrationSuspendedError) {
            const resumeIdx = groupIndex;
            // Bug 17 fix: Truncate executedGroups to before resumeIdx to prevent duplicates on continuation resume
            const resumeExecuted = completedGroupsBefore(groups, executedGroups, resumeIdx);
            const resumeTracker = { ...groupFilesTracker };
            const resumeReplyTracker = { ...replyTracker };
            const resumeNotesTracker = { ...notesTracker };
            const resumeDirective = resumeIdx === startGroupIdx ? continuationDirective : undefined;
            _pendingOrchestration!.continuation = async (answer: string) => {
              await executeGroupsFrom(classification, deps, steps, groups, resumeIdx, resumeExecuted, appendClarification(userClarificationAnswer, answer), maxIterations, resumeTracker, resumeReplyTracker, resumeNotesTracker, resumeDirective);
            };
            return { lastLlmReply, executedGroups, userClarificationAnswer };
          }
          if (err instanceof MainLlmFatalError) {
            // Dead key — stop the redo loop entirely, fail the conversation
            log.error("Main LLM fatal error during retry, aborting orchestration", { group: group.id, error: err.message });
            clearOrchestrationState(deps.sessionTaskDir);
            throw err;
          }
          // TASK-003: Retry execution failed — skip retry audit, continue to next retry
          log.error("Retry execution failed", { error: String(err) });
          continue;
        }

        const retryResult = await runCheckpointAudit(group, classification, deps, executedGroups, lastLlmReply, groupFiles, userClarificationAnswer);
        appendAuditResult(deps.sessionTaskDir, { phase: "checkpoint", groupId: `${group.id}_retry_${retry}`, timestamp: new Date().toISOString(), ...retryResult });
        emitEvent({ type: "thinking", role: "assistant", delta: formatAuditProgress("Retry", retryResult) });
        checkpointResult = retryResult;

        if (retryResult.passed || retryResult.skipped) break;
        if (retry === maxIterations) {
          emitEvent({ type: "thinking", role: "assistant", delta: `[Audit] Group ${group.id} reached max retries, continuing` });
          log.warn("Max retries reached for group", { group: group.id });
        }
      }
    }

    // Persist progress after group completion (for crash/restart recovery)
    const _existingState = readOrchestrationState(deps.sessionTaskDir);
    persistOrchestrationState(deps.sessionTaskDir, {
      artifactIdentity: orchestrationArtifactIdentity(deps),
      status: "executing",
      classification,
      steps,
      groups,
      completedGroupIds: executedGroups.map((g) => g.id),
      currentGroupIdx: groupIndex + 1,
      maxIterations,
      userClarificationAnswer,
      groupFilesMapData: { ...groupFilesTracker },
      replyTrackerData: { ...replyTracker },
      notesTrackerData: { ...notesTracker },
      createdAt: _existingState?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    groupIndex++;
  }

  return { lastLlmReply, executedGroups, userClarificationAnswer };
}

/**
 * Execute groups starting from `startGroupIdx`, then run final audit.
 * Extracted so that clarification suspension/resume can continue from the correct group.
 *
 * Flow: execute all groups (internalMode=true) → final audit → exit internalMode → send final notification as bubble.
 * The final audit uses a flat retry loop (no recursive executeGroupsFrom calls) to avoid
 * deeply nested audit chains.
 */
async function executeGroupsFrom(
  classification: AuditClassification,
  deps: LongTaskDeps,
  steps: Step[],
  groups: StepGroup[],
  startGroupIdx: number,
  executedGroupsInit: StepGroup[],
  initUserClarification: string,
  maxIterations: number,
  initTracker: GroupFilesTracker = {},
  initReplyTracker: GroupReplyTracker = {},
  initNotesTracker: GroupNotesTracker = {},
  continuationDirective?: string,
): Promise<void> {
  const { emitEvent } = deps;
  let executedGroups: StepGroup[] = [...executedGroupsInit];
  let userClarificationAnswer = initUserClarification;
  let startIdx = startGroupIdx;
  let tracker: GroupFilesTracker = { ...initTracker };
  let replyTracker: GroupReplyTracker = { ...initReplyTracker };
  let notesTracker: GroupNotesTracker = { ...initNotesTracker };
  // Injected once, on the group this call resumes at: a final-audit retry round is
  // driven by audit findings, not by the original continuation request.
  let pendingDirective = continuationDirective;

  // ═══ Phases 3 + 4: Execute groups → Final audit → Retry if needed ═══
  // Flat loop: each iteration runs groups from startIdx, then final audit.
  // If audit fails, update startIdx and loop again (no recursive calls).
  for (let finalAttempt = 0; finalAttempt <= maxIterations; finalAttempt++) {
    // User abort: stop before re-executing groups on the final-audit retry loop
    if (isAbortRequested()) {
      throw new OrchestrationAbortedError();
    }

    // On retry: clear tracker entries for groups that will be re-executed.
    // Groups before startIdx are preserved; groups from startIdx onward are cleared.
    // This is automatic because executeGroupsOnly overwrites tracker[group.id]
    // and we clear stale entries here:
    if (finalAttempt > 0) {
      for (const g of groups.slice(startIdx)) {
        delete tracker[g.id];
        delete replyTracker[g.id];
        delete notesTracker[g.id];
      }
    }

    // Phase 3: Execute groups (internalMode stays true throughout)
    const groupResult = await executeGroupsOnly(
      classification, deps, steps, groups, startIdx, executedGroups, userClarificationAnswer, maxIterations,
      tracker,
      replyTracker,
      notesTracker,
      pendingDirective,
    );
    // Consumed only when a group actually ran: a resume that lands straight in the
    // final audit must keep the directive for the audit-retry round below.
    if (startIdx < groups.length) pendingDirective = undefined;
    executedGroups = groupResult.executedGroups;
    userClarificationAnswer = groupResult.userClarificationAnswer;

    // If orchestration was suspended for clarification, bail out.
    // The continuation (set inside executeGroupsOnly) will re-enter executeGroupsFrom.
    if (_pendingOrchestration) return;

    const allFiles = flattenGroupFiles(tracker);

    // User abort: skip the final audit entirely
    if (isAbortRequested()) {
      throw new OrchestrationAbortedError();
    }

    // Phase 4: Final Audit
    emitEvent({ type: "thinking", role: "assistant", delta: "[Long Task] Final audit..." });
    log.info("Long Task: starting final audit", { attempt: finalAttempt, allFiles });

    const completedIds = new Set(executedGroups.map(group => group.id));
    const replyBudget = Math.max(1, Math.min(MAX_REPLY_CONTEXT_PER_GROUP, Math.floor(2000 / groups.length)));
    const executionSummary = groups.map(group =>
      `Group ${group.id}: ${completedIds.has(group.id) ? "executed" : "NOT completed"}\n` +
      truncateByTokens(replyTracker[group.id] || "(no result captured)", replyBudget).text,
    ).join("\n\n");
    // Report execution facts and let the lenient auditor judge goal fulfillment.
    // A redundant/skipped group or a recovered tool error is not a hard veto.
    const finalResult = await runFinalAudit(classification, deps, steps, executionSummary, allFiles, userClarificationAnswer);
    appendAuditResult(deps.sessionTaskDir, { phase: "final", timestamp: new Date().toISOString(), ...finalResult });
    emitEvent({ type: "thinking", role: "assistant", delta: formatAuditProgress("Final", finalResult) });

    if (finalResult.passed || finalResult.skipped) {
      log.info(finalResult.skipped ? "Long Task: final verification skipped" : "Long Task: final audit passed");
      await sendFinalNotification(deps, classification, finalResult, allFiles, executionSummary, userClarificationAnswer);
      return;
    }

    if (finalAttempt < maxIterations) {
      const retryFrom = finalResult.retryFrom || groups[groups.length - 1]?.id || "planning";
      emitEvent({ type: "thinking", role: "assistant", delta: `[Audit] Final audit failed, redoing from ${retryFrom} (${finalAttempt + 1}/${maxIterations}): ${finalResult.feedback}` });

      const retryGroupIdx = retryFrom === "planning" ? 0 : groups.findIndex((g) => g.id === retryFrom);
      startIdx = retryGroupIdx >= 0 ? retryGroupIdx : Math.max(0, groups.length - 1);
      // Bug 16 fix: Truncate executedGroups to before startIdx to prevent duplicate entries on retry
      // Issue: executeGroupsOnly pushes new groups from startIdx, but old groups remain in executedGroups
      // causing buildExecutionPrompt's "Completed Work" and checkpoint audit to show duplicate group IDs
      executedGroups = completedGroupsBefore(groups, executedGroups, startIdx);
      // Progress events are not model input. Restate the latest final findings
      // in the restarted group's prompt, replacing any consumed older findings.
      pendingDirective = [pendingDirective, `Final audit feedback (attempt ${finalAttempt + 1}):\n${finalResult.feedback}`].filter(Boolean).join("\n\n");
      // Loop continues: re-execute groups from startIdx, then final audit again
    } else {
      emitEvent({ type: "thinking", role: "assistant", delta: `[Long Task] Final audit reached max retries, finishing with current results` });
      log.warn("Long Task: final audit max retries reached");
      await sendFinalNotification(deps, classification, finalResult, allFiles, executionSummary, userClarificationAnswer);
    }
  }
}

function formatAuditProgress(phase: string, result: ScoreResult): string {
  return result.skipped
    ? `[Audit] ${phase} verification skipped; results remain unverified: ${result.feedback}`
    : `[Audit] ${phase} score: ${result.score}/100 ${result.passed ? "✓" : "✗"}`;
}

function artifactPromptEntry(
  deps: LongTaskDeps,
  file: string,
): { role: "intermediate" | "raw_data" | "regular" | "deliverable" | "unmanaged"; path: string } {
  const artifact = resolveArtifactFile(file, deps);
  return artifact
    ? { role: artifact.role, path: artifact.rootRelative }
    : { role: "unmanaged", path: file };
}

function deliveryDecisionExample(policy: ArtifactRunPolicy | undefined, projectScoped: boolean): string {
  const mode = policy?.delivery.mode ?? (projectScoped ? "none" : "deliverables");
  return mode === "selected_files"
    ? JSON.stringify({
        schema_version: "1.0",
        type: "delivery_decision",
        mode,
        files: (policy?.delivery.files ?? []).map((path) => ({ path })),
      })
    : JSON.stringify({ schema_version: "1.0", type: "delivery_decision", mode });
}

/** Exit internal mode after the audit attempt and summarize its actual outcome. */
async function sendFinalNotification(
  deps: LongTaskDeps,
  classification: AuditClassification,
  auditResult: ScoreResult,
  accumulatedFiles: string[],
  executionSummary: string,
  userClarificationAnswer: string,
): Promise<void> {
  const { emitEvent } = deps;

  // The main LLM sees every declared output and makes the structured delivery
  // decision. Runtime defaults are the fallback; no natural-language regex grants access.
  const declaredArtifacts = accumulatedFiles.map((file) => artifactPromptEntry(deps, file));
  const managedArtifacts = declaredArtifacts.filter((artifact) => artifact.role !== "unmanaged");
  const unmanagedArtifacts = declaredArtifacts.filter((artifact) => artifact.role === "unmanaged");
  const fileListForPrompt = managedArtifacts.length > 0
    ? managedArtifacts.map((artifact) => `- [${artifact.role}] ${artifact.path}`).join("\n")
    : "(no files declared)";
  const unmanagedLine = unmanagedArtifacts.length > 0
    ? `\nIgnored unmanaged declarations (not eligible for selected_files):\n${unmanagedArtifacts.map((artifact) => `- ${artifact.path}`).join("\n")}`
    : "";

  const auditFeedback = auditResult.feedback.trim().slice(0, 2000);
  const statusLine = auditResult.skipped
    ? `Execution ended; final verification was skipped. Results remain unverified. State this limitation in the final answer; do not claim an audit pass or a verified score.${auditFeedback ? ` Reason: ${auditFeedback}` : ""}`
    : auditResult.passed
    ? `The available results passed final audit (${auditResult.score}/100). Describe any uncompleted groups according to their actual impact on the core goal.`
    : `Execution ended, but final audit did not pass (${auditResult.score}/100).${auditFeedback ? ` Audit feedback: ${auditFeedback}` : ""}`;

  const projectDirLine = deps.projectDir ? `\nProject directory: ${deps.projectDir}` : "";

  const policy = deps.artifactRunPolicy;
  const policyInstruction = policy?.delivery.locked
    ? `- The protocol delivery mode is locked to ${policy.delivery.mode}; the final decision must not expand or replace it.`
    : `- The default delivery mode is ${policy?.delivery.mode ?? (deps.projectDir ? "none" : "deliverables")}; you may choose another mode from the user's request.`;
  const selectedFilesInstruction = policy?.delivery.locked && policy.delivery.mode === "selected_files"
    ? "- The locked selected_files paths come from the decision shape below; repeat them exactly even when they are historical Project files and are absent from this run's declarations."
    : "- When choosing selected_files in an unlocked run, use only exact Manifest-relative paths already established by the user request, execution history, or managed declarations; historical Project files are allowed, but do not guess paths and never select intermediate files.";
  const deliverInstruction = [
    "IMPORTANT: Follow the current instruction snapshot and run-scoped delivery policy; internal groups return their requested schema, only top-level completion uses the conversation delivery envelope.",
    policyInstruction,
    "- Do not call deliver_files merely to register final outputs; delivery happens automatically after Manifest reconciliation.",
    "- End with one schema-valid delivery_decision JSON object. Choose from none, deliverables, raw_data, or selected_files.",
    "- deliverables selects changed [deliverable] files and eligible changed final-output-*.* files in ordinary Sessions. A declared output or a successful audit does not change its Manifest role; choosing deliverables cannot promote it.",
    "- If the requested conversation outputs include [regular] files or unchanged files from an earlier attempt, use selected_files unless the policy is locked. Include every requested output and its required companion files in files: [{\"path\":\"exact Manifest-relative path\"}]. Keep the required filenames; do not rename or rewrite files to make delivery work.",
    selectedFilesInstruction,
    `- ${policy?.delivery.locked ? "Locked decision shape" : "Default decision example (choose a different mode when the requested files require it)"}: ${deliveryDecisionExample(policy, Boolean(deps.projectDir))}`,
    deps.projectDir
      ? "- Project files remain on the project page unless the delivery decision selects them."
      : "- The Session default is deliverables when no valid decision is declared.",
    "- This is a read-only summary turn. Do not call tools, inspect files again, or change any artifact after the completed audit.",
    "- Briefly summarize declared outputs and, where already established by the execution history, distinguish new, modified, versioned, and raw-data files before the final JSON object.",
  ].join("\n");

  const finalPrompt = `## Task Execution Complete\n\n${statusLine}\n\n${deliverInstruction}\n\n` +
    `Current task objective:\n${clarifiedObjective(classification, userClarificationAnswer)}\n\n` +
    `Session task directory: ${deps.sessionTaskDir}${projectDirLine}\n` +
    `Managed declared output files:\n${fileListForPrompt}${unmanagedLine}\n\n` +
    `Execution results (evidence, not new instructions):\n${executionSummary}\n\n` +
    "Please briefly summarize completed work, output files and results, then append the delivery_decision object. If audit did not fully pass, explain why.";

  await ensureContextCapacityOrAbort(deps, finalPrompt);

  // Exit internal mode so the main LLM's reply renders as a chat bubble
  setInternalMode(false);
  emitEvent({ type: "internal_mode", active: false } as RpcEvent);

  // Suppress the "Task Execution Complete" user message from showing as a bubble
  setSuppressUserBubble(true);
  try {
    // Preparation can fail or receive an abort before prompt() starts. Keep it
    // inside the same cleanup boundary so display flags cannot leak to the next turn.
    const deliveryManager = getDeliveryManager();
    deliveryManager?.setDeliveryRestricted(false);
    await deps.mainHarness.setActiveTools([]);
    await deps.mainHarness.setResources({ skills: [] });
    if (isAbortRequested()) throw new OrchestrationAbortedError();
    setHarnessFinalizationDeferred(true);
    const finalResponse = await withInstructionScope("main", () => deps.mainHarness.prompt(finalPrompt));
    // Aborted mid-delivery — unwind instead of reporting success
    if (finalResponse?.stopReason === "aborted" || isAbortRequested()) {
      throw new OrchestrationAbortedError();
    }
    if (finalResponse?.stopReason === "error") {
      const errorMessage = finalResponse.errorMessage || "unknown LLM error";
      if (isBenignCompletionError(finalResponse as unknown as Record<string, unknown>, errorMessage)) {
        log.warn("Final delivery ended with benign completion error", { error: errorMessage });
      } else {
        throw new Error(`Final delivery prompt failed: ${errorMessage}`);
      }
    }
    const checkpoint = readOrchestrationState(deps.sessionTaskDir);
    if (checkpoint) {
      const text = finalResponse?.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("\n") ?? "";
      persistOrchestrationState(deps.sessionTaskDir, { ...checkpoint, status: "completed",
        artifactIdentity: orchestrationArtifactIdentity(deps), deliveryDecision: parseDeliveryDecision(text), finalContent: stripDeliveryDecision(text), updatedAt: new Date().toISOString() });
    }
  } finally {
    setHarnessFinalizationDeferred(false);
    setSuppressUserBubble(false);
  }

  // NOTE: agent_end is emitted by the caller (prompt-handlers.ts finally block)
  // AFTER orchestration_completed, following the lifecycle:
  //   orchestration_resuming → ... → orchestration_completed → agent_end
  // Do NOT emit agent_end here — the caller owns the lifecycle completion.
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

/** Extract text content from a AssistantMessage response. */
function extractTextFromResponse(response: AssistantMessage): string {
  if (!response?.content) return "";
  return response.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => (block as TextContent).text)
    .join("\n");
}

/**
 * Parse step JSON from a AssistantMessage response.
 * Looks for JSON array in the text content.
 */
function parseStepsFromResponse(response: AssistantMessage): Step[] {
  // A provider may split a single JSON value across text blocks, even in a string.
  const text = response.content.filter((block): block is TextContent => block.type === "text")
    .map(block => block.text).join("");
  return extractStepArray(text) ?? [];
}

/**
 * Accept complete step arrays only; never cast unrelated JSON data into a plan.
 */
function parseStepArray(text: string): Step[] | null {
  try {
    // Keep legacy trailing-comma tolerance without editing quoted descriptions.
    const fixed = text.replace(/"(?:[^"\\]|\\.)*"|,\s*([\]}])/g, (match, closing: string | undefined) => closing ?? match);
    const parsed: unknown = JSON.parse(fixed);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const ids = new Set<string>();
    for (const step of parsed) {
      if (!step || typeof step !== "object" || Array.isArray(step)
        || typeof step.id !== "string" || !step.id.trim() || ids.has(step.id)
        || typeof step.description !== "string" || !step.description.trim()
        || ["group", "skill", "workflowStage"].some(key => step[key] !== undefined && typeof step[key] !== "string")) return null;
      ids.add(step.id);
    }
    return parsed as Step[];
  } catch { /* Incomplete or malformed JSON is corrected by the model, never guessed. */ }
  return null;
}

/** Scan balanced arrays so brackets in prose/strings and other blocks do not swallow the plan. */
function extractStepArray(text: string): Step[] | null {
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\" && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) {
        const steps = parseStepArray(text.slice(start, i + 1));
        if (steps) return steps;
        // Do not salvage a nested fragment of a complete but invalid array.
        start = i;
        break;
      }
    }
  }
  return null;
}

/**
 * Group steps by their `group` field, or by default chunking (3 per group).
 */
function groupSteps(steps: Step[]): StepGroup[] {
  const groupMap = new Map<string, Step[]>();

  for (const step of steps) {
    const groupId = step.group || `group_${Math.floor((steps.indexOf(step)) / 3) + 1}`;
    if (!groupMap.has(groupId)) {
      groupMap.set(groupId, []);
    }
    groupMap.get(groupId)!.push(step);
  }

  return Array.from(groupMap.entries()).map(([id, steps]) => ({ id, steps }));
}

/**
 * Run checkpoint audit for a single group.
 */
async function runCheckpointAudit(
  group: StepGroup,
  classification: AuditClassification,
  deps: LongTaskDeps,
  executedGroups: StepGroup[],
  lastLlmReply: string,
  groupFiles: string[],
  userClarificationAnswer: string,
): Promise<ScoreResult> {
  const fileListContent = groupFiles.length > 0 ? groupFiles.join("\n") : "(none)";
  return auditScore(
    "checkpoint",
    deps.auditModelObj,
    deps.auditConfig,
    deps.env,
    deps.allTools,
    deps.allSkills,
    {
      goals: classification.goals || [],
      criteria: classification.acceptanceCriteria || [],
      results: `Completed groups: ${executedGroups.map((g) => g.id).join(", ")}\nCurrent group: ${group.id}\nSteps: ${group.steps.map((s) => s.description).join("; ")}`,
      plan: clarifiedObjective(classification, userClarificationAnswer),
      sessionTaskDir: deps.sessionTaskDir,
      workspaceDir: deps.workspaceDir,
      projectDir: deps.projectDir,
      runtimeContext: deps.runtimeContext,
      lastLlmReply,
      fileListContent,
    },
    deps.emitEvent,
    deps.llmTracking,
  );
}

/**
 * Run final audit for the entire task.
 * Uses the groups' explicitly declared output files as the audit output file list.
 */
async function runFinalAudit(
  classification: AuditClassification,
  deps: LongTaskDeps,
  allSteps: Step[],
  lastLlmReply: string,
  accumulatedFiles: string[],
  userClarificationAnswer: string,
): Promise<ScoreResult> {
  const fileListContent = accumulatedFiles.length > 0 ? accumulatedFiles.join("\n") : "(none)";

  // ═══ Primary deliverable check: use this run's declared managed outputs only ═══
  // Neutral fact report — the audit prompt scores it via the "Primary deliverable
  // existence" rubric item (10 points); it is no longer a hard fail gate.
  let finalOutputCheck = "";
  let finalOutputFound = false;

  const primaryArtifact = accumulatedFiles
    .map((file) => resolveArtifactFile(file, deps))
    .find((artifact) => artifact
      && artifact.role === "deliverable"
      && /^final-output/.test(basenamePath(artifact.rootRelative))
      && (deps.projectDir
        ? artifact.root === "project" && artifact.rootRelative.startsWith(`${projectDeliverablesDirectory()}/`)
        : artifact.root === "session"));

  if (primaryArtifact) {
    const primaryName = basenamePath(primaryArtifact.rootRelative);
    finalOutputCheck = `Primary deliverable check: '${primaryName}' FOUND in this run's declared managed outputs`;
    finalOutputFound = true;
    log.info("Final audit: declared primary deliverable found", { file: primaryArtifact.rootRelative });
    deps.emitEvent({ type: "thinking", role: "assistant", delta: `[Audit] Declared primary deliverable '${primaryName}' found` });
  }

  if (!finalOutputFound) {
    const searchLocations = deps.projectDir
      ? join(deps.projectDir, projectDeliverablesDirectory())
      : deps.sessionTaskDir;
    finalOutputCheck = `Primary deliverable check: no current declared managed 'final-output-*' file found for ${searchLocations}. Whether this costs the 10-point rubric item depends on whether the task explicitly requires it`;
    log.info("Final audit: no current declared 'final-output-*' file found", { searchLocations });
    deps.emitEvent({ type: "thinking", role: "assistant", delta: `[Audit] No current declared 'final-output-*' file found for ${searchLocations}` });
  }

  return auditScore(
    "final",
    deps.auditModelObj,
    deps.auditConfig,
    deps.env,
    deps.allTools,
    deps.allSkills,
    {
      goals: classification.goals || [],
      criteria: classification.acceptanceCriteria || [],
      results: `Planned steps: ${allSteps.length}. Consult the per-group execution results for actual completion; never assume every planned step ran.\nStep list:\n${allSteps.map((s) => `- ${s.id}: ${s.description}`).join("\n")}`,
      plan: clarifiedObjective(classification, userClarificationAnswer),
      sessionTaskDir: deps.sessionTaskDir,
      workspaceDir: deps.workspaceDir,
      projectDir: deps.projectDir,
      runtimeContext: deps.runtimeContext,
      lastLlmReply,
      fileListContent,
      finalOutputCheck,
    },
    deps.emitEvent,
    deps.llmTracking,
  );
}
