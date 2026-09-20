/**
 * Handler Shared Types & Dependencies
 *
 * Defines the shared dependency and mutable state interfaces used by
 * all RPC handler modules. Also provides shared helper functions.
 */

import type { AgentHarness } from "../vendor/agent/harness/agent-harness.ts";
import type { Session } from "../vendor/agent/harness/session/session.ts";
import type { ExecutionEnv, SessionTreeEntry, Skill } from "../vendor/agent/harness/types.ts";
import type { AgentMessage, AgentTool } from "../vendor/agent/types.ts";
import type { Model } from "../vendor/ai/base.ts";
import type { Message } from "../vendor/ai/base.ts";
import type {
  Capabilities,
  ConversationMode,
  HogAgentConfig,
  RpcEvent,
} from "../utils/types.ts";
import type { ActivityLogger } from "../utils/activity-logger.ts";
import type { SkillApiConfigEntry } from "../config.ts";
import type { LlmTrackingContext } from "../llm-metadata-hook.ts";
import type { LlmAuth } from "../llm-auth.ts";
import type { RuntimeContextManager } from "../runtime-context.ts";
import type { AgentToolRegistry } from "../tool-registry.ts";
import {
  CompactionManager,
  ContextCompactionError,
} from "../compaction-manager.ts";
import { emitEvent } from "../rpc.ts";
import { createLogger } from "../utils/logger.ts";
import { calculateContextTokens, estimateTokens } from "../vendor/agent/base.ts";
import { buildSessionContext } from "../vendor/agent/harness/session/session.ts";
import {
  BRANCH_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_PREFIX,
} from "../vendor/agent/harness/messages.ts";
import { isAbortRequested as isGlobalAbortRequested } from "../agent-state.ts";
import { stripDeliveryDecision } from "../protocol/agent-result-schema.ts";

const log = createLogger("core");
const settledCompactionFingerprintByHarness = new WeakMap<AgentHarness, string>();

// ─── Dependency Interface ───────────────────────────────────────────────────

/**
 * Immutable dependencies shared across all RPC handlers.
 * These are set once during createHogAgent and passed to each handler group.
 * Note: `auditModelObj` and `activityLogger` are mutable (can be reassigned
 * during saveSettings / newSession), so they are accessed via getter/setter.
 */
export interface HandlerDeps {
  /** Mutable harness reference (replaced on new/resume session) */
  harnessRef: { current: AgentHarness };
  /** Mutable session reference (replaced on new/resume session) */
  sessionRef: { current: Session };
  /** HogAgent config (sessionId, sessionTaskDir, llmProvider are mutable) */
  config: HogAgentConfig;
  /** Mutable activity logger ref (replaced on new/resume session) */
  activityLoggerRef: { current: ActivityLogger };
  /** Mutable audit model object ref (reassigned on saveSettings) */
  auditModelObjRef: { value: Model<any> | null };
  /** All loaded skills */
  allSkills: Skill[];
  /** Process-local tool source of truth (built-in + extension + external MCP). */
  toolRegistry: AgentToolRegistry;
  /** Per-skill API config */
  skillsConfig: Record<string, SkillApiConfigEntry>;
  /** Execution environment */
  executionEnv: ExecutionEnv;
  /** Mutable current mode reference */
  currentModeRef: { value: ConversationMode | null };
  /** Capabilities getter function */
  getCapabilitiesFn: () => Capabilities;
  /**
   * Ensure current session matches the specified sessionId.
   * Populated by session-handlers; called by prompt/steer/follow_up handlers when session_id is received.
   * - Already matched → skip
   * - JSONL file exists → resume_session
   * - JSONL file does not exist → new_session
   */
  ensureSessionRef: { current: ((sessionId: string, mode?: string) => Promise<void>) | null };
  /** LLM request tracking context (session_id / work_id / task_id) */
  llmTracking: LlmTrackingContext;
  /** Shared compaction lifecycle owner; survives Harness replacement. */
  compactionManager: CompactionManager;
  /** Shared authentication resolver for turns, rebuilt Harnesses, and compaction. */
  resolveMainLlmAuth: (model: Model<any>) => Promise<LlmAuth>;
  /** Ephemeral three-scope runtime context; never persisted by handlers. */
  runtimeContext: RuntimeContextManager;
}

