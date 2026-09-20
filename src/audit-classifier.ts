import { buildInstructionPrompt } from "./instruction-snapshot.ts";
import { formatInstructionScope } from "./instruction-scope.ts";
import { formatRuntimeContextForModel, type DeepReadonly, type RuntimeContextSnapshot } from "./runtime-context.ts";
import { projectDeliverablesDirectory } from "./gateway-project.ts";
/**
 * HogAgent Audit Classifier
 *
 * Audit model direct-call module. The audit model has no mode concept —
 * its behavior is determined entirely by the calling phase's context
 * (system prompt + tools + skills).
 *
 * Phases:
 * - classifyIntent: prompt optimization for long_task (direct LLM call, no harness)
 * - auditScore: Long Task audit scoring (temporary AgentHarness, read-only tools)
 */

import { Type } from "@sinclair/typebox";
import type { Message, Model } from "./vendor/ai/types.ts";
import type { AuditClassification, AuditModelConfig, RpcEvent, ScoreResult } from "./utils/types.ts";
import type { AgentTool } from "./vendor/agent/types.ts";
import type { Skill, ExecutionEnv } from "./vendor/agent/harness/types.ts";
import { AgentHarness } from "./vendor/agent/harness/agent-harness.ts";
import { Session } from "./vendor/agent/harness/session/session.ts";
import { InMemorySessionStorage } from "./vendor/agent/harness/session/memory-storage.ts";
import { streamSimple } from "./vendor/ai/stream.ts";
import { lstatSync, realpathSync, statSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createLogger } from "./utils/logger.ts";
import { isPathInside } from "./utils/path-safety.ts";
import { truncateByTokens } from "./utils/token-estimation.ts";
import { isLlmKeyOrQuotaError, AuditModelUnavailableError, OrchestrationAbortedError } from "./utils/llm-error.ts";
import { isMainTurnStarted, isAbortRequested } from "./agent-state.ts";
import { buildLlmMetadata, registerLlmMetadataHook, type LlmTrackingContext } from "./llm-metadata-hook.ts";

const log = createLogger("audit-classifier");

/** Preserve the existing continue-with-results policy without claiming verification. */
function skippedAudit(feedback: string): ScoreResult {
  return { score: 0, passed: false, skipped: true, feedback, retryFrom: null };
}

// ─── Active Audit Harness Registry (for user abort) ─────────────────────────

/** The audit harness is a temporary instance created inside auditScore and is
 *  unreachable from the main harness abort path. Register it here so onAbort
 *  can stop a running audit immediately instead of waiting out the timeout. */
let _activeAuditHarness: AgentHarness | undefined;

const CLASSIFICATION_TIMEOUT_MS = 60_000;

class IntentClassificationTimeoutError extends Error {
  constructor() {
    super(`Intent classification timed out after ${CLASSIFICATION_TIMEOUT_MS / 1000}s`);
    this.name = "IntentClassificationTimeoutError";
  }
}

interface ActiveClassification {
  abort(error: Error): void;
}

let _activeClassification: ActiveClassification | undefined;

/** Abort the active classification call and/or audit harness. Fire-and-forget. */
export function abortActiveAuditHarness(): void {
  _activeClassification?.abort(new OrchestrationAbortedError());
  const harness = _activeAuditHarness;
  harness?.abort().catch((err: unknown) => {
    log.debug("Failed to abort active audit harness", { error: String(err) });
  });
}

// ─── Audit Usage Tracking ────────────────────────────────────────────────────

/** Accumulated token usage shape (aligned with vendor Usage minus cost). */
interface AuditUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

function emptyAuditUsage(): AuditUsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function addAuditUsage(target: AuditUsageStats, src: AuditUsageStats | undefined): void {
  if (!src) return;
  target.input += src.input || 0;
  target.output += src.output || 0;
  target.cacheRead += src.cacheRead || 0;
  target.cacheWrite += src.cacheWrite || 0;
  target.totalTokens += src.totalTokens || 0;
}

/**
 * Persist one audit usage record to <sessionTaskDir>/audit-usage.json (append to array).
 * Non-fatal: failures are logged but never throw.
 */
function persistAuditUsage(
  sessionTaskDir: string | undefined,
  phase: string,
  usage: AuditUsageStats,
): void {
  if (!sessionTaskDir || usage.totalTokens === 0) return;
  try {
    if (!existsSync(sessionTaskDir)) mkdirSync(sessionTaskDir, { recursive: true });
    const usageFile = join(sessionTaskDir, "audit-usage.json");
    let records: unknown[] = [];
    if (existsSync(usageFile)) {
      try {
        const parsed = JSON.parse(readFileSync(usageFile, "utf8"));
        if (Array.isArray(parsed)) records = parsed;
      } catch { /* corrupt file: start fresh */ }
    }
    records.push({ phase, usage, timestamp: new Date().toISOString() });
    writeFileSync(usageFile, JSON.stringify(records, null, 2));
  } catch (err) {
    log.warn("Failed to persist audit usage", { phase, error: String(err) });
  }
}

/** Emit thinking_end with audit usage and persist to disk. */
function emitAuditUsage(
  emitEvent: ((event: RpcEvent) => void) | undefined,
  sessionTaskDir: string | undefined,
  phase: string,
  usage: AuditUsageStats,
  tracking?: LlmTrackingContext,
): void {
  const count = (value: number) => Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  usage = {
    input: count(usage.input), output: count(usage.output),
    cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite), totalTokens: count(usage.totalTokens),
  };
  usage.totalTokens = Math.max(usage.totalTokens, usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
  if (usage.totalTokens === 0) return;
  emitEvent?.({
    type: "thinking_end",
    role: "assistant",
    usage,
    source: "audit",
    phase,
    ...(tracking?.sessionId ? { session_id: tracking.sessionId } : {}),
    ...(tracking?.workId ? { work_id: tracking.workId } : {}),
    ...(tracking?.taskId ? { task_id: tracking.taskId } : {}),
  });
  persistAuditUsage(sessionTaskDir, phase, usage);
}

// ─── 4a. Prompt Optimization (Direct LLM, no harness) ──────────────────────

