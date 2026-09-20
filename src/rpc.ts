/**
 * HogAgent RPC Protocol Implementation
 *
 * Listens on stdin for JSONL commands, dispatches to handlers,
 * and emits events as JSON + "\n" to stdout.
 */

import { createInterface } from "node:readline";
import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "./utils/logger.ts";
import type { RpcCommand, RpcEvent } from "./utils/types.ts";
import { isCompactionInProgress } from "./compaction-manager.ts";
import { isSessionTransitionInProgress } from "./session-transition-state.ts";

const log = createLogger("rpc");

// ─── Session ID Injection ────────────────────────────────────────────────────

/** Module-level current session ID, auto-injected into every emitted event. */
let _currentSessionId: string | undefined;
const commandEventScope = new AsyncLocalStorage<{ internal: boolean; requestId?: string }>();

/** Update the current session ID for automatic event injection. */
export function setCurrentSessionId(id: string): void {
  _currentSessionId = id;
  log.debug("Current session ID updated", { sessionId: id });
}

/** Get the current session ID. */
export function getCurrentSessionId(): string | undefined {
  return _currentSessionId;
}

// ─── Event Emission ───────────────────────────────────────────────────────────

/** Emit an RPC event to stdout as JSONL. session_id is auto-injected if not explicitly provided. */
export function emitEvent(event: RpcEvent): void {
  const scope = commandEventScope.getStore();
  const payload: RpcEvent = {
    ...event,
    ...(event.request_id === undefined && scope?.requestId ? { request_id: scope.requestId } : {}),
    session_id: event.session_id ?? _currentSessionId,
    ...(event.internal === undefined && scope?.internal ? { internal: true } : {}),
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
  const line = JSON.stringify(payload) + "\n";
  process.stdout.write(line);
}

// ─── Command Handler Registry ─────────────────────────────────────────────────

export type CommandHandler = (command: RpcCommand) => void | Promise<void>;

const handlers = new Map<string, CommandHandler>();

/** Register a handler for a specific command type. */
export function registerHandler(type: string, handler: CommandHandler): void {
  handlers.set(type, handler);
  log.debug("Handler registered", { type });
}

/** Remove a handler for a specific command type. */
export function unregisterHandler(type: string): void {
  handlers.delete(type);
}

// ─── Command Dispatch ─────────────────────────────────────────────────────────

/** CHAT-007 fix: abort epoch to skip queued prompts that haven't started yet */
let abortQueueEpoch = 0;

async function dispatchCommand(command: RpcCommand, queuedAbortEpoch = abortQueueEpoch): Promise<void> {
  // CHAT-007: Check for stale queued prompts before starting prompt; skip if found.
  // A single abort invalidates every prompt already queued before it, not just one.
  if (command.type === "prompt" && queuedAbortEpoch < abortQueueEpoch) {
    log.info("Prompt skipped due to pending abort", {
      queuedAbortEpoch,
      abortQueueEpoch,
    });
    return;
  }

  await commandEventScope.run({ internal: command.internal === true,
    requestId: typeof command.request_id === "string" ? command.request_id : undefined }, async () => {
    const handler = handlers.get(command.type);
    if (!handler) {
      log.warn("Unknown command type", { type: command.type });
      emitEvent({
        type: "error",
        error: `Unknown command type: ${command.type}`,
        command_type: command.type,
      });
      return;
    }

    try {
      await handler(command);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("Command handler failed", { type: command.type, error: errorMessage });
      emitEvent({
        type: "error",
        error: errorMessage,
        command_type: command.type,
      });
      // For conversation commands, emit termination event so consumers (Gateway/App)
      // can reset busy state — the error event alone may not trigger a state reset
      if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
        emitEvent({ type: "agent_end", reason: "error", error: errorMessage });
      }
    }
  });
}

// ─── Command Queue ──────────────────────────────────────────────────────────────

