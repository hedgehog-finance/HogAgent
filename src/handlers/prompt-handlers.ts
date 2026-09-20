import { beginInstructionSnapshot, endInstructionSnapshot } from "../instruction-snapshot.ts";
import { resolveGatewayProject } from "../gateway-project.ts";
/**
 * Prompt & Long Task RPC Handlers
 *
 * Contains the unified Long Task message processor and the core
 * conversation handlers: onPrompt, onSteer, onFollowUp, onAbort.
 */

import { join } from "node:path";
import type { RpcCommand, RpcEvent } from "../utils/types.ts";
import type { ConversationMode } from "../utils/types.ts";
import { emitEvent, emitEvent as emitEventGlobal } from "../rpc.ts";
import { createLogger } from "../utils/logger.ts";
import { classifyIntent, abortActiveAuditHarness } from "../audit-classifier.ts";
import { AuditModelUnavailableError, OrchestrationAbortedError } from "../utils/llm-error.ts";
import { ContextCompactionError, isCompactionInProgress } from "../compaction-manager.ts";
import {
  executeLongTask,
  runOrchestrationTurn,
  hasPendingOrchestration,
  clearPendingOrchestration,
  resumeOrchestrationWithUserAnswer,
  hasIncompleteOrchestration,
  readOrchestrationState,
  resumeInterruptedOrchestration,
  resolveResumeGroupIndex,
  clearOrchestrationState,
  cleanupAbortedOrchestration,
  archiveOrchestrationState,
  removeArchivedOrchestrationState,
  tryRestoreArchivedOrchestration,
  isTaskContinuationMessage,
  extractContinuationUserDirective,
  wrapContinuationDirectiveAsClarification,
  forceNoFurtherClarification,
} from "../long-task-orchestrator.ts";
import { filterSkillsByMode } from "../skills-filter.ts";
import { notifyAgentAbort } from "../extensions/index.ts";
import { isConversationMode, readModeMetadata, writeModeMetadata, loadSystemConfig, loadPersistedLlmSettings } from "../config.ts";
import { withExplicitCache } from "../model-utils.ts";
import { isPathInside, realPath } from "../utils/path-safety.ts";
import { startArtifactRun } from "../artifacts/artifact-protocol.ts";
import { defaultArtifactRunPolicy, isArtifactRunPolicy } from "../artifacts/artifact-policy.ts";
import {
  setInternalMode,
  setMainTurnStarted,
  setAbortRequested,
  isAbortRequested,
  getPendingPrePlanningClarification,
  setPendingPrePlanningClarification,
  setBufferedUserMessage,
  getComplexAssistantCount,
} from "../agent-state.ts";
import {
  type HandlerDeps,
  type HandlerMutableState,
  buildConversationHistory,
  extractProjectDirFromText,
  maybeAutoCompact,
  saveSessionName,
  type OrchestrationContext,
} from "./types.ts";
import { resolveLlmApiKey } from "../llm-auth.ts";
import { isSafeSessionId } from "./session-handlers.ts";
import {
  resolvePromptRuntimeContextInputs,
  type CurrentRunContextInput,
  type SessionRuntimeContextInput,
} from "../runtime-context.ts";

const log = createLogger("core");

const VALID_QUICK_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** Resolve an ephemeral quick-prompt override without mutating persisted LLM settings. */
export function resolveQuickThinkingLevel(requested: unknown, persisted: unknown): string {
  const candidate = typeof requested === "string"
    ? requested
    : typeof persisted === "string" ? persisted : "off";
  return (VALID_QUICK_THINKING_LEVELS as readonly string[]).includes(candidate) ? candidate : "off";
}

