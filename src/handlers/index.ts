/**
 * RPC Handler Context Factory
 *
 * Wires together all RPC handler groups (prompt, session, model, skill)
 * into a single RpcHandlerContext object for registration with the
 * RPC dispatch system.
 */

import type { AgentHarness } from "../vendor/agent/harness/agent-harness.ts";
import type { Session, ExecutionEnv, Skill } from "../vendor/agent/harness/types.ts";
import type { Model } from "../vendor/ai/base.ts";
import type {
  Capabilities,
  ConversationMode,
  HogAgentConfig,
} from "../utils/types.ts";
import type { ActivityLogger } from "../utils/activity-logger.ts";
import type { SkillApiConfigEntry } from "../config.ts";
import type { RpcHandlerContext } from "../rpc.ts";
import type { LlmTrackingContext } from "../llm-metadata-hook.ts";
import { type HandlerDeps, type HandlerMutableState } from "./types.ts";
import { createPromptHandlers } from "./prompt-handlers.ts";
import { createSessionHandlers } from "./session-handlers.ts";
import { createModelHandlers } from "./model-handlers.ts";
import { createSkillHandlers } from "./skill-handlers.ts";
import { CompactionManager } from "../compaction-manager.ts";
import type { LlmAuth } from "../llm-auth.ts";
import type { RuntimeContextManager } from "../runtime-context.ts";
import type { AgentToolRegistry } from "../tool-registry.ts";
import { createMcpHandlers } from "./mcp-handlers.ts";

/**
 * Create the RPC handler context by wiring together all handler groups.
 *
 * This replaces the original 1200-line createRpcHandlerContext function
 * in index.ts. Each handler group receives shared deps and mutable state.
 *
 * Returns both the context and the state (state.unsubscribe must be set with initial subscription by index.ts).
 */
export function createRpcHandlerContext(
  harnessRef: { current: AgentHarness },
  config: HogAgentConfig,
  _hogContext: unknown,
  activityLogger: ActivityLogger,
  auditModelObj: Model<any> | null,
  allSkills: Skill[],
  toolRegistry: AgentToolRegistry,
  skillsConfig: Record<string, SkillApiConfigEntry>,
  executionEnv: ExecutionEnv,
  currentModeRef: { value: ConversationMode | null },
  sessionRef: { current: Session },
  getCapabilitiesFn: () => Capabilities,
  llmTracking: LlmTrackingContext,
  resolveMainLlmAuth: (model: Model<any>) => Promise<LlmAuth>,
  runtimeContext: RuntimeContextManager,
): { context: RpcHandlerContext; state: HandlerMutableState; compactionManager: CompactionManager } {
  // Wrap mutable values in ref objects so handler modules can mutate them
  const activityLoggerRef: { current: ActivityLogger } = { current: activityLogger };
  const auditModelObjRef: { value: Model<any> | null } = { value: auditModelObj };
  // Build shared dependencies
  const compactionManager = new CompactionManager();
  const deps: HandlerDeps = {
    harnessRef,
    sessionRef,
    config,
    activityLoggerRef,
    auditModelObjRef,
    allSkills,
    toolRegistry,
    skillsConfig,
    executionEnv,
    currentModeRef,
    getCapabilitiesFn,
    ensureSessionRef: { current: null },
    llmTracking,
    compactionManager,
    resolveMainLlmAuth,
    runtimeContext,
  };

  // Build mutable state
  const state: HandlerMutableState = {
    switchedSession: false,
    sessionNameSaved: false,
    unsubscribe: null,
    quickThinkingOverride: false,
    savedThinkingLevel: null,
  };

  // Create handler groups
  const promptHandlers = createPromptHandlers(deps, state);
  const sessionHandlers = createSessionHandlers(deps, state);
  const modelHandlers = createModelHandlers(deps, state);
  const skillHandlers = createSkillHandlers(deps, state);
  const mcpHandlers = createMcpHandlers();

  // Assemble into RpcHandlerContext
  const context: RpcHandlerContext = {
    ...promptHandlers,
    ...sessionHandlers,
    ...modelHandlers,
    ...skillHandlers,
    ...mcpHandlers,
  };

  return { context, state, compactionManager };
}