/** POOL-001 fix: max queue depth to prevent unbounded growth */
const MAX_QUEUE_DEPTH = 100;
let queueDepth = 0;

/**
 * Command queue ensures sequential execution.
 * abort bypasses the queue to allow immediate interruption.
 */
let commandQueue: Promise<void> = Promise.resolve();

/** @internal — exported for testing */
export function enqueueCommand(command: RpcCommand): void {
  if (!command || typeof command !== "object" || Array.isArray(command)
    || typeof command.type !== "string" || !command.type.trim()) {
    emitEvent({ type: "error", error: "Command must be an object with a non-empty 'type' field" });
    return;
  }
  if (command.type === "switch_session" && command.read_only === true) {
    // History reads only persisted data; it must remain available during a long
    // prompt without waiting for, cancelling or switching the active Harness.
    void dispatchCommand(command);
    return;
  }
  if (command.type === "abort" || command.type === "steer" || command.type === "follow_up") {
    if (
      command.session_id !== undefined
      && (typeof command.session_id !== "string" || command.session_id.length === 0)
    ) {
      emitEvent({
        type: "error",
        error: `${command.type}.session_id must be a non-empty string when provided`,
        command_type: command.type,
      });
      return;
    }
    const requestedSessionId = typeof command.session_id === "string" ? command.session_id : undefined;
    if (isSessionTransitionInProgress()) {
      emitEvent({
        type: "error",
        error: `${command.type} is unavailable while a session transition is in progress`,
        command_type: command.type,
        ...(requestedSessionId ? { session_id: requestedSessionId } : {}),
      });
      return;
    }
    if (requestedSessionId && _currentSessionId && requestedSessionId !== _currentSessionId) {
      // Immediate conversation controls bypass the FIFO, so they must never be
      // allowed to mutate whichever other session currently owns the Harness.
      // Legacy single-session clients may continue omitting session_id.
      log.warn("Rejected immediate command for inactive session", {
        type: command.type,
        requestedSessionId,
        activeSessionId: _currentSessionId,
      });
      emitEvent({
        type: "error",
        error: `${command.type} targets inactive session '${requestedSessionId}'`,
        command_type: command.type,
        session_id: requestedSessionId,
      });
      return;
    }
  }
  if (command.type === "compact" && isCompactionInProgress()) {
    log.debug("Ignoring duplicate compact command while compaction is in progress");
    return;
  }
  if (command.type === "compact" && queueDepth > 0) {
    emitEvent({
      type: "compact_failed",
      reason: "error",
      message: "Manual context compaction requires an idle command queue",
      command_type: command.type,
    });
    return;
  }
  if (command.type === "abort" || command.type === "steer" || command.type === "follow_up") {
    if (isCompactionInProgress()) {
      emitEvent({
        type: "error",
        error: `${command.type} is unavailable while context compaction is in progress`,
        command_type: command.type,
      });
      return;
    }
    // abort/steer/follow_up bypass the queue:
    // - abort: allow immediate interruption of the current command
    //   CHAT-007: Also invalidates queued prompts that have not started.
    // - steer/follow_up: must execute while harness is in "turn" phase;
    //   queuing them would delay until phase="idle", causing phase check errors
    if (command.type === "abort") {
      // If a prompt is already running, harness.abort() handles it directly.
      // Every prompt already queued behind the current command belongs to the
      // pre-abort generation and must be skipped when it reaches the queue.
      abortQueueEpoch++;
    }
    void dispatchCommand(command);
  } else {
    // POOL-001: Backpressure — reject commands when queue is full
    if (queueDepth >= MAX_QUEUE_DEPTH) {
      log.warn("Command queue overflow, rejecting command", { type: command.type, queueDepth });
      emitEvent({ type: "error", error: "Command queue overflow — too many pending commands",
        command_type: command.type, request_id: command.request_id });
      return;
    }
    queueDepth++;
    const queuedAbortEpoch = abortQueueEpoch;
    // Other commands are queued to ensure FIFO execution order
    commandQueue = commandQueue
      .then(async () => {
        await dispatchCommand(command, queuedAbortEpoch);
      })
      .finally(() => queueDepth--)
      .catch((err) => {
        log.error("Command queue chain error", { error: String(err) });
      });
  }
}

