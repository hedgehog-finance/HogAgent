/**
 * Agent Shared State
 *
 * Module-level mutable state shared across HogAgent components.
 * Extracted from index.ts to avoid circular dependencies between
 * index.ts, audit-classifier.ts, and long-task-orchestrator.ts.
 */

import type { AuditClassification } from "./utils/types.ts";
import type { Message } from "./vendor/ai/base.ts";

/** Maximum number of LLM turns per prompt (safety limit) */
export const MAX_TURNS_PER_PROMPT = 5000;
/** Number of turns before limit to inject completion reminder */
export const TURNS_REMINDER_BEFORE_LIMIT = 5;

// ─── Abort Request Flag ─────────────────────────────────────────────────────

/** Module-level sticky abort flag. Set by onAbort, cleared when the next prompt
 *  starts. Harness.abort() only cancels the *current* run — the Long Task
 *  orchestration loop issues many sequential prompts, so it must consult this
 *  flag before every prompt/audit to actually stop. */
let _abortRequested = false;

export function setAbortRequested(active: boolean): void {
  _abortRequested = active;
}

export function isAbortRequested(): boolean {
  return _abortRequested;
}

// ─── Internal Mode ─────────────────────────────────────────────────────────

/** Module-level flag: when true, harness message events are redirected to thinking events */
let _internalMode = false;

/** Toggle internal mode — during Long Task intermediate steps, message_* events become thinking events */
export function setInternalMode(active: boolean): void {
  _internalMode = active;
}

/** Check if internal mode is active (message events redirected to thinking) */
export function isInternalMode(): boolean {
  return _internalMode;
}

// The long_task final summary renders outside internal mode, but its Harness
// agent_end is still an orchestration boundary. The orchestrator emits the one
// terminal boundary after orchestration_completed.
let _harnessFinalizationDeferred = false;

export function setHarnessFinalizationDeferred(active: boolean): void {
  _harnessFinalizationDeferred = active;
}

export function isHarnessFinalizationDeferred(): boolean {
  return _harnessFinalizationDeferred;
}

// ─── Suppress User Bubble ──────────────────────────────────────────────────────

/** Module-level flag: when true, user message_start/update/end events are suppressed (not shown as bubbles).
 *  Used during sendFinalNotification to hide the internal "Task Execution Complete" prompt from the UI. */
let _suppressUserBubble = false;

export function setSuppressUserBubble(active: boolean): void {
  _suppressUserBubble = active;
}

export function isSuppressUserBubble(): boolean {
  return _suppressUserBubble;
}

// ─── Complex Assistant Count ────────────────────────────────────────────────

/** Counts assistant messages produced during internalMode=true for orchestration statistics.
 *  History presentation uses persisted prompt boundaries, not this cumulative count. */
let _complexAssistantCount = 0;

export function getComplexAssistantCount(): number {
  return _complexAssistantCount;
}

export function incrementComplexAssistantCount(): void {
  _complexAssistantCount++;
}

// ─── Main Turn Tracking ─────────────────────────────────────────────────────

/** Module-level flag: true after main harness emits turn_start. Audit thinking events are suppressed before this. */
let _mainTurnStarted = false;

/** Check whether the main harness has started its first turn (used by audit-classifier to suppress pre-turn thinking events) */
export function isMainTurnStarted(): boolean {
  return _mainTurnStarted;
}

/** Set the main turn started flag (called by harness event subscriber) */
export function setMainTurnStarted(started: boolean): void {
  _mainTurnStarted = started;
}

// ─── Pre-Planning Clarification State ──────────────────────────────────────

export interface PendingPrePlanningClarification {
  originalMessage: string;
  classification: AuditClassification;
  conversationHistory?: Message[];
}

let _pendingPrePlanningClarification: PendingPrePlanningClarification | null = null;

/** Get the pending pre-planning clarification (null if none) */
export function getPendingPrePlanningClarification(): PendingPrePlanningClarification | null {
  return _pendingPrePlanningClarification;
}

/** Set the pending pre-planning clarification */
export function setPendingPrePlanningClarification(value: PendingPrePlanningClarification | null): void {
  _pendingPrePlanningClarification = value;
}

// ─── Buffered User Message ─────────────────────────────────────────────────

/** Buffered user message — held while resuming an interrupted orchestration (process restart recovery). */
let _bufferedUserMessage: string | null = null;

/** Get the buffered user message */
export function getBufferedUserMessage(): string | null {
  return _bufferedUserMessage;
}

/** Set the buffered user message */
export function setBufferedUserMessage(value: string | null): void {
  _bufferedUserMessage = value;
}

// ─── POOL-007 fix: Defensively reset all module-level state ─────────────────────

/**
 * Reset all module-level shared state.
 * Should be called on session switch or shutdown to prevent cross-session contamination.
 */
export function resetAllModuleState(): void {
  _internalMode = false;
  _mainTurnStarted = false;
  _pendingPrePlanningClarification = null;
  _bufferedUserMessage = null;
  _suppressUserBubble = false;
  _harnessFinalizationDeferred = false;
  _complexAssistantCount = 0;
  _abortRequested = false;
}
