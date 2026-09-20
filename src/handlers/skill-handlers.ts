import { formatInstructionScope } from "../instruction-scope.ts";
import { hasInstructionSnapshot, buildInstructionPrompt } from '../instruction-snapshot.ts';
/**
 * Skill & Misc RPC Handlers
 *
 * Handles compaction, search cache reset, LLM chat, shutdown,
 * skill installation (local + git), config reload, and skill configuration.
 */

import { join } from "node:path";
import { validateSkillName } from "../utils/skill-name.ts";
import type { RpcCommand } from "../utils/types.ts";
import { emitEvent } from "../rpc.ts";
import { createLogger } from "../utils/logger.ts";
import { resetSearchSettingsCache } from "../tools/web-search.ts";
import { llmChat } from "../llm-chat.ts";
import { loadSkillsFromDirs } from "../skill-loader.ts";
import { getProjectRoot, saveSkillApiConfig, getSkillApiConfigPath, getSystemConfigSnapshot, loadSkillApiConfig, loadSystemConfig } from "../config.ts";
import { applyExtensionConfigUpdates } from "../extensions/index.ts";
import { type HandlerDeps, type HandlerMutableState } from "./types.ts";
import { installSkillDirectory } from "../utils/skill-installation.ts";
import { resolveGitBinary, getGitEnv, clearGitBinaryCache } from "../utils/git-binary.ts";
import { CompactionOperationError, isCompactionInProgress } from "../compaction-manager.ts";
import { hasIncompleteOrchestration, hasPendingOrchestration } from "../long-task-orchestrator.ts";
import { formatIsolatedRunContextForModel } from "../runtime-context.ts";
import { filterSkillsByMode } from "../skills-filter.ts";

const log = createLogger("core");