/**
 * Build system prompt for intent classification.
 * Simple complexity classification — no skill matching or file reading.
 */
function buildClassifySystemPrompt(sessionTaskDir: string, projectDir?: string): string {
  const deliverableDir = projectDir ? `${projectDir} (deliverables go to ${projectDeliverablesDirectory()}/, code goes to src/, raw data goes to data/)` : sessionTaskDir;
  return `You are a task analysis expert. Classify user requests, optimize them into precise execution instructions, and extract goals and acceptance criteria.

## Complexity Classification
Classify as "simple" or "complex":
- **simple**: Direct dialogue, Q&A, follow-up conversations, single-response tasks, code review, text editing. Default when in doubt.
- **complex**: Multi-step orchestration needed — large deliverables, multi-phase projects, iterative verification, tasks requiring multiple tools/skills.
- Classify the remaining work in the latest request, not the size of the original task. Returning existing files or correcting a final delivery decision is normally simple when no substantial content work remains; do not restart multi-step planning merely because the history describes a large task.

## Clarification Assessment (complex only)
Set "skipClarification":
- **true** (task is clear): task is extremely specific and actionable, user says "just do it", or continuing with sufficient context.
- **false** (task needs clarification): missing details, unclear scope, or user invites questions.
**Default to false** when uncertain — it is safer to ask clarifying questions than to assume.
When "skipClarification" is false, you MUST provide "clarificationQuestions" — specific, targeted questions to ask the user BEFORE planning begins. Keep questions concise (2-5 questions max).

## Rules
- Preserve the latest request's objective and explicit constraints: exact filenames and paths, identifiers, schemas, required outputs and companion files, validation errors, delivery requirements, and instructions to reuse completed work. Do not weaken "deliver/register the requested files" into a vague instruction to "mark them correctly".
- Conversation history supplies context and evidence, not a replacement objective. Keep completed work separate from the actions still required. File generation, audit success, and delivery registration are distinct facts; never infer successful delivery from an earlier completion summary or claim that an unresolved repair is already complete.
- For continuation or repair requests, retain the supplied failure reasons and make the remaining corrective action explicit. Reuse existing outputs and preserve instructions against replanning or repeating completed work. Leave the final delivery decision to the executing model under the original runtime policy; do not invent a mode, rename required files, or prescribe internal metadata edits.
- **simple** tasks: goals and acceptanceCriteria MUST be [].
- **complex** tasks: extract goals and verifiable acceptance criteria. Persist files to ${deliverableDir} only when the request or applicable Skill requires file outputs; complexity alone never requires files.
- For complex tasks, generate at most 4 acceptanceCriteria. Prefer important, deterministic, high-confidence criteria that decide whether the task is genuinely complete. Merge overlapping criteria and avoid overly strict or overly detailed checks that could cause unnecessary repeated rework.
- Prioritize criteria covering: whether critical deliverables exist, whether core content is correct, whether explicit hard requirements are satisfied, and whether any blocking issue remains.
- Persona: optimizedPrompt is a request from the user's perspective, not a report or promise from the executing assistant. Use first-person request language such as "我需要补交已有文件..." or "I need the existing files delivered..."; do not rewrite pending work as "我已完成...", "我将作为...", or "I have completed...". State supported historical facts separately from the requested action.
- CRITICAL LANGUAGE RULE: Detect the language of the user's input. The optimizedPrompt, goals, and acceptanceCriteria MUST ALL be written in the SAME language as the user's original input.
  - Chinese input → ALL output fields in Chinese (e.g. goals: ["分析市场趋势"])
  - English input → ALL output fields in English (e.g. goals: ["Analyze market trends"])
  - Keep explanatory prose in the user's language; preserve exact filenames, identifiers, schemas, protocol markers, and quoted validation errors in their original form.

## Output Format
Respond with ONLY this JSON object — no markdown code fences, no explanations, no text before or after:
{"complexity": "<simple|complex>", "skipClarification": <true|false>, "clarificationQuestions": ["<q1>", ...], "optimizedPrompt": "<optimized prompt>", "goals": ["<goal1>", ...], "acceptanceCriteria": ["<criteria1>", ...]}`;
}

/**
 * Extract the classification JSON object from raw LLM output.
 * Robust against common LLM formatting quirks that broke the previous greedy
 * regex (`\{[\s\S]*"optimizedPrompt"[\s\S]*\}`):
 * - JSON wrapped in ```json fences with prose before/after
 * - Multiple JSON blocks in one response (only the one with "optimizedPrompt" counts)
 * - Braces inside surrounding explanation text
 * Uses balanced-brace scanning and tries each candidate object independently.
 */
export function extractClassificationJson(text: string): Record<string, unknown> | null {
  if (!text) return null;

  // Prefer fenced code block contents, then fall back to the full text
  const sources: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let fence: RegExpExecArray | null;
  while ((fence = fenceRe.exec(text)) !== null) {
    if (fence[1].includes('"optimizedPrompt"')) sources.push(fence[1]);
  }
  sources.push(text);

  for (const source of sources) {
    // Scan balanced top-level objects; try to parse each candidate containing the key
    for (let start = source.indexOf("{"); start !== -1; start = source.indexOf("{", start + 1)) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = inString; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const candidate = source.slice(start, i + 1);
            if (candidate.includes('"optimizedPrompt"')) {
              try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  return parsed as Record<string, unknown>;
                }
              } catch {
                // Malformed candidate — keep scanning from the next "{"
              }
            }
            break;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Classify user intent. Direct LLM call (no Harness), outputs JSON.
 * Only used in long_task mode to extract goals and acceptance criteria.
 * Audit model output is not persisted; results are consumed directly in code.
 */
