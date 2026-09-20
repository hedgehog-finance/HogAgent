/**
 * Model & Settings RPC Handlers
 *
 * Handles model switching, thinking level, LLM provider updates,
 * settings persistence, and model list refreshing.
 */

import type { ThinkingLevel } from "../vendor/agent/types.ts";
import { isDeepStrictEqual } from "node:util";
import type { HogAgentConfig, RpcCommand, RpcEvent } from "../utils/types.ts";
import { emitEvent } from "../rpc.ts";
import { createLogger } from "../utils/logger.ts";
import { configModelToAgentModel, selectDefaultModelConfig } from "../model-utils.ts";
import { listConfiguredModels } from "../configuration-service.ts";
import {
  DEFAULT_AUDIT_MAX_ITERATIONS,
  getSystemConfigSnapshot,
  isSandboxMode,
  isValidAuditMaxIterations,
  loadPersistedLlmSettings,
  mergeLlmSettingsPatch,
  loadSystemConfig,
  normalizeAuditMaxIterations,
  savePersistedLlmSettings,
  saveSystemConfig,
} from "../config.ts";
import type { PersistedLlmSettings, SandboxMode } from "../config.ts";
import { applyExtensionConfigUpdates } from "../extensions/index.ts";
import { type HandlerDeps, type HandlerMutableState } from "./types.ts";
import { DEFAULT_CONTEXT_WINDOW } from "../model-window.ts";

const log = createLogger("core");

