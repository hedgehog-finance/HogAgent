import { projectDeliverablesDirectory } from "../../gateway-project.ts";
/**
 * Sub-Agent Extension
 *
 * Allows the main Agent to spawn isolated sub-agents for specialized tasks.
 * Each sub-agent gets:
 * - Its own Pi AgentHarness instance
 * - InMemorySessionStorage (no persistence)
 * - Shares the parent session's task directory (no sandbox)
 * - Shared LLM configuration from parent
 */

import { join } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../utils/logger.ts";
import { createActivityLogger, type ActivityLogger } from "../../utils/activity-logger.ts";
import { buildSystemPrompt } from "../../system-prompt.ts";
import { isTopLevelOnlyTool } from "../../tool-registry.ts";
import type {
  HogAgentContext,
  IExtension,
} from "../../utils/types.ts";
import { AgentHarness } from "../../vendor/agent/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../vendor/agent/harness/env/nodejs.ts";
import { Session } from "../../vendor/agent/harness/session/session.ts";
import { InMemorySessionStorage } from "../../vendor/agent/harness/session/memory-storage.ts";
import type { AgentHarnessOptions } from "../../vendor/agent/harness/types.ts";
import type { Model } from "../../vendor/ai/base.ts";
import { basenamePath, isPathAbsolute, realPath, realPathInside, relativePathIfInside } from "../../utils/path-safety.ts";
import { registerLlmMetadataHook } from "../../llm-metadata-hook.ts";
import { isBenignCompletionError } from "../../utils/llm-error.ts";
import { resolveLlmApiKey } from "../../llm-auth.ts";
import { parseSubAgentResult, type SubAgentTextResult } from "../../protocol/agent-result-schema.ts";
import type { DeepReadonly, RuntimeContextSnapshot } from "../../runtime-context.ts";

const log = createLogger("sub-agent");

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_TIMEOUT_SECONDS = 900;

interface SubAgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

interface SubAgentResult {
  id: string;
  status: "completed" | "timeout" | "error" | "max_turns_reached";
  summary: string;
  content: string;
  turns_used: number;
  outputs: string[];
  output_files: string[];
  usage?: SubAgentUsage;
  error?: string;
}

export class SubAgentExtension implements IExtension {
  name = "sub-agent";
  version = "1.0.0";

  private context: HogAgentContext | null = null;
  private activeSubAgents = new Map<string, AbortController>();
  private subAgentCounter = 0;
  private maxTurns = DEFAULT_MAX_TURNS;
  private timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;

  async initialize(context: HogAgentContext, _config?: unknown): Promise<void> {
    this.context = context;

    // Read configurable limits from extension config
    if (_config && typeof _config === "object") {
      const cfg = _config as Record<string, unknown>;
      if (typeof cfg.maxTurns === "number" && Number.isInteger(cfg.maxTurns) && cfg.maxTurns > 0) {
        this.maxTurns = cfg.maxTurns;
        log.info("Custom maxTurns applied", { maxTurns: cfg.maxTurns });
      }
      if (typeof cfg.timeoutSeconds === "number" && Number.isFinite(cfg.timeoutSeconds) && cfg.timeoutSeconds > 0) {
        this.timeoutSeconds = cfg.timeoutSeconds;
        log.info("Custom timeoutSeconds applied", { timeoutSeconds: cfg.timeoutSeconds });
      }
    }

    // Register spawn_sub_agent tool
    await context.registerTool({
      name: "spawn_sub_agent",
      label: "Spawn Sub-Agent",
      description: "Spawn an isolated sub-agent for a specialized task. Inherits parent tools and system context. Skills loaded on-demand.",
      parameters: Type.Object({
        task_description: Type.String({ description: "Task description with full context for the sub-agent" }),
        skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names to load (e.g., ['gen-chart']). Empty = no skills" })),
        max_turns: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum turns including format repair (default: 50)" })),
        timeout_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds (default: 900)" })),
      }),
      execute: async (
        _toolCallId: string,
        params: {
          task_description: string;
          skills?: string[];
          max_turns?: number;
          timeout_seconds?: number;
        },
        signal?: AbortSignal,
      ) => {
        return this.spawnSubAgent(params, signal);
      },
    });

    log.info("Initialized");
  }