export async function classifyIntent(
  auditModelObj: Model<any>,
  auditApiKey: string,
  userMessage: string,
  workspaceDir: string,
  _env: ExecutionEnv,
  emitEvent?: (event: RpcEvent) => void,
  conversationHistory?: Message[],
  sessionTaskDir?: string,
  tracking?: LlmTrackingContext,
  projectDir?: string,
  runtimeContext?: DeepReadonly<RuntimeContextSnapshot>,
): Promise<AuditClassification> {
  const usageOwner = tracking ? { ...tracking } : undefined;
  const fallback: AuditClassification = {
    optimizedPrompt: userMessage, goals: [], acceptanceCriteria: [],
    complexity: "simple", skipClarification: false,
  };

  if (emitEvent && isMainTurnStarted()) {
    emitEvent({ type: "thinking", role: "assistant", delta: "[Audit] Analyzing intent..." });
  }

  // Build messages: conversation history + current user request
  const messages: Message[] = [];
  if (conversationHistory && conversationHistory.length > 0) {
    messages.push(...conversationHistory);
  }
  messages.push({
    role: "user",
    content: [{ type: "text", text: userMessage }],
    timestamp: Date.now(),
  });

  // Single classification round: call the audit model and collect text output + usage
  const classificationPrompt = buildInstructionPrompt(workspaceDir) + formatRuntimeContextForModel(runtimeContext)
    + "\n\n" + buildClassifySystemPrompt(sessionTaskDir || "", projectDir) + formatInstructionScope("classification", []);

  // Accumulate audit usage across initial call + optional retry.
  const classifyUsage = emptyAuditUsage();

  // Register cancellation only after all synchronous prompt preparation has
  // succeeded. Otherwise a preparation error could strand the global handle
  // and its timer outside the try/finally cleanup boundary below.
  const controller = new AbortController();
  let rejectGuard!: (error: Error) => void;
  let guardSettled = false;
  const guard = new Promise<never>((_resolve, reject) => { rejectGuard = reject; });
  const activeClassification: ActiveClassification = {
    abort(error) {
      if (guardSettled) return;
      guardSettled = true;
      rejectGuard(error);
      controller.abort();
    },
  };
  _activeClassification = activeClassification;
  const classificationTimer = setTimeout(
    () => activeClassification.abort(new IntentClassificationTimeoutError()),
    CLASSIFICATION_TIMEOUT_MS,
  );
  const guarded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, guard]);

  const runClassification = async (msgs: Message[]): Promise<{ text: string; usage: AuditUsageStats }> => {
    const stream = streamSimple(auditModelObj, {
      systemPrompt: classificationPrompt,
      messages: msgs,
    }, {
      apiKey: auditApiKey,
      signal: controller.signal,
      // Inject tracking metadata into request body for LLM proxy usage stats
      onPayload: usageOwner ? (payload) => {
        const body = payload as Record<string, unknown>;
        return { ...body, metadata: buildLlmMetadata(usageOwner) };
      } : undefined,
    });
    let responseText = "";
    for await (const event of stream) {
      if (event.type === "text_delta" && typeof event.delta === "string") {
        responseText += event.delta;
      }
      // Surface provider errors (previously swallowed → empty response → pointless retry)
      if (event.type === "error" && event.reason === "error") {
        // Providers can report non-zero consumption on failed/cancelled calls.
        // The error exits before stream.result(), so preserve its returned usage here.
        addAuditUsage(classifyUsage, event.error?.usage);
        throw new Error(event.error?.errorMessage || "audit model stream error");
      }
    }
    // Extract usage from the completed stream result
    const msg = await stream.result();
    const u = msg.usage;
    return {
      text: responseText,
      usage: { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0, totalTokens: u.totalTokens || 0 },
    };
  };

  try {
    const first = await guarded(runClassification(messages));
    addAuditUsage(classifyUsage, first.usage);
    let responseText = first.text;
    log.info("Classification response", { length: responseText.length });

    let parsed = extractClassificationJson(responseText);

    // One corrective retry: with long conversation histories, lightweight audit
    // models sometimes answer the user directly instead of emitting the JSON.
    if (!parsed) {
      log.warn("Classification output unparsable, retrying once", { preview: responseText.slice(0, 300) });
      const retryMessages: Message[] = [
        ...messages,
        {
          role: "user",
          content: [{ type: "text", text: "Your previous response could not be parsed. Do NOT answer the request itself. Respond with ONLY the JSON object in the exact Output Format from the system instructions — no markdown code fences, no explanations, no text before or after." }],
          timestamp: Date.now(),
        },
      ];
      const retry = await guarded(runClassification(retryMessages));
      addAuditUsage(classifyUsage, retry.usage);
      responseText = retry.text;
      log.info("Classification retry response", { length: responseText.length });
      parsed = extractClassificationJson(responseText);
    }

    // Emit audit usage for classify phase
    emitAuditUsage(emitEvent, sessionTaskDir, "classify", classifyUsage, usageOwner);

    if (parsed) {
      const strings = (value: unknown): string[] => Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      return {
        optimizedPrompt: typeof parsed.optimizedPrompt === "string" && parsed.optimizedPrompt ? parsed.optimizedPrompt : userMessage,
        goals: strings(parsed.goals),
        acceptanceCriteria: strings(parsed.acceptanceCriteria),
        complexity: parsed.complexity === "complex" ? "complex" : "simple",
        skipClarification: parsed.skipClarification === true,
        clarificationQuestions: strings(parsed.clarificationQuestions),
      };
    }

    log.warn("Classification JSON parse failed after retry, using original message", { preview: responseText.slice(0, 300) });
    // Surface the silent degradation to the user (task will run as "simple")
    emitEvent?.({ type: "warning", message: "Intent classification returned invalid output — falling back to simple mode for this message" });
    return fallback;
  } catch (err) {
    // Emit whatever usage was accumulated before the error
    emitAuditUsage(emitEvent, sessionTaskDir, "classify", classifyUsage, usageOwner);

    const msg = err instanceof Error ? err.message : String(err);
    log.error("Classification direct call failed", { error: msg });
    if (err instanceof OrchestrationAbortedError) throw err;
    // Audit model's own key is unusable (invalid key / quota exhausted):
    // propagate so the caller degrades this turn to standard mode instead of
    // silently running a crippled long_task flow.
    if (isLlmKeyOrQuotaError(msg)) {
      throw new AuditModelUnavailableError(msg);
    }
    emitEvent?.({ type: "warning", message: `Intent classification failed (${msg}) — falling back to simple mode for this message` });
    return fallback;
  } finally {
    guardSettled = true;
    clearTimeout(classificationTimer);
    if (_activeClassification === activeClassification) _activeClassification = undefined;
  }
}

