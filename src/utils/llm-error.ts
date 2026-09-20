/**
 * LLM fatal error detection.
 *
 * Classifies provider error messages that indicate the API key itself is
 * unusable (invalid key, unauthorized, quota/balance exhausted). These errors
 * are NOT recoverable by retrying the same call, so callers should degrade
 * or fail fast instead of looping.
 */

/** Patterns that indicate an unusable API key or exhausted quota/balance. */
const KEY_OR_QUOTA_PATTERNS: RegExp[] = [
  // HTTP status codes commonly used for auth/billing failures
  /\b40[13]\b/,
  /\b402\b/,
  /\b429\b.*quota/i,
  // Invalid / unauthorized key
  /invalid[_\s-]?api[_\s-]?key/i,
  /incorrect api key/i,
  /invalid[_\s-]?token/i,
  /api key (not valid|invalid|expired)/i,
  /unauthorized/i,
  /authentication[_\s]?(error|failed|fail)/i,
  /permission[_\s]?denied/i,
  /access denied/i,
  /account (is )?(disabled|suspended|not active)/i,
  // Quota / billing exhausted
  /insufficient[_\s]?quota/i,
  /quota[_\s]?(exceeded|exhausted)/i,
  /exceeded your current quota/i,
  /billing/i,
  /insufficient[_\s]?(balance|funds|credits)/i,
  /(balance|credit)s? (is )?(insufficient|too low|exhausted)/i,
  // Chinese provider variants
  /无效的?(令牌|密钥|api\s*key)/i,
  /(令牌|密钥|key)(已)?(过期|失效|无效)/i,
  /余额不足/,
  /欠费/,
  /额度(已)?(用完|用尽|不足|超限)/,
  /(超出|超过).{0,6}(额度|配额)/,
  /认证失败/,
  /鉴权失败/,
];

/**
 * Returns true when the error message clearly indicates the LLM key is
 * unusable or the account quota/balance is exhausted — i.e. retrying the
 * same call cannot succeed.
 */
export function isLlmKeyOrQuotaError(message: string | undefined | null): boolean {
  if (!message) return false;
  return KEY_OR_QUOTA_PATTERNS.some((re) => re.test(message));
}

const BENIGN_COMPLETION_ERROR_PATTERNS = [
  /finish_?Reason:\s*MALFORMED_FUNCTION_CALL/i,
  /finish_?Reason:\s*UNEXPECTED_TOOL_CALL/i,
];

/** Known Gemini end-of-turn misfires are benign only after usable text exists. */
export function isBenignCompletionError(msg: Record<string, unknown>, errorMessage: string): boolean {
  if (!BENIGN_COMPLETION_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))) return false;
  const content = msg.content as Array<{ type?: string; text?: string }> | undefined;
  return Array.isArray(content) && content.some(
    (item) => item?.type === "text" && typeof item.text === "string" && item.text.trim().length > 0,
  );
}

export interface AssistantMessageTerminal {
  terminalStatus: "success" | "error";
  stopReason?: string;
  errorMessage?: string;
  /** Preserves the legacy standalone error event; only genuine LLM errors should emit it. */
  independentError?: string;
}

/**
 * Normalizes a provider's assistant completion state into the terminal RPC message_end state.
 * Known trailing false positives remain successful when valid text was produced, keeping clients from duplicating this rule.
 */
export function classifyAssistantMessageTerminal(msg: Record<string, unknown>): AssistantMessageTerminal {
  const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : undefined;
  const errorMessage = typeof msg.errorMessage === "string" && msg.errorMessage
    ? msg.errorMessage
    : undefined;
  const benignError = stopReason === "error"
    && errorMessage !== undefined
    && isBenignCompletionError(msg, errorMessage);
  const failed = !benignError && (stopReason === "error" || stopReason === "aborted");

  return {
    terminalStatus: failed ? "error" : "success",
    ...(stopReason ? { stopReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    // Preserve existing behavior: lifecycle events handle aborted runs without emitting an additional error event.
    ...(stopReason === "error" && errorMessage && !benignError
      ? { independentError: `LLM call failed: ${errorMessage}` }
      : {}),
  };
}

/** Thrown when the audit model's own key/quota is unusable — caller should degrade to standard mode. */
export class AuditModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditModelUnavailableError";
  }
}

/** Thrown when the main LLM returns a fatal key/quota error — caller should fail the conversation, not retry. */
export class MainLlmFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MainLlmFatalError";
  }
}

/**
 * Thrown when the user aborts the current run while a Long Task orchestration
 * is in flight. The orchestration loop must unwind immediately — no further
 * groups, audits, or continuation prompts may be issued.
 */
export class OrchestrationAbortedError extends Error {
  constructor(message = "Orchestration aborted by user") {
    super(message);
    this.name = "OrchestrationAbortedError";
  }
}