export function createSkillHandlers(deps: HandlerDeps, state: HandlerMutableState) {
  const { harnessRef, config, executionEnv } = deps;

  async function reloadSkills(): Promise<void> {
    if (hasInstructionSnapshot(config.workspaceDir)) throw new Error("Skill reload waits for the current top-level execution to finish; retry at the next boundary");
    const skills = loadSkillsFromDirs(config.workspaceDir);
    // Prompt and session handlers retain this array; keep its identity while
    // publishing the refreshed inventory for subsequent prompts and sessions.
    deps.allSkills.splice(0, deps.allSkills.length, ...skills);
    const latestSkillsConfig = loadSkillApiConfig();
    for (const name of Object.keys(deps.skillsConfig)) delete deps.skillsConfig[name];
    for (const [name, entry] of Object.entries(latestSkillsConfig)) {
      // Define an own data property so unusual persisted names cannot mutate
      // the shared object's prototype during an in-place refresh.
      Object.defineProperty(deps.skillsConfig, name, {
        value: entry,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    await harnessRef.current.setResources({
      skills: filterSkillsByMode(deps.allSkills, deps.currentModeRef.value ?? "standard", deps.skillsConfig),
    });
  }

  // ─── onCompact ───────────────────────────────────────────────────────

  async function onCompact(command: RpcCommand): Promise<void> {
    const reject = (message: string): void => emitEvent({
      type: "compact_failed",
      reason: "error",
      message,
    });
    if (command.custom_instructions !== undefined || command.customInstructions !== undefined) {
      reject("Manual custom compaction instructions are not supported");
      return;
    }
    if (state.switchedSession) {
      reject("The selected session is read-only");
      return;
    }
    if (hasPendingOrchestration() || hasIncompleteOrchestration(config.sessionTaskDir)) {
      reject("Manual context compaction is unavailable while a Long Task is pending");
      return;
    }
    if (isCompactionInProgress()) {
      // Duplicate manual requests are idempotent; the original operation owns the terminal event.
      return;
    }

    try {
      await deps.compactionManager.run({
        harness: harnessRef.current,
        emitEvent,
        resolveAuth: deps.resolveMainLlmAuth,
      });
    } catch (error) {
      // CompactionManager already emitted the unique compact_failed terminal.
      if (error instanceof CompactionOperationError) return;
      throw error;
    }
  }

  // ─── onResetSearchCache ──────────────────────────────────────────────

  function onResetSearchCache(): void {
    log.info("Search settings cache reset requested");
    resetSearchSettingsCache();
    emitEvent({ type: "search_cache_cleared" });
  }

  // ─── onLlmChat ───────────────────────────────────────────────────────

  async function onLlmChat(command: RpcCommand): Promise<void> {
    const correlationSessionId = typeof command.session_id === "string" ? command.session_id : undefined;
    const persistUsage = command.persist_usage === true;
    const emitIsolatedEvent = (event: import("../utils/types.ts").RpcEvent): void => emitEvent({
      ...event,
      ...(correlationSessionId ? { session_id: correlationSessionId } : {}),
      internal: true,
      persist_usage: persistUsage,
    });
    try {
      const text = command.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("llm_chat requires a non-empty 'text' string");
      }
      // thinking_level is an optional override; it defaults to "off" without changing the main Agent configuration.
      const thinkingLevel = (command.thinking_level as import("../vendor/agent/types.ts").ThinkingLevel) || undefined;
      const systemPrompt = typeof command.system_prompt === "string" && command.system_prompt.trim()
        ? command.system_prompt
        : undefined;
      const requestedTimeout = command.timeout_ms;
      const timeoutMs = typeof requestedTimeout === "number"
        && Number.isFinite(requestedTimeout)
        && requestedTimeout > 0
        ? Math.floor(requestedTimeout)
        : undefined;
      const runtimePrompt = formatIsolatedRunContextForModel(
        deps.runtimeContext.getSnapshot().process,
        command.run_context,
      );
      const model = harnessRef.current.getModel();
      await llmChat({
        text,
        systemPrompt: `${buildInstructionPrompt(config.workspaceDir)}\n\n${systemPrompt ?? "You are a helpful assistant."}${runtimePrompt}${formatInstructionScope("isolated", [])}`,
        model,
        thinkingLevel,
        timeoutMs,
        getApiKey: async () => (await deps.resolveMainLlmAuth(model)).apiKey,
        env: executionEnv,
        emitEvent: emitIsolatedEvent,
      });
    } catch (error) {
      // Validation fails before llmChat owns the terminal event, but it still
      // belongs to the isolated call, never to the active conversation.
      emitIsolatedEvent({ type: "error", error: error instanceof Error ? error.message : String(error) });
      emitIsolatedEvent({ type: "agent_end" });
    }
  }

  // ─── onInstallSkill ─────────────────────────────────────────────

  async function onInstallSkill(command: RpcCommand): Promise<void> {
    const name = command.name as string | undefined;
    if (!name) {
      emitEvent({ type: "error", error: "install_skill requires 'name' field" });
      return;
    }
    log.info("Skill install requested", { name });
    // Reload skills after installation
    await reloadSkills();
    emitEvent({ type: "skill_installed", name });
  }

  // ─── onReloadConfig ─────────────────────────────────────────────────

  async function onReloadConfig(): Promise<void> {
    log.info("Config reload requested");
    await reloadSkills();
    const extensions = loadSystemConfig().extensions ?? [];
    await applyExtensionConfigUpdates(extensions);
    config.extensions = extensions;
    emitEvent({ type: "config_reloaded", systemConfig: getSystemConfigSnapshot(), builtin_tools: deps.harnessRef.current.getTools().map(tool => tool.name) });
  }

  // ─── onInstallSkillFromGit ──────────────────────────────────────────

  async function onInstallSkillFromGit(command: RpcCommand): Promise<void> {
    const url = command.url as string | undefined;
    if (!url) {
      emitEvent({ type: "error", error: "install_skill_from_git requires 'url' field" });
      return;
    }

    // Bug 1 fix: Validate URL format to prevent command injection
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
      if (!["http:", "https:", "git:", "ssh:"].includes(parsedUrl.protocol)) {
        throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
      }
    } catch (err) {
      emitEvent({ type: "error", error: `Invalid git URL: ${url}` });
      return;
    }

    log.info("Installing skill from git", { url });
    try {
      if (hasInstructionSnapshot(config.workspaceDir)) throw new Error('Skill installation waits for the current execution to finish');
      const rawRepoName = url.split("/").pop()?.replace(/\.git$/, "") || `skill-${Date.now()}`;
      const repoName = rawRepoName.replace(/[^a-zA-Z0-9_\-.]/g, "_");
      if (!validateSkillName(repoName)) throw new Error('Invalid skill name');
      const { execFileSync } = await import("node:child_process");
      const skillsDir = join(config.workspaceDir, ".hogagent", "skills");
      const result = installSkillDirectory(skillsDir, repoName, staging => {
        execFileSync(resolveGitBinary(), ["clone", "--depth", "1", parsedUrl.toString(), staging], { stdio: "pipe", timeout: 60000, env: getGitEnv() });
      });
      if (result.installed) emitEvent({ type: "skill_installed", name: repoName, source: result.updated ? "git_updated" : "git" });
      else emitEvent({ type: "skill_install_skipped", name: repoName, reason: "newer_exists", existingVer: result.existingVersion, incomingVer: result.incomingVersion });
      // Reload skills
      await reloadSkills();
    } catch (err) {
      // git may be removed at runtime; clear the cache so the next call probes again and reports a helpful error.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        clearGitBinaryCache();
        emitEvent({ type: "error", error: "未找到 git 可执行文件（可能已被卸载），请确认已安装 git 后重试" });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      emitEvent({ type: "error", error: `Skill installation failed: ${msg}` });
    }
  }

  // ─── onConfigureSkill ───────────────────────────────────────────────

  async function onConfigureSkill(command: RpcCommand): Promise<void> {
    const name = command.name as string | undefined;
    const apiKey = command.apiKey as string | undefined;
    if (!name) {
      emitEvent({ type: "error", error: "configure_skill requires 'name' field" });
      return;
    }
    log.info("Configuring skill", { name });
    try {
      saveSkillApiConfig(name, { 'api-key': apiKey || "" });
      emitEvent({ type: "skill_configured", name, configPath: getSkillApiConfigPath() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitEvent({ type: "error", error: `Skill configuration failed: ${msg}` });
    }
  }

  return { onCompact, onResetSearchCache, onLlmChat, onInstallSkill, onReloadConfig, onInstallSkillFromGit, onConfigureSkill };
}