// ─── 4b. Audit Score (Temporary AgentHarness) ─────────────────────────────────

/**
 * Code-level hard veto rules. When a rule fires it OVERRIDES the score-based
 * decision: the audit is forced to `passed = false` with `score = 0`, and the
 * veto name/reason is prepended to the feedback. The list is currently empty —
 * pass/fail is decided purely by `score >= minPassScore`.
 */
interface HardVetoRule {
  name: string;
  /** Return a non-null reason string to fire the veto for this audit result. */
  check: (result: ScoreResult, ctx: { phase: "checkpoint" | "final" }) => string | null;
}
const HARD_VETO_RULES: HardVetoRule[] = [];

/**
 * Checkpoint audit prompt. The passing threshold is injected so the auditor
 * can align its record-only `passed` field and its retryFrom obligation with
 * the system's score-based decision.
 */
function buildCheckpointAuditPrompt(minPassScore: number): string {
  return `You are a checkpoint auditor. Your role is to verify the execution results of the current step group.

## Verification Rules
1. Verify the current step group's execution results only against the subset of task goals and acceptance criteria that is applicable to this group. Ignore requirements assigned to later groups or to the final deliverable
2. The audit content consists of two parts: **output file list** and **main LLM's last reply**. The file list records group outputs and does not imply conversation delivery
3. Read only the declared paths below. Paths are absolute or relative to workspaceDir, never relative to sessionTaskDir/projectDir. Do not add another task/project prefix
4. **Do NOT** scan directories, search files, or guess file names on your own — strictly follow the output file list
5. If the output file list is empty or listed files cannot be read, prioritize scoring based on the **main LLM's last reply**; if the reply meets the requirements applicable to this group, award it directly (**award a total score at or above the passing threshold (${minPassScore})**, set retryFrom to null), do NOT fail solely because "files not found"
6. **RAW DATA FILES**: For Session files whose names start with "data-", or Project files under "data/" — do NOT read their content. Verify the path appears in the group output list and assess its existence against the applicable requirement. Raw data may be the core result of an acquisition task; it is not automatically an intermediate file. Reading large raw files here wastes tokens
7. Score 0-100, then call submit_score. The system decides pass/fail by comparing your score against the passing threshold (${minPassScore}); set \`passed\` to true if and only if score >= ${minPassScore}. If score < ${minPassScore}, retryFrom is MANDATORY — set it to the current group ID
8. Verify at most 2 decisive points for this checkpoint. Focus on the current group's essential outcome and do not expand acceptance criteria into finer-grained checks
9. Prioritize whether deliverables expected from the current group exist, the current group's core result is correct, explicit hard requirements for this group are satisfied, and blocking issues for subsequent groups remain. Do NOT require final deliverables or later-group outcomes before their planned group has completed
10. Non-blocking detail issues may be noted in feedback, but MUST NOT by themselves fail the checkpoint or trigger group re-execution

## CRITICAL: Anti-Hallucination Rules
- If a file read tool returns an error (file not found, cannot be read, etc.), treat its content as UNVERIFIED; only an explicit not-found result proves it is missing. Do NOT fabricate, imagine, or assume its content.
- Your judgment MUST be based ONLY on actual tool results and the supplied execution results. NEVER invent file content.
- This is a ONE-SHOT evaluation. Score once based on what you can actually verify, then call submit_score. Do NOT loop or re-verify.

Note: If a "Project directory" is provided below, deliverables may also be located there. Use the absolute path shown to read files from the project directory.`;
}

function buildFinalAuditPrompt(minPassScore: number): string {
  return `You are a final auditor. Your role is to verify all deliverables.

## Verification Rules
1. Verify all deliverables against task goals and acceptance criteria
2. The audit content consists of two parts: **output file list** and **main LLM's last reply**. The file list records task outputs and does not imply conversation delivery
3. Read only the declared paths below, combined with the supplied execution results. Paths are absolute or relative to workspaceDir, never relative to sessionTaskDir/projectDir. Do not add another task/project prefix
4. **Do NOT** scan directories, search files, or guess file names on your own — strictly follow the output file list
5. **PRIMARY DELIVERABLE CHECK**: A "PRIMARY DELIVERABLE CHECK" section is provided below, reporting whether a \`final-output-*\` file was found. Use it ONLY to score the "Primary deliverable existence" rubric item. Do NOT fail the audit solely because this file is missing — the pass/fail decision is made by the system from the total score
6. **RAW DATA FILES**: For Session files whose names start with "data-", or Project files under "data/" — do NOT read their content. Verify the path appears in the group output list and assess its existence against the applicable requirement. Raw data may be the core result of an acquisition task; it is not automatically an intermediate file. Reading large raw files here wastes tokens
7. For non-critical files: if the output file list is empty or listed files cannot be read, prioritize scoring based on the **main LLM's last reply**; if the reply meets requirements, award it directly (**award a total score at or above the passing threshold (${minPassScore})**, set retryFrom to null), do NOT fail solely because "files not found"
8. Within the 4 decisive checks below, verify deliverable completeness and only quality requirements explicitly requested by the user; do not invent additional quality standards
9. Call submit_score to submit the score. If the total score is below the passing threshold (${minPassScore}), retryFrom is MANDATORY — set it to the group ID that needs redo (earliest can be "planning")
10. Verify at most 4 decisive points for the final audit. Merge overlapping checks and do not expand acceptance criteria into finer-grained checks
11. Prioritize whether critical deliverables exist, core content is correct, explicit hard requirements are satisfied, and blocking issues remain
12. Non-blocking detail issues may be noted in feedback, but MUST NOT by themselves fail the final audit or trigger group re-execution

## Scoring Rubric (total 100 points)
Score each item below and sum them to obtain the final score:
1. Primary deliverable existence (10 points): If the task goals, acceptance criteria, or a matched skill explicitly requires a \`final-output-*\` file, AND the "PRIMARY DELIVERABLE CHECK" section below reports NOT FOUND, award 0 for this item. In all other cases (not explicitly required, or the file was found), award the full 10 points.
2. Goal fulfillment (40 points): How well the deliverables and the supplied execution results satisfy the task goals and acceptance criteria.
3. Deliverable correctness & completeness (30 points): Accuracy, structure, and completeness of the deliverables you actually read.
4. Explicit hard requirements (20 points): Only hard requirements explicitly stated by the user; do not invent additional quality standards.
The system decides pass/fail by comparing the total score against the passing threshold (${minPassScore}). Set \`passed\` to true if and only if total score >= ${minPassScore}.

## CRITICAL: Anti-Hallucination Rules
- If a file read tool returns an error (file not found, cannot be read, etc.), treat its content as UNVERIFIED; only an explicit not-found result proves it is missing. Do NOT fabricate, imagine, or assume its content.
- Your judgment MUST be based ONLY on actual tool results and the supplied execution results. NEVER invent file content.
- This is a ONE-SHOT evaluation. Score once based on what you can actually verify, then call submit_score. Do NOT loop or re-verify.

Note: If a "Project directory" is provided below, deliverables may also be located there. Use the absolute path shown to read files from the project directory.`;
}