  /** Apply runtime config changes from save_settings (no restart needed). */
  applyConfigUpdate(_enabled: boolean, config?: unknown): void {
    if (config && typeof config === "object") {
      const cfg = config as Record<string, unknown>;
      if (typeof cfg.maxTurns === "number" && Number.isInteger(cfg.maxTurns) && cfg.maxTurns > 0) {
        this.maxTurns = cfg.maxTurns;
      }
      if (typeof cfg.timeoutSeconds === "number" && Number.isFinite(cfg.timeoutSeconds) && cfg.timeoutSeconds > 0) {
        this.timeoutSeconds = cfg.timeoutSeconds;
      }
      log.info("Runtime config applied", { maxTurns: this.maxTurns, timeoutSeconds: this.timeoutSeconds });
    }
  }

  async shutdown(): Promise<void> {
    // Abort all active sub-agents
    for (const [id, controller] of this.activeSubAgents) {
      controller.abort();
      log.info("Aborted sub-agent on shutdown", { id });
    }
    this.activeSubAgents.clear();
    this.context = null;
    log.info("Shutdown complete");
  }

  /**
   * Append this sub-agent's aggregated stats to <sessionTaskDir>/sub-agent-usage.json.
   * One record per sub-agent (not per-turn); read by switch_session so the WebUI
   * can rebuild the per-sub-agent table and merge the values into the main totals.
   */
  private persistSubAgentUsage(sessionTaskDir: string, subAgentId: string, result: SubAgentResult): void {
    if (!result.usage) return;
    try {
      if (!existsSync(sessionTaskDir)) return;
      const usageFile = join(sessionTaskDir, "sub-agent-usage.json");
      let records: unknown[] = [];
      if (existsSync(usageFile)) {
        try {
          const parsed = JSON.parse(readFileSync(usageFile, "utf8"));
          if (Array.isArray(parsed)) records = parsed;
          // Legacy aggregate-object format: keep as a single synthetic record
          else if (parsed && typeof parsed === "object") records = [{ id: "legacy-total", status: "completed", ...parsed }];
        } catch { /* corrupt file: start fresh */ }
      }
      records.push({
        id: subAgentId,
        status: result.status,
        turns_used: result.turns_used,
        ...result.usage,
        timestamp: new Date().toISOString(),
      });
      writeFileSync(usageFile, JSON.stringify(records, null, 2));
    } catch (err) {
      log.warn("Failed to persist sub-agent usage", { id: subAgentId, error: String(err) });
    }
  }

  /**
   * Append one registry line to <sessionTaskDir>/sub-agent-list.txt on completion:
   * `Sub-agent-<index>:<session_id>:<status>:<output_files>`. Automating this frees
   * the main agent and sub-agents from bookkeeping turns (see morning-briefing SKILL.md).
   */
  private appendSubAgentRegistry(sessionTaskDir: string, subIndex: number, sessionId: string | undefined, result: SubAgentResult): void {
    try {
      if (!existsSync(sessionTaskDir)) return;
      const registryFile = join(sessionTaskDir, "sub-agent-list.txt");
      const files = result.output_files.length > 0 ? result.output_files.map((f) => basenamePath(f)).join(",") : "-";
      const line = `Sub-agent-${subIndex}:${sessionId ?? "unknown"}:${result.status}:${files}\n`;
      const prefix = existsSync(registryFile) ? readFileSync(registryFile, "utf8") : "# Sub-agent Registry\n";
      writeFileSync(registryFile, prefix.endsWith("\n") || prefix === "" ? prefix + line : prefix + "\n" + line);
    } catch (err) {
      log.warn("Failed to append sub-agent registry", { index: subIndex, error: String(err) });
    }
  }

