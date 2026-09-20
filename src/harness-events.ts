/**
 * Harness Event Subscription
 *
 * Subscribes to AgentHarness events and re-emits them as RPC events.
 * Handles turn tracking, message streaming, tool execution events,
 * and turn-limit enforcement.
 */

import type { AgentHarness } from "./vendor/agent/harness/agent-harness.ts";
import type { AgentHarnessEvent } from "./vendor/agent/harness/types.ts";
import type { HogAgentConfig, RpcEvent } from "./utils/types.ts";
import type { ActivityLogger } from "./utils/activity-logger.ts";
import { emitEvent } from "./rpc.ts";
import { notifyBeforeAgentEnd } from "./extensions/index.ts";
import { createLogger } from "./utils/logger.ts";
import { classifyAssistantMessageTerminal } from "./utils/llm-error.ts";
import {
  isHarnessFinalizationDeferred,
  isInternalMode,
  isSuppressUserBubble,
  setMainTurnStarted,
  incrementComplexAssistantCount,
  MAX_TURNS_PER_PROMPT,
  TURNS_REMINDER_BEFORE_LIMIT,
} from "./agent-state.ts";
import { parseDeliveryDecision, hasInvalidDeliverySelection, stripDeliveryDecision } from "./protocol/agent-result-schema.ts";

const log = createLogger("core");