// ─── Mutable State Interface ───────────────────────────────────────────────

/**
 * Mutable local state shared across handlers within a single RPC context.
 * These values change during the session lifecycle.
 */
export interface HandlerMutableState {
  /** True when user has switched to a different session (read-only mode) */
  switchedSession: boolean;
  /** True after session name has been persisted to JSONL */
  sessionNameSaved: boolean;
  /** Unsubscribe function for harness events (reassigned on new session) */
  unsubscribe: (() => void) | null;
  /** True when quick mode has overridden thinkingLevel (needs restore on mode exit) */
  quickThinkingOverride: boolean;
  /** Saved thinkingLevel to restore when leaving quick mode */
  savedThinkingLevel: string | null;
}

// ─── Shared Helper Functions ───────────────────────────────────────────────

/** Extract text from a Message's content (string or ContentBlock[]) */
export function messageText(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return m.content.map((c: any) => c.text || "").join("");
}

/**
 * Save session title to JSONL via appendSessionName().
 * Only called once per session lifecycle (idempotent).
 */
export function saveSessionName(
  sessionRef: { current: Session },
  state: HandlerMutableState,
  metadata: { optimizedPrompt?: string; goals?: string[] },
): void {
  if (state.sessionNameSaved) return;
  const title = (metadata.optimizedPrompt || metadata.goals?.[0] || "").slice(0, 30);
  if (!title) return;
  sessionRef.current.appendSessionName(title);
  state.sessionNameSaved = true;
  log.debug("Session name saved to JSONL", { title });
}

// ─── Internal Message Patterns ─────────────────────────────────────

/**
 * Patterns for system-generated user messages (orchestrator prompts, retry
 * instructions, final notification). Shared by session listing/switching
 * (title extraction) and buildConversationHistory (classification input).
 */
export const INTERNAL_PATTERNS = [
  /^Based on the user.s task request, determine if you need to ask clarification/,
  /^## Overall Task Objective/,
  /^## Planning Only\b/,
  /^Please re-execute group /,
  /^Your previous response did not (?:provide a complete, valid execution plan|include the required structured output JSON block)\./,
  /^## Task Execution Complete/,
];

/** Internal prompts whose following assistant messages are orchestration internals. */
const INTERNAL_REPLY_PATTERNS = INTERNAL_PATTERNS.filter(
  (pattern) => pattern.source !== /^## Task Execution Complete/.source,
);

/** True when a user-role message text is a system-generated orchestration prompt. */
export function isInternalUserMessage(text: string): boolean {
  return INTERNAL_PATTERNS.some((p) => p.test(text));
}

/** Final-summary replies stay visible; planning/execution replies do not enter classification. */
export function hasInternalAssistantReply(text: string): boolean {
  return INTERNAL_REPLY_PATTERNS.some((pattern) => pattern.test(text));
}

function isSyntheticSessionSummary(text: string): boolean {
  return text.startsWith(COMPACTION_SUMMARY_PREFIX) || text.startsWith(BRANCH_SUMMARY_PREFIX);
}

// ─── Conversation History Constants ───────────────────────────────────────

export const HISTORY_MAX_CHARS = 8000;
export const HISTORY_MIN_TURNS = 3;
export const ASSISTANT_TRUNCATE_CHARS = 1000;

/**
 * Build conversation history as native Message[] from the main Harness session.
 * Returns UserMessage/AssistantMessage only, with turn-based truncation.
 * classifyIntent will pass these directly into the LLM Context.messages array.
 */
