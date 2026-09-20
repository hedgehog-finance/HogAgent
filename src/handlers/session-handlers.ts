import { deliveryReceiptsFromEntries } from "../artifacts/file-delivery.ts";
/**
 * Session Management RPC Handlers
 *
 * Handles session lifecycle: new, resume, list, and switch sessions.
 * Each creates/opens JSONL storage, builds a new AgentHarness, and
 * updates the shared refs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AgentHarness } from "../vendor/agent/harness/agent-harness.ts";
import type { AgentHarnessOptions } from "../vendor/agent/harness/types.ts";
import { Session, buildSessionContext } from "../vendor/agent/harness/session/session.ts";
import { JsonlSessionStorage } from "../vendor/agent/harness/session/jsonl-storage.ts";
import type { Skill } from "../vendor/agent/harness/types.ts";
import type { Model } from "../vendor/ai/base.ts";
import type { RpcCommand, ConversationMode } from "../utils/types.ts";
import { emitEvent, setCurrentSessionId } from "../rpc.ts";
import { resetAllModuleState } from "../agent-state.ts";
import { createLogger } from "../utils/logger.ts";
import { getSessionsDir, isConversationMode, readModeMetadata, writeModeMetadata } from "../config.ts";
import { createActivityLogger, type ActivityLogger } from "../utils/activity-logger.ts";
import { ensureDir } from "../utils/ensure-dir.ts";
import { openOrCreateSessionStorage, repairSessionTree } from "../session-storage.ts";
import { subscribeToHarnessEvents } from "../harness-events.ts";
import { buildSystemPrompt } from "../system-prompt.ts";
import { clearPendingOrchestration, hasIncompleteOrchestration } from "../long-task-orchestrator.ts";
import { getDeliveryManager, notifyHarnessReplaced } from "../extensions/index.ts";
import { registerLlmMetadataHook, registerMainLlmContextThrottle } from "../llm-metadata-hook.ts";
import { stripDeliveryDecision } from "../protocol/agent-result-schema.ts";
import { parseSessionRuntimeContextInput, type SessionRuntimeContextInput } from "../runtime-context.ts";
import { beginSessionTransition, endSessionTransition } from "../session-transition-state.ts";
import {
  type HandlerDeps,
  type HandlerMutableState,
  messageText,
  saveSessionName,
  INTERNAL_PATTERNS,
} from "./types.ts";

const log = createLogger("core");
const SESSION_ID_SAFE_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/** Session IDs become filenames and task-directory segments. */
export function isSafeSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_SAFE_RE.test(value);
}