export function subscribeToHarnessEvents(harness: AgentHarness, activityLogger: ActivityLogger, config: HogAgentConfig): () => void {
  // Track tool call names for activity logging
  const toolCallNames = new Map<string, string>();
  // Accumulate LLM text response for activity log
  let llmResponseBuffer = "";
  let turnIndex = 0;
  let hasToolCalls = false;
  let reminderSent = false; // Prevent duplicate reminders within one session
  let turnLimitReached = false;
  const terminalFields = (message?: Record<string, unknown>) => {
    if (turnLimitReached) return { reason: "max_turn_requests" };
    const terminal = classifyAssistantMessageTerminal(message ?? {});
    if (terminal.stopReason === "aborted") return { reason: "cancelled" };
    return terminal.terminalStatus === "error"
      ? { reason: "error", ...(terminal.errorMessage ? { error: terminal.errorMessage } : {}) }
      : { reason: "completed" };
  };
  // P2 #18: in internal mode both message_start and the thinking_start stream event
  // map to a thinking_start RPC event — dedupe so the frontend gets exactly one
  // thinking_start per thinking block.
  let thinkingStartEmitted = false;

  const unsubscribe = harness.subscribe(async (event: AgentHarnessEvent) => {
    // Re-emit harness events as RPC events
    switch (event.type) {
      case "agent_start":
        turnIndex = 0; // Reset turn counter for new agent session
        reminderSent = false;
        turnLimitReached = false;
        emitEvent({ type: "agent_start" });
        break;

      case "agent_end":
        activityLogger.setStatus("completed");
        // Don't close logger here — agent_end fires after every prompt response,
        // but the session may continue with more user messages.
        // Logger is closed on new_session or process shutdown.
        // A nested final-summary prompt ends while the outer long_task lifecycle is
        // still active. Its terminal boundary is deferred to the outer prompt so
        // consumers see one authoritative agent_end after orchestration_completed.
        if (isHarnessFinalizationDeferred()) break;
        if (!isInternalMode() && terminalFields([...event.messages].reverse().find(message => message.role === "assistant") as unknown as Record<string, unknown> | undefined).reason === "completed") await notifyBeforeAgentEnd();
        emitEvent({
          type: "agent_end",
          message_count: event.messages.length,
          ...terminalFields([...event.messages].reverse().find(message => message.role === "assistant") as unknown as Record<string, unknown> | undefined),
        });
        break;

      case "turn_start":
        turnIndex++;
        setMainTurnStarted(true);
        // For subsequent turns (after tool execution), log a new "call llm" entry
        if (turnIndex > 1 && hasToolCalls) {
          activityLogger.log("call llm", "(tool results)", "");
        }
        hasToolCalls = false;
        emitEvent({ type: "turn_start" });
        break;

      case "turn_end":
        // Warn LLM when approaching turn limit (inject steering message)
        const remainingTurns = MAX_TURNS_PER_PROMPT - turnIndex;
        if (!reminderSent && remainingTurns <= TURNS_REMINDER_BEFORE_LIMIT && remainingTurns > 0) {
          reminderSent = true;
          const warning = `⚠️ System reminder: This session is approaching the turn limit (approximately ${remainingTurns} turns remaining). Please complete the following immediately:\n1. Stop any unnecessary tool calls\n2. Summarize the completed work and append the structured result required by the current prompt\nDo not proceed with any new operations.`;
          log.warn("Turn limit approaching, injecting completion reminder", { turnIndex, remainingTurns });
          harness.steer(warning).catch((err) => {
            log.error("Failed to steer turn-limit reminder", { error: err instanceof Error ? err.message : String(err) });
          });
        }
        // Force abort if turn limit exceeded (prevents infinite tool-call loops)
        if (turnIndex >= MAX_TURNS_PER_PROMPT) {
          turnLimitReached = true;
          log.warn("Turn limit reached, aborting agent loop", { turns: turnIndex, limit: MAX_TURNS_PER_PROMPT });
          emitEvent({ type: "error", error: `Maximum turn limit reached (${MAX_TURNS_PER_PROMPT}), auto-terminated. Reason: Too many LLM calls in a single turn. Please simplify the task or split it into multiple sessions.` });
          harness.abort();
        }
        // Attach the turn's assistant text so the orchestrator can capture the final
        // reply on the boundary (Gateway caches content from the last no-tool turn_end;
        // without it, text-delivery task results stay empty and validation always fails)
        const turnMsg = event.message as unknown as { content?: Array<{ type?: string; text?: string }> };
        const rawTurnText = Array.isArray(turnMsg.content)
          ? turnMsg.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n")
          : "";
        const deliveryDecision = rawTurnText && event.toolResults.length === 0 && (!isInternalMode() || isHarnessFinalizationDeferred())
          ? parseDeliveryDecision(rawTurnText)
          : undefined;
        if (deliveryDecision) {
          if (deliveryDecision && config.artifactRunState) config.artifactRunState.deliveryDecision = deliveryDecision;
        }
        if (config.artifactRunState && !deliveryDecision && event.toolResults.length === 0 && (!isInternalMode() || isHarnessFinalizationDeferred())) {
          config.artifactRunState.invalidDeliverySelection = hasInvalidDeliverySelection(rawTurnText);
        }
        const turnText = stripDeliveryDecision(rawTurnText);
        emitEvent({
          type: "turn_end",
          has_tool_results: event.toolResults.length > 0,
          ...terminalFields(event.message as unknown as Record<string, unknown>),
          ...(turnText ? { content: turnText } : {}),
          ...(deliveryDecision ? { delivery_decision: deliveryDecision } : {}),
        });
        break;

      case "message_start":
        // Suppress user message bubbles during final notification ("Task Execution Complete" prompt)
        if (isSuppressUserBubble() && event.message.role === "user") break;
        thinkingStartEmitted = false;
        if (isInternalMode() && event.message.role === "assistant") {
          emitEvent({ type: "thinking_start", role: event.message.role });
          thinkingStartEmitted = true;
        } else {
          emitEvent({
            type: "message_start",
            role: event.message.role,
          });
        }
        break;

      case "message_update": {
        // Suppress user message updates during final notification
        if (isSuppressUserBubble() && event.message.role === "user") break;
        // Extract text delta from the assistantMessageEvent streaming protocol
        const ase = (event as any).assistantMessageEvent;
        let deltaText = "";
        let thinkingText = "";
        if (ase?.type === "text_delta" && typeof ase.delta === "string") {
          deltaText = ase.delta;
        } else if (ase?.type === "thinking_delta" && typeof ase.delta === "string") {
          thinkingText = ase.delta;
        } else if (ase?.type === "thinking_start") {
          if (!thinkingStartEmitted) {
            emitEvent({ type: "thinking_start", role: event.message.role });
            thinkingStartEmitted = true;
          }
        } else if (ase?.type === "thinking_end") {
          emitEvent({ type: "thinking_end", role: event.message.role });
          thinkingStartEmitted = false;
        } else if (ase?.type === "toolcall_start") {
          // LLM started generating a tool call — extract tool name from partial message
          const msgContent = (event.message as any).content;
          const toolBlock = msgContent?.[ase.contentIndex];
          const toolName = toolBlock?.name || "unknown";
          emitEvent({
            type: "tool_call_stream",
            phase: "start",
            role: event.message.role,
            tool_name: toolName,
          });
        } else if (ase?.type === "toolcall_delta") {
          // LLM is streaming tool call arguments as JSON — redact sensitive fields
          emitEvent({
            type: "tool_call_stream",
            phase: "delta",
            role: event.message.role,
            delta: redactSensitiveString(ase.delta),
          });
        } else if (ase?.type === "toolcall_end") {
          // LLM finished generating the tool call — full toolCall object available
          emitEvent({
            type: "tool_call_stream",
            phase: "end",
            role: event.message.role,
            tool_name: ase.toolCall?.name,
            tool_call_id: ase.toolCall?.id,
          });
        }
        // Accumulate assistant text for activity log (also in internal mode)
        if (deltaText && event.message.role === "assistant") {
          llmResponseBuffer += deltaText;
        }
        // Emit thinking event separately
        if (thinkingText) {
          emitEvent({
            type: "thinking",
            role: event.message.role,
            delta: thinkingText,
          });
        }
        // Emit text event — redirect to thinking during internal mode
        if (deltaText) {
          if (isInternalMode() && event.message.role === "assistant") {
            emitEvent({
              type: "thinking",
              role: event.message.role,
              delta: deltaText,
            });
          } else {
            emitEvent({
              type: "message_update",
              role: event.message.role,
              delta: deltaText,
            });
          }
        }
        break;
      }

      case "message_end": {
        // Suppress user message end during final notification
        if (isSuppressUserBubble() && event.message.role === "user") break;
        const msg = event.message as unknown as Record<string, unknown>;
        const terminal = event.message.role === "assistant"
          ? classifyAssistantMessageTerminal(msg)
          : undefined;
        // Update activity log with LLM response text (also in internal mode)
        if (event.message.role === "assistant" && llmResponseBuffer) {
          activityLogger.updateLastOutput(llmResponseBuffer);
          llmResponseBuffer = "";
        }
        if (isInternalMode() && event.message.role === "assistant") {
          // Track internal assistant calls for orchestration statistics
          incrementComplexAssistantCount();
          thinkingStartEmitted = false;
          const thinkPayload = { type: "thinking_end", role: event.message.role } as Record<string, unknown>;
          if (msg.usage) thinkPayload.usage = msg.usage;
          emitEvent(thinkPayload as RpcEvent);
        } else {
          const endPayload = {
            type: "message_end",
            role: event.message.role,
          } as Record<string, unknown>;
          if (event.message.role === "assistant" && msg.usage) endPayload.usage = msg.usage;
          if (terminal) {
            endPayload.terminal_status = terminal.terminalStatus;
            if (terminal.stopReason) endPayload.stop_reason = terminal.stopReason;
            if (terminal.errorMessage) endPayload.error_message = terminal.errorMessage;
          }
          emitEvent(endPayload as RpcEvent);
        }
        // Keep the standalone error event for clients that do not yet recognize terminal message_end fields.
        // Exception: benign end-of-turn misfires (e.g. Gemini MALFORMED_FUNCTION_CALL
        // after it already produced its final text) — the reply was streamed normally
        // and turn_end/agent_end follow, so don't surface an error to the user.
        if (terminal?.independentError) {
          log.error("LLM call failed", { error: terminal.errorMessage });
          emitEvent({ type: "error", error: terminal.independentError });
        } else if (terminal?.stopReason === "error" && terminal.errorMessage) {
          log.warn("LLM reported benign end-of-turn error, suppressing error event", { error: terminal.errorMessage });
        } else if (event.message.role !== "assistant") {
          // Preserve legacy behavior defensively: emit a standalone error if a non-assistant message carries a provider error.
          const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : undefined;
          const errorMessage = typeof msg.errorMessage === "string" ? msg.errorMessage : undefined;
          if (stopReason === "error" && errorMessage) {
            log.error("LLM call failed", { error: errorMessage });
            emitEvent({ type: "error", error: `LLM call failed: ${errorMessage}` });
          }
        }
        break;
      }

      case "tool_execution_start": {
        hasToolCalls = true;
        toolCallNames.set(event.toolCallId, event.toolName);
        const fileOps = ["read", "write", "edit"];
        const action = fileOps.includes(event.toolName) ? "operate file" : "execute tool";
        // Redact sensitive data before logging to prevent secrets in log files
        const redactedArgs = redactSensitiveData(event.args);
        const argsStr = event.args ? JSON.stringify(redactedArgs) : "";
        activityLogger.log(action as any, `${event.toolName}(${argsStr})`, "");
        emitEvent({
          type: "tool_execution_start",
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          args: redactedArgs,
        });
        break;
      }

      case "tool_execution_update":
        emitEvent({
          type: "tool_execution_update",
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          output: event.partialResult,
        });
        break;

      case "tool_execution_end": {
        const toolName = toolCallNames.get(event.toolCallId) || "unknown";
        const fileOps = ["read", "write", "edit"];
        const action = fileOps.includes(toolName) ? "operate file" : "execute tool";
        const resultStr = event.result
          ? (typeof event.result === "string" ? event.result : JSON.stringify(event.result)).slice(0, 50)
          : "";
        activityLogger.log(action as any, `${toolName}(${event.toolCallId})`, event.isError ? `error: ${resultStr}` : resultStr);
        toolCallNames.delete(event.toolCallId);
        emitEvent({
          type: "tool_execution_end",
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          is_error: event.isError,
        });
        break;
      }

      case "tool_result":
        // content_compressed event is emitted by the content-compressor extension
        // (with full payload: tool_call_id, original_length, compressed_length)
        // No need to emit here to avoid duplicate events with inconsistent payloads.
        break;

      case "session_compact":
        emitEvent({
          type: "session_compact",
          from_hook: event.fromHook,
        });
        break;
    }
  });

  return unsubscribe;
}