export async function buildConversationHistory(sessionRef: { current: Session }): Promise<Message[]> {
  const sessionCtx = await sessionRef.current.buildContext();
  const contextMessages = sessionCtx.messages
    .filter((m: any) => m.role === "user" || m.role === "assistant") as Message[];

  // Filter internal prompts together with every assistant message they own. A
  // final-summary prompt is hidden while its user-visible reply remains useful
  // conversation history. Synthetic summaries are intentionally excluded from
  // classification because they can flatten internal orchestration instructions
  // into a user-role message; the main Harness still consumes them normally.
  let messages: Message[] = [];
  let suppressAssistantReplies = false;
  for (const message of contextMessages) {
    if (message.role === "user") {
      const text = messageText(message);
      if (isSyntheticSessionSummary(text)) {
        suppressAssistantReplies = false;
        continue;
      }
      suppressAssistantReplies = hasInternalAssistantReply(text);
      if (!isInternalUserMessage(text)) messages.push(message);
      continue;
    }
    if (suppressAssistantReplies) continue;

    // delivery_decision is a runtime control envelope, not conversational
    // evidence. Keep the human-readable assistant summary in future intent
    // classification without teaching the classifier from protocol JSON.
    const m = message;
    const original = messageText(m);
    const cleaned = stripDeliveryDecision(original);
    if (cleaned === original) {
      messages.push(m);
    } else if (cleaned.trim()) {
      messages.push({ ...m, content: [{ type: "text", text: cleaned }] } as Message);
    }
  }

  // Truncation protection: drop earliest turns until within budget
  const totalChars = (msgs: Message[]) =>
    msgs.reduce((sum, m) => sum + messageText(m).length, 0);

  while (messages.length > 0 && totalChars(messages) > HISTORY_MAX_CHARS) {
    // Count remaining turns (a turn starts with a "user" message)
    const turnCount = messages.filter((m) => m.role === "user").length;
    if (turnCount <= HISTORY_MIN_TURNS) break;  // Can't drop more turns
    // Drop the first turn: leading user message + subsequent assistant messages until next user
    let dropIdx = 0;
    // Skip the first user message
    while (dropIdx < messages.length && messages[dropIdx].role === "user") dropIdx++;
    // Skip assistant messages belonging to this turn
    while (dropIdx < messages.length && messages[dropIdx].role === "assistant") dropIdx++;
    messages = messages.slice(dropIdx);
  }

  // If still over budget, truncate each assistant message's text content
  if (totalChars(messages) > HISTORY_MAX_CHARS) {
    messages = messages.map((m) => {
      if (m.role === "assistant" && messageText(m).length > ASSISTANT_TRUNCATE_CHARS) {
        const text = messageText(m).slice(0, ASSISTANT_TRUNCATE_CHARS) + "...(truncated)";
        return { ...m, content: [{ type: "text", text }] } as Message;
      }
      return m;
    });
  }

  return messages;
}

/** Standalone compatibility: inspect only the current user prompt, never history. */
export function extractProjectDirFromText(text: string): string | undefined {
  const bracket = text.match(/\[Project directory:\s*(.+?)\]/)?.[1];
  const plain = text.match(/projectDir:\s*(\S*[\\/]projects[\\/]\S+)/i)?.[1];
  const projectDir = (bracket ?? plain)?.trim();
  // Full drive/UNC paths are absolute; drive-relative and root-relative Windows
  // paths depend on ambient CWD and must not select a project.
  if (!projectDir || !(/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(projectDir)
    || (process.platform !== "win32" && projectDir.startsWith("/")))
    || projectDir.split(/[\\/]/).includes("..") || /[\u0000-\u001f]/.test(projectDir)) return undefined;
  return projectDir;
}

/**
 * Resolve current context token usage without trusting provider usage that
 * predates the latest compaction boundary.
 */
export function resolveContextTokens(branchEntries: SessionTreeEntry[]): number {
  let latestCompactionIndex = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i]?.type === "compaction") {
      latestCompactionIndex = i;
      break;
    }
  }

  for (let i = branchEntries.length - 1; i > latestCompactionIndex; i--) {
    const entry = branchEntries[i];
    if (!entry || entry.type !== "message") continue;
    const msg = entry.message as AgentMessage;
    if (msg.role !== "assistant" || msg.stopReason === "aborted" || msg.stopReason === "error") continue;
    const usage = msg.usage as Parameters<typeof calculateContextTokens>[0] | undefined;
    if (!usage) continue;
    const tokens = calculateContextTokens(usage);
    if (tokens > 0) {
      const trailingTokens = branchEntries.slice(i + 1).reduce((total, trailingEntry) => {
        if (trailingEntry.type !== "message") return total;
        return total + estimateTokens(trailingEntry.message as AgentMessage);
      }, 0);
      return tokens + trailingTokens;
    }
  }

  // estimateContextTokens() is intentionally not used here: it also trusts the
  // retained pre-compaction assistant usage that caused repeated compaction.
  return buildSessionContext(branchEntries).messages
    .reduce((total, message) => total + estimateTokens(message), 0);
}