/**
 * Create submit_score tool and register it with the temporary audit Harness.
 * When the audit model calls this tool, the scoring result is passed back to the orchestrator via the resolve callback.
 *
 * Threshold decision: pass/fail is normalized here as `score >= minPassScore`.
 * The LLM-supplied `passed` field is record-only and never overrides the
 * decision. Code-level hard veto rules (HARD_VETO_RULES) can still force a
 * failure regardless of the score.
 */
function createSubmitScoreTool(resolve: (result: ScoreResult) => void, minPassScore: number, phase: "checkpoint" | "final"): AgentTool {
  return {
    name: "submit_score",
    label: "Submit Audit Score",
    description: "Submit audit scoring result. Must be called after verification is complete.",
    parameters: Type.Object({
      score: Type.Number({ description: "Total score 0-100 per the scoring rubric. The system passes the audit if score >= passing threshold" }),
      passed: Type.Boolean({ description: "Record-only: should reflect score >= passing threshold. The system recomputes pass/fail from the score; this field never overrides the decision" }),
      feedback: Type.String({ description: "Detailed feedback" }),
      retryFrom: Type.Optional(Type.String({ description: "Group ID to redo. MANDATORY when score < passing threshold" })),
    }),
    execute: async (_id: string, raw: unknown) => {
      const args = raw as Record<string, unknown>;
      const rawScore = Number(args.score);
      const score = isNaN(rawScore) ? 0 : Math.min(Math.max(rawScore, 0), 100);
      const result: ScoreResult = {
        score,
        // Ignore the LLM's `passed` — the decision is score >= minPassScore
        passed: score >= minPassScore,
        feedback: String(args.feedback || ""),
        retryFrom: (args.retryFrom as string) || null,
      };
      // Code-level hard veto: overrides the score-based decision when a rule fires
      for (const rule of HARD_VETO_RULES) {
        const reason = rule.check(result, { phase });
        if (reason) {
          result.score = 0;
          result.passed = false;
          result.feedback = `[HARD VETO: ${rule.name}] ${reason}\n${result.feedback}`;
          break;
        }
      }
      resolve(result);
      return {
        content: [{ type: "text" as const, text: "Score submitted" }],
        details: result,
      };
    },
  };
}

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Max tokens to include for LLM reply context */
const MAX_REPLY_CONTEXT = 3000;

/** Build one exact-file allowlist for the audit's sole filesystem tool. */
function createRestrictedAuditReadTool(
  allTools: AgentTool[],
  fileListContent: string,
  workspaceDir: string,
  artifactRoots: string[],
): AgentTool[] {
  const readTool = allTools.find((tool) => tool.name === "read");
  if (!readTool) return [];

  const lexicalWorkspace = resolve(workspaceDir);
  let canonicalWorkspace: string | undefined;
  try { canonicalWorkspace = realpathSync(lexicalWorkspace); } catch { /* Invalid workspace leaves no relative aliases. */ }
  const canonicalRoots = artifactRoots.flatMap((root) => {
    try { return [realpathSync(root)]; } catch { return []; }
  });
  const allowedFormsByCanonical = new Map<string, Set<string>>();
  if (fileListContent.trim() && fileListContent.trim() !== "(none)") {
    for (const declaration of fileListContent.split("\n").map((line) => line.trim()).filter(Boolean)) {
      const lexical = isAbsolute(declaration) ? resolve(declaration) : resolve(lexicalWorkspace, declaration);
      try {
        if (lstatSync(lexical).isSymbolicLink()) continue;
        const canonical = realpathSync(lexical);
        if (!statSync(canonical).isFile() || !canonicalRoots.some((root) => isPathInside(root, canonical))) continue;
        const forms = allowedFormsByCanonical.get(canonical) ?? new Set<string>();
        forms.add(canonical);
        // Derive the workspace-relative lexical form from the canonical file.
        // This preserves a trusted workspace root alias (for example /var ->
        // /private/var) without authorizing nested symlink aliases supplied by
        // a declaration or tool call.
        if (canonicalWorkspace && isPathInside(canonicalWorkspace, canonical)) {
          const relativeToWorkspace = canonical.slice(canonicalWorkspace.length).replace(/^[/\\]+/, "");
          forms.add(resolve(lexicalWorkspace, relativeToWorkspace));
        }
        allowedFormsByCanonical.set(canonical, forms);
      } catch {
        // Missing/unreadable declarations remain visible as unverified prompt facts.
      }
    }
  }

  return [{
    ...readTool,
    description: `${readTool.description} Audit scope: only the exact declared files for this verification run are readable.`,
    execute: async (toolCallId, rawParams, signal, onUpdate) => {
      const requested = rawParams && typeof rawParams === "object"
        ? (rawParams as { path?: unknown }).path
        : undefined;
      if (typeof requested !== "string" || !requested.trim()) {
        return { content: [{ type: "text", text: "Error: Audit read denied: path must name a declared file" }], details: { error: "audit_read_denied" } };
      }
      const lexical = isAbsolute(requested) ? resolve(requested) : resolve(lexicalWorkspace, requested);
      let canonical: string;
      try {
        if (lstatSync(lexical).isSymbolicLink()) throw new Error("symbolic link aliases are not allowed");
        canonical = realpathSync(lexical);
        const allowedForms = allowedFormsByCanonical.get(canonical);
        if (!allowedForms?.has(lexical) || !statSync(canonical).isFile()) throw new Error("file was not declared for this audit");
      } catch {
        return { content: [{ type: "text", text: "Error: Audit read denied: file was not declared for this verification run" }], details: { error: "audit_read_denied" } };
      }
      return readTool.execute(toolCallId, { ...(rawParams as Record<string, unknown>), path: canonical }, signal, onUpdate);
    },
  }];
}

