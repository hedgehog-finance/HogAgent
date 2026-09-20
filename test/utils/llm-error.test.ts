import { describe, it, expect } from "vitest";
import {
  isLlmKeyOrQuotaError,
  classifyAssistantMessageTerminal,
  AuditModelUnavailableError,
  MainLlmFatalError,
} from "../../src/utils/llm-error.ts";

// ─── Unit tests for LLM fatal error detection ─────────────────────────────────

describe("isLlmKeyOrQuotaError - key/auth errors", () => {
  it("should detect 401 status errors", () => {
    expect(isLlmKeyOrQuotaError("401 status code (no body)")).toBe(true);
  });

  it("should detect 403 status errors", () => {
    expect(isLlmKeyOrQuotaError("Request failed with status 403")).toBe(true);
  });

  it("should detect invalid_api_key errors", () => {
    expect(isLlmKeyOrQuotaError('{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}')).toBe(true);
  });

  it("should detect unauthorized errors", () => {
    expect(isLlmKeyOrQuotaError("Unauthorized: invalid credentials")).toBe(true);
  });

  it("should detect authentication_error", () => {
    expect(isLlmKeyOrQuotaError("authentication_error: x-api-key header is invalid")).toBe(true);
  });

  it("should detect Chinese invalid token errors", () => {
    expect(isLlmKeyOrQuotaError("无效的令牌")).toBe(true);
    expect(isLlmKeyOrQuotaError("密钥已过期")).toBe(true);
    expect(isLlmKeyOrQuotaError("认证失败")).toBe(true);
  });
});

describe("isLlmKeyOrQuotaError - quota/billing errors", () => {
  it("should detect insufficient_quota errors", () => {
    expect(isLlmKeyOrQuotaError("insufficient_quota: You exceeded your current quota, please check your plan and billing details")).toBe(true);
  });

  it("should detect quota exceeded errors", () => {
    expect(isLlmKeyOrQuotaError("Quota exceeded for this month")).toBe(true);
  });

  it("should detect insufficient balance errors", () => {
    expect(isLlmKeyOrQuotaError("Insufficient Balance")).toBe(true);
  });

  it("should detect Chinese quota errors", () => {
    expect(isLlmKeyOrQuotaError("账户余额不足，请充值")).toBe(true);
    expect(isLlmKeyOrQuotaError("额度已用完")).toBe(true);
    expect(isLlmKeyOrQuotaError("超出配额限制")).toBe(true);
  });
});

describe("isLlmKeyOrQuotaError - non-fatal errors", () => {
  it("should NOT match transient network errors", () => {
    expect(isLlmKeyOrQuotaError("ECONNRESET")).toBe(false);
    expect(isLlmKeyOrQuotaError("fetch failed: socket hang up")).toBe(false);
    expect(isLlmKeyOrQuotaError("Request timed out after 60000ms")).toBe(false);
  });

  it("should NOT match server errors", () => {
    expect(isLlmKeyOrQuotaError("500 Internal Server Error")).toBe(false);
    expect(isLlmKeyOrQuotaError("502 Bad Gateway")).toBe(false);
    expect(isLlmKeyOrQuotaError("503 Service Unavailable, overloaded")).toBe(false);
  });

  it("should NOT match plain rate limits without quota context", () => {
    expect(isLlmKeyOrQuotaError("429 Too Many Requests, retry after 3s")).toBe(false);
  });

  it("should return false for empty/undefined input", () => {
    expect(isLlmKeyOrQuotaError("")).toBe(false);
    expect(isLlmKeyOrQuotaError(undefined)).toBe(false);
    expect(isLlmKeyOrQuotaError(null)).toBe(false);
  });
});

describe("error classes", () => {
  it("AuditModelUnavailableError should carry name and message", () => {
    const err = new AuditModelUnavailableError("invalid api key");
    expect(err.name).toBe("AuditModelUnavailableError");
    expect(err.message).toBe("invalid api key");
    expect(err instanceof Error).toBe(true);
  });

  it("MainLlmFatalError should carry name and message", () => {
    const err = new MainLlmFatalError("insufficient quota");
    expect(err.name).toBe("MainLlmFatalError");
    expect(err.message).toBe("insufficient quota");
    expect(err instanceof Error).toBe(true);
  });
});

describe("classifyAssistantMessageTerminal", () => {
  it("marks normal completion as success and preserves stop reason", () => {
    expect(classifyAssistantMessageTerminal({ stopReason: "stop" })).toEqual({
      terminalStatus: "success",
      stopReason: "stop",
    });
  });

  it("marks provider failures as error and keeps the legacy independent error", () => {
    expect(classifyAssistantMessageTerminal({
      stopReason: "error",
      errorMessage: "provider unavailable",
    })).toEqual({
      terminalStatus: "error",
      stopReason: "error",
      errorMessage: "provider unavailable",
      independentError: "LLM call failed: provider unavailable",
    });
  });

  it("normalizes aborted completion as error without adding a new independent error event", () => {
    expect(classifyAssistantMessageTerminal({
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    })).toEqual({
      terminalStatus: "error",
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    });
  });

  it("keeps known benign tail errors successful after usable text", () => {
    expect(classifyAssistantMessageTerminal({
      stopReason: "error",
      errorMessage: "finishReason: MALFORMED_FUNCTION_CALL",
      content: [{ type: "text", text: "已经生成完整内容" }],
    })).toEqual({
      terminalStatus: "success",
      stopReason: "error",
      errorMessage: "finishReason: MALFORMED_FUNCTION_CALL",
    });
  });
});