export function createSessionHandlers(deps: HandlerDeps, state: HandlerMutableState) {
  const { harnessRef, config, toolRegistry, allSkills, executionEnv } = deps;

  // Track the sessionId bound to the current Harness (separate from config.sessionId)
  // A writable display switch can change config.sessionId without rebinding the Harness.
  let harnessSessionId = config.sessionId;

  // Track the actual session data source loaded in Harness memory
  // A writable display switch invalidates this marker so resume rebuilds the Harness.
  // Read-only history must leave both markers untouched, including during execution.
  let harnessLoadedSessionId = config.sessionId;

  // ─── Helper: Build harness options for a new/resumed session ──────────

  function buildHarnessOptions(session: Session): AgentHarnessOptions {
    return {
      env: executionEnv,
      session,
      model: harnessRef.current.getModel(),
      tools: toolRegistry.snapshotTopLevel(),
      thinkingLevel: (state.quickThinkingOverride ? state.savedThinkingLevel : null)
        ?? harnessRef.current.getThinkingLevel(),
      resources: { skills: allSkills },
      getApiKeyAndHeaders: deps.resolveMainLlmAuth,
      systemPrompt: ({ env: _env, model, activeTools, resources }) => {
        return buildSystemPrompt({
          workspaceDir: config.workspaceDir,
          sessionTaskDir: config.sessionTaskDir,
          model,
          skills: (resources.skills ?? []) as Skill[],
          activeTools,
          currentMode: deps.currentModeRef.value,
          theme: config.theme,
          projectDir: config.projectDir,
          runtimeContext: deps.runtimeContext.getSnapshot(),
        });
      },
    } as AgentHarnessOptions;
  }

  interface PreparedSessionTransition {
    sessionId: string;
    sessionTaskDir: string;
    session: Session;
    harness: AgentHarness;
    activityLogger: ActivityLogger;
    unsubscribe: () => void;
  }

  /** Build and wire the target Harness without changing the active session. */
  function prepareSessionTransition(
    sessionId: string,
    sessionTaskDir: string,
    session: Session,
  ): PreparedSessionTransition {
    const harness = new AgentHarness(buildHarnessOptions(session));
    const activityLogger = createActivityLogger(join(sessionTaskDir, "log.txt"));
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = subscribeToHarnessEvents(harness, activityLogger, config);
      // These hooks read mutable tracking/config only when a request begins, so
      // registering them during preparation does not expose the target early.
      registerLlmMetadataHook(harness, deps.llmTracking);
      registerMainLlmContextThrottle(harness);
    } catch (error) {
      unsubscribe?.();
      activityLogger.close();
      throw error;
    }
    return { sessionId, sessionTaskDir, session, harness, activityLogger, unsubscribe };
  }

  /** Retire the old Harness, then synchronously publish one prepared target. */
  async function commitSessionTransition(
    prepared: PreparedSessionTransition,
    suppliedSessionContext: SessionRuntimeContextInput | undefined,
    mode: ConversationMode | null,
    lockSessionName: boolean,
  ): Promise<void> {
    // All fallible target I/O and construction has completed. From this point,
    // no await occurs between runtime/config/ref publication steps.
    beginSessionTransition();
    try {
      deps.activityLoggerRef.current.close();
      if (state.unsubscribe) state.unsubscribe();
      try {
        await harnessRef.current.abort();
      } catch {
        // Ignore abort failures (Harness may already be idle).
      }

      deps.runtimeContext.bindSession(
        prepared.sessionId,
        prepared.sessionTaskDir,
        suppliedSessionContext,
      );
      config.sessionId = prepared.sessionId;
      config.sessionTaskDir = prepared.sessionTaskDir;
      config.projectId = undefined;
      config.projectDir = undefined;
      setCurrentSessionId(prepared.sessionId);
      harnessRef.current = prepared.harness;
      deps.sessionRef.current = prepared.session;
      deps.activityLoggerRef.current = prepared.activityLogger;
      state.unsubscribe = prepared.unsubscribe;
      harnessSessionId = prepared.sessionId;
      harnessLoadedSessionId = prepared.sessionId;
      deps.llmTracking.sessionId = prepared.sessionId;
      deps.currentModeRef.value = mode;

      state.switchedSession = false;
      state.sessionNameSaved = lockSessionName;
      state.quickThinkingOverride = false;
      state.savedThinkingLevel = null;
      resetSessionState();

      // Extension notifications are failure-isolated internally and observe the
      // fully committed Harness/runtime/config tuple.
      await notifyHarnessReplaced(prepared.harness);
    } finally {
      endSessionTransition();
    }
  }

  // ─── Helper: Reset session-scoped state ───────────────────────────────

  function resetSessionState(): void {
    clearPendingOrchestration();
    // Reset ALL module-level flags (internalMode, suppressUserBubble,
    // complexAssistantCount, mainTurnStarted, pre-planning clarification,
    // buffered message) — keep in sync with resetAllModuleState()
    resetAllModuleState();
  }

  // ─── onNewSession ────────────────────────────────────────────────────

  async function onNewSession(command: RpcCommand): Promise<void> {
    let suppliedSessionContext: SessionRuntimeContextInput | undefined;
    try {
      suppliedSessionContext = command.session_context === undefined
        ? undefined
        : parseSessionRuntimeContextInput(command.session_context);
    } catch (err) {
      emitEvent({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        command_type: "new_session",
      });
      return;
    }
    // 1. Validate session ID before any destructive operations
    const customId = command.session_id;
    if (customId !== undefined && typeof customId !== "string") {
      emitEvent({
        type: "error",
        error: "session_id must be a string",
        command_type: "new_session",
      });
      return;
    }
    let newSessionId: string;
    if (customId && customId.trim()) {
      newSessionId = customId.trim();
      if (!isSafeSessionId(newSessionId)) {
        emitEvent({
          type: "error",
          error: "session_id contains illegal characters",
          command_type: "new_session",
        });
        return;
      }
      // Guard: reject IDs that match existing sessions to prevent data loss
      const sessionsDir = getSessionsDir(config.user);
      const existingFile = join(sessionsDir, `${newSessionId}.jsonl`);
      if (existsSync(existingFile)) {
        emitEvent({
          type: "error",
          error: `Session '${newSessionId}' already exists. Use switch_session or resume_session to access historical sessions.`,
          command_type: "new_session",
        });
        return;
      }
    } else {
      newSessionId = crypto.randomUUID();
    }

    const sessionTaskDir = join(config.workspaceDir, "tasks", newSessionId);
    const sessionsDir = getSessionsDir(config.user);
    const sessionFilePath = join(sessionsDir, `${newSessionId}.jsonl`);
    let prepared: PreparedSessionTransition;
    try {
      // Phase 1 — prepare target resources while the old session remains fully
      // active. A failure here does not close its logger, unsubscribe events, or
      // publish target config/runtime state.
      await ensureDir(sessionTaskDir);
      const storage = await openOrCreateSessionStorage(
        executionEnv,
        sessionFilePath,
        config.workspaceDir,
        newSessionId,
      );
      prepared = prepareSessionTransition(newSessionId, sessionTaskDir, new Session(storage));
    } catch (error) {
      log.error("Failed to prepare new session", { error: String(error) });
      emitEvent({
        type: "error",
        error: `Failed to create session: ${error instanceof Error ? error.message : String(error)}`,
        command_type: "new_session",
      });
      return;
    }

    // Phase 2 — retire the old Harness and publish the prepared target.
    await commitSessionTransition(prepared, suppliedSessionContext, null, false);
    log.info("New session created", { sessionId: newSessionId });
    // A new session has no historical-file boundary for automatic delivery.
    getDeliveryManager()?.setAutoDeliveryModifiedAfter(null);

    emitEvent({ type: "session_created", session_id: newSessionId });
  }

  // ─── onResumeSession ──────────────────────────────────────────────────

  async function onResumeSession(command: RpcCommand): Promise<void> {
    // Resume a historical session as writable (in-process, no restart needed)
    if (command.mode !== undefined && !isConversationMode(command.mode)) {
      emitEvent({
        type: "error",
        error: "resume_session.mode must be quick, standard, or long_task",
        command_type: "resume_session",
      });
      return;
    }
    const requestedMode = isConversationMode(command.mode) ? command.mode : undefined;
    const sessionId = typeof command.session_id === "string" ? command.session_id : undefined;
    if (!sessionId) {
      emitEvent({
        type: "error",
        error: "resume_session requires 'session_id' field",
        command_type: "resume_session",
      });
      return;
    }
    if (!isSafeSessionId(sessionId)) {
      emitEvent({
        type: "error",
        error: "session_id contains illegal characters",
        command_type: "resume_session",
      });
      return;
    }
    let suppliedSessionContext: SessionRuntimeContextInput | undefined;
    try {
      suppliedSessionContext = command.session_context === undefined
        ? undefined
        : parseSessionRuntimeContextInput(command.session_context);
    } catch (err) {
      emitEvent({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        command_type: "resume_session",
      });
      return;
    }
    // Guard: skip if Harness is already bound to this session AND loaded data matches (fast path)
    // Writable display switches invalidate harnessLoadedSessionId; read-only views do not.
    if (sessionId === harnessSessionId && sessionId === harnessLoadedSessionId) {
      log.info("Resume session skipped — already active", { sessionId });
      state.switchedSession = false;
      // Bug 8 fix: Recalculate taskDir using sessionId instead of relying on config.sessionTaskDir
      // (switch_session(read_only=false) may have updated config.sessionTaskDir to a different session)
      const correctTaskDir = join(config.workspaceDir, "tasks", sessionId);
      deps.runtimeContext.bindSession(sessionId, correctTaskDir, suppliedSessionContext);
      const hasIncomplete = hasIncompleteOrchestration(correctTaskDir);
      const modeMeta = readModeMetadata(correctTaskDir);
      deps.currentModeRef.value = requestedMode ?? modeMeta?.mode ?? null;
      state.sessionNameSaved = true;
      emitEvent({
        type: "ready",
        session_id: sessionId,
        _resumed: true,
        has_incomplete_orchestration: hasIncomplete,
        capabilities: deps.getCapabilitiesFn(),
        mode: deps.currentModeRef.value,
      });
      return;
    }
    const sessionsDir = getSessionsDir(config.user);
    const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
    if (!existsSync(sessionFile)) {
      emitEvent({
        type: "error",
        error: `Session not found: ${sessionId}`,
        command_type: "resume_session",
      });
      return;
    }

    const sessionTaskDir = join(config.workspaceDir, "tasks", sessionId);
    let prepared: PreparedSessionTransition;
    let restoredMode: ConversationMode | null;
    try {
      // Phase 1 — target storage validation/repair and Harness wiring happen
      // before any active-session state is retired or published.
      await ensureDir(sessionTaskDir);
      const storage = await openOrCreateSessionStorage(
        executionEnv,
        sessionFile,
        config.workspaceDir,
        sessionId,
      );
      await repairSessionTree(storage, sessionId);
      const resumedSession = new Session(storage);
      const modeMeta = readModeMetadata(sessionTaskDir);
      restoredMode = requestedMode ?? modeMeta?.mode ?? null;
      prepared = prepareSessionTransition(sessionId, sessionTaskDir, resumedSession);
    } catch (err) {
      log.error("Failed to prepare resumed session", { error: String(err) });
      emitEvent({
        type: "error",
        error: `Failed to resume session: ${err instanceof Error ? err.message : String(err)}`,
        command_type: "resume_session",
      });
      return;
    }

    log.info("Resuming session", { sessionId });
    await commitSessionTransition(prepared, suppliedSessionContext, restoredMode, true);
    // Only files written from this successful writable restoration onward may
    // be picked up by the automatic-delivery fallback.
    getDeliveryManager()?.setAutoDeliveryModifiedAfter(Date.now());

    emitEvent({
      type: "ready",
      session_id: sessionId,
      _resumed: true,
      has_incomplete_orchestration: hasIncompleteOrchestration(sessionTaskDir),
      capabilities: deps.getCapabilitiesFn(),
      mode: deps.currentModeRef.value,
    });
  }

  // ─── onListSessions ───────────────────────────────────────────────────

  function onListSessions(): void {
    const sessionsDir = getSessionsDir(config.user);
    const sessions: Array<{ id: string; title?: string; createdAt: string; messageCount: number }> = [];
    if (!existsSync(sessionsDir)) {
      emitEvent({ type: "session_list", sessions, current_session_id: config.sessionId });
      return;
    }
    try {
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).sort();
      for (const file of files) {
        try {
          const sessionIdFromName = file.replace(/\.jsonl$/, "");
          const content = readFileSync(join(sessionsDir, file), "utf-8");
          const lines = content.split("\n").filter((l) => l.trim());
          if (lines.length === 0) continue;
          // Try to find session header (may not be the first line in some cases)
          let sessionId = sessionIdFromName;
          let createdAt = "";
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.type === "session" && entry.id) {
                sessionId = entry.id;
                createdAt = entry.timestamp || "";
                break;
              }
            } catch { /* skip */ }
          }
          // If no session header found, use file stat for timestamp
          if (!createdAt) {
            try {
              const stat = statSync(join(sessionsDir, file));
              createdAt = stat.birthtime.toISOString();
            } catch { createdAt = new Date().toISOString(); }
          }
          // Count user messages and scan for session_name in a single pass
          let userMessageCount = 0;
          let firstUserMessage = "";
          let sessionNameFromJsonl: string | undefined;
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.message?.role === "user") {
                userMessageCount++;
                if (!firstUserMessage) {
                  const text = entry.message.content?.[0]?.text || "";
                  // Skip system-internal prompts (clarification, orchestrator re-prompt, retry)
                  const isInternal = INTERNAL_PATTERNS.some((p) => p.test(text));
                  if (!isInternal && text.length >= 2) firstUserMessage = text.slice(0, 30);
                }
              }
              // Check for session_name in session_info entries (last write wins)
              if (entry.type === "session_info" && entry.name_kind === "session_name" && entry.name) {
                sessionNameFromJsonl = entry.name.slice(0, 30);
              }
            } catch { /* skip invalid lines */ }
          }
          // Try to get title: session_name > first prompt/goals > rolling values > first user message
          let title: string | undefined = sessionNameFromJsonl;
          if (!title) {
            try {
              const taskDir = join(config.workspaceDir, "tasks", sessionId);
              const modeMeta = readModeMetadata(taskDir);
              if (modeMeta?.firstOptimizedPrompt) {
                title = modeMeta.firstOptimizedPrompt.slice(0, 30);
              } else if (modeMeta?.firstGoals?.length) {
                title = modeMeta.firstGoals[0]!.slice(0, 30);
              } else if (modeMeta?.optimizedPrompt) {
                title = modeMeta.optimizedPrompt.slice(0, 30);
              } else if (modeMeta?.goals && modeMeta.goals.length > 0) {
                title = modeMeta.goals[0]!.slice(0, 30);
              }
            } catch { /* ignore */ }
          }
          if (!title) title = firstUserMessage || undefined;
          log.debug("Session list entry", { sessionId, file, userMessageCount, title: title?.slice(0, 20), lineCount: lines.length });
          // Skip empty sessions (no user messages) and clean up their files
          if (userMessageCount === 0) {
            // Bug 9 fix: Do not perform file deletion on read path (avoid concurrent ENOENT race condition)
            // Log only — empty session cleanup is handled by shutdown callbacks
            log.debug("Skipping empty session from list", { sessionId, lineCount: lines.length });
            continue; // always skip empty sessions from the list
          }
          sessions.push({
            id: sessionId,
            title,
            createdAt,
            messageCount: userMessageCount,
          });
        } catch { /* skip invalid files */ }
      }
      // Sort by creation time, newest first
      sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch (err) {
      log.error("Failed to list sessions", { error: String(err) });
    }
    log.info("Session list result", { totalFiles: sessions.length, currentSessionId: config.sessionId, sessionIds: sessions.map(s => s.id.slice(0, 8)) });
    emitEvent({ type: "session_list", sessions, current_session_id: config.sessionId });
  }

  // ─── onSwitchSession ─────────────────────────────────────────────────

  async function onSwitchSession(command: RpcCommand): Promise<void> {
    const sessionId = typeof command.session_id === "string" ? command.session_id : undefined;
    const readOnly = command.read_only === true;
    const reportError = (error: string) => emitEvent({
      type: readOnly ? "session_history_error" : "error",
      session_id: sessionId,
      command_type: "switch_session",
      read_only: readOnly,
      error,
    });
    if (!sessionId) {
      reportError("switch_session requires 'session_id' field");
      return;
    }
    if (!isSafeSessionId(sessionId)) {
      reportError("session_id contains illegal characters");
      return;
    }
    const sessionsDir = getSessionsDir(config.user);
    const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
    if (!existsSync(sessionFile)) {
      reportError(`Session not found: ${sessionId}`);
      return;
    }
    try {
      // 1. Open session with auto-repair (handles missing headers)
      const storage = readOnly
        ? await JsonlSessionStorage.open(executionEnv, sessionFile)
        : await openOrCreateSessionStorage(executionEnv, sessionFile, config.workspaceDir, sessionId);
      if ((await storage.getMetadata()).id !== sessionId) throw new Error('Native history identity mismatch');

      // 2. Validate and repair session tree integrity
      if (!readOnly) await repairSessionTree(storage, sessionId);

      // 3. Use Session class for compaction-aware message extraction
      const switchSession = new Session(storage);
      const branch = await switchSession.getBranch();
      const context = buildSessionContext(branch);
      // Classify the complete active branch before compaction or empty/tool-only
      // messages are filtered. A cumulative count cannot locate interleaved final
      // answers, follow-ups, or messages retained after compaction.
      const thinkingMessages = new Set<typeof context.messages[number]>();
      let internalReply = false;
      for (const entry of branch) {
        if (entry.type !== "message") continue;
        if (entry.message.role === "user") {
          const text = messageText(entry.message);
          const internalPrompt = INTERNAL_PATTERNS.some(pattern => pattern.test(text))
            || /^## Planning Only\b/.test(text)
            || /^Your previous response did not (?:provide a complete, valid execution plan|include the required structured output JSON block)\./.test(text);
          internalReply = internalPrompt && !/^## Task Execution Complete\b/.test(text);
        } else if (entry.message.role === "assistant" && internalReply) {
          thinkingMessages.add(entry.message);
        }
      }

      // Display uses the compacted active context. Consumption includes all persisted
      // assistant calls, including compacted history and abandoned retry branches.
      const messages: Array<{ role: string; content: string; type: string }> = [];
      const usageHistory: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }> = [];
      const persistedEntries = await switchSession.getEntries();
      const deliveryFiles = deliveryReceiptsFromEntries(persistedEntries, sessionId);
      for (const entry of persistedEntries) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        const u = entry.message.usage;
        if (!u) continue;
        usageHistory.push({
          input: u.input || 0,
          output: u.output || 0,
          cacheRead: u.cacheRead || 0,
          cacheWrite: u.cacheWrite || 0,
          totalTokens: u.totalTokens || 0,
          cost: u.cost?.total || 0,
        });
      }
      let firstUserMessage = "";
      for (const msg of context.messages) {
        const role = (msg as any).role;
        if (role === "user" || role === "assistant") {
          const text = messageText(msg as any);
          // Skip internal user messages (system-generated prompts, clarification, etc.)
          if (role === "user") {
            const isInternal = INTERNAL_PATTERNS.some((p) => p.test(text));
            if (isInternal) continue;
            if (!firstUserMessage && text.length >= 2) firstUserMessage = text.slice(0, 30);
          }
          const visibleText = role === "assistant" ? stripDeliveryDecision(text) : text;
          if (role !== "assistant" || visibleText.trim()) {
            messages.push({ role, content: visibleText, type: thinkingMessages.has(msg) ? "thinking" : "message" });
          }
        }
      }

      // 4. Read mode metadata early (needed for both title and message type marking)
      const targetTaskDir = join(config.workspaceDir, "tasks", sessionId);
      const modeMeta = readModeMetadata(targetTaskDir);

      // 4b. Replace optimized user messages with original inputs (long_task only)
      // Audit LLM rewrites user prompts via classifyIntent → optimizedPrompt stored in JSONL.
      // originalUserMessages preserves what the user actually typed.
      if (modeMeta?.mode === "long_task" && modeMeta.originalUserMessages?.length) {
        const originals = modeMeta.originalUserMessages;
        let origIdx = 0;
        for (let i = 0; i < messages.length && origIdx < originals.length; i++) {
          if (messages[i]!.role === "user") {
            messages[i]!.content = originals[origIdx]!;
            origIdx++;
          }
        }
      }

      // 5. Get session title: session_name > stable mode metadata > first user message
      let title = (await switchSession.getSessionName())?.slice(0, 30) || "";
      if (!title) {
        if (modeMeta?.firstOptimizedPrompt) {
          title = modeMeta.firstOptimizedPrompt.slice(0, 30);
        } else if (modeMeta?.firstGoals?.length) {
          title = modeMeta.firstGoals[0]!.slice(0, 30);
        } else if (modeMeta?.optimizedPrompt) {
          title = modeMeta.optimizedPrompt.slice(0, 30);
        } else if (modeMeta?.goals && modeMeta.goals.length > 0) {
          title = modeMeta.goals[0]!.slice(0, 30);
        }
      }
      if (!title) title = firstUserMessage;

      // 6. Update current session ID and set read-only mode (skip in read_only mode)
      if (!readOnly) {
        config.sessionId = sessionId;
        setCurrentSessionId(sessionId);
        config.sessionTaskDir = join(config.workspaceDir, "tasks", sessionId);
        config.projectId = undefined;
        config.projectDir = undefined;
        deps.runtimeContext.bindSession(sessionId, config.sessionTaskDir);
        // POOL-007 fix: Clean up module-level state from old session on session switch to prevent cross-session pollution
        resetAllModuleState();
        clearPendingOrchestration();
        // NOTE: the target session's orchestration-state.json is intentionally preserved
        // (previously deleted as "Bug 4 fix") — resume_session reports
        // has_incomplete_orchestration so an unfinished orchestration stays resumable.
        // Auto-resume only happens on the next prompt via processLongTaskMessage.
        state.switchedSession = true;
        // Writable display switches require an explicit resume to rebuild the Harness.
        harnessLoadedSessionId = sessionId;
      }

      // Delivery is an event/task-history fact, not a filename convention.
      // Restore only persisted native receipts; never scan names to invent delivery.

      // 8. Restore per-sub-agent token stats persisted by the sub-agent extension
      let subAgentUsage: Array<Record<string, unknown>> | undefined;
      try {
        const subUsageFile = join(targetTaskDir, "sub-agent-usage.json");
        if (existsSync(subUsageFile)) {
          const parsed = JSON.parse(readFileSync(subUsageFile, "utf8"));
          // Legacy aggregate-object format: expose as a single synthetic record
          const entries: unknown[] = Array.isArray(parsed)
            ? parsed
            : (parsed && typeof parsed === "object" ? [{ id: "legacy-total", status: "completed", ...parsed }] : []);
          const valid = entries.filter(
            (e): e is Record<string, unknown> => !!e && typeof e === "object" && (Number((e as Record<string, unknown>).totalTokens) || 0) > 0,
          );
          if (valid.length > 0) subAgentUsage = valid;
        }
      } catch { /* corrupt usage file is non-fatal */ }

      // 9. Restore audit LLM token usage persisted by audit-classifier
      let auditUsage: Array<Record<string, unknown>> | undefined;
      try {
        const auditUsageFile = join(targetTaskDir, "audit-usage.json");
        if (existsSync(auditUsageFile)) {
          const parsed = JSON.parse(readFileSync(auditUsageFile, "utf8"));
          if (Array.isArray(parsed) && parsed.length > 0) {
            auditUsage = parsed.filter(
              (e): e is Record<string, unknown> => !!e && typeof e === "object",
            );
          }
        }
      } catch { /* corrupt audit usage file is non-fatal */ }

      emitEvent({
        type: "session_switched",
        session_id: sessionId,
        messages,
        title,
        mode: modeMeta?.mode || null,
        files: deliveryFiles,
        usageHistory: usageHistory.length > 0 ? usageHistory : undefined,
        subAgentUsage,
        auditUsage,
      });
      log.info("Switched to session", { sessionId });
    } catch (err) {
      log.error("Failed to switch session", { error: String(err) });
      reportError(`Failed to load session: ${String(err)}`);
    }
  }

  // ─── ensureSession: called by prompt/steer/follow_up handlers ───────
  // Auto-switch session based on session_id, avoiding requiring client to send resume_session before prompt
  deps.ensureSessionRef.current = async (sessionId: string, mode?: string) => {
    // Path injection protection: reject illegal characters
    if (!isSafeSessionId(sessionId)) {
      // Throw (not just emit) so onPrompt aborts — otherwise the prompt would
      // continue executing in the wrong session context
      throw new Error(`Invalid session_id format: ${sessionId}`);
    }
    // Already matched current session and Harness data not polluted → skip
    if (sessionId === config.sessionId && sessionId === harnessLoadedSessionId) {
      return;
    }
    const sessionsDir = getSessionsDir(config.user);
    const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
    if (existsSync(sessionFile)) {
      await onResumeSession({ type: "resume_session", session_id: sessionId, mode });
    } else {
      await onNewSession({ type: "new_session", session_id: sessionId });
    }
    // Verify the switch actually succeeded — onResumeSession/onNewSession emit
    // error events internally but do not throw; without this check onPrompt would
    // proceed in the stale session context (wrong history, wrong taskDir)
    if (config.sessionId !== sessionId) {
      throw new Error(`Failed to switch to session: ${sessionId}`);
    }
  };

  return { onNewSession, onResumeSession, onListSessions, onSwitchSession };
}