interface ContextCapacityOptions {
  harness?: AgentHarness;
  session?: Session;
  emitEvent?: (event: RpcEvent) => void;
  /** Text appended by the immediately following main-model prompt. */
  nextPrompt?: string;
  /** Optional Long Task cancellation probe; normal turns use the global sticky abort guard. */
  isAbortRequested?: () => boolean;
}

/**
 * Check context usage and auto-trigger compaction if over threshold.
 */
export async function maybeAutoCompact(
  deps: HandlerDeps,
  options: ContextCapacityOptions = {},
): Promise<void> {
  const harness = options.harness ?? deps.harnessRef.current;
  const session = options.session ?? deps.sessionRef.current;
  const emit = options.emitEvent ?? emitEvent;
  const abortRequested = options.isAbortRequested ?? isGlobalAbortRequested;
  try {
    const branchEntries = await session.getBranch();
    // Abort can arrive while getBranch() is awaiting local session I/O, before
    // CompactionManager has an active operation for onAbort() to cancel.
    // Never arm a new compaction after that abort has already settled.
    if (abortRequested()) return;
    const pendingPromptTokens = options.nextPrompt
      ? estimateTokens({ role: "user", content: options.nextPrompt, timestamp: Date.now() })
      : 0;
    const tokens = resolveContextTokens(branchEntries) + pendingPromptTokens;
    const contextWindow = harness.getModel().contextWindow;
    if (!Number.isInteger(contextWindow) || contextWindow < 4096) {
      throw new Error(`Invalid context window for model ${harness.getModel().id}: ${contextWindow}`);
    }
    const usageRatio = tokens / contextWindow;
    const threshold = deps.config.compaction.autoCompactThreshold;
    const branchLeafId = branchEntries[branchEntries.length - 1]?.id ?? "empty";
    const fingerprint = `${branchLeafId}:${harness.getModel().provider}:${harness.getModel().id}:${contextWindow}:${threshold}`;

    if (settledCompactionFingerprintByHarness.get(harness) === fingerprint) return;

    if (usageRatio >= threshold) {
      const percent = Math.round(usageRatio * 100);
      log.info("Auto-compaction triggered", { percent, tokens, window: contextWindow, threshold });
      await deps.compactionManager.run({
        harness,
        emitEvent: emit,
        resolveAuth: deps.resolveMainLlmAuth,
      });
      const settledBranch = await session.getBranch();
      const settledLeafId = settledBranch[settledBranch.length - 1]?.id ?? "empty";
      const settledTokens = resolveContextTokens(settledBranch) + pendingPromptTokens;
      if (settledTokens >= contextWindow) {
        throw new Error(
          `Context remains too large after compaction: ${settledTokens}/${contextWindow} tokens`,
        );
      }
      settledCompactionFingerprintByHarness.set(
        harness,
        `${settledLeafId}:${harness.getModel().provider}:${harness.getModel().id}:${contextWindow}:${threshold}`,
      );
    }
  } catch (err) {
    // Cancellation owns the outer conversation lifecycle. Callers perform the
    // second abort check and must not also report a compaction failure.
    if (abortRequested()) return;
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Pre-prompt context compaction failed", { error: msg });
    throw new ContextCompactionError(`Context capacity check failed: ${msg}`, { cause: err });
  }
}

// ─── Orchestration Context ──────────────────────────────────────────────────

/** Context object passed to long-task orchestration functions */
export type OrchestrationContext = import("../long-task-orchestrator.ts").LongTaskDeps;