/** Max agent turns for a single audit run (safety cap alongside the timeout). */
const MAX_AUDIT_TURNS = 100;

/** Declarations have already been normalized by the shared artifact resolver.
 * Resolve exactly that path; never substitute a same-named historical file.
 * Read/access failures stay unverified rather than becoming fabricated absence.
 */
function annotateFileExistence(
  fileListContent: string,
  workspaceDir: string,
  artifactRoots: string[],
): string {
  if (!fileListContent.trim() || fileListContent.trim() === "(none)") return "(none)";
  const lexicalWorkspace = resolve(workspaceDir);
  let canonicalWorkspace: string | undefined;
  try { canonicalWorkspace = realpathSync(lexicalWorkspace); } catch { /* Invalid workspace cannot authorize aliases. */ }
  const canonicalRoots = artifactRoots.flatMap((root) => {
    try { return [realpathSync(root)]; } catch { return []; }
  });
  return fileListContent.split("\n").map(line => line.trim()).filter(Boolean).map(file => {
    const path = isAbsolute(file) ? resolve(file) : resolve(lexicalWorkspace, file);
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return `[UNVERIFIED] ${file} — symbolic link aliases are not allowed`;
      }
      const canonical = realpathSync(path);
      if (!canonicalRoots.some((root) => isPathInside(root, canonical))) {
        return `[UNVERIFIED] ${file} — outside the current artifact roots`;
      }
      const derivedWorkspaceForm = canonicalWorkspace && isPathInside(canonicalWorkspace, canonical)
        ? resolve(lexicalWorkspace, canonical.slice(canonicalWorkspace.length).replace(/^[/\\]+/, ""))
        : undefined;
      if (path !== canonical && path !== derivedWorkspaceForm) {
        return `[UNVERIFIED] ${file} — symbolic link aliases are not allowed`;
      }
      return statSync(canonical).isFile()
        ? `[EXISTS] ${file}`
        : `[UNVERIFIED] ${file} — not a regular file`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR"
        ? `[MISSING] ${file} — FILE DOES NOT EXIST, do NOT fabricate its content`
        : `[UNVERIFIED] ${file} — existence check failed (${code || "unknown"}); do NOT fabricate its content`;
    }
  }).join("\n");
}

/**
 * Audit scoring function (for Long Task).
 * Creates a temporary AgentHarness (InMemorySessionStorage, not persisted),
 * loads read-safe tools + submit_score and the inherited instruction snapshot,
 * the audit model autonomously calls tools across multiple turns to verify deliverables,
 * then calls submit_score to submit the final score.
 *
 * @param phase - "checkpoint" checkpoint audit | "final" final audit
 */
