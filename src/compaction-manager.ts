import type { AgentHarness } from "./vendor/agent/harness/agent-harness.ts";
import { compact } from "./vendor/agent/base.ts";
import type { SessionBeforeCompactEvent } from "./vendor/agent/harness/types.ts";
import type { RpcEvent } from "./utils/types.ts";
import type { LlmAuth } from "./llm-auth.ts";

export const COMPACTION_TIMEOUT_MS = 5 * 60 * 1000;

let activeCompactionCount = 0;

/** One HogAgent RPC process owns one interactive session at a time. */
export function isCompactionInProgress(): boolean {
  return activeCompactionCount > 0;
}

export interface CompactionOutcome {
  status: "completed" | "skipped";
}

export class CompactionOperationError extends Error {
  readonly reason = "error" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CompactionOperationError";
  }
}

/** A Long Task must stop instead of treating a failed context check as a failed group. */
export class ContextCompactionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ContextCompactionError";
  }
}

interface ActiveCompaction {
  promise: Promise<CompactionOutcome>;
}

interface RunCompactionOptions {
  harness: AgentHarness;
  emitEvent: (event: RpcEvent) => void;
  resolveAuth: (model: ReturnType<AgentHarness["getModel"]>) => Promise<LlmAuth>;
}

function isNothingToCompact(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Nothing to compact");
}

function operationError(error: unknown): CompactionOperationError {
  let current = error;
  while (current instanceof Error) {
    if (current instanceof CompactionOperationError) return current;
    if (!current.cause || current.cause === current) break;
    current = current.cause;
  }
  return new CompactionOperationError(
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

/** Adds a bounded provider request around vendor compaction without changing vendor code. */
export class CompactionManager {
  private readonly activeByHarness = new WeakMap<AgentHarness, ActiveCompaction>();

  run(options: RunCompactionOptions): Promise<CompactionOutcome> {
    const existing = this.activeByHarness.get(options.harness);
    if (existing) return existing.promise;

    const controller = new AbortController();
    let rejectBoundary: ((error: CompactionOperationError) => void) | undefined;
    let boundarySettled = false;
    const boundary = new Promise<never>((_resolve, reject) => {
      rejectBoundary = reject;
    });
    void boundary.catch(() => undefined);
    const failBoundary = (failure: CompactionOperationError): void => {
      if (boundarySettled) return;
      controller.abort(failure);
      rejectBoundary?.(failure);
    };
    activeCompactionCount++;
    const promise = this.execute(options, controller, boundary, failBoundary)
      .finally(() => {
        boundarySettled = true;
        this.activeByHarness.delete(options.harness);
        activeCompactionCount--;
      });

    this.activeByHarness.set(options.harness, { promise });
    return promise;
  }

  private async execute(
    options: RunCompactionOptions,
    controller: AbortController,
    boundary: Promise<never>,
    failBoundary: (failure: CompactionOperationError) => void,
  ): Promise<CompactionOutcome> {
    const { harness, emitEvent, resolveAuth } = options;
    emitEvent({ type: "compact_started" });

    const removeHook = harness.on("session_before_compact", async (event: SessionBeforeCompactEvent) => {
      const timeout = setTimeout(() => failBoundary(new CompactionOperationError(
        `Context compaction exceeded ${COMPACTION_TIMEOUT_MS / 60000} minutes`,
      )), COMPACTION_TIMEOUT_MS);
      try {
        const model = harness.getModel();
        const authPromise = resolveAuth(model);
        void authPromise.catch(() => undefined);
        const auth = await Promise.race([authPromise, boundary]);
        const providerPromise = compact(
          event.preparation,
          model,
          auth.apiKey,
          auth.headers,
          event.customInstructions,
          controller.signal,
          harness.getThinkingLevel(),
        ).then((result) => {
          if (!result.ok) throw result.error;
          return result.value;
        });

        // Some providers may ignore AbortSignal. Consume their late rejection and
        // let only the race winner return a value to Harness for persistence.
        void providerPromise.catch(() => undefined);
        const compaction = await Promise.race([providerPromise, boundary]);
        return { compaction };
      } finally {
        clearTimeout(timeout);
      }
    });

    try {
      const result = await harness.compact();
      const outcome: CompactionOutcome = { status: "completed" };
      emitEvent({
        type: "compact_completed",
        summary_length: result.summary.length,
        tokens_before: result.tokensBefore,
      });
      return outcome;
    } catch (error) {
      const signalledFailure = controller.signal.reason instanceof CompactionOperationError
        ? controller.signal.reason
        : undefined;
      if (error instanceof CompactionOperationError || signalledFailure) {
        const failure = signalledFailure ?? error as CompactionOperationError;
        emitEvent({
          type: "compact_failed",
          reason: failure.reason,
          message: failure.message,
        });
        throw failure;
      }
      if (isNothingToCompact(error)) {
        const outcome: CompactionOutcome = { status: "skipped" };
        emitEvent({
          type: "compact_completed",
          status: "skipped",
        });
        return outcome;
      }
      const failure = operationError(error);
      emitEvent({
        type: "compact_failed",
        reason: failure.reason,
        message: failure.message,
      });
      throw failure;
    } finally {
      removeHook();
    }
  }
}