  /** Spawn an isolated sub-agent for a specialized task. */
  private async spawnSubAgent(
    params: {
      task_description: string;
      skills?: string[];
      max_turns?: number;
      timeout_seconds?: number;
    },
    parentSignal?: AbortSignal,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: SubAgentResult }> {
    const subAgentId = crypto.randomUUID();
    const maxTurns = params.max_turns ?? this.maxTurns;
    const timeoutSeconds = params.timeout_seconds ?? this.timeoutSeconds;

    if (!Number.isInteger(maxTurns) || maxTurns < 1 || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new Error("Sub-agent requires a positive integer max_turns and finite positive timeout_seconds");
    }

    log.info("Spawning sub-agent", {
      id: subAgentId,
      skills: params.skills,
      max_turns: maxTurns,
      timeout_seconds: timeoutSeconds,
    });

    // Create abort controller with timeout
    const controller = new AbortController();
    this.activeSubAgents.set(subAgentId, controller);

    // Link to parent signal
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    if (parentSignal?.aborted) controller.abort();

    // Set timeout
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutSeconds * 1000);

    // Capture the parent session identity at spawn time so late completions
    // (e.g. user switches session while a sub-agent is running) are still
    // attributed to the session that spawned this sub-agent, not the current one.
    const parentConfig = this.context?.getConfig();
    const sessionTaskDir = parentConfig?.sessionTaskDir ?? this.context?.getWorkspaceDir() ?? process.cwd();
    const spawnSessionId = parentConfig?.sessionId;
    const usageOwner = this.context ? { ...this.context.getLlmTracking() } : undefined;
    // A sub-agent owns an immutable spawn-time view; later session/run changes in
    // the parent process must not relabel an already-running child.
    const runtimeContextAtSpawn = this.context?.getRuntimeContext();
    const subIndex = ++this.subAgentCounter;

    let result: SubAgentResult;