// ===== Sensitive data redaction utilities =====

/** Regex matching common secret/credential field names */
const SENSITIVE_KEY_PATTERN =
  /api[_-]?key|token|secret|password|credential|access[_-]?key|private[_-]?key|\bauth(?:orization)?(?:[_-](?:key|token))?\b(?!or)/i;

/** Check whether a key name represents a sensitive field */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Mask a sensitive value: keep first 2 and last 2 chars, replace middle with **** */
function maskValue(value: unknown): string {
  const str = String(value);
  if (str.length <= 4) return "****";
  return str.slice(0, 2) + "****" + str.slice(-2);
}

/** Redact sensitive JSON key-value pairs in a raw string (for streaming deltas) */
function redactSensitiveString(str: string): string {
  return str.replace(
    /("(?:api[_-]?key|token|secret|password|credential|access[_-]?key|private[_-]?key|\bauth(?:orization)?(?:[_-](?:key|token))?\b(?!or))"\s*:\s*)"(.*?)"/gi,
    (_match, prefix: string, value: string) => {
      const masked = value.length <= 4 ? "****" : value.slice(0, 2) + "****" + value.slice(-2);
      return `${prefix}"${masked}"`;
    },
  );
}

/** Recursively traverse an object/array and redact sensitive field values */
function redactSensitiveData(data: unknown): unknown {
  if (typeof data === "string") return redactSensitiveString(data);
  if (Array.isArray(data)) return data.map(redactSensitiveData);
  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (isSensitiveKey(key)) {
        result[key] = maskValue(value);
      } else {
        result[key] = redactSensitiveData(value);
      }
    }
    return result;
  }
  return data;
}