// ─── Stdin JSONL Listener ─────────────────────────────────────────────────────

let rlInterface: ReturnType<typeof createInterface> | null = null;
let shutdownRequested = false;

/** Start listening for JSONL commands on stdin. */
export function startRpcLoop(): void {
  log.info("Starting RPC loop");

  rlInterface = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rlInterface.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let command: RpcCommand;
    try {
      command = JSON.parse(trimmed) as RpcCommand;
    } catch {
      log.warn("Failed to parse JSONL line", { line: trimmed.slice(0, 200) });
      emitEvent({
        type: "error",
        error: "Invalid JSON in command",
      });
      return;
    }

    enqueueCommand(command);
  });

  rlInterface.on("close", () => {
    log.info("Stdin closed, initiating shutdown");
    if (!shutdownRequested) {
      shutdownRequested = true;
      emitEvent({ type: "shutdown" });
    }
  });
}

/** Stop the RPC loop gracefully. */
export function stopRpcLoop(): void {
  log.info("Stopping RPC loop");
  shutdownRequested = true;
  if (rlInterface) {
    rlInterface.close();
    rlInterface = null;
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

let shutdownCallbacks: Array<() => Promise<void>> = [];

/** Register a shutdown callback for SIGTERM handling. Multiple callbacks are supported. */
export function onShutdown(callback: () => Promise<void>): void {
  shutdownCallbacks.push(callback);
}

/** Execute all registered shutdown callbacks (shared by command + signal paths).
 *  Re-entrancy guard: the shutdown command and SIGTERM/SIGINT can both fire
 *  (e.g. gateway sends shutdown then SIGTERMs) — callbacks must only run once. */
let _shutdownCallbacksStarted = false;
async function runShutdownCallbacks(): Promise<void> {
  if (_shutdownCallbacksStarted) return;
  _shutdownCallbacksStarted = true;
  for (const cb of shutdownCallbacks) {
    try { await cb(); } catch (err) {
      log.error("Shutdown callback error", { error: String(err) });
    }
  }
}

// ─── Built-in Command Handlers Registration ───────────────────────────────────

export interface RpcHandlerContext {
  onPrompt: (command: RpcCommand) => Promise<void>;
  onSteer: (command: RpcCommand) => Promise<void>;
  onFollowUp: (command: RpcCommand) => Promise<void>;
  onAbort: (command?: RpcCommand) => Promise<void>;
  onNewSession: (command: RpcCommand) => Promise<void>;
  onResumeSession: (command: RpcCommand) => Promise<void>;
  onListSessions: () => void;
  onSwitchSession: (command: RpcCommand) => Promise<void>;
  onGetState: () => void;
  onSetModel: (command: RpcCommand) => Promise<void>;
  onSetThinkingLevel: (command: RpcCommand) => Promise<void>;
  onCompact: (command: RpcCommand) => Promise<void>;
  onSetLlmProvider: (command: RpcCommand) => Promise<void>;
  onInstallSkill: (command: RpcCommand) => Promise<void>;
  onReloadConfig: () => Promise<void>;
  onRefreshModels?: (command: RpcCommand) => Promise<void>;
  onTestApiKey?: (command: RpcCommand) => Promise<void>;
  onInstallSkillFromGit?: (command: RpcCommand) => Promise<void>;
  onConfigureSkill?: (command: RpcCommand) => Promise<void>;
  onSaveSettings?: (command: RpcCommand) => Promise<void>;
  onResetSearchCache?: () => void;
  onLlmChat?: (command: RpcCommand) => Promise<void>;
  onGetMcpServers?: (command: RpcCommand) => Promise<void>;
  onSaveMcpServers?: (command: RpcCommand) => Promise<void>;
  onProbeMcpServer?: (command: RpcCommand) => Promise<void>;
  onReloadMcpServers?: (command: RpcCommand) => Promise<void>;
}

/** Register all built-in command handlers. */
export function registerBuiltinHandlers(ctx: RpcHandlerContext): void {
  // Universal agent commands
  registerHandler("prompt", ctx.onPrompt);
  registerHandler("steer", ctx.onSteer);
  registerHandler("follow_up", ctx.onFollowUp);
  registerHandler("abort", ctx.onAbort);
  registerHandler("new_session", ctx.onNewSession);
  registerHandler("resume_session", ctx.onResumeSession);
  registerHandler("list_sessions", () => ctx.onListSessions());
  registerHandler("switch_session", ctx.onSwitchSession);
  registerHandler("get_state", () => ctx.onGetState());
  registerHandler("set_model", ctx.onSetModel);
  registerHandler("set_thinking_level", ctx.onSetThinkingLevel);
  registerHandler("compact", ctx.onCompact);

  // Config commands
  registerHandler("set_llm_provider", ctx.onSetLlmProvider);
  registerHandler("install_skill", ctx.onInstallSkill);
  registerHandler("reload_config", ctx.onReloadConfig);

  // Extended WebUI commands
  if (ctx.onRefreshModels) registerHandler("refresh_models", ctx.onRefreshModels);
if (ctx.onTestApiKey) registerHandler("test_api_key", ctx.onTestApiKey);
  if (ctx.onInstallSkillFromGit) registerHandler("install_skill_from_git", ctx.onInstallSkillFromGit);
  if (ctx.onConfigureSkill) registerHandler("configure_skill", ctx.onConfigureSkill);
  if (ctx.onSaveSettings) registerHandler("save_settings", ctx.onSaveSettings);
  if (ctx.onResetSearchCache) {
    const handler = ctx.onResetSearchCache;
    registerHandler("reset_search_cache", () => handler());
  }
  if (ctx.onLlmChat) registerHandler("llm_chat", ctx.onLlmChat);
  if (ctx.onGetMcpServers) registerHandler("get_mcp_servers", ctx.onGetMcpServers);
  if (ctx.onSaveMcpServers) registerHandler("save_mcp_servers", ctx.onSaveMcpServers);
  if (ctx.onProbeMcpServer) registerHandler("probe_mcp_server", ctx.onProbeMcpServer);
  if (ctx.onReloadMcpServers) registerHandler("reload_mcp_servers", ctx.onReloadMcpServers);

  // Lifecycle commands
  registerHandler("shutdown", async () => {
    log.info("Shutdown command received");
    emitEvent({ type: "shutdown", reason: "command" });
    stopRpcLoop();
    // Bug 6 fix: Removed ctx.onShutdown() call — unified under runShutdownCallbacks()
    // Reason: ctx.onShutdown() and instance.shutdown() in runShutdownCallbacks() are the same callback,
    // dual invocation caused abort() + waitForIdle() + shutdownExtensions() to run twice
    await runShutdownCallbacks();
    process.stdout.write("", () => process.exit(0));
  });

  log.info("Built-in handlers registered");
}

// ─── Signal Handlers ─────────────────────────────────────────────────────────

/** Install SIGTERM handler for graceful shutdown. */
export function installSignalHandlers(): void {
  const handleSignal = async (signal: string) => {
    log.info("Signal received, shutting down", { signal });
    emitEvent({ type: "shutdown", reason: signal });
    stopRpcLoop();
    // Execute all shutdown callbacks in registration order
    await runShutdownCallbacks();
    // Ensure stdout buffer is flushed before exiting
    process.stdout.write("", () => process.exit(0));
  };

  process.on("SIGTERM", () => void handleSignal("SIGTERM"));
  process.on("SIGINT", () => void handleSignal("SIGINT"));
}