    try {
      // CWD: always workspaceDir — consistent with main agent and SYSTEM.md Bash rules
      const taskCwd = this.context?.getWorkspaceDir() ?? sessionTaskDir;

      // Create sub-agent activity logger
      const subLogPath = join(sessionTaskDir, `log-sub-${subIndex}.txt`);
      const subLogger = createActivityLogger(subLogPath);
      subLogger.init(subAgentId, params.task_description);

      // Emit sub-agent spawned event
      if (this.context) {
        this.context.emitEvent({
          type: "sub_agent_spawned",
          session_id: spawnSessionId,
          sub_agent_id: subAgentId,
          skills: params.skills,
          task_description: params.task_description,
          timestamp: new Date().toISOString(),
        });
      }

      // 2. Set up isolated agent context and execute
      result = await this.executeSubAgent(
        subAgentId,
        sessionTaskDir,
        taskCwd,
        params,
        maxTurns,
        controller.signal,
        subLogger,
        runtimeContextAtSpawn,
      );

      // Finalize sub-agent log
      subLogger.setStatus(result.status === "completed" ? "completed" : "error");
      subLogger.close();
    } catch (err) {
      if (controller.signal.aborted) {
        result = {
          id: subAgentId,
          status: "timeout",
          summary: `Sub-agent timed out after ${timeoutSeconds} seconds`,
          content: "",
          turns_used: 0,
          outputs: [],
          output_files: [],
          error: "Execution timed out",
        };
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err);
        result = {
          id: subAgentId,
          status: "error",
          summary: `Sub-agent encountered an error: ${errorMessage}`,
          content: "",
          turns_used: 0,
          outputs: [],
          output_files: [],
          error: errorMessage,
        };
      }
    } finally {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", onParentAbort);
      this.activeSubAgents.delete(subAgentId);
    }

    // Persist per-sub-agent usage (into the spawning session's task dir)
    // so token stats survive session switch/reload
    this.persistSubAgentUsage(sessionTaskDir, subAgentId, result);

    // Auto-append the registry line so neither the main agent nor the
    // sub-agent has to maintain sub-agent-list.txt manually
    this.appendSubAgentRegistry(sessionTaskDir, subIndex, spawnSessionId, result);

    // Emit completion event
    if (this.context) {
      this.context.emitEvent({
        type: "sub_agent_completed",
        session_id: spawnSessionId,
        ...(usageOwner?.workId ? { work_id: usageOwner.workId } : {}),
        ...(usageOwner?.taskId ? { task_id: usageOwner.taskId } : {}),
        sub_agent_id: subAgentId,
        status: result.status,
        turns_used: result.turns_used,
        usage: result.usage,
        timestamp: new Date().toISOString(),
      });
    }

    log.info("Sub-agent completed", {
      id: subAgentId,
      status: result.status,
      turns_used: result.turns_used,
    });

    return {
      content: [
        {
          type: "text",
          text: this.formatResult(result),
        },
      ],
      details: result,
    };
  }

  /** Execute the sub-agent using a real Pi AgentHarness. */
  private async executeSubAgent(
    id: string,
    sessionTaskDir: string,
    taskCwd: string,
    params: {
      task_description: string;
      skills?: string[];
    },
    maxTurns: number,
    signal: AbortSignal,
    subLogger: ActivityLogger,
    runtimeContextAtSpawn?: DeepReadonly<RuntimeContextSnapshot>,
  ): Promise<SubAgentResult> {
    const outputs: string[] = [];
    let turnsUsed = 0;
    let turnLimitReached = false;

    if (!this.context) {
      return {
        id,
        status: "error",
        summary: "No context available",
        content: "",
        turns_used: 0,
        outputs: [],
        output_files: [],
        error: "Extension context not initialized",
      };
    }

    // Get parent harness to share LLM config
    const parentHarness = this.context.getHarness();
    const parentModel = parentHarness.getModel();
    const parentConfig = this.context.getConfig();

    // Create isolated execution environment with workspaceDir CWD (same as main agent)
    const subEnv = new NodeExecutionEnv({ cwd: taskCwd });

    // Create in-memory session (no persistence)
    const subStorage = new InMemorySessionStorage();
    const subSession = new Session(subStorage);

    // Inherit tools from parent, excluding:
    // - spawn_sub_agent: prevent recursive nesting
    // - deliver_files: sub-agent declares output_files for audit/Manifest use;
    //   only the main agent may explicitly deliver a real file
    const parentTools = parentHarness.getTools();
    const SUB_AGENT_EXCLUDED_TOOLS = new Set(["spawn_sub_agent", "deliver_files"]);
    const subTools = parentTools.filter((t) =>
      !SUB_AGENT_EXCLUDED_TOOLS.has(t.name) && !isTopLevelOnlyTool(t));
    const subActiveToolNames = subTools.map((t) => t.name);

    // Skills: load on-demand based on params.skills, with full descriptions
    const parentResources = parentHarness.getResources();
    const parentSkills = parentResources.skills ?? [];
    const subSkills = (params.skills && params.skills.length > 0)
      ? parentSkills.filter((s) => params.skills!.includes(s.name))
      : [];

    // Build full system prompt using the shared builder (SYSTEM.md, AGENTS.md, tools, date, theme, etc.)
    const basePrompt = buildSystemPrompt({
      workspaceDir: this.context.getWorkspaceDir(),
      sessionTaskDir: sessionTaskDir,
      model: parentModel,
      skills: subSkills,
      activeTools: subTools,
      theme: parentConfig.theme,
      projectDir: parentConfig.projectDir,
      runtimeContext: runtimeContextAtSpawn,
      scope: "sub_agent",
    });

    // Append sub-agent identity and structured output requirement
    const projectDir = parentConfig.projectDir;
    const workspaceDir = this.context.getWorkspaceDir();
    const outputPathRule = `\`output_files\` = array of absolute project file paths or session file paths **relative to workspaceDir** (${workspaceDir}). ` +
      `For session task dir files: use "tasks/<session-id>/sub-output-<short_title>.<ext>" for intermediate work and "tasks/<session-id>/data-<short_title>.<ext>" for raw evidence. ` +
      (projectDir
        ? `For project files, use absolute paths under the current project directory; raw evidence goes to \`data/\`, regular files to \`src/\`, and business deliverables to \`${projectDeliverablesDirectory()}/\`.`
        : `Classify persisted evidence through the filename instead of hiding it under a \`sub-output-*\` name.`);
    const subAgentFooter = [
      "",
      "## Sub-Agent Role",
      "You are a sub-agent spawned by the main agent to complete a specific task.",
      "Use only the tools and context explicitly supplied to this child execution.",
      "Focus on completing the assigned task efficiently.",
      "",
      "**IMPORTANT — Output declaration only:** You have no chat-delivery authority. Do NOT call `deliver_files`; declare real output files in `output_files` and let the parent handle final delivery. Your ONLY output format is the JSON block below.",
      "",
      "## MANDATORY Output Format",
      "When the task is done, stop calling tools — reply in plain text ending with this JSON block (never emit it via a tool such as bash echo):",
      '```',
      '{ "schema_version": "1.0", "type": "sub_agent_result", "summary": "Brief description", "content": "text result", "output_files": [] }',
      '```',
      "",
      "**Fields:**",
      "- `summary`: A brief description of what was accomplished",
      "- `content`: concise result text or a brief summary of declared files; it may be non-empty together with `output_files`.",
      `- ${outputPathRule}`,
      "",
      "- Do NOT add any text after the JSON block",
      "- This JSON is your text reply to the main agent, NOT a file to write",
    ].join("\n");
    const systemPrompt = basePrompt + subAgentFooter;

    // Create isolated AgentHarness with filtered tools and selected skills from parent
    const subHarness = new AgentHarness({
      env: subEnv,
      session: subSession,
      model: parentModel,
      tools: subTools,
      activeToolNames: subActiveToolNames,
      thinkingLevel: "minimal",
      systemPrompt,
      resources: { skills: subSkills },
      getApiKeyAndHeaders: async (_model: Model<any>) => {
        const apiKey = resolveLlmApiKey(
          parentConfig.llmProvider.provider,
          parentConfig.llmProvider.apiKey,
          process.env["HOGAGENT_LLM_API_KEY"],
        );
        return { apiKey };
      },
    } as AgentHarnessOptions);

    // Sub-agent inherits parent tracking context for LLM metadata injection
    const parentTracking = { ...this.context.getLlmTracking() };
    registerLlmMetadataHook(subHarness, parentTracking);

    // Track turns and log activities via subscription
    const subToolCallNames = new Map<string, string>();
    let subLlmResponseBuffer = "";
    let subTurnIndex = 0;
    let subHasToolCalls = false;
    // Accumulate token usage across all LLM calls of this sub-agent
    const subUsage: SubAgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    subHarness.subscribe((event) => {
      if (event.type === "turn_start") {
        subTurnIndex++;
        if (subTurnIndex === 1) {
          // First turn: log initial call llm
          subLogger.log("call llm", params.task_description, "");
        } else if (subHasToolCalls) {
          // Subsequent turns after tool execution
          subLogger.log("call llm", "(tool results)", "");
        }
        subHasToolCalls = false;
      }
      if (event.type === "turn_end") {
        turnsUsed++;
        // A final text reply on the last allowed turn is valid. Stop only if
        // the tool loop would need another provider request.
        if (turnsUsed >= maxTurns && event.message.role === "assistant"
          && event.message.content.some(block => block.type === "toolCall")) {
          turnLimitReached = true;
          log.warn("Sub-agent turn limit reached, aborting", { id, turnsUsed, maxTurns });
          subHarness.abort();
        }
      }
      if (event.type === "message_update") {
        const ase = (event as any).assistantMessageEvent;
        if (ase?.type === "text_delta" && typeof ase.delta === "string" && event.message.role === "assistant") {
          subLlmResponseBuffer += ase.delta;
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        // Accumulate per-call token usage for the parent's token stats panel
        const u = (event.message as unknown as { usage?: SubAgentUsage }).usage;
        if (u) {
          subUsage.input += u.input || 0;
          subUsage.output += u.output || 0;
          subUsage.cacheRead += u.cacheRead || 0;
          subUsage.cacheWrite += u.cacheWrite || 0;
          subUsage.totalTokens += u.totalTokens || 0;
        }
        // Update activity log with LLM response text
        if (subLlmResponseBuffer) {
          subLogger.updateLastOutput(subLlmResponseBuffer);
          subLlmResponseBuffer = "";
        }
        const content = event.message.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          if (text) outputs.push(text);
        } else if (typeof content === "string") {
          outputs.push(content);
        }
      }
      if (event.type === "tool_execution_start") {
        subHasToolCalls = true;
        subToolCallNames.set(event.toolCallId, event.toolName);
        const fileOps = ["read", "write", "edit"];
        const action = fileOps.includes(event.toolName) ? "operate file" : "execute tool";
        const argsStr = event.args ? JSON.stringify(event.args) : "";
        subLogger.log(action as any, `${event.toolName}(${argsStr})`, "");
      }
      if (event.type === "tool_execution_end") {
        const toolName = subToolCallNames.get(event.toolCallId) || "unknown";
        subToolCallNames.delete(event.toolCallId);
        const fileOps = ["read", "write", "edit"];
        const action = fileOps.includes(toolName) ? "operate file" : "execute tool";
        const resultStr = event.result
          ? (typeof event.result === "string" ? event.result : JSON.stringify(event.result)).slice(0, 50)
          : "";
        subLogger.log(action as any, `${toolName}(${event.toolCallId})`, event.isError ? `error: ${resultStr}` : resultStr);
      }
    });

    // Both execution and the optional tool-free repair share one budget and
    // cancellation boundary. Parse only the response from the current prompt.
    const runPrompt = async (text: string): Promise<SubAgentTextResult | undefined> => {
      if (signal.aborted) throw new Error("Execution aborted");
      if (turnsUsed >= maxTurns) {
        turnLimitReached = true;
        throw new Error("Sub-agent turn limit reached");
      }
      const onAbort = () => subHarness.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await subHarness.prompt(text);
        await subHarness.waitForIdle();
        if (signal.aborted) throw new Error("Execution aborted");
        if (turnLimitReached) throw new Error("Sub-agent turn limit reached");
        if (response.stopReason === "aborted") throw new Error("Sub-agent execution aborted");
        if (response.stopReason === "error" && !isBenignCompletionError(
          response as unknown as Record<string, unknown>, response.errorMessage || "",
        )) throw new Error(response.errorMessage || "Sub-agent model request failed");
        return this.parseStructuredOutput([response.content
          .filter(block => block.type === "text").map(block => block.text).join("\n")]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    };

    try {
      let parsedOutput = await runPrompt(params.task_description);
      if (!parsedOutput) {
        log.info("Sub-agent output failed schema validation; requesting one format repair", { id });
        await subHarness.setActiveTools([]);
        await subHarness.setResources({ skills: [] });
        parsedOutput = await runPrompt([
          "Your previous reply did not match the required sub_agent_result schema.",
          "Do not redo the task or call tools. Reply once with only a JSON object using this exact shape:",
          '{ "schema_version": "1.0", "type": "sub_agent_result", "summary": "Brief description", "content": "text result", "output_files": [] }',
        ].join("\n"));
      }
      if (!parsedOutput) {
        return {
          id,
          status: "error",
          summary: "Sub-agent result did not match the required sub_agent_result schema",
          content: "",
          turns_used: turnsUsed,
          outputs,
          output_files: [],
          usage: subUsage,
          error: "Invalid sub_agent_result after one format repair",
        };
      }
      const resolvedOutput = parsedOutput;
      const outputFiles = resolvedOutput.output_files;

      // Post-execution: accept only files from the Session/Project artifact roots.
      const correctedFiles = outputFiles.length > 0
        ? this.validateDeclaredOutputFiles(outputFiles, workspaceDir, sessionTaskDir, projectDir)
        : [];

      return {
        id,
        status: "completed",
        summary: resolvedOutput.summary || this.generateSummary(params.task_description, outputs, turnsUsed),
        content: resolvedOutput.content,
        turns_used: turnsUsed,
        outputs,
        output_files: correctedFiles,
        usage: subUsage,
      };
    } catch (err) {
      const status = signal.aborted ? "timeout" : turnLimitReached ? "max_turns_reached" : "error";
      const errorMessage = signal.aborted ? "Execution aborted"
        : err instanceof Error ? err.message : String(err);
      return {
        id, status,
        summary: status === "max_turns_reached"
          ? "Sub-agent reached maximum turn limit (" + maxTurns + ")"
          : "Sub-agent " + status + ": " + errorMessage,
        content: "", turns_used: turnsUsed, outputs, output_files: [],
        usage: subUsage, error: errorMessage,
      };
    }
  }

  /**
   * Parse structured JSON output from sub-agent's last reply.
   * Expected format is the discriminator-backed sub_agent_result schema.
   * Uses brace-counting to correctly find the outer closing brace,
   * handling nested braces and strings that contain } characters.
   */
  private parseStructuredOutput(outputs: string[]): SubAgentTextResult | undefined {
    if (outputs.length === 0) return undefined;
    const lastOutput = outputs[outputs.length - 1]!;
    return parseSubAgentResult(lastOutput);
  }

  /**
   * Validate declared output_files against the same roots used by Manifest.
   * Paths must resolve exactly; workspace-root and basename guessing are rejected.
   */
  private validateDeclaredOutputFiles(outputFiles: string[], workspaceDir: string, taskDir: string, projectDir?: string): string[] {
    const corrected: string[] = [];
    const missing: string[] = [];
    const canonicalWorkspace = realPath(workspaceDir);
    const canonicalTaskDir = realPath(taskDir);
    const canonicalProjectDir = projectDir ? realPath(projectDir) : null;

    const acceptManagedFile = (candidate: string): string | null => {
      try {
        if (!statSync(candidate).isFile()) return null;
      } catch {
        return null;
      }
      const sessionFile = realPathInside(taskDir, candidate);
      if (sessionFile && canonicalTaskDir) {
        const taskRelative = relativePathIfInside(canonicalTaskDir, sessionFile)?.replace(/\\/g, "/");
        if (!taskRelative || taskRelative.split("/").includes(".hedgehog")) return null;
        return canonicalWorkspace
          ? relativePathIfInside(canonicalWorkspace, sessionFile)?.replace(/\\/g, "/") ?? sessionFile
          : sessionFile;
      }
      if (!projectDir || !canonicalProjectDir) return null;
      const projectFile = realPathInside(projectDir, candidate);
      if (!projectFile) return null;
      const projectRelative = relativePathIfInside(canonicalProjectDir, projectFile)?.replace(/\\/g, "/");
      if (!projectRelative || !/^(publish|artifacts|dashboard|src|data)\//.test(projectRelative)) return null;
      return canonicalWorkspace
        ? relativePathIfInside(canonicalWorkspace, projectFile)?.replace(/\\/g, "/") ?? projectFile
        : projectFile;
    };

    for (const filePath of outputFiles) {
      const absPath = isPathAbsolute(filePath, workspaceDir) ? filePath : join(workspaceDir, filePath);
      const declared = acceptManagedFile(absPath);
      if (declared) {
        corrected.push(declared);
        continue;
      }
      missing.push(filePath);
    }

    if (missing.length > 0) {
      log.warn("Sub-agent declared output_files missing, not regular files, or outside artifact roots", { files: missing, workspaceDir });
    }

    return corrected;
  }

  /** Generate a summary from sub-agent outputs. */
  private generateSummary(task: string, outputs: string[], turns: number): string {
    if (outputs.length === 0) {
      return `Sub-agent attempted task "${task}" but produced no outputs in ${turns} turns.`;
    }
    const lastOutput = outputs[outputs.length - 1];
    return `Sub-agent completed task "${task}" in ${turns} turn(s). Last output: ${lastOutput.slice(0, 200)}`;
  }

  /** Format the result for display. */
  private formatResult(result: SubAgentResult): string {
    const lines = [
      `Sub-Agent Result (${result.id})`,
      `Status: ${result.status}`,
      `Turns Used: ${result.turns_used}`,
      `Summary: ${result.summary}`,
    ];

    if (result.error) {
      lines.push(`Error: ${result.error}`);
    }

    if (result.output_files && result.output_files.length > 0) {
      lines.push("", "Output Files:");
      for (const file of result.output_files) {
        lines.push(`  - ${file}`);
      }
    } else if (result.content) {
      lines.push("", "Content:");
      lines.push(result.content.slice(0, 500));
    } else if (result.outputs.length > 0) {
      lines.push("", "Outputs:");
      for (const output of result.outputs.slice(-3)) {
        lines.push(`  - ${output.slice(0, 100)}`);
      }
    }

    return lines.join("\n");
  }
}