export async function auditScore(
  phase: "checkpoint" | "final",
  auditModelObj: Model<any>,
  auditConfig: AuditModelConfig,
  env: ExecutionEnv,
  allTools: AgentTool[],
  allSkills: Skill[],
  ctx: { goals: string[]; criteria: string[]; results: string; plan: string; sessionTaskDir: string; workspaceDir: string; projectDir?: string; lastLlmReply: string; fileListContent: string; finalOutputCheck?: string; runtimeContext?: DeepReadonly<RuntimeContextSnapshot> },
  emitEvent?: (event: RpcEvent) => void,
  tracking?: LlmTrackingContext,
): Promise<ScoreResult> {
  // Clamp invalid threshold values (NaN / out of 0-100): the threshold now solely
  // decides pass/fail, so an invalid value would otherwise make every audit
  // deterministically fail (NaN / >100) and inject garbage into the prompts.
  const rawMinPassScore = Number(auditConfig.minPassScore);
  const minPassScore = Number.isFinite(rawMinPassScore)
    ? Math.min(Math.max(rawMinPassScore, 0), 100)
    : 70;
  let systemPrompt = phase === "checkpoint" ? buildCheckpointAuditPrompt(minPassScore) : buildFinalAuditPrompt(minPassScore);
  systemPrompt += "\n\nAutomation audit policy: use lenient, outcome-based judgment. Recovered tool errors, omitted non-critical plan steps, empty file lists for text-only tasks, and non-blocking detail issues are not standalone failure reasons. Fail only for an evidenced unmet core objective, explicit hard requirement, or blocking defect. Inability to read a file proves it is unverified, not that its contents are wrong; never invent evidence.";
  const storage = new InMemorySessionStorage();
  const session = new Session(storage);

  // Audit is exact-file verification: expose only a read proxy scoped to this
  // run's normalized declarations. Search/list and every mutating tool stay out.
  const auditArtifactRoots = [ctx.sessionTaskDir, ctx.projectDir]
    .filter((root): root is string => Boolean(root));
  const auditTools = createRestrictedAuditReadTool(
    allTools,
    ctx.fileListContent,
    ctx.workspaceDir,
    auditArtifactRoots,
  );

  systemPrompt = buildInstructionPrompt(ctx.workspaceDir) + formatRuntimeContextForModel(ctx.runtimeContext)
    + "\n\n" + systemPrompt + formatInstructionScope("audit", [...auditTools.map(tool => tool.name), "submit_score"]);

  // Bug 2/3 fix: Hoist auditHarness to scope accessible by timeout handler
  // Bug 24 fix: Declare as AgentHarness | undefined to prevent TypeError if constructor throws before timeout fires
  let auditHarness: AgentHarness | undefined;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;
  let resolved = false;
  const usageOwner = tracking ? { ...tracking } : undefined;

  const scorePromise = new Promise<ScoreResult>((resolve, reject) => {
    // Bug 3 fix: Prevent double-resolve (submit_score and harness error no longer double-resolve)
    const safeResolve = (result: ScoreResult) => {
      if (resolved) return;
      resolved = true;
      // Bug 2 fix: Clear timer when score resolves
      if (timerId) clearTimeout(timerId);
      if (heartbeatId) clearInterval(heartbeatId);
      if (_activeAuditHarness === auditHarness) _activeAuditHarness = undefined;
      resolve(result);
      // Stop the audit harness once the score is in — without this the agent loop
      // keeps running turns (and burning tokens) after submit_score resolves.
      // Abort immediately (no deferral): the score is already resolved, so any
      // in-flight turn output is unused; aborting mid tool-call is safe because
      // prompt().catch is guarded by the `resolved` flag above.
      auditHarness?.abort().catch((err: unknown) => {
        log.debug("Audit harness abort after resolve failed", { error: String(err) });
      });
    };

    // User abort path: reject with OrchestrationAbortedError so the orchestration
    // loop unwinds immediately instead of treating the audit as failed (which
    // would trigger pointless redo loops) or waiting out the timeout.
    const safeRejectAborted = () => {
      if (resolved) return;
      resolved = true;
      if (timerId) clearTimeout(timerId);
      if (heartbeatId) clearInterval(heartbeatId);
      if (_activeAuditHarness === auditHarness) _activeAuditHarness = undefined;
      // Harness was already aborted (that's why we're settling) — no re-abort needed
      reject(new OrchestrationAbortedError());
    };

    const submitTool = createSubmitScoreTool(safeResolve, minPassScore, phase);
    auditHarness = new AgentHarness({
      env,
      session,
      model: auditModelObj,
      tools: [...auditTools, submitTool],
      resources: { skills: allSkills },
      getApiKeyAndHeaders: async () => ({ apiKey: auditConfig.apiKey }),
      systemPrompt: () => systemPrompt,
    });
    _activeAuditHarness = auditHarness;
    // Attach metadata hook for audit LLM calls
    if (usageOwner) registerLlmMetadataHook(auditHarness, usageOwner);

    // Turn-limit safeguard: the audit harness bypasses subscribeToHarnessEvents,
    // so enforce a local cap to stop runaway audit loops before the timeout.
    let auditTurns = 0;
    auditHarness.subscribe((event: any) => {
      if (event.type !== "turn_start") return;
      auditTurns++;
      if (auditTurns > MAX_AUDIT_TURNS) {
        log.warn("Audit exceeded max turns, continuing without verification", { phase, maxTurns: MAX_AUDIT_TURNS });
        safeResolve(skippedAudit(`Audit exceeded ${MAX_AUDIT_TURNS} turns without submitting a score`));
      }
    });

    // Record each completed request immediately, including errors and messages
    // that settle after scoring/abort. Business completion is not a usage boundary.
    auditHarness.subscribe((event: any) => {
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const u = event.message.usage;
        if (u) emitAuditUsage(emitEvent, ctx.sessionTaskDir, phase === "checkpoint" ? "checkpoint_audit" : "final_audit", {
          input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0,
          cacheWrite: u.cacheWrite || 0, totalTokens: u.totalTokens || 0,
        }, usageOwner);
      }
    });

    // Subscribe to audit harness events for UI visibility
    if (emitEvent) {
      const phaseLabel = phase === "checkpoint" ? "Checkpoint Audit" : "Final Audit";
      emitEvent({ type: "thinking", role: "assistant", delta: `[${phaseLabel}] Starting verification...` });
      auditHarness.subscribe((event: any) => {
        switch (event.type) {
          case "message_update": {
            const ase = event.assistantMessageEvent;
            if (ase?.type === "text_delta" && typeof ase.delta === "string") {
              emitEvent({ type: "thinking", role: "assistant", delta: ase.delta });
            }
            break;
          }
          case "tool_execution_start":
            emitEvent({ type: "thinking", role: "assistant", delta: `[${phaseLabel}] Tool: ${event.toolName}(${JSON.stringify(event.args || {}).slice(0, 100)})` });
            break;
          case "tool_execution_end":
            emitEvent({ type: "thinking", role: "assistant", delta: `[${phaseLabel}] Tool completed: ${event.toolName}${event.isError ? " (error)" : ""}` });
            break;
        }
      });
    }

    const rawFileListContent = ctx.fileListContent || "(none)";
    // Pre-validate file existence at code level to prevent audit LLM hallucination
    const fileListContent = annotateFileExistence(rawFileListContent, ctx.workspaceDir, auditArtifactRoots);
    const truncatedReply = truncateByTokens(ctx.lastLlmReply, MAX_REPLY_CONTEXT).text;

    const msg = [
      `Workspace directory (default CWD; base for relative declarations): ${ctx.workspaceDir}`,
      `Task objective: ${ctx.plan}`,
      `Initial classification goals (the current task objective and latest clarification take precedence): ${JSON.stringify(ctx.goals)}`,
      `Initial acceptance criteria (do not reimpose criteria superseded by the latest clarification): ${JSON.stringify(ctx.criteria)}`,
      `Execution results: ${ctx.results}`,
    ];
    if (ctx.projectDir) {
      msg.push(`Primary deliverable directory: ${ctx.projectDir} (deliverables go to ${projectDeliverablesDirectory()}/, including final-output-*; code goes to src/, raw data goes to data/)`);
      msg.push(`Session system directory: ${ctx.sessionTaskDir} (logs and state only)`);
    } else {
      msg.push(`Deliverable directory: ${ctx.sessionTaskDir}`);
    }
    msg.push(`Output file list (existence pre-verified by system; not a conversation delivery declaration):\n${fileListContent}`);
    msg.push(`Main LLM last reply:\n${truncatedReply || "(none)"}`);
    msg.push(`\n⚠️ CRITICAL: Files marked [MISSING] DO NOT EXIST on disk. You MUST NOT read them or fabricate their content. Treat [MISSING] files as failed outputs and score accordingly.`);
    

    // Append final-output check result for final audits
    if (phase === "final" && ctx.finalOutputCheck) {
      msg.push(`\n=== PRIMARY DELIVERABLE CHECK ===\n${ctx.finalOutputCheck}`);
    }

    auditHarness.prompt(msg.join("\n")).then((response) => {
      if (resolved) return;
      // User abort: the harness resolves with stopReason "aborted" — propagate
      // as OrchestrationAbortedError so the caller unwinds without waiting out
      // the timeout or mis-scoring an interrupted audit.
      if (response?.stopReason === "aborted") {
        safeRejectAborted();
        return;
      }
      // Audit model itself failed (harness surfaces LLM errors as stopReason "error"
      // instead of throwing). Degrade: mark verification skipped so a dead audit key
      // never blocks delivery, triggers main-LLM retries, or waits out the 3-min timeout.
      if (resolved || response?.stopReason !== "error") return;
      const errMsg = response.errorMessage || "unknown audit model error";
      const keyIssue = isLlmKeyOrQuotaError(errMsg);
      log.warn("Audit model call failed, skipping verification", { phase, keyIssue, error: errMsg });
      emitEvent?.({
        type: "warning",
        message: keyIssue
          ? `Audit model key unavailable (${errMsg}) — audit skipped, proceeding without verification`
          : `Audit model error (${errMsg}) — audit skipped, proceeding without verification`,
      });
      safeResolve(skippedAudit(`Audit model unavailable (${errMsg})`));
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      // User abort surfaced as a thrown error — same propagation as stopReason "aborted"
      if (isAbortRequested()) {
        safeRejectAborted();
        return;
      }
      log.error("Audit harness prompt failed", { phase, error: errMsg });
      // Same degradation for thrown key/quota errors: skip audit instead of failing
      // (a failed audit would trigger pointless main-LLM redo loops).
      if (isLlmKeyOrQuotaError(errMsg)) {
        emitEvent?.({ type: "warning", message: `Audit model key unavailable (${errMsg}) — audit skipped, proceeding without verification` });
        safeResolve(skippedAudit(`Audit model unavailable (${errMsg})`));
        return;
      }
      // Bug 3 fix: safeResolve prevents double-resolve after submit_score was already called
      // Hard failure: audit infrastructure broke (not a key/quota issue) — fail loudly
      // instead of bypassing the threshold, so the orchestration can react.
      safeResolve({
        score: 0,
        passed: false,
        feedback: `Audit execution failed: ${errMsg}`,
        retryFrom: null,
      });
    });
  });

  // TASK-002: audit scoring timeout (continue with unverified results on expiry).
  // 3 minutes per user decision — audit models may legitimately need multiple
  // read-tool turns. Note: user-facing waits (e.g. [ASK_USER] clarification)
  // happen during group execution, never inside this timing window, so no
  // confirmation wait is ever counted against this timeout.
  const AUDIT_TIMEOUT_MS = 180_000;

  // Heartbeat: keep the user informed while the audit LLM works (or hangs).
  // Without this, a stalled audit call leaves the user staring at silence for
  // up to AUDIT_TIMEOUT_MS before the verification is skipped.
  const HEARTBEAT_INTERVAL_MS = 30_000;
  if (emitEvent) {
    const phaseLabel = phase === "checkpoint" ? "Checkpoint Audit" : "Final Audit";
    const startedAt = Date.now();
    heartbeatId = setInterval(() => {
      if (resolved) return;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      emitEvent({
        type: "thinking",
        role: "assistant",
        delta: `[${phaseLabel}] Verification in progress... (${elapsed}s elapsed, times out at ${AUDIT_TIMEOUT_MS / 1000}s)`,
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  const timeoutPromise = new Promise<ScoreResult>((resolve) => {
    timerId = setTimeout(() => {
      if (resolved) return; // Bug 3 fix: score already resolved, ignore timeout
      resolved = true; // mark settled so a late abort reject cannot fire unhandled
      if (heartbeatId) clearInterval(heartbeatId);
      if (_activeAuditHarness === auditHarness) _activeAuditHarness = undefined;
      log.warn("Audit scoring timed out, aborting harness", { phase, timeoutMs: AUDIT_TIMEOUT_MS });
      // Let the user know why the wait ended and that delivery proceeds anyway
      emitEvent?.({
        type: "thinking",
        role: "assistant",
        delta: `[${phase === "checkpoint" ? "Checkpoint Audit" : "Final Audit"}] Verification timed out after ${AUDIT_TIMEOUT_MS / 1000}s — proceeding with results as-is`,
      });
      // Bug 2 fix: Abort audit harness on timeout to terminate background LLM calls
      // Bug 24 fix: Use optional chaining to prevent TypeError when auditHarness is undefined
      auditHarness?.abort().catch((err: unknown) => {
        log.warn("Failed to abort audit harness on timeout", { error: String(err) });
      });
      resolve(skippedAudit(`Audit timed out after ${AUDIT_TIMEOUT_MS / 1000}s`));
    }, AUDIT_TIMEOUT_MS);
  });

  const result = await Promise.race([scorePromise, timeoutPromise]);
  // When the timeout wins the race, scorePromise may still reject later (user
  // abort of the timed-out harness) — swallow it to avoid an unhandled rejection.
  scorePromise.catch(() => {});

  // User abort takes precedence over a skipped audit: if the abort flag
  // is set, unwind the orchestration instead of continuing with the result.
  if (isAbortRequested()) {
    throw new OrchestrationAbortedError();
  }

  log.info(result.skipped ? "Audit verification skipped" : "Audit score completed", {
    phase,
    score: result.skipped ? undefined : result.score,
    passed: result.passed,
    skipped: result.skipped ?? false,
    retryFrom: result.retryFrom,
  });
  return result;
}
