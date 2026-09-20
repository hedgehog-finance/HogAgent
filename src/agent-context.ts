import { deliveryResultsFromEntries } from "./artifacts/file-delivery.ts";
import type { Session } from "./vendor/agent/harness/session/session.ts";
/**
 * Agent Context Implementation
 *
 * Creates the HogAgentContext object that is passed to extensions
 * for tool registration, event subscription, and config access.
 */

import type { AgentHarness } from "./vendor/agent/harness/agent-harness.ts";
import type { AgentTool } from "./vendor/agent/types.ts";
import type {
  HogAgentConfig,
  HogAgentContext,
  RpcEvent,
} from "./utils/types.ts";
import type { LlmTrackingContext } from "./llm-metadata-hook.ts";
import type { RuntimeContextManager } from "./runtime-context.ts";
import { emitEvent } from "./rpc.ts";
import { createLogger } from "./utils/logger.ts";
import type { AgentToolRegistry } from "./tool-registry.ts";

const log = createLogger("core");

export function createHogAgentContext(
  // Mutable ref — new_session/resume_session replace the harness instance, and
  // extensions must always see the CURRENT one (a captured instance would leave
  // hooks/tool registration bound to a dead harness after session rebuild).
  harnessRef: { current: AgentHarness },
  config: HogAgentConfig,
  llmTracking: LlmTrackingContext,
  runtimeContext: RuntimeContextManager,
  toolRegistry: AgentToolRegistry,
  sessionRef?: { current: Session },
): HogAgentContext {
  const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    async registerTool(tool: unknown, registration = { source: "extension" }): Promise<void> {
      const agentTools = (Array.isArray(tool) ? tool : [tool]) as AgentTool[];
      await toolRegistry.registerOnHarness(harnessRef.current, agentTools, registration);
      log.info("Tools registered", { names: agentTools.map(tool => tool.name) });
    },

    async unregisterTool(name: string, ...additionalNames: string[]): Promise<void> {
      const names = [name, ...additionalNames];
      await toolRegistry.unregisterFromHarness(harnessRef.current, names);
      log.info("Tools unregistered", { names });
    },

    on(event: string, handler: (...args: unknown[]) => void): () => void {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, new Set());
      }
      eventListeners.get(event)!.add(handler);
      return () => {
        eventListeners.get(event)?.delete(handler);
      };
    },

    emitEvent(event: RpcEvent): void {
      emitEvent(event);
      // Also notify local listeners
      const listeners = eventListeners.get(event.type);
      if (listeners) {
        for (const listener of listeners) {
          listener(event);
        }
      }
    },

    captureDeliveryWriter() {
      const session = sessionRef?.current;
      const sessionId = config.sessionId;
      return async (result) => {
        if (!session || result.session_id !== sessionId) throw new Error("Delivery Session changed or is unavailable");
        await session.appendCustomEntry("hogagent.file-delivery", result);
      };
    },
    async readDeliveryHistory() {
      return sessionRef ? deliveryResultsFromEntries(await sessionRef.current.getEntries()) : [];
    },
    getConfig(): HogAgentConfig {
      return config;
    },

    getSessionId(): string {
      return config.sessionId;
    },

    getWorkspaceDir(): string {
      return config.workspaceDir;
    },

    getHarness(): AgentHarness {
      return harnessRef.current;
    },

    getLlmTracking(): LlmTrackingContext {
      return llmTracking;
    },

    getRuntimeContext() {
      return runtimeContext.getSnapshot();
    },
  };
}
