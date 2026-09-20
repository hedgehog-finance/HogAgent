import { gatewayProjectsDirectory } from "./gateway-project.ts";
/**
 * HogAgent Main Entry Point
 *
 * Creates and configures the AgentHarness (from Pi vendor),
 * loads configuration, initializes extensions, registers tools,
 * subscribes to harness events and re-emits as RPC events.
 *
 * This module is now a thin orchestration layer — all implementation
 * logic has been extracted into dedicated modules:
 *   - model-utils.ts        : Model conversion
 *   - system-prompt.ts      : System prompt builder
 *   - skill-loader.ts       : Skill loading & frontmatter parsing
 *   - session-storage.ts     : Session storage & repair
 *   - agent-state.ts        : Shared mutable state
 *   - agent-context.ts      : Agent context implementation
 *   - harness-events.ts     : Harness event subscription
 *   - handlers/             : RPC command handlers (by domain)
 */

import { AgentHarness } from "./vendor/agent/harness/agent-harness.ts";
import { NodeExecutionEnv } from "./vendor/agent/harness/env/nodejs.ts";
import { Session } from "./vendor/agent/harness/session/session.ts";
import type {
  AgentHarnessOptions,
  Skill,
} from "./vendor/agent/harness/types.ts";
import type { Model } from "./vendor/ai/base.ts";
// Import to trigger auto-registration of all built-in LLM API providers
import "./vendor/ai/providers/register-builtins.ts";
import { loadConfig, getProjectRoot, getSessionsDir, getSystemDir, loadSkillApiConfig, loadPersistedLlmSettings, loadSystemConfig, getSystemConfigSnapshot, readModeMetadata, resolveSandboxMode } from "./config.ts";
import type { SkillApiConfigEntry } from "./config.ts";
import type { CliArgs } from "./config.ts";
import type { PersistedLlmSettings } from "./config.ts";
import {
  getDeliveryManager,
  getExtensionNames,
  initializeExtensions,
  shutdownExtensions,
} from "./extensions/index.ts";
import {
  emitEvent,
  registerBuiltinHandlers,
  onShutdown,
  setCurrentSessionId,
} from "./rpc.ts";
import { createLogger } from "./utils/logger.ts";
import { createMathCalcTool } from "./tools/math-calc.ts";
import { createWebSearchTool } from "./tools/web-search.ts";
import { createWebFetchTool } from "./tools/web-fetch.ts";
import { createBuiltinTools } from "./tools/builtin-tools.ts";
import { prepareBashRuntime } from "./tools/bash-sandbox.ts";
import { createActivityLogger } from "./utils/activity-logger.ts";
import { createMainLlmAuthResolver } from "./llm-auth.ts";
import { DEFAULT_CONTEXT_WINDOW } from "./model-window.ts";
import { hasIncompleteOrchestration } from "./long-task-orchestrator.ts";
import type {
  Capabilities,
  ConversationMode,
  HogAgentConfig,
  HogAgentContext,
} from "./utils/types.ts";
import { existsSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";

// Re-import from extracted modules
import {
  configModelToAgentModel,
  HEDGEHOG_DEFAULT_MODEL_ID,
  selectDefaultModelConfig,
} from "./model-utils.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { loadSkillsFromDirs } from "./skill-loader.ts";
import { openOrCreateSessionStorage } from "./session-storage.ts";
import { createHogAgentContext } from "./agent-context.ts";
import { subscribeToHarnessEvents } from "./harness-events.ts";
import { createRpcHandlerContext } from "./handlers/index.ts";
import { ensureDir } from "./utils/ensure-dir.ts";
import {
  registerLlmMetadataHook,
  registerMainLlmContextThrottle,
  type LlmTrackingContext,
} from "./llm-metadata-hook.ts";
import {
  getRuntimeContextCapability,
  loadProcessRuntimeContextInput,
  RuntimeContextManager,
} from "./runtime-context.ts";
import { AgentToolRegistry } from "./tool-registry.ts";

const log = createLogger("core");

// Set NODE_PATH so skill scripts (spawned via bash) can resolve modules from project node_modules
const _projectNodeModules = join(getProjectRoot(), "node_modules");
if (process.env["NODE_PATH"]) {
  if (!process.env["NODE_PATH"]!.includes(_projectNodeModules)) {
    process.env["NODE_PATH"] = `${process.env["NODE_PATH"]}:${_projectNodeModules}`;
  }
} else {
  process.env["NODE_PATH"] = _projectNodeModules;
}

// ─── HogAgent Instance ────────────────────────────────────────────────────────

export interface HogAgentInstance {
  harness: AgentHarness;
  config: HogAgentConfig;
  context: HogAgentContext;
  getCapabilities(): Capabilities;
  hasIncompleteOrchestration(): boolean;
  shutdown(): Promise<void>;
}

// ─── Create HogAgent ──────────────────────────────────────────────────────────

/**
 * Create and initialize a HogAgent instance.
 * This is the primary factory function for creating the agent.
 */
export async function createHogAgent(cliArgs?: CliArgs): Promise<HogAgentInstance> {
  log.info("Creating HogAgent instance");

  // 1. Load configuration
  const config = loadConfig(cliArgs);

  const runtimeContext = new RuntimeContextManager({
    workspaceDir: config.workspaceDir,
    mode: config.mode,
    user: config.user ?? "default",
    processContext: loadProcessRuntimeContextInput({
      value: cliArgs?.processRuntimeContext,
      filePath: cliArgs?.runtimeContextFile,
    }),
  });
  runtimeContext.bindSession(config.sessionId, config.sessionTaskDir);

  // Set the initial session ID for automatic event injection
  setCurrentSessionId(config.sessionId);

  // 1.5. Create session task directory (with retry for concurrent instances)
  await ensureDir(config.sessionTaskDir);

  // 2. Prepare the initial model
  // Determine initial model — use persisted modelId if available
  const persistedSettings = loadPersistedLlmSettings();
  const sysCfg = loadSystemConfig();
  const persistedModelId = persistedSettings.modelId;
  const persistedModelConfig = persistedModelId
    ? config.llmProvider.models?.find((model) => model.id === persistedModelId)
    : undefined;
  const defaultModelConfig = selectDefaultModelConfig(
    config.llmProvider.provider,
    config.llmProvider.models ?? [],
  );
  const initialModel = persistedModelConfig
    ? configModelToAgentModel(
        persistedModelConfig,
        config.llmProvider.provider,
        config.llmProvider.baseUrl || "",
        sysCfg.explicitCache,
      )
    : persistedModelId
      ? configModelToAgentModel(
          { id: persistedModelId, name: persistedModelId, contextWindow: DEFAULT_CONTEXT_WINDOW },
          config.llmProvider.provider,
          config.llmProvider.baseUrl || "",
          sysCfg.explicitCache,
        )
      : defaultModelConfig
        ? configModelToAgentModel(
            defaultModelConfig,
            config.llmProvider.provider,
            config.llmProvider.baseUrl || "",
            sysCfg.explicitCache,
          )
        : configModelToAgentModel(
            { id: HEDGEHOG_DEFAULT_MODEL_ID, name: "Qwen 3.8 Flash", contextWindow: DEFAULT_CONTEXT_WINDOW },
            "hedgehog",
            "https://api.ciweiai.com/api/llm/v1",
            sysCfg.explicitCache,
          );

  // 3. Create execution environment
  const env = new NodeExecutionEnv({ cwd: config.workspaceDir });

  // 4. Create session (JSONL persistent storage or in-memory)
  const sessionsDir = getSessionsDir(config.user);
  await ensureDir(sessionsDir);
  const sessionFilePath = join(sessionsDir, `${config.sessionId}.jsonl`);
  const isRestoredInitialSession = existsSync(sessionFilePath);
  let currentMode: ConversationMode | null = isRestoredInitialSession
    ? readModeMetadata(config.sessionTaskDir)?.mode ?? null
    : null;

  const storage = await openOrCreateSessionStorage(env, sessionFilePath, config.workspaceDir, config.sessionId);
  const session = new Session(storage);

  // 5. Load skills
  const skills = loadSkillsFromDirs(config.workspaceDir);

  // 5.1 Load per-skill config from ~/.hogagent/skills_config.json
  const skillsConfig: Record<string, SkillApiConfigEntry> = loadSkillApiConfig();

  // 5.5 Create tools (Pi built-in + HogAgent custom)
  // All tools use workspaceDir as their default CWD
  const bashRuntimeResult = await prepareBashRuntime({
    workspaceDir: config.workspaceDir,
    projectRoot: getProjectRoot(),
    systemDir: getSystemDir(),
    configuredPython: sysCfg.pythonPath ?? process.env["HOGAGENT_PYTHON"],
    sandboxMode: resolveSandboxMode(sysCfg),
  });
  if (!bashRuntimeResult.available) {
    log.warn(bashRuntimeResult.reason);
  } else if (bashRuntimeResult.runtime.unrestrictedByPlatform) {
    log.warn("Bash running in platform-required UNSANDBOXED mode; sandboxMode is ignored", {
      platform: process.platform,
      pythonEnvironment: bashRuntimeResult.runtime.pythonEnvironment?.root,
      reason: bashRuntimeResult.runtime.degradedReason,
    });
  } else if (bashRuntimeResult.runtime.unrestrictedByConfiguration) {
    log.warn("Bash sandbox disabled by system configuration", {
      pythonEnvironment: bashRuntimeResult.runtime.pythonEnvironment?.root,
      pythonFallbackReason: bashRuntimeResult.runtime.degradedReason,
    });
  } else if (bashRuntimeResult.runtime.backend === "bare-shell") {
    log.warn("Bash running in degraded UNSANDBOXED mode", {
      reason: bashRuntimeResult.runtime.degradedReason,
    });
  } else {
    log.info("Bash sandbox ready", {
      backend: bashRuntimeResult.runtime.backend,
      pythonEnvironment: bashRuntimeResult.runtime.pythonEnvironment?.root,
    });
  }
  const builtinTools = createBuiltinTools(
    () => config.workspaceDir,
    () => config.sessionTaskDir,
    bashRuntimeResult.available ? bashRuntimeResult.runtime : undefined,
    () => config,
  );
  const customTools = [createMathCalcTool(), createWebSearchTool(), createWebFetchTool(() => config.sessionTaskDir, () => config)];
  const toolRegistry = new AgentToolRegistry([
    ...builtinTools.map((tool) => ({ tool, registration: { source: "builtin" as const } })),
    ...customTools.map((tool) => ({ tool, registration: { source: "custom" as const } })),
  ]);

  // 5.6 Create audit model object (vendor Model, NOT AgentHarness)
  let auditModelObj: Model<any> | null = null;
  if (config.auditModel) {
    auditModelObj = configModelToAgentModel(
      { id: config.auditModel.modelId, name: config.auditModel.modelId, contextWindow: DEFAULT_CONTEXT_WINDOW },
      config.auditModel.provider,
      config.auditModel.baseUrl || "",
    );
    log.info("Audit model object created", { provider: config.auditModel.provider, modelId: config.auditModel.modelId });
  }

  // 6. Create AgentHarness
  const resolveMainLlmAuth = createMainLlmAuthResolver(config);
  const harness = new AgentHarness({
    env,
    session,
    model: initialModel,
    tools: toolRegistry.snapshotTopLevel(),
    thinkingLevel: (persistedSettings.thinkingLevel as import("./vendor/agent/types.ts").ThinkingLevel) || "medium",
    resources: { skills },
    getApiKeyAndHeaders: resolveMainLlmAuth,
    systemPrompt: ({ env: _env, model, activeTools, resources }) => {
      return buildSystemPrompt({
        workspaceDir: config.workspaceDir,
        sessionTaskDir: config.sessionTaskDir,
        model,
        skills: (resources.skills ?? []) as Skill[],
        activeTools,
        currentMode,
        theme: config.theme,
        projectDir: config.projectDir,
        runtimeContext: runtimeContext.getSnapshot(),
      });
    },
  } as AgentHarnessOptions);

  // 7. Create mutable references for harness, session, and mode
  // (created BEFORE the context so extensions always see the current harness)
  const harnessRef: { current: AgentHarness } = { current: harness };
  const sessionRef: { current: Session } = { current: session };

  // 7.1. Business tracking context (updated by prompt command metadata from Gateway)
  const llmTracking: LlmTrackingContext = { sessionId: config.sessionId, workId: "", taskId: "" };
  registerLlmMetadataHook(harness, llmTracking);
  registerMainLlmContextThrottle(harness);

  // 7.5. Create HogAgent context (holds harnessRef — survives session rebuilds)
  const hogContext = createHogAgentContext(harnessRef, config, llmTracking, runtimeContext, toolRegistry, sessionRef);

  // 7.6. Create activity logger
  const activityLogger = createActivityLogger(join(config.sessionTaskDir, "log.txt"));

  // 8. Subscribe to harness events → RPC stdout
  // Bug 7 fix: Save initial subscription return value; assign to state.unsubscribe after handler context is created
  const initialUnsubscribe = subscribeToHarnessEvents(harness, activityLogger, config);

  // 9. Initialize extensions
  await initializeExtensions(hogContext, config.extensions, config.workspaceDir);
  if (isRestoredInitialSession) {
    // Starting the process directly on an existing session is also a restoration,
    // even if no resume_session RPC command is subsequently needed.
    getDeliveryManager()?.setAutoDeliveryModifiedAfter(Date.now());
  }

  // 9.1. Get all tools including extension-registered tools
  const allToolsWithExtensions = toolRegistry.snapshotTopLevel();
  log.info("Tools after extension initialization", { count: allToolsWithExtensions.length, names: allToolsWithExtensions.map(t => t.name) });

  // 10. Register RPC command handlers
  const { context: handlerContext, state: handlerState } = createRpcHandlerContext(harnessRef, config, hogContext, activityLogger, auditModelObj, skills, toolRegistry, skillsConfig, env, { get value() { return currentMode; }, set value(v) { currentMode = v; } }, sessionRef, getCapabilities, llmTracking, resolveMainLlmAuth, runtimeContext);
  // Bug 7 fix: Store initial subscription in state.unsubscribe so onNewSession/onResumeSession can properly clean up
  handlerState.unsubscribe = initialUnsubscribe;
  handlerState.sessionNameSaved = isRestoredInitialSession;
  registerBuiltinHandlers(handlerContext);

  // 11. Register shutdown callback — shutdown extensions and clean up empty session files
  // Note: harnessRef.current.abort() and waitForIdle() are registered by bin/hogagent.ts via
  // onShutdown(instance.shutdown); this section only handles extension shutdown and session file cleanup
  onShutdown(async () => {
    await shutdownExtensions();
    // Clean up current session files if no user messages were sent
    try {
      const sessionsDir = getSessionsDir(config.user);
      const sessionFilePath = join(sessionsDir, `${config.sessionId}.jsonl`);
      if (existsSync(sessionFilePath)) {
        const content = readFileSync(sessionFilePath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        let hasUserMessages = false;
        for (let i = 1; i < lines.length; i++) {
          try {
            const entry = JSON.parse(lines[i]!);
            if (entry.message?.role === "user") { hasUserMessages = true; break; }
          } catch { /* skip */ }
        }
        log.info("Shutdown session cleanup check", {
          sessionId: config.sessionId,
          hasUserMessages,
          lineCount: lines.length,
          fileSize: content.length,
        });
        // Delete empty session (no user messages) on shutdown
        if (!hasUserMessages) {
          unlinkSync(sessionFilePath);
          if (existsSync(config.sessionTaskDir)) {
            rmSync(config.sessionTaskDir, { recursive: true, force: true });
          }
          log.info("Cleaned up empty session on shutdown", { sessionId: config.sessionId, lineCount: lines.length });
        }
      }
    } catch (err) {
      log.error("Failed to clean up empty session on shutdown", { error: String(err) });
    }
  });

  // 12. Build capabilities
  function getCapabilities(): Capabilities {
    // Read system config fresh each time to reflect latest toggle state
    const currentSysCfg = loadSystemConfig();
    return {
      extensions: getExtensionNames(),
      builtin_tools: harnessRef.current.getTools().map((t) => t.name),
      installed_skills: skills.map((s) => s.name),
      // Automatic pre-prompt and idle manual compaction are both available.
      supports_compaction: true,
      supports_sub_agent: true,
      supports_llm_chat: true,
      supports_gateway_projects: Boolean(gatewayProjectsDirectory()),
      supports_concurrent_history_read: true,
      runtime_context: getRuntimeContextCapability(),
      llmProvider: {
        provider: config.llmProvider.provider,
        // apiKey is intentionally omitted here — the WebUI server's _serverInit ready
        // event sends the real key from llm-settings.json. Sending a masked key here
        // would overwrite state.currentApiKey with "****1234", causing save_settings
        // to persist the masked value back to disk.
        baseUrl: config.llmProvider.baseUrl || "",
        // Models are no longer cached server-side; client fetches from provider on demand
      },
      currentModel: harnessRef.current.getModel().id,
      thinkingLevel: harnessRef.current.getThinkingLevel(),
      quickThinkingLevel: loadPersistedLlmSettings().quickThinkingLevel || "off",
      auditModel: config.auditModel ? {
        provider: config.auditModel.provider,
        modelId: config.auditModel.modelId,
        baseUrl: config.auditModel.baseUrl,
        // apiKey intentionally omitted — same reason as llmProvider above
        minPassScore: config.auditModel.minPassScore,
        maxIterations: config.auditModel.maxIterations,
        configured: true,
      } : { configured: false },
      explicitCache: currentSysCfg.explicitCache ?? false,
      systemConfig: getSystemConfigSnapshot(currentSysCfg),
    };
  }

  const instance: HogAgentInstance = {
    harness,
    config,
    context: hogContext,
    getCapabilities,
    hasIncompleteOrchestration: () => hasIncompleteOrchestration(config.sessionTaskDir),
    async shutdown(): Promise<void> {
      log.info("Shutting down HogAgent");
      await harnessRef.current.abort();
      await harnessRef.current.waitForIdle();
      await shutdownExtensions();
    },
  };

  log.info("HogAgent instance created", {
    sessionId: config.sessionId,
    mode: config.mode,
    model: initialModel.id,
  });

  return instance;
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

// Types
export type { HogAgentConfig, Capabilities } from "./utils/types.ts";
export type { CliArgs } from "./config.ts";
export type {
  CurrentRunContextInput,
  ProcessRuntimeContextInput,
  RuntimeContextSnapshot,
  SessionRuntimeContextInput,
} from "./runtime-context.ts";

// RPC
export { emitEvent } from "./rpc.ts";

// Logger
export { logger, createLogger, setLogLevel } from "./utils/logger.ts";

// Shared state (used by audit-classifier.ts and long-task-orchestrator.ts)
export { setInternalMode, isMainTurnStarted } from "./agent-state.ts";

// Utilities (used by tests)
export { ensureDir } from "./utils/ensure-dir.ts";
export { parseSkillFrontmatter } from "./skill-loader.ts";
