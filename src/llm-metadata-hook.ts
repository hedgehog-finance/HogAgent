/**
 * Main LLM Request Hooks
 *
 * Injects OpenAI-standard `metadata` (session_id / work_id / task_id) into
 * every LLM request body via the before_provider_payload harness hook.
 * The ciweiai LLM proxy uses these fields for per-session/per-task usage tracking.
 * Also applies a small, stateless delay before main LLM requests when the
 * conversation context is large.
 *
 * This module is intentionally standalone to avoid circular dependencies
 * between index.ts, session-handlers.ts, and extension modules.
 */

import type { AgentHarness } from "./vendor/agent/harness/agent-harness.ts";
import { estimateContextTokens } from "./vendor/agent/base.ts";

/** Return the send delay for a context size. Thresholds are strictly greater-than. */
export function getMainLlmSendDelayMs(contextTokens: number): number {
  if (contextTokens > 50_000) return 2_000;
  if (contextTokens > 40_000) return 1_500;
  if (contextTokens > 30_000) return 1_000;
  if (contextTokens > 20_000) return 500;
  return 0;
}

/** Register stateless context-based throttling before every main LLM request. */
export function registerMainLlmContextThrottle(harness: AgentHarness): void {
  harness.on("context", async ({ messages }) => {
    const delayMs = getMainLlmSendDelayMs(estimateContextTokens(messages).tokens);
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    return undefined;
  });
}

/** Business tracking context driven by Gateway prompt command metadata. */
export interface LlmTrackingContext {
  sessionId: string;
  workId: string;
  taskId: string;
}

/** Build the OpenAI-standard metadata object from current tracking context. */
export function buildLlmMetadata(tracking: LlmTrackingContext): Record<string, string> {
  return {
    session_id: tracking.sessionId,
    work_id: tracking.workId,
    task_id: tracking.taskId,
  };
}

/**
 * Register before_provider_payload hook on a harness to inject
 * OpenAI-standard metadata into every LLM request body.
 */
export function registerLlmMetadataHook(
  harness: AgentHarness,
  tracking: LlmTrackingContext,
): void {
  harness.on("before_provider_payload", ({ payload }) => {
    const body = payload as Record<string, unknown>;
    return { payload: { ...body, metadata: buildLlmMetadata(tracking) } };
  });
}