export function createPromptHandlers(deps: HandlerDeps, state: HandlerMutableState) {
  const { harnessRef, config, toolRegistry, allSkills, skillsConfig, executionEnv } = deps;
  const standaloneProjectDir = config.projectDir;

  const activateTopLevelTools = () => harnessRef.current.setActiveTools(toolRegistry.namesTopLevel());

  async function setExplicitCache(enabled: boolean): Promise<void> {
    const current = harnessRef.current.getModel();
    const next = withExplicitCache(current, enabled);
    if (next !== current) await harnessRef.current.setModel(next);
  }

  /** One fail-closed entry point for every direct main-session prompt. */
  async function promptWithContextCapacity(text: string): Promise<void> {
    if (isAbortRequested()) return;
    await maybeAutoCompact(deps, { nextPrompt: text });
    if (isAbortRequested()) return;
    await harnessRef.current.prompt(text);
  }

  function createOrchestrationContext(
    emit: (event: RpcEvent) => void,
  ): OrchestrationContext {
    const mainHarness = harnessRef.current;
    const session = deps.sessionRef.current;
    return {
      mainHarness,
      auditModelObj: deps.auditModelObjRef.value!,
      auditConfig: {
        ...config.auditModel!,
        apiKey: resolveLlmApiKey(config.auditModel!.provider, config.auditModel!.apiKey),
      },
      env: executionEnv,
      allTools: toolRegistry.snapshotTopLevel(),
      allSkills,
      skillsConfig,
      emitEvent: emit,
      workspaceDir: config.workspaceDir,
      sessionTaskDir: config.sessionTaskDir,
      projectDir: config.projectDir,
      manifestOwner: config.manifestOwner,
      artifactRunPolicy: config.artifactRunPolicy,
      runtimeContext: deps.runtimeContext.getSnapshot(),
      llmTracking: deps.llmTracking,
      ensureContextCapacity: (nextPrompt?: string) => maybeAutoCompact(deps, {
        harness: mainHarness,
        session,
        emitEvent: emit,
        nextPrompt,
        isAbortRequested,
      }),
    };
  }

  // ─── Unified Long Task Message Processor ───────────────────────────────

  async function processLongTaskMessage(text: string): Promise<{ started: boolean }> {
    // Long Task is nested work inside the owning RPC Prompt Run. Planning,
    // execution groups, retries, checkpoint/final audit, clarification handling,
    // and delivery inherit the already-active context; this function must never
    // begin or end CurrentRunContext itself.
    // P0 #5 fix: snapshot the session that owns this orchestration and shadow the
    // module-level emitEvent with a bound version. Long-running orchestrations can
    // outlive a session switch — without the explicit session_id, rpc.ts would stamp
    // events with whatever session is *currently* active, mislabeling them.
    const orchSessionId = config.sessionId;
    const emitEvent = (event: RpcEvent): void =>
      emitEventGlobal({ session_id: orchSessionId, ...event });

    const currentText = text;
    setMainTurnStarted(false);

    // --- Check if resuming from mid-execution clarification ([ASK_USER]) ---
    if (hasPendingOrchestration()) {
      // A "[Continue Task]" dispatch is a control command, never a clarification
      // answer: drop the template text and resume under a "no more questions,
      // just execute" directive, with further [ASK_USER] suspensions suppressed
      // for the rest of this orchestration.
      if (isTaskContinuationMessage(currentText)) {
        forceNoFurtherClarification();
        await resumeOrchestrationWithUserAnswer(
          "[Continuation Directive]\nThe user chose to continue without answering the clarification question. Do not ask any further clarification questions — complete the current group using reasonable assumptions for any missing details.",
          createOrchestrationContext(emitEvent),
        );
      } else {
        await resumeOrchestrationWithUserAnswer(currentText, createOrchestrationContext(emitEvent));
      }
      return { started: true };
    }

    // --- Check 2 (NEW): Resume from interrupted orchestration (process restart) ---
    // An explicit "[Continue Task]" dispatch (Gateway work/task continue after a
    // user abort) first restores the archived checkpoint, then the resume route
    // below takes over exactly as after a crash/restart.
    tryRestoreArchivedOrchestration(currentText, config.sessionTaskDir);
    const isContinuationDispatch = isTaskContinuationMessage(currentText);
    if (hasIncompleteOrchestration(config.sessionTaskDir)) {
      // The current message only requests recovery; it is never replayed as a
      // second task after recovery completes.
      setBufferedUserMessage(null);

      // 2. Send status notification
      emitEvent({ type: "status_update", message: "Detected incomplete orchestration task, resuming previous execution progress..." });
      emitEvent({ type: "orchestration_resuming", session_task_dir: config.sessionTaskDir });

      // 3. Read persisted state and resume
      const orchState = readOrchestrationState(config.sessionTaskDir);
      if (orchState) {
        const resumeGroupIdx = resolveResumeGroupIndex(
          orchState.groups,
          orchState.completedGroupIds,
          orchState.currentGroupIdx,
        );
        setInternalMode(true);
        emitEvent({ type: "internal_mode", active: true } as any);
        emitEvent({
          type: "thinking", role: "assistant",
          delta: resumeGroupIdx < orchState.groups.length
            ? `[Long Task] Resuming interrupted orchestration, continuing from group ${resumeGroupIdx + 1}/${orchState.groups.length}...`
            : "[Long Task] Resuming interrupted orchestration at the final audit...",
        });
        await runOrchestrationTurn({ emitEvent, sessionTaskDir: config.sessionTaskDir }, async () => {
          const orchCtx = createOrchestrationContext(emitEvent);
          // One recovery path preserves prior answers for planning and groups.
          // An explicit continuation remains a directive rather than an answer.
          await resumeInterruptedOrchestration(orchState, orchCtx,
            isContinuationDispatch ? currentText : undefined,
            !isContinuationDispatch && (orchState.status === 'clarification_suspended' || orchState.groups.length === 0) ? currentText : undefined);
        });
      } else {
        // P2 #16: state file unreadable/corrupted — clear it so we don't loop back
        // into this branch on every subsequent message.
        clearOrchestrationState(config.sessionTaskDir);
        throw new Error("Saved orchestration state became unavailable; retry the task to start a new plan");
      }

      return { started: true };
    }

    // --- Check if resuming from pre-planning clarification ---
    const pendingClarification = getPendingPrePlanningClarification();
    if (pendingClarification) {
      // A "[Continue Task]" dispatch is a control command, never a clarification
      // answer: drop the template text entirely and proceed with the ORIGINAL
      // request as if the user had said "stop asking, just execute" — the marker
      // wording must not leak into the re-classification prompt.
      const continuationOverride = isContinuationDispatch;
      setPendingPrePlanningClarification(null);

      // Re-classify intent with user's clarification answers
      emitEvent({
        type: "thinking", role: "assistant",
        delta: continuationOverride
          ? "[Long Task] Continuation requested before planning — skipping clarification and proceeding directly..."
          : "[Long Task] Re-analyzing intent with your answers...",
      });
      const augmentedMessage = continuationOverride
        ? `${pendingClarification.originalMessage}\n\n[Continuation Directive]\nThe user chose to continue without answering the clarification questions. Do not ask any further clarification questions — proceed directly to planning and execution using reasonable assumptions for any missing details.`
        : `${pendingClarification.originalMessage}\n\n[My answers to your clarification questions]\n${currentText}`;
      const conversationHistory = await buildConversationHistory(deps.sessionRef);
      let classification = await classifyIntent(
        deps.auditModelObjRef.value!, resolveLlmApiKey(config.auditModel!.provider, config.auditModel!.apiKey), augmentedMessage, config.workspaceDir, executionEnv, emitEvent, conversationHistory, config.sessionTaskDir, deps.llmTracking, config.projectDir, deps.runtimeContext.getSnapshot()
      );
      // Keep a sticky post-call check for an abort that races with
      // classification settlement before a new run is started.
      if (isAbortRequested()) {
        throw new OrchestrationAbortedError();
      }

      // A continuation dispatch demands "no more questions, just execute": force
      // skipClarification on so neither a second pre-planning question round nor
      // any mid-execution [ASK_USER] suspension can re-open clarification.
      if (continuationOverride && !classification.skipClarification) {
        classification = { ...classification, skipClarification: true };
      }

      writeModeMetadata(config.sessionTaskDir, {
        mode: "long_task",
        optimizedPrompt: classification.optimizedPrompt,
        goals: classification.goals,
        acceptanceCriteria: classification.acceptanceCriteria,
        complexity: classification.complexity,
        createdAt: new Date().toISOString(),
        originalUserMessages: [pendingClarification.originalMessage],
        complexAssistantCount: getComplexAssistantCount(),
      });
      saveSessionName(deps.sessionRef, state, classification);

      await activateTopLevelTools();
      await harnessRef.current.setResources({ skills: allSkills });

      if (classification.complexity === "simple") {
        emitEvent({ type: "thinking", role: "assistant", delta: "[Long Task] After clarification, task is simple — responding directly..." });
        await promptWithContextCapacity(classification.optimizedPrompt);
        return { started: true };
      }

      // projectDir was already extracted before classifyIntent
      emitEvent({ type: "thinking", role: "assistant", delta: "[Long Task] Starting orchestration with clarified requirements..." });
      setInternalMode(true);
      emitEvent({ type: "internal_mode", active: true } as any);
      emitEvent({ type: "orchestration_resuming", session_task_dir: config.sessionTaskDir });
      const orchCtx = createOrchestrationContext(emitEvent);
      await runOrchestrationTurn(orchCtx, () => executeLongTask(classification, orchCtx));
      return { started: true };
    }

    // --- Classify intent ---
    const conversationHistory = await buildConversationHistory(deps.sessionRef);
    const classification = await classifyIntent(
      deps.auditModelObjRef.value!, resolveLlmApiKey(config.auditModel!.provider, config.auditModel!.apiKey), currentText, config.workspaceDir, executionEnv, emitEvent, conversationHistory, config.sessionTaskDir, deps.llmTracking, config.projectDir, deps.runtimeContext.getSnapshot()
    );
    // Keep a sticky post-call check for an abort that races with
    // classification settlement before a new run is started.
    if (isAbortRequested()) {
      throw new OrchestrationAbortedError();
    }

    // Always write mode metadata AFTER classification
    writeModeMetadata(config.sessionTaskDir, {
      mode: "long_task",
      optimizedPrompt: classification.optimizedPrompt,
      goals: classification.goals,
      acceptanceCriteria: classification.acceptanceCriteria,
      complexity: classification.complexity,
      createdAt: new Date().toISOString(),
      originalUserMessages: [currentText],
      complexAssistantCount: getComplexAssistantCount(),
    });
    saveSessionName(deps.sessionRef, state, classification);

    await activateTopLevelTools();
    await harnessRef.current.setResources({ skills: allSkills });

    // --- Simple: direct LLM response ---
    if (classification.complexity === "simple") {
      emitEvent({ type: "thinking", role: "assistant", delta: "[Long Task] Simple dialogue, responding directly..." });
      await promptWithContextCapacity(classification.optimizedPrompt);
      return { started: true };
    }

    // --- Complex + needs clarification: ask questions BEFORE planning ---
    if (!classification.skipClarification && classification.clarificationQuestions?.length) {
      const header = "\u2753 Before I begin, I need to clarify a few things:\n\n";
      const questionsText = classification.clarificationQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n");
      const fullText = header + questionsText;

      // Emit as a proper chat bubble (message_start + message_update + message_end)
      emitEvent({ type: "message_start", role: "assistant" } as any);
      emitEvent({ type: "message_update", role: "assistant", delta: fullText } as any);
      emitEvent({ type: "message_end" } as any);
      // Signal agent turn complete so frontend re-enables the send button
      emitEvent({ type: "agent_end", message_count: 1 } as any);

      // Save state for when user responds
      setPendingPrePlanningClarification({
        originalMessage: currentText,
        classification,
        conversationHistory,
      });

      return { started: true };
    }

    // --- Complex + clear enough: go straight to orchestration ---
    // projectDir was already extracted before classifyIntent
    emitEvent({ type: "thinking", role: "assistant", delta: "[Long Task] Complex task, starting orchestration..." });
    setInternalMode(true);
    emitEvent({ type: "internal_mode", active: true } as any);
    emitEvent({ type: "orchestration_resuming", session_task_dir: config.sessionTaskDir });
    const orchCtx = createOrchestrationContext(emitEvent);
    await runOrchestrationTurn(orchCtx, () => executeLongTask(classification, orchCtx));
    return { started: true };
  }

  /** Validate native/legacy transports and business paths before committing Prompt Run state. */
  function beginPromptRuntimeContext(command: RpcCommand, text: string): string {
    const resolved = resolvePromptRuntimeContextInputs({
      sessionContext: command.session_context,
      runContext: command.run_context,
      metadata: command.metadata,
      previousSession: deps.runtimeContext.getSessionInput(config.sessionId),
    });
    const effectiveSession: SessionRuntimeContextInput = resolved.session
      ?? deps.runtimeContext.getSessionInput(config.sessionId)
      ?? { schema_version: "1.0", attributes: {} };
    const effectiveRun: CurrentRunContextInput = resolved.run;

    // Prepare every value first. A rejected Gateway project or malformed policy
    // must not leave tracking/config/runtime context partially updated.
    if (process.env.HOGAGENT_GATEWAY_MANAGED === "1" && effectiveRun.manifest_owner !== "gateway") {
      throw new Error("Gateway-managed prompts require manifest_owner=gateway");
    }
    const manifestOwner = effectiveRun.manifest_owner === "gateway" ? "gateway" : "hogagent";
    const structuredProjectId = effectiveSession.project_id;
    const structuredProjectDir = effectiveSession.project_dir;
    let projectDir: string | undefined;
    if (manifestOwner === "gateway") {
      projectDir = resolveGatewayProject(structuredProjectId, structuredProjectDir);
      if (projectDir && command.mode === "quick") throw new Error("Gateway project sessions require standard or long_task");
    } else {
      // Standalone mode has no Gateway authority. Only startup config or
      // an explicit path in the current prompt may select the project root.
      const promptProjectDir = extractProjectDirFromText(text);
      const standaloneCandidate = promptProjectDir ?? standaloneProjectDir;
      const canonicalCandidate = standaloneCandidate ? realPath(standaloneCandidate) ?? undefined : undefined;
      projectDir = canonicalCandidate && (!promptProjectDir || isPathInside(config.workspaceDir, canonicalCandidate))
        ? canonicalCandidate
        : undefined;
    }
    const artifactRunPolicy = isArtifactRunPolicy(effectiveRun.artifact_run_policy)
      ? effectiveRun.artifact_run_policy
      : defaultArtifactRunPolicy(Boolean(projectDir));

    const promptRunId = deps.runtimeContext.beginPromptRun({
      ...effectiveRun,
      schema_version: "1.0",
      manifest_owner: manifestOwner,
      artifact_run_policy: artifactRunPolicy,
      attributes: effectiveRun.attributes ?? {},
    });
    try {
      // Session context is the consumer's declarative, session-scoped value. Its
      // project path is preserved even when this standalone run does not authorize
      // that path for business operations. Gateway business config still receives
      // only the canonical path computed above. Starting the Prompt Run first means
      // a rejected finalized run cannot partially commit a session-context update.
      deps.runtimeContext.bindSession(config.sessionId, config.sessionTaskDir, {
        schema_version: "1.0",
        ...(structuredProjectId ? { project_id: structuredProjectId } : {}),
        ...(structuredProjectDir ? { project_dir: structuredProjectDir } : {}),
        attributes: effectiveSession.attributes ?? {},
      });
    } catch (error) {
      deps.runtimeContext.endPromptRun(promptRunId);
      throw error;
    }

    // Existing business fields keep their established behavior; native context
    // is only an additional transport and legacy prompt.metadata maps here.
    deps.llmTracking.workId = effectiveRun.work_id ?? "";
    deps.llmTracking.taskId = effectiveRun.task_id ?? "";
    config.manifestOwner = manifestOwner;
    config.projectId = structuredProjectId;
    config.projectDir = projectDir;
    config.artifactRunPolicy = artifactRunPolicy;
    return promptRunId;
  }

  // ─── RPC Handlers ─────────────────────────────────────────────────────

  async function onPrompt(command: RpcCommand): Promise<void> {
    // Validate routing fields before switching sessions or clearing pending work.
    const text = typeof command.text === "string" ? command.text : "";
    const requestedSessionId = command.session_id;
    const invalidInput = !text.trim()
      ? "prompt command requires a non-empty 'text' string"
      : requestedSessionId !== undefined && !isSafeSessionId(requestedSessionId)
        ? "prompt.session_id must be a valid session ID"
        : command.mode !== undefined && !isConversationMode(command.mode)
          ? "prompt.mode must be quick, standard, or long_task"
          : undefined;
    if (invalidInput) {
      emitEvent({ type: "error", error: invalidInput, command_type: "prompt" });
      emitEvent({ type: "agent_end", reason: "error", error: invalidInput });
      return;
    }
    // A new prompt means the user wants to proceed — clear any sticky abort flag
    // left over from a previous abort (the flag only applies within one turn).
    setAbortRequested(false);

    // Auto-switch session based on session_id (supports new or resume), avoiding requiring client to send resume_session first
    if (requestedSessionId && deps.ensureSessionRef.current) {
      try {
        await deps.ensureSessionRef.current(requestedSessionId as string, command.mode as string | undefined);
      } catch (err) {
        const error = `Session switch failed: ${err instanceof Error ? err.message : String(err)}`;
        emitEvent({ type: "error", error });
        // Emit termination event so all consumers reset busy state (error alone may not suffice)
        emitEvent({ type: "agent_end", reason: "error", error });
        return;
      }
    }

    if (state.switchedSession) {
      const error = "Currently in read-only historical session mode. Please click \"New Session\" before sending messages";
      emitEvent({ type: "error", error });
      emitEvent({ type: "agent_end", reason: "error", error });
      return;
    }
    let promptRunId: string;
    try {
      promptRunId = beginPromptRuntimeContext(command, text);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emitEvent({ type: "error", error });
      emitEvent({ type: "agent_end", reason: "error", error });
      return;
    }

    // CurrentRunContext belongs to this outer onPrompt invocation. Long Task may
    // emit several internal agent_end events and execute many Harness turns; none
    // of those events owns cleanup. Only this finally boundary does.
    try {
      beginInstructionSnapshot(config.workspaceDir);
      // Initialize activity logger on first prompt
      deps.activityLoggerRef.current.init(config.sessionId, text);
      deps.activityLoggerRef.current.log("call llm", text, "");
      log.info("Prompt received", { length: text.length });
      startArtifactRun(config, deps.runtimeContext.getSnapshot().current_run?.run_id ?? promptRunId);

      const requestedMode = (command.mode as ConversationMode) || undefined;

      // 1. Read mode (memory first, then mode.json on disk)
      if (!deps.currentModeRef.value) {
        const meta = readModeMetadata(config.sessionTaskDir);
        if (meta) deps.currentModeRef.value = meta.mode;
      }

      if (!deps.currentModeRef.value) {
        // First message: determine mode from RPC parameter
        const mode = requestedMode || "standard";
        deps.currentModeRef.value = mode;
        if (requestedMode) {
          log.info("First message mode set", { mode });
        }
      }

      // 3. Mid-conversation mode switch
      if (requestedMode && requestedMode !== deps.currentModeRef.value) {
        const prevMode = deps.currentModeRef.value;
        deps.currentModeRef.value = requestedMode;
        setPendingPrePlanningClarification(null);
        clearPendingOrchestration();
        clearOrchestrationState(config.sessionTaskDir);
        // Mode switch abandons the current task entirely — also drop any archived
        // checkpoint so a later "[Continue Task]" cannot resurrect it.
        removeArchivedOrchestrationState(config.sessionTaskDir);
        // Persist mode switch immediately so page reloads preserve the new mode
        writeModeMetadata(config.sessionTaskDir, { mode: requestedMode, optimizedPrompt: text, createdAt: new Date().toISOString() });
        saveSessionName(deps.sessionRef, state, { goals: [text] });
        emitEvent({ type: "thinking", role: "assistant", delta: `⚡ Mode switch: ${prevMode} → ${requestedMode}` });
        log.info("Mode switched mid-conversation", { from: prevMode, to: requestedMode });
      }

      // 4. Unified routing
      if (deps.currentModeRef.value === "long_task") {
        // Restore thinkingLevel when switching from quick to long_task
        if (state.quickThinkingOverride) {
          if (state.savedThinkingLevel) {
            (harnessRef.current as any).thinkingLevel = state.savedThinkingLevel;
          }
          state.quickThinkingOverride = false;
          state.savedThinkingLevel = null;
        }
        // Restore explicit cache for long_task (may have been stripped by a prior quick turn).
        // Only the cache field changes; thinking/provider compat remains intact.
        try {
          await setExplicitCache(loadSystemConfig().explicitCache === true);
        } catch (e) {
          log.warn("Failed to restore explicit cache for long_task mode", { error: e instanceof Error ? e.message : String(e) });
        }
        // Degraded standard-mode processing for this turn (audit model unusable).
        // P2 #17: keep mode as "long_task" — degradation is per-turn (audit model may
        // come back later); overwriting with "standard" would silently discard the
        // user's mode choice for the rest of the session.
        const degradeToStandard = async (reason: string) => {
          emitEvent({ type: "thinking", role: "assistant", delta: `⚠️ ${reason}, Long Task degraded to Standard` });
          emitEvent({ type: "warning", message: `${reason}, Long Task degraded to Standard` });
          const degradedFiltered = filterSkillsByMode(allSkills, "standard", skillsConfig);
          // MUST await setActiveTools — it's async and sets this.activeToolNames AFTER I/O completes.
          // Without await, prompt() reads stale activeToolNames (race condition).
          await activateTopLevelTools();
          await harnessRef.current.setResources({ skills: degradedFiltered });
          writeModeMetadata(config.sessionTaskDir, { mode: "long_task", optimizedPrompt: text, createdAt: new Date().toISOString() });
          saveSessionName(deps.sessionRef, state, { goals: [text] });
          // Abort that arrived during audit failure handling — do not start a new run
          if (isAbortRequested()) {
            throw new OrchestrationAbortedError();
          }
          await promptWithContextCapacity(text);
        };

        const auditAvailable = !!(deps.auditModelObjRef.value && config.auditModel);
        if (auditAvailable) {
          try {
            await processLongTaskMessage(text);
          } catch (err) {
            // Audit model's own key is unusable (invalid key / quota exhausted):
            // process this turn in standard mode instead of failing the conversation.
            if (err instanceof AuditModelUnavailableError) {
              log.warn("Audit model key unavailable, degrading to standard", { error: err.message });
              await degradeToStandard(`Audit model LLM key unavailable (${err.message})`);
            } else {
              throw err;
            }
          }
        } else {
          await degradeToStandard("Audit model not configured or disabled");
        }
      } else {
        // Restore thinkingLevel when leaving quick mode
        if (state.quickThinkingOverride && deps.currentModeRef.value !== "quick") {
          if (state.savedThinkingLevel) {
            (harnessRef.current as any).thinkingLevel = state.savedThinkingLevel;
          }
          state.quickThinkingOverride = false;
          state.savedThinkingLevel = null;
        }

        switch (deps.currentModeRef.value) {
          case "quick": {
            // First-time setup: only when entering quick mode (not on consecutive messages)
            if (!state.quickThinkingOverride) {
              // MUST await setActiveTools — without it, prompt() runs before activeToolNames is cleared.
              await harnessRef.current.setActiveTools([]);
              await harnessRef.current.setResources({ skills: [] });
              // Disable explicit cache for quick mode (low cost-effectiveness)
              try {
                await setExplicitCache(false);
              } catch (e) {
                log.warn("Failed to disable explicit cache for quick mode", { error: e instanceof Error ? e.message : String(e) });
              }
              // Save current thinkingLevel for restore on mode exit
              state.savedThinkingLevel = harnessRef.current.getThinkingLevel();
              state.quickThinkingOverride = true;
            }
            // Per-call override takes priority; persisted quick setting remains the fallback.
            // Direct assignment keeps this override ephemeral and does not rewrite llm-settings.json.
            (harnessRef.current as any).thinkingLevel = resolveQuickThinkingLevel(
              command.thinking_level,
              loadPersistedLlmSettings().quickThinkingLevel,
            );

            writeModeMetadata(config.sessionTaskDir, { mode: "quick", optimizedPrompt: text, createdAt: new Date().toISOString() });
            saveSessionName(deps.sessionRef, state, { goals: [text] });
            break;
          }
          case "standard": {
            await activateTopLevelTools();
            await harnessRef.current.setResources({ skills: filterSkillsByMode(allSkills, "standard", skillsConfig) });
            // Restore explicit cache for standard mode (may have been stripped by quick)
            try {
              await setExplicitCache(loadSystemConfig().explicitCache === true);
            } catch (e) {
              log.warn("Failed to restore explicit cache for standard mode", { error: e instanceof Error ? e.message : String(e) });
            }
            writeModeMetadata(config.sessionTaskDir, { mode: "standard", optimizedPrompt: text, createdAt: new Date().toISOString() });
            saveSessionName(deps.sessionRef, state, { goals: [text] });
            break;
          }
        }
        await promptWithContextCapacity(text);
      }
    } catch (err) {
      if (err instanceof OrchestrationAbortedError) {
        // A Long Task orchestration was aborted — unwind cleanly without an
        // "error" event, then terminate the turn so consumers reset busy state.
        // Two abort sources share this path and differ in checkpoint handling:
        // - User abort (onAbort set the sticky flag): cancel the task — drop the
        //   persisted checkpoint so the next message must NOT auto-resume it.
        //   (onAbort already deleted it; this is a belt-and-braces cleanup.)
        // - Shutdown abort (process exit, flag false): the task was not
        //   cancelled — keep orchestration-state.json so the next startup can
        //   resume from the interrupted group via hasIncompleteOrchestration.
        setInternalMode(false);
        emitEvent({ type: "internal_mode", active: false } as any);
        // The outer Prompt owns this terminal. Clear Gateway's orchestration
        // suppression before agent_end, including shutdown-driven cancellation.
        emitEvent({ type: "orchestration_completed" });
        clearPendingOrchestration();
        const userRequested = isAbortRequested();
        cleanupAbortedOrchestration(config.sessionTaskDir, userRequested);
        if (userRequested) {
          log.info("Long Task orchestration aborted by user");
        } else {
          log.info("Long Task orchestration interrupted by shutdown; checkpoint preserved for resume");
        }
        emitEvent({ type: "thinking", role: "assistant", delta: "[Long Task] Task aborted" });
        emitEvent({ type: "agent_end", reason: "cancelled" });
        return;
      }
      // Bug 27 fix: Reset internalMode on exception to prevent _internalMode stuck at true
      // Issue: When executeLongTask throws, setInternalMode(false) in processLongTaskMessage is unreachable
      // causing subsequent message_* events to be redirected as thinking events
      setInternalMode(false);
      // P1 #13: also tell the frontend, otherwise its internal-mode rendering stays stuck
      emitEvent({ type: "internal_mode", active: false } as any);
      if (deps.currentModeRef.value === "long_task") emitEvent({ type: "orchestration_completed" });
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Prompt execution failed", { error: msg });
      emitEvent({ type: "error", error: msg });
      // Emit termination event so all consumers reset busy state (error alone may not suffice)
      emitEvent({
        type: "agent_end",
        reason: err instanceof ContextCompactionError ? "context_compaction_failed" : "error",
        error: msg,
      } as any);
      return;
    } finally {
      // Abort only requests termination; the original Prompt Run clears its own
      // context after the Harness, final audit, and delivery paths unwind.
      deps.runtimeContext.endPromptRun(promptRunId);
      endInstructionSnapshot(config.workspaceDir);
    }
  }

  async function onSteer(command: RpcCommand): Promise<void> {
    if (state.switchedSession) {
      emitEvent({ type: "error", error: "Currently in read-only historical session mode. Please click \"New Session\" before sending messages" });
      return;
    }
    // Support text at top-level or nested in params (sendCommand generic path uses params nesting)
    const params = command.params as Record<string, unknown> | undefined;
    const text = (command.text as string | undefined) || (params?.['text'] as string | undefined);
    if (!text) {
      emitEvent({ type: "error", error: "steer command requires 'text' field" });
      return;
    }
    try {
      await harnessRef.current.steer(text);
      emitEvent({ type: "steer_queued" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitEvent({ type: "error", error: msg });
    }
  }

  async function onFollowUp(command: RpcCommand): Promise<void> {
    if (state.switchedSession) {
      emitEvent({ type: "error", error: "Currently in read-only historical session mode. Please click \"New Session\" before sending messages" });
      return;
    }
    // Support text at top-level or nested in params (sendCommand generic path uses params nesting)
    const params = command.params as Record<string, unknown> | undefined;
    const text = (command.text as string | undefined) || (params?.['text'] as string | undefined);
    if (!text) {
      emitEvent({ type: "error", error: "follow_up command requires 'text' field" });
      return;
    }
    try {
      await harnessRef.current.followUp(text);
      emitEvent({ type: "follow_up_queued" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitEvent({ type: "error", error: msg });
    }
  }

  // Guard against concurrent onAbort runs (rapid double-click during an
  // orchestration unwind): harness.abort() awaits waitForIdle(), and a second
  // concurrent abort can deadlock on it while the harness is mid-unwind.
  let abortInFlight = false;

  async function onAbort(command?: RpcCommand): Promise<void> {
    log.info("Abort requested");
    if (isCompactionInProgress()) {
      throw new Error("Context compaction is in progress and cannot be cancelled; wait for it to complete or time out");
    }
    // Long Task fix: harness.abort() only cancels the *current* run, but the
    // orchestration loop issues many sequential prompts (groups, audits,
    // continuation prompts). Set the sticky flag so the loop stops re-arming.
    setAbortRequested(true);
    // Drop BOTH suspended clarification states (mid-execution [ASK_USER] and
    // pre-planning clarification) so the next message starts fresh instead of
    // being treated as a clarification answer / auto-resume.
    clearPendingOrchestration();
    setPendingPrePlanningClarification(null);
    // Archive (not delete) the checkpoint: the task is cancelled for auto-resume
    // purposes, but an explicit "[Continue Task]" dispatch may still restore it.
    archiveOrchestrationState(config.sessionTaskDir);
    if (abortInFlight) {
      log.info("Abort already in flight, skipping duplicate harness abort");
      return;
    }
    abortInFlight = true;
    // Gateway currently flattens abort params, while older direct clients may
    // still nest them under params. Prefer the current top-level protocol.
    const abortParams = command?.params as Record<string, unknown> | undefined;
    const taskId = command?.task_id ?? abortParams?.task_id;
    const workId = command?.work_id ?? abortParams?.work_id;
    try {
      // The audit harness is a temporary isolated instance unreachable via the
      // main harness abort — stop it explicitly (no-op when no audit is running).
      abortActiveAuditHarness();
      // A fast extension rejection must not publish abort_completed while the
      // main Harness is still unwinding and can still write project files.
      const outcomes = await Promise.allSettled([
        harnessRef.current.abort(),
        notifyAgentAbort(),
      ]);
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failure) throw failure.reason;
      emitEvent({ type: "aborted" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Abort failed", { error: msg });
      emitEvent({ type: "error", error: `Abort failed: ${msg}`, command_type: "abort" });
    } finally {
      abortInFlight = false;
      // Terminal settle event for the Gateway: work-engine defers run
      // release / cascade until abort_completed arrives, and session-pool
      // transitions the adapter back to idle on it. Emitted unconditionally
      // (even when harness.abort() threw): the sticky flag, orchestration
      // state and audit harness were already handled above, and the Gateway
      // already marked the task aborted — settle must not depend on harness
      // teardown succeeding, or cancellationSettlingAdapters never converges.
      // Echo task_id/work_id when the abort command carried them so the
      // Gateway can match the exact task instead of falling back to session lookup.
      emitEvent({
        type: "abort_completed",
        ...(typeof taskId === "string" ? { task_id: taskId } : {}),
        ...(typeof workId === "string" ? { work_id: workId } : {}),
      });
    }
  }

  return { onPrompt, onSteer, onFollowUp, onAbort };
}
