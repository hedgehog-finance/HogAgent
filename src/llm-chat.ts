/**
 * llm_chat RPC Command Implementation
 *
 * Creates a temporary InMemory Harness (no tools/skills), calls the LLM directly,
 * and streams results back via message_start / message_update / message_end events.
 * Only uses the main Harness model configuration; model_id override is not supported.
 */

import { AgentHarness } from "./vendor/agent/harness/agent-harness.ts";
import { InMemorySessionStorage } from "./vendor/agent/harness/session/memory-storage.ts";
import { Session } from "./vendor/agent/harness/session/session.ts";
import type { Model } from "./vendor/ai/base.ts";
import type { AgentHarnessEvent, ExecutionEnv } from "./vendor/agent/harness/types.ts";
import type { ThinkingLevel } from "./vendor/agent/types.ts";
import type { RpcEvent } from "./utils/types.ts";
import { createLogger } from "./utils/logger.ts";

const log = createLogger("llm-chat");

class IsolatedLlmChatTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`llm_chat timed out after ${timeoutMs}ms`);
    this.name = "IsolatedLlmChatTimeoutError";
  }
}

/**
 * Execute a single tool-less LLM conversation, streaming output via emitEvent callback.
 *
 * Event protocol:
 *   message_start  → message_update × N → message_end
 *
 * Uses a temporary InMemory Harness; does not write to the main session store.
 */
export async function llmChat(params: {
  text: string;
  /** Trusted system instruction for this isolated call; does not modify the main Harness prompt. */
  systemPrompt?: string;
  model: Model<any>;
  getApiKey: () => Promise<string>;
  env: ExecutionEnv;
  emitEvent: (event: RpcEvent) => void;
  /** Overrides the temporary Harness thinking depth; defaults to "off" without changing the main Agent configuration. */
  thinkingLevel?: ThinkingLevel;
  /** Best-effort execution timeout for this temporary Harness only. */
  timeoutMs?: number;
}): Promise<void> {
  const { text, systemPrompt, model, getApiKey, env, emitEvent, thinkingLevel, timeoutMs } = params;

  let timedOut = false;

  const tempHarness = new AgentHarness({
    env,
    session: new Session(new InMemorySessionStorage()),
    model,
    tools: [],
    thinkingLevel: thinkingLevel ?? "off",
    resources: {},
    getApiKeyAndHeaders: async () => ({ apiKey: await getApiKey() }),
    systemPrompt: () => systemPrompt || "You are a helpful assistant.",
  });

  // Forward harness events as llm_chat-specific RPC events
  tempHarness.subscribe((event: AgentHarnessEvent) => {
    // An abort may synthesize an empty assistant terminal message. Once this
    // call owns a timeout, suppress that synthetic success boundary and emit a
    // single explicit error below instead.
    if (timedOut) return;
    switch (event.type) {
      case "message_start":
        emitEvent({ type: "message_start", role: event.message.role });
        break;
      case "message_update": {
        const ase = (event as any).assistantMessageEvent;
        if (ase?.type === "text_delta" && typeof ase.delta === "string") {
          emitEvent({ type: "message_update", role: event.message.role, delta: ase.delta });
        }
        break;
      }
      case "message_end":
        emitEvent({
          type: "message_end",
          role: event.message.role,
          ...((event.message as any).usage ? { usage: (event.message as any).usage } : {}),
        });
        break;
      // Ignore tool / thinking / turn events (not needed in tool-less scenario)
    }
  });

  log.info("llm_chat started", { textLength: text.length });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        void tempHarness.abort().catch((error: unknown) => {
          log.warn("llm_chat timeout abort failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, timeoutMs);
    }
    const response = await tempHarness.prompt(text);
    if (timedOut) throw new IsolatedLlmChatTimeoutError(timeoutMs!);
    if (response?.stopReason === "error") {
      throw new Error(response.errorMessage || "LLM provider returned an error");
    }
    log.info("llm_chat completed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("llm_chat failed", { error: msg });
    emitEvent({ type: "error", error: `llm_chat failed: ${msg}` });
  } finally {
    if (timeout) clearTimeout(timeout);
    // Keep the process lifecycle balanced even when the isolated model call fails.
    emitEvent({ type: "agent_end", message_count: 1 });
  }
}