export function createModelHandlers(deps: HandlerDeps, state: HandlerMutableState) {
  const { harnessRef, config } = deps;

  // ─── onGetState ───────────────────────────────────────────────────────

  function onGetState(): void {
    emitEvent({
      type: "state",
      model: harnessRef.current.getModel().id,
      provider: config.llmProvider.provider,
      base_url: config.llmProvider.baseUrl || "",
      thinking_level: harnessRef.current.getThinkingLevel(),
      session_id: config.sessionId,
      tool_count: harnessRef.current.getTools().length,
      // Bug 2 fix: Add mode field so frontend can restore conversation mode state after reload
      mode: deps.currentModeRef.value,
    });
  }

  // ─── onSetModel ───────────────────────────────────────────────────────

  async function onSetModel(command: RpcCommand): Promise<void> {
    const modelId = command.model_id as string | undefined;
    if (!modelId) {
      emitEvent({ type: "error", error: "set_model requires 'model_id' field" });
      return;
    }
    const modelConfig = config.llmProvider.models?.find((model) => model.id === modelId);
    const sysCfg = loadSystemConfig();
    const model = configModelToAgentModel(
      modelConfig ?? { id: modelId, name: modelId, contextWindow: DEFAULT_CONTEXT_WINDOW },
      config.llmProvider.provider,
      config.llmProvider.baseUrl || "",
      sysCfg.explicitCache,
    );
    await harnessRef.current.setModel(model);
    log.info("Model changed", { modelId });
    emitEvent({ type: "model_changed", model_id: modelId });
  }

  // ─── onSetThinkingLevel ──────────────────────────────────────────────

  async function onSetThinkingLevel(command: RpcCommand): Promise<void> {
    const level = command.level as string | undefined;
    if (!level) {
      emitEvent({ type: "error", error: "set_thinking_level requires 'level' field" });
      return;
    }
    const validLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
    if (!validLevels.includes(level)) {
      emitEvent({ type: "error", error: `Invalid thinking level: ${level}` });
      return;
    }
    await harnessRef.current.setThinkingLevel(level as ThinkingLevel);
    if (state.quickThinkingOverride) state.savedThinkingLevel = level;
    emitEvent({ type: "thinking_level_changed", level });
  }

  // ─── onSetLlmProvider ────────────────────────────────────────────────

  async function onSetLlmProvider(command: RpcCommand): Promise<void> {
    const provider = command.provider as HogAgentConfig["llmProvider"] | undefined;
    if (!provider) {
      emitEvent({ type: "error", error: "set_llm_provider requires 'provider' field" });
      return;
    }
    config.llmProvider = { ...config.llmProvider, ...provider };
    const defaultModel = selectDefaultModelConfig(provider.provider, provider.models ?? []);
    if (defaultModel) {
      const sysCfg = loadSystemConfig();
      const model = configModelToAgentModel(
        defaultModel,
        provider.provider,
        provider.baseUrl || "",
        sysCfg.explicitCache,
      );
      await harnessRef.current.setModel(model);
    }
    log.info("LLM provider updated", { provider: provider.provider });
    emitEvent({ type: "llm_provider_changed", provider: provider.provider });
  }

  // ─── onSaveSettings ──────────────────────────────────────────────────

  async function onSaveSettings(command: RpcCommand): Promise<void> {
    const reloadPersistedLlm = command.reloadPersistedLlm === true;
    if (reloadPersistedLlm) {
      const latest = loadPersistedLlmSettings(true);
      const credentials = (settings: PersistedLlmSettings) => [
        settings.provider, settings.apiKey, settings.baseUrl, settings.providerApiKeys,
        settings.audit?.provider, settings.audit?.apiKey, settings.audit?.baseUrl,
      ];
      if (!isDeepStrictEqual(credentials(command as PersistedLlmSettings), credentials(latest))) {
        throw new Error("LLM credentials changed while settings were queued; reapply settings or restart HogAgent");
      }
      command = { type: "save_settings", ...latest };
    }
    const provider = command.provider as string | undefined;
    const apiKey = command.apiKey as string | undefined;
    const baseUrl = command.baseUrl as string | undefined;
    const modelId = command.modelId as string | undefined;
    const thinkingLevel = command.thinkingLevel as string | undefined;
    const quickThinkingLevel = command.quickThinkingLevel as string | undefined;
    const providerApiKeys = command.providerApiKeys as Record<string, string> | undefined;
    const hasApiKey = Object.prototype.hasOwnProperty.call(command, "apiKey");
    const hasBaseUrl = Object.prototype.hasOwnProperty.call(command, "baseUrl");

    // Audit model settings from command
    // - audit = { provider: "..." } → user configured audit
    // - audit = {} → user explicitly cleared audit
    // - audit = null or undefined → frontend didn't send audit; preserve existing
    const audit = command.audit as {
      provider?: string;
      apiKey?: string;
      baseUrl?: string;
      modelId?: string;
      minPassScore?: number;
      maxIterations?: number;
    } | null | undefined;

    // Compaction settings from command
    const compaction = command.compaction as { autoCompactThreshold?: number } | undefined;

    // System config: explicit cache toggle + new fields
    const explicitCache = command.explicitCache as boolean | undefined;
    const showCacheStats = command.showCacheStats as boolean | undefined;
    const rawSystemConfig = command.systemConfig;
    if (rawSystemConfig !== undefined
      && (rawSystemConfig === null || typeof rawSystemConfig !== "object" || Array.isArray(rawSystemConfig))) {
      throw new Error("systemConfig must be an object");
    }
    const systemConfig = rawSystemConfig as {
      sandboxMode?: unknown;
      compressorEnabled?: boolean;
      compressThreshold?: number;
      subagentMaxTurns?: number;
      memoryEnabled?: boolean;
      memoryMcpKbUrl?: string;
    } | undefined;
    if (systemConfig?.sandboxMode !== undefined && !isSandboxMode(systemConfig.sandboxMode)) {
      throw new Error("sandboxMode must be enabled, fallback, or disabled");
    }

    if (systemConfig?.compressorEnabled !== undefined && typeof systemConfig.compressorEnabled !== "boolean") {
      throw new Error("compressorEnabled must be a boolean");
    }

    if (audit?.maxIterations !== undefined && !isValidAuditMaxIterations(audit.maxIterations)) {
      throw new Error("audit.maxIterations must be a non-negative safe integer");
    }

    // 1. Load existing settings to preserve providerApiKeys
    const existingSettings = loadPersistedLlmSettings(true);
    const effectiveProvider = provider || existingSettings.provider || config.llmProvider.provider;
    const hasLlmFields = !!(provider || hasApiKey || hasBaseUrl || modelId || thinkingLevel
      || quickThinkingLevel || audit || compaction || providerApiKeys);

    const requestedThreshold = compaction?.autoCompactThreshold;
    if (requestedThreshold !== undefined
      && (!Number.isFinite(requestedThreshold) || requestedThreshold <= 0 || requestedThreshold >= 1)) {
      throw new Error("autoCompactThreshold must be a finite number greater than 0 and less than 1");
    }

    // Use the same endpoint/key merge policy as the session-free management API.
    const mergedEndpoints = mergeLlmSettingsPatch({
      provider: config.llmProvider.provider,
      apiKey: config.llmProvider.apiKey,
      baseUrl: config.llmProvider.baseUrl,
      audit: config.auditModel,
      ...existingSettings,
    }, {
      provider: effectiveProvider,
      ...(hasApiKey ? { apiKey: apiKey ?? "" } : {}),
      ...(hasBaseUrl ? { baseUrl: baseUrl ?? "" } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
      providerApiKeys,
      ...(audit ? { audit } : {}),
    });
    const mergedProviderApiKeys = mergedEndpoints.providerApiKeys!;
    // 3. Merge audit settings
    // - audit sent with empty provider → user cleared audit config → {}
    // - audit sent with provider → merge with existing
    // - audit not sent (undefined) → preserve existing
    let mergedAudit: PersistedLlmSettings["audit"];
    if (audit) {
      if (audit.provider === "close") {
        mergedAudit = { provider: "close" };
      } else if (mergedEndpoints.audit?.provider) {
        // User configured audit — merge individual fields with existing
        const hasExistingMaxIterations = Boolean(existingSettings.audit)
          && Object.prototype.hasOwnProperty.call(existingSettings.audit, "maxIterations");
        mergedAudit = {
          provider: mergedEndpoints.audit.provider,
          apiKey: mergedEndpoints.audit.apiKey ?? "",
          baseUrl: mergedEndpoints.audit.baseUrl ?? "",
          modelId: mergedEndpoints.audit.modelId ?? "",
          minPassScore: audit.minPassScore ?? existingSettings.audit?.minPassScore ?? 70,
          maxIterations: normalizeAuditMaxIterations(
            audit.maxIterations !== undefined
              ? audit.maxIterations
              : hasExistingMaxIterations ? existingSettings.audit!.maxIterations : DEFAULT_AUDIT_MAX_ITERATIONS,
            "save_settings.audit.maxIterations",
          ),
        };
      } else {
        // User selected "Not configured" — clear audit config
        mergedAudit = {};
      }
    } else {
      // audit not sent — preserve existing (always ensure at least {})
      mergedAudit = existingSettings.audit ?? {};
    }

    // 3.5. Merge compaction settings
    let mergedCompaction: PersistedLlmSettings["compaction"];
    if (compaction) {
      mergedCompaction = {
        autoCompactThreshold: compaction.autoCompactThreshold
          ?? existingSettings.compaction?.autoCompactThreshold ?? 0.75,
      };
    } else {
      mergedCompaction = existingSettings.compaction;
    }
    const mergedThreshold = mergedCompaction?.autoCompactThreshold;
    if (mergedThreshold !== undefined
      && (!Number.isFinite(mergedThreshold) || mergedThreshold <= 0 || mergedThreshold >= 1)) {
      mergedCompaction = { autoCompactThreshold: config.compaction.autoCompactThreshold };
    }

    // 4. Persist LLM settings to disk — only when LLM-relevant fields are provided.
    // System tab sends only explicitCache/showCacheStats/systemConfig (no LLM fields);
    // writing llm-settings.json in that case would overwrite modelId/thinkingLevel with
    // stale existingSettings or config.llmProvider.models[0] fallback (Bug: model reset).
    if (hasLlmFields && !reloadPersistedLlm) {
      const settings: PersistedLlmSettings = {
        provider: effectiveProvider,
        apiKey: mergedEndpoints.apiKey ?? "",
        baseUrl: mergedEndpoints.baseUrl ?? "",
        modelId: mergedEndpoints.modelId
          || selectDefaultModelConfig(config.llmProvider.provider, config.llmProvider.models ?? [])?.id,
        thinkingLevel: thinkingLevel || existingSettings.thinkingLevel || "medium",
        quickThinkingLevel: quickThinkingLevel ?? existingSettings.quickThinkingLevel ?? "off",
        providerApiKeys: Object.keys(mergedProviderApiKeys).length > 0 ? mergedProviderApiKeys : undefined,
        audit: mergedAudit,
        compaction: mergedCompaction,
      };
      savePersistedLlmSettings(settings);
    }

    // 4.5. Save system config (explicit cache, showCacheStats, extensions) to hogagent.json
    if (explicitCache !== undefined || showCacheStats !== undefined || systemConfig !== undefined) {
      const sysCfg = loadSystemConfig();
      if (explicitCache !== undefined) sysCfg.explicitCache = explicitCache;
      if (showCacheStats !== undefined) sysCfg.showCacheStats = showCacheStats;
      if (systemConfig !== undefined) {
        if (systemConfig.sandboxMode !== undefined) {
          sysCfg.sandboxMode = systemConfig.sandboxMode as SandboxMode;
          delete sysCfg.sandboxEnabled;
        }
        sysCfg.extensions = sysCfg.extensions ?? [];
        // content-compressor: enabled toggle + textThreshold (validate numeric)
        if (systemConfig.compressorEnabled !== undefined || systemConfig.compressThreshold !== undefined) {
          const idx = sysCfg.extensions.findIndex(e => e.name === "content-compressor");
          const ext = idx >= 0 ? { ...sysCfg.extensions[idx] } : { name: "content-compressor", enabled: false, config: {} as Record<string, unknown> };
          if (systemConfig.compressorEnabled !== undefined) {
            ext.enabled = systemConfig.compressorEnabled;
          }
          if (systemConfig.compressThreshold !== undefined) {
            const val = Number(systemConfig.compressThreshold);
            if (Number.isFinite(val) && val > 0) {
              ext.config = { ...ext.config, textThreshold: val };
            }
          }
          if (idx >= 0) sysCfg.extensions[idx] = ext; else sysCfg.extensions.push(ext);
        }
        // sub-agent: maxTurns (validate numeric)
        if (systemConfig.subagentMaxTurns !== undefined) {
          const val = Number(systemConfig.subagentMaxTurns);
          if (Number.isFinite(val) && val > 0) {
            const idx = sysCfg.extensions.findIndex(e => e.name === "sub-agent");
            const ext = idx >= 0 ? sysCfg.extensions[idx] : { name: "sub-agent", enabled: true, config: {} };
            ext.config = { ...ext.config, maxTurns: val };
            if (idx >= 0) sysCfg.extensions[idx] = ext; else sysCfg.extensions.push(ext);
          }
        }
        // memory: cross-session persistent memory (enabled toggle + Gateway KB MCP URL)
        if (systemConfig.memoryEnabled !== undefined || systemConfig.memoryMcpKbUrl !== undefined) {
          const mem = sysCfg.memory ?? { enabled: false };
          if (systemConfig.memoryEnabled !== undefined) mem.enabled = systemConfig.memoryEnabled;
          if (systemConfig.memoryMcpKbUrl !== undefined) {
            const url = String(systemConfig.memoryMcpKbUrl).trim();
            if (url) mem.mcpKbUrl = url;
          }
          sysCfg.memory = mem;
        }
      }
      saveSystemConfig(sysCfg);
      log.info("System config updated", { explicitCache, showCacheStats, systemConfig });

      // Push runtime updates to loaded extensions — persisting hogagent.json alone
      // only affects the NEXT process start; loaded extensions read config at initialize
      if (systemConfig !== undefined) {
        await applyExtensionConfigUpdates(sysCfg.extensions ?? []);
        config.extensions = sysCfg.extensions ?? [];
      }

      // Hot-reload model compat when explicitCache changes (System tab doesn't send modelId)
      if (explicitCache !== undefined && !modelId) {
        const currentModel = harnessRef.current.getModel();
        const updatedModel = configModelToAgentModel(
          { id: currentModel.id, name: currentModel.name, contextWindow: currentModel.contextWindow },
          currentModel.provider,
          currentModel.baseUrl || "",
          sysCfg.explicitCache,
        );
        await harnessRef.current.setModel(updatedModel);
        log.info("Model compat hot-reloaded after explicitCache change", { explicitCache: sysCfg.explicitCache });
      }
    }

    // 5. Update in-memory config
    if (provider || hasApiKey || hasBaseUrl) {
      // Bug 26 fix: Preserve existing apiKey when not provided, consistent with persistence handling
      config.llmProvider = {
        ...config.llmProvider,
        provider: effectiveProvider,
        apiKey: mergedEndpoints.apiKey ?? "",
        baseUrl: mergedEndpoints.baseUrl ?? "",
      };
      process.env["HOGAGENT_LLM_API_KEY"] = config.llmProvider.apiKey;
      process.env["HOGAGENT_LLM_PROVIDER"] = effectiveProvider;
      process.env["HOGAGENT_LLM_BASE_URL"] = config.llmProvider.baseUrl;
    }

    // 6. Update model if specified
    if (modelId) {
      const modelConfig = config.llmProvider.models?.find((model) => model.id === modelId);
      const sysCfg = loadSystemConfig();
      const model = configModelToAgentModel(
        modelConfig ?? { id: modelId, name: modelId, contextWindow: DEFAULT_CONTEXT_WINDOW },
        config.llmProvider.provider,
        config.llmProvider.baseUrl || "",
        sysCfg.explicitCache,
      );
      await harnessRef.current.setModel(model);
    }

    // 6.5. Update compaction config if specified
    if (mergedCompaction) {
      config.compaction = {
        autoCompactThreshold: mergedCompaction.autoCompactThreshold ?? 0.75,
      };
      log.info("Compaction config updated", { ...config.compaction });
    }

    // 7. Update thinking level if specified
    if (thinkingLevel) {
      await harnessRef.current.setThinkingLevel(thinkingLevel as ThinkingLevel);
      if (state.quickThinkingOverride) state.savedThinkingLevel = thinkingLevel;
    }

    // 8. Update audit model if changed
    if (audit !== null && audit !== undefined) {
      const auditProvider = mergedAudit?.provider;
      const auditApiKey = mergedAudit?.apiKey;
      const auditModelId = mergedAudit?.modelId;
      if (auditProvider === "close" || auditProvider === "") {
        // Audit model explicitly closed (persist the close value for loadConfig on restart)
        config.auditModel = undefined;
        deps.auditModelObjRef.value = null;
        log.info("Audit model explicitly closed", { provider: auditProvider });
      } else if (auditProvider && auditModelId && (auditApiKey || auditProvider === "custom")) {
        config.auditModel = {
          provider: auditProvider,
          apiKey: auditApiKey ?? "",
          baseUrl: mergedAudit?.baseUrl || "",
          modelId: auditModelId,
          minPassScore: mergedAudit?.minPassScore ?? 70,
          maxIterations: normalizeAuditMaxIterations(
            mergedAudit?.maxIterations ?? DEFAULT_AUDIT_MAX_ITERATIONS,
            "runtime.audit.maxIterations",
          ),
        };
        // Rebuild auditModelObj
        deps.auditModelObjRef.value = configModelToAgentModel(
          { id: auditModelId, name: auditModelId, contextWindow: DEFAULT_CONTEXT_WINDOW },
          auditProvider,
          mergedAudit?.baseUrl || ""
        );
        log.info("Audit model updated", { provider: auditProvider, modelId: auditModelId });
      } else {
        // Audit model cleared (no provider specified)
        config.auditModel = undefined;
        deps.auditModelObjRef.value = null;
        log.info("Audit model cleared");
      }
    }

    log.info("Settings saved; runtime updates processed", { provider, modelId, thinkingLevel, auditUpdated: !!audit });
    const savedEvent: Record<string, unknown> = {
      type: "settings_saved", success: true,
      builtin_tools: harnessRef.current.getTools().map(tool => tool.name),
      systemConfig: getSystemConfigSnapshot(),
    };
    if (hasLlmFields) {
      savedEvent.provider = provider || existingSettings.provider || config.llmProvider.provider;
      savedEvent.modelId = modelId || existingSettings.modelId || harnessRef.current.getModel().id;
    }
    emitEvent(savedEvent as RpcEvent);
  }

  // ─── onRefreshModels ─────────────────────────────────────────────────

  async function onRefreshModels(command: RpcCommand): Promise<void> {
    const provider = (command.provider as string) || "hedgehog";
    const baseUrl = command.baseUrl as string | undefined;
    const apiKey = command.apiKey as string | undefined;
    const target = (command.target as string) || "main"; // "main" or "audit"
    log.info("Refreshing models for provider", { provider, target, hasApiKey: !!apiKey });
    try {
      const { models, error } = await listConfiguredModels({ provider, baseUrl, apiKey });
      if (models.length > 0) {
        emitEvent({ type: "models_refreshed", provider, models, target });
      } else {
        const hint = error || `${provider} has no available models`;
        emitEvent({ type: "error", error: hint, target, provider });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitEvent({ type: "error", error: `Failed to fetch model list: ${msg}`, target, provider });
    }
  }

  // ─── onTestApiKey ──────────────────────────────────────────────────

  async function onTestApiKey(command: RpcCommand): Promise<void> {
    const provider = (command.provider as string) || "hedgehog";
    const baseUrl = (command.baseUrl as string) || "";
    const apiKey = (command.apiKey as string) || "";

    if (!apiKey) {
      emitEvent({ type: "api_key_test_result", success: false, error: "No API Key provided" });
      return;
    }

    // Resolve effective base URL
    let effectiveBase = baseUrl;
    if (!effectiveBase) {
      const defaults: Record<string, string> = {
        hedgehog: "https://api.ciweiai.com/api/llm/v1",
        openai: "https://api.openai.com/v1",
        anthropic: "https://api.anthropic.com",
        google: "https://generativelanguage.googleapis.com/v1beta",
        deepseek: "https://api.deepseek.com",
        mistral: "https://api.mistral.ai/v1",
        openrouter: "https://openrouter.ai/api/v1",
      };
      effectiveBase = defaults[provider] || "";
    }
    if (!effectiveBase) {
      emitEvent({ type: "api_key_test_result", success: false, error: "No Base URL" });
      return;
    }

    try {
      let url: string;
      let headers: Record<string, string>;
      let method = "GET";
      let body: string | undefined;

      if (provider === "google") {
        // Google: use models endpoint with key param
        const base = effectiveBase.endsWith("/") ? effectiveBase.slice(0, -1) : effectiveBase;
        url = `${base}/models?key=${encodeURIComponent(apiKey)}`;
        headers = {};
      } else if (provider === "anthropic") {
        // Anthropic: POST to messages with minimal payload
        url = `${effectiveBase.replace(/\/$/, "")}/v1/messages`;
        headers = {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        };
        method = "POST";
        body = JSON.stringify({ model: "claude-3-5-haiku-20241022", max_tokens: 1, messages: [] });
      } else {
        // OpenAI-compatible (hedgehog, openai, deepseek, mistral, openrouter, custom):
        // POST to chat/completions — 401/403 means invalid key, other errors mean key is valid
        const base = effectiveBase.replace(/\/$/, "");
        url = `${base}/chat/completions`;
        headers = {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        };
        method = "POST";
        body = JSON.stringify({ model: "test", messages: [], max_tokens: 1 });
      }

      const resp = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });

      const status = resp.status;
      if (status === 401 || status === 403) {
        emitEvent({ type: "api_key_test_result", success: false, error: `Invalid API Key (${status})` });
      } else if (status === 200 || (status >= 400 && status < 500) || status === 502 || status === 503 || status === 504) {
        // 200 = fully valid
        // 4xx (not 401/403) = key authenticated, request rejected for other reasons
        // 502/503/504 = key authenticated (passed auth layer), backend temporarily unavailable
        emitEvent({ type: "api_key_test_result", success: true });
      } else {
        emitEvent({ type: "api_key_test_result", success: false, error: `Server error (${status})` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitEvent({ type: "api_key_test_result", success: false, error: msg });
    }
  }

  return { onGetState, onSetModel, onSetThinkingLevel, onSetLlmProvider, onSaveSettings, onRefreshModels, onTestApiKey };
}
