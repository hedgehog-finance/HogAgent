/**
 * Ephemeral runtime context for orchestrator integrations.
 *
 * The three scopes deliberately live outside HogAgent configuration and
 * conversation storage:
 * - process: immutable for the lifetime of this OS process
 * - session: isolated by session_id and retained in memory only
 * - current_run: owned by one RPC `prompt` command (one Prompt Run)
 *
 * Consumers receive deep-frozen snapshots. Nothing in this module writes JSONL,
 * compaction summaries, or Long Task checkpoints.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isArtifactRunPolicy } from "./artifacts/artifact-policy.ts";
import type { ArtifactRunPolicy, Capabilities } from "./utils/types.ts";

const JsonValueSchema = Type.Recursive((self) => Type.Union([
  Type.Null(),
  Type.Boolean(),
  Type.Number(),
  Type.String(),
  Type.Array(self),
  Type.Record(Type.String(), self),
]));

const AttributesSchema = Type.Record(Type.String(), JsonValueSchema);

export const RUNTIME_CONTEXT_LIMITS = Object.freeze({
  maxJsonDepth: 16,
  processMaxBytes: 32 * 1024,
  sessionMaxBytes: 512 * 1024,
  currentRunMaxBytes: 64 * 1024,
  maxSessionContexts: 256,
});

export const ProcessRuntimeContextInputSchema = Type.Object({
  schema_version: Type.Literal("1.0"),
  attributes: Type.Optional(AttributesSchema),
}, { additionalProperties: false });

export const SessionRuntimeContextInputSchema = Type.Object({
  schema_version: Type.Literal("1.0"),
  project_id: Type.Optional(Type.String({ minLength: 1 })),
  project_dir: Type.Optional(Type.String({ minLength: 1 })),
  attributes: Type.Optional(AttributesSchema),
}, { additionalProperties: false });

export const CurrentRunContextInputSchema = Type.Object({
  schema_version: Type.Literal("1.0"),
  run_id: Type.Optional(Type.String({ minLength: 1 })),
  work_id: Type.Optional(Type.String({ minLength: 1 })),
  task_id: Type.Optional(Type.String({ minLength: 1 })),
  manifest_owner: Type.Optional(Type.Union([Type.Literal("gateway"), Type.Literal("hogagent")])),
  artifact_run_policy: Type.Optional(Type.Unknown()),
  attributes: Type.Optional(AttributesSchema),
}, { additionalProperties: false });

export type JsonValue = Static<typeof JsonValueSchema>;
export type RuntimeAttributes = Record<string, JsonValue>;
export type ProcessRuntimeContextInput = Static<typeof ProcessRuntimeContextInputSchema>;
export type SessionRuntimeContextInput = Static<typeof SessionRuntimeContextInputSchema>;
export type CurrentRunContextInput = Omit<Static<typeof CurrentRunContextInputSchema>, "artifact_run_policy"> & {
  artifact_run_policy?: ArtifactRunPolicy;
};

export interface ProcessRuntimeContext {
  schema_version: "1.0";
  process_instance_id: string;
  workspace_dir: string;
  mode: "interactive" | "rpc";
  platform: NodeJS.Platform;
  arch: string;
  user?: string;
  attributes: RuntimeAttributes;
}

export interface SessionRuntimeContext {
  schema_version: "1.0";
  session_id: string;
  workspace_dir: string;
  session_task_dir: string;
  revision: number;
  project_id?: string;
  project_dir?: string;
  attributes: RuntimeAttributes;
}

export interface CurrentRunContext {
  schema_version: "1.0";
  /** Unique cleanup token for this RPC prompt; never use as a business artifact ID. */
  prompt_run_id: string;
  run_id?: string;
  work_id?: string;
  task_id?: string;
  manifest_owner?: "gateway" | "hogagent";
  artifact_run_policy?: ArtifactRunPolicy;
  attributes: RuntimeAttributes;
}

export interface RuntimeContextSnapshot {
  process: ProcessRuntimeContext;
  session?: SessionRuntimeContext;
  current_run?: CurrentRunContext;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export class RuntimeContextValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeContextValidationError";
  }
}

/** One capability definition shared by native and Web ready events. */
export function getRuntimeContextCapability(): Capabilities["runtime_context"] {
  return {
    schema_version: "1.0",
    scopes: ["process", "session", "current_run"],
    transports: {
      process: ["cli_file", "programmatic"],
      session: ["new_session", "resume_session", "prompt"],
      current_run: ["prompt"],
    },
    session_persistence: "memory_only",
    session_eviction: "lru_inactive",
    legacy_prompt_metadata: true,
    attributes_model_visible: true,
    limits: {
      max_json_depth: RUNTIME_CONTEXT_LIMITS.maxJsonDepth,
      process_max_bytes: RUNTIME_CONTEXT_LIMITS.processMaxBytes,
      session_max_bytes: RUNTIME_CONTEXT_LIMITS.sessionMaxBytes,
      current_run_max_bytes: RUNTIME_CONTEXT_LIMITS.currentRunMaxBytes,
      max_session_contexts: RUNTIME_CONTEXT_LIMITS.maxSessionContexts,
    },
  };
}

interface JsonTreeInspection {
  valid: boolean;
  depth: number;
}

function inspectPlainJsonTree(
  value: unknown,
  ancestors = new WeakSet<object>(),
  parentDepth = 0,
): JsonTreeInspection {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { valid: true, depth: 0 };
  }
  if (typeof value === "number") return { valid: Number.isFinite(value), depth: 0 };
  if (typeof value !== "object") return { valid: false, depth: 0 };

  const object = value as object;
  if (ancestors.has(object)) return { valid: false, depth: 0 };
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(object);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    return { valid: false, depth: 0 };
  }

  const objectDepth = parentDepth + 1;
  // Stop descending as soon as the configured boundary is crossed. Besides
  // producing a clearer validation error, this prevents hostile programmatic
  // inputs from exhausting the JavaScript call stack before depth validation.
  if (objectDepth > RUNTIME_CONTEXT_LIMITS.maxJsonDepth) {
    return { valid: true, depth: objectDepth };
  }

  ancestors.add(object);
  let maximumDepth = objectDepth;
  for (const key of Reflect.ownKeys(object)) {
    if (isArray && key === "length") continue;
    if (typeof key !== "string" || (isArray && !/^(0|[1-9]\d*)$/.test(key))) {
      return { valid: false, depth: 0 };
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return { valid: false, depth: 0 };
    const inspected = inspectPlainJsonTree(descriptor.value, ancestors, objectDepth);
    if (!inspected.valid) return inspected;
    maximumDepth = Math.max(maximumDepth, inspected.depth);
    if (maximumDepth > RUNTIME_CONTEXT_LIMITS.maxJsonDepth) {
      ancestors.delete(object);
      return { valid: true, depth: maximumDepth };
    }
  }
  ancestors.delete(object);
  return { valid: true, depth: maximumDepth };
}

function validate<T>(
  schema: TSchema,
  value: unknown,
  label: string,
  maxBytes: number,
): T {
  // TypeBox Record accepts some class instances with no enumerable fields
  // (for example Map). Reject those before cloning/serialization can silently
  // change their meaning, and reject cycles/accessors that JSON cannot represent.
  const inspected = inspectPlainJsonTree(value);
  if (!inspected.valid) {
    throw new RuntimeContextValidationError(`${label} is invalid (must be plain JSON data)`);
  }
  if (inspected.depth > RUNTIME_CONTEXT_LIMITS.maxJsonDepth) {
    throw new RuntimeContextValidationError(
      `${label} exceeds maximum JSON depth of ${RUNTIME_CONTEXT_LIMITS.maxJsonDepth}`,
    );
  }
  const encodedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (encodedBytes > maxBytes) {
    throw new RuntimeContextValidationError(
      `${label} exceeds maximum encoded size of ${maxBytes} bytes`,
    );
  }
  if (!Value.Check(schema, value)) {
    const first = Value.Errors(schema, value).First();
    const detail = first ? `${first.path || "/"}: ${first.message}` : "invalid value";
    throw new RuntimeContextValidationError(`${label} is invalid (${detail})`);
  }
  return structuredClone(value) as T;
}

function normalizeAttributes(
  attributes: RuntimeAttributes | DeepReadonly<RuntimeAttributes> | undefined,
): RuntimeAttributes {
  return attributes ? structuredClone(attributes) as RuntimeAttributes : {};
}

export function parseProcessRuntimeContextInput(value: unknown): ProcessRuntimeContextInput {
  const parsed = validate<ProcessRuntimeContextInput>(
    ProcessRuntimeContextInputSchema,
    value,
    "process runtime context",
    RUNTIME_CONTEXT_LIMITS.processMaxBytes,
  );
  return { ...parsed, attributes: normalizeAttributes(parsed.attributes) };
}

export function parseSessionRuntimeContextInput(value: unknown): SessionRuntimeContextInput {
  const parsed = validate<SessionRuntimeContextInput>(
    SessionRuntimeContextInputSchema,
    value,
    "session_context",
    RUNTIME_CONTEXT_LIMITS.sessionMaxBytes,
  );
  if (parsed.project_dir && !isAbsolute(parsed.project_dir)) {
    throw new RuntimeContextValidationError("session_context.project_dir must be an absolute path");
  }
  return { ...parsed, attributes: normalizeAttributes(parsed.attributes) };
}

export function parseCurrentRunContextInput(value: unknown): CurrentRunContextInput {
  const parsed = validate<Static<typeof CurrentRunContextInputSchema>>(
    CurrentRunContextInputSchema,
    value,
    "run_context",
    RUNTIME_CONTEXT_LIMITS.currentRunMaxBytes,
  );
  if (parsed.artifact_run_policy !== undefined && !isArtifactRunPolicy(parsed.artifact_run_policy)) {
    throw new RuntimeContextValidationError("run_context.artifact_run_policy is invalid");
  }
  const { artifact_run_policy: artifactRunPolicy, ...rest } = parsed;
  return {
    ...rest,
    ...(artifactRunPolicy !== undefined
      ? { artifact_run_policy: artifactRunPolicy as ArtifactRunPolicy }
      : {}),
    attributes: normalizeAttributes(parsed.attributes),
  };
}

export function loadProcessRuntimeContextInput(options: {
  value?: ProcessRuntimeContextInput;
  filePath?: string;
}): ProcessRuntimeContextInput | undefined {
  if (options.value !== undefined && options.filePath !== undefined) {
    throw new RuntimeContextValidationError(
      "Specify either processRuntimeContext or runtimeContextFile, not both",
    );
  }
  if (options.value !== undefined) return parseProcessRuntimeContextInput(options.value);
  if (options.filePath === undefined) return undefined;
  if (!isAbsolute(options.filePath)) {
    throw new RuntimeContextValidationError("--runtime-context-file requires an absolute path");
  }
  let value: unknown;
  try {
    const fileSize = statSync(options.filePath).size;
    if (fileSize > RUNTIME_CONTEXT_LIMITS.processMaxBytes) {
      throw new RuntimeContextValidationError(
        `process runtime context file exceeds maximum size of ${RUNTIME_CONTEXT_LIMITS.processMaxBytes} bytes`,
      );
    }
    const source = readFileSync(options.filePath, "utf-8");
    // Recheck the bytes actually read to close the stat/read race and to keep
    // whitespace-heavy input files within the same transport limit.
    if (Buffer.byteLength(source, "utf8") > RUNTIME_CONTEXT_LIMITS.processMaxBytes) {
      throw new RuntimeContextValidationError(
        `process runtime context file exceeds maximum size of ${RUNTIME_CONTEXT_LIMITS.processMaxBytes} bytes`,
      );
    }
    value = JSON.parse(source);
  } catch (error) {
    if (error instanceof RuntimeContextValidationError) throw error;
    throw new RuntimeContextValidationError(
      `Unable to read process runtime context file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseProcessRuntimeContextInput(value);
}

function assertCompatible(field: string, explicit: unknown, legacy: unknown): void {
  if (explicit !== undefined && legacy !== undefined && !isDeepStrictEqual(explicit, legacy)) {
    throw new RuntimeContextValidationError(
      `Conflicting values for ${field} in native runtime context and legacy metadata`,
    );
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Resolve native prompt fields and the supported legacy metadata projection. */
export function resolvePromptRuntimeContextInputs(options: {
  sessionContext?: unknown;
  runContext?: unknown;
  metadata?: unknown;
  previousSession?: SessionRuntimeContextInput;
}): {
  session?: SessionRuntimeContextInput;
  run: CurrentRunContextInput;
} {
  const metadata = options.metadata && typeof options.metadata === "object"
    ? options.metadata as Record<string, unknown>
    : {};
  const explicitSession = options.sessionContext === undefined
    ? undefined
    : parseSessionRuntimeContextInput(options.sessionContext);
  const explicitRun = options.runContext === undefined
    ? undefined
    : parseCurrentRunContextInput(options.runContext);

  const legacyProjectId = nonEmptyString(metadata.project_id);
  const legacyProjectDir = nonEmptyString(metadata.project_dir);
  assertCompatible("project_id", explicitSession?.project_id, legacyProjectId);
  assertCompatible("project_dir", explicitSession?.project_dir, legacyProjectDir);

  const hasLegacySession = legacyProjectId !== undefined || legacyProjectDir !== undefined;
  let session: SessionRuntimeContextInput | undefined;
  if (explicitSession) {
    session = {
      ...explicitSession,
      project_id: explicitSession.project_id ?? legacyProjectId,
      project_dir: explicitSession.project_dir ?? legacyProjectDir,
    };
  } else if (hasLegacySession) {
    session = {
      schema_version: "1.0",
      ...options.previousSession,
      ...(legacyProjectId ? { project_id: legacyProjectId } : {}),
      ...(legacyProjectDir ? { project_dir: legacyProjectDir } : {}),
      attributes: normalizeAttributes(options.previousSession?.attributes),
    };
  }

  const legacyRun = {
    work_id: nonEmptyString(metadata.work_id),
    task_id: nonEmptyString(metadata.task_id),
    manifest_owner: metadata.manifest_owner === "gateway" || metadata.manifest_owner === "hogagent"
      ? metadata.manifest_owner
      : undefined,
    artifact_run_policy: isArtifactRunPolicy(metadata.artifact_run_policy)
      ? metadata.artifact_run_policy
      : undefined,
  } satisfies Partial<CurrentRunContextInput>;

  assertCompatible("work_id", explicitRun?.work_id, legacyRun.work_id);
  assertCompatible("task_id", explicitRun?.task_id, legacyRun.task_id);
  assertCompatible("manifest_owner", explicitRun?.manifest_owner, legacyRun.manifest_owner);
  assertCompatible("artifact_run_policy", explicitRun?.artifact_run_policy, legacyRun.artifact_run_policy);

  const workId = explicitRun?.work_id ?? legacyRun.work_id;
  const taskId = explicitRun?.task_id ?? legacyRun.task_id;
  const manifestOwner = explicitRun?.manifest_owner ?? legacyRun.manifest_owner;
  const artifactRunPolicy = explicitRun?.artifact_run_policy ?? legacyRun.artifact_run_policy;
  return {
    session,
    run: {
      schema_version: "1.0",
      ...(explicitRun?.run_id ? { run_id: explicitRun.run_id } : {}),
      ...(workId ? { work_id: workId } : {}),
      ...(taskId ? { task_id: taskId } : {}),
      ...(manifestOwner ? { manifest_owner: manifestOwner } : {}),
      ...(artifactRunPolicy ? { artifact_run_policy: artifactRunPolicy } : {}),
      attributes: normalizeAttributes(explicitRun?.attributes),
    },
  };
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value as DeepReadonly<T>;
}

function frozenClone<T>(value: T): DeepReadonly<T> {
  return deepFreeze(structuredClone(value));
}

export class RuntimeContextManager {
  private readonly processContext: DeepReadonly<ProcessRuntimeContext>;
  private readonly sessions = new Map<string, DeepReadonly<SessionRuntimeContext>>();
  private activeSessionId?: string;
  private currentRun?: DeepReadonly<CurrentRunContext>;
  private readonly maxSessionContexts: number;

  constructor(options: {
    workspaceDir: string;
    mode: "interactive" | "rpc";
    user?: string;
    processContext?: ProcessRuntimeContextInput;
    /** Test/internal override; advertised integrations use the default limit. */
    maxSessionContexts?: number;
  }) {
    this.maxSessionContexts = options.maxSessionContexts ?? RUNTIME_CONTEXT_LIMITS.maxSessionContexts;
    if (!Number.isInteger(this.maxSessionContexts) || this.maxSessionContexts < 1) {
      throw new RuntimeContextValidationError("maxSessionContexts must be a positive integer");
    }
    const processInput = options.processContext
      ? parseProcessRuntimeContextInput(options.processContext)
      : { schema_version: "1.0" as const, attributes: {} };
    this.processContext = frozenClone({
      schema_version: "1.0",
      process_instance_id: randomUUID(),
      workspace_dir: options.workspaceDir,
      mode: options.mode,
      platform: process.platform,
      arch: process.arch,
      ...(options.user ? { user: options.user } : {}),
      attributes: normalizeAttributes(processInput.attributes),
    });
  }

  /** Bind or activate a session. Revisions change only when semantic content changes. */
  bindSession(
    sessionId: string,
    sessionTaskDir: string,
    input?: SessionRuntimeContextInput,
  ): DeepReadonly<SessionRuntimeContext> {
    if (this.currentRun && sessionId !== this.activeSessionId) {
      throw new Error("Cannot activate another session while a Prompt Run is active");
    }
    const previous = this.sessions.get(sessionId);
    const parsed = input ? parseSessionRuntimeContextInput(input) : undefined;
    const candidate = {
      schema_version: "1.0" as const,
      session_id: sessionId,
      workspace_dir: this.processContext.workspace_dir,
      session_task_dir: sessionTaskDir,
      project_id: parsed ? parsed.project_id : previous?.project_id,
      project_dir: parsed ? parsed.project_dir : previous?.project_dir,
      attributes: parsed ? normalizeAttributes(parsed.attributes) : normalizeAttributes(previous?.attributes),
    };
    const previousComparable = previous && {
      schema_version: previous.schema_version,
      session_id: previous.session_id,
      workspace_dir: previous.workspace_dir,
      session_task_dir: previous.session_task_dir,
      project_id: previous.project_id,
      project_dir: previous.project_dir,
      attributes: previous.attributes,
    };
    const revision = previous && isDeepStrictEqual(previousComparable, candidate)
      ? previous.revision
      : (previous?.revision ?? 0) + 1;
    const bound = frozenClone({ ...candidate, revision });

    // Map insertion order is the LRU order. A rebind is a touch. When adding a
    // new session, evict only a context that will be inactive after this bind;
    // an active Prompt Run is never displaced.
    if (!previous && this.sessions.size >= this.maxSessionContexts) {
      const protectedSessionId = this.currentRun ? this.activeSessionId : undefined;
      let evictableSessionId: string | undefined;
      for (const id of this.sessions.keys()) {
        if (id !== sessionId && id !== protectedSessionId) {
          evictableSessionId = id;
          break;
        }
      }
      if (!evictableSessionId) {
        throw new Error(`Runtime session context capacity (${this.maxSessionContexts}) is exhausted`);
      }
      this.sessions.delete(evictableSessionId);
    }
    if (previous) this.sessions.delete(sessionId);
    this.sessions.set(sessionId, bound);
    this.activeSessionId = sessionId;
    return bound;
  }

  getSessionInput(sessionId: string): SessionRuntimeContextInput | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return structuredClone({
      schema_version: "1.0",
      ...(session.project_id ? { project_id: session.project_id } : {}),
      ...(session.project_dir ? { project_dir: session.project_dir } : {}),
      attributes: structuredClone(session.attributes) as RuntimeAttributes,
    });
  }

  /**
   * Begin one HogAgent Prompt Run: the complete processing lifetime of one RPC
   * `prompt`, which may contain many Harness turns and LLM/tool calls.
   */
  beginPromptRun(input: CurrentRunContextInput): string {
    if (this.currentRun) {
      throw new Error(`Prompt Run ${this.currentRun.prompt_run_id} is still active`);
    }
    if (!this.activeSessionId) {
      throw new Error("Cannot begin a Prompt Run without an active session context");
    }
    const parsed = parseCurrentRunContextInput(input);
    const promptRunId = randomUUID();
    this.currentRun = frozenClone({
      ...parsed,
      schema_version: "1.0",
      prompt_run_id: promptRunId,
      attributes: normalizeAttributes(parsed.attributes),
    });
    return promptRunId;
  }

  /** A stale token cannot clear a newer run. */
  endPromptRun(promptRunId: string): boolean {
    if (this.currentRun?.prompt_run_id !== promptRunId) return false;
    this.currentRun = undefined;
    return true;
  }

  getSnapshot(): DeepReadonly<RuntimeContextSnapshot> {
    return frozenClone({
      process: this.processContext,
      ...(this.activeSessionId && this.sessions.get(this.activeSessionId)
        ? { session: this.sessions.get(this.activeSessionId)! }
        : {}),
      ...(this.currentRun ? { current_run: this.currentRun } : {}),
    });
  }
}

/** Runtime context is a system-prompt segment, never a synthetic history message. */
export function formatRuntimeContextForModel(
  snapshot: DeepReadonly<RuntimeContextSnapshot> | undefined,
): string {
  if (!snapshot) return "";
  // Keep this as an explicit allowlist. Internal lifecycle fields such as
  // prompt_run_id are available to extensions but must not become model input.
  const modelCurrentRun = snapshot.current_run ? {
    schema_version: snapshot.current_run.schema_version,
    ...(snapshot.current_run.run_id ? { run_id: snapshot.current_run.run_id } : {}),
    ...(snapshot.current_run.work_id ? { work_id: snapshot.current_run.work_id } : {}),
    ...(snapshot.current_run.task_id ? { task_id: snapshot.current_run.task_id } : {}),
    ...(snapshot.current_run.manifest_owner
      ? { manifest_owner: snapshot.current_run.manifest_owner }
      : {}),
    ...(snapshot.current_run.artifact_run_policy
      ? { artifact_run_policy: snapshot.current_run.artifact_run_policy }
      : {}),
    ...(Object.keys(snapshot.current_run.attributes).length > 0
      ? { attributes: snapshot.current_run.attributes }
      : {}),
  } : undefined;
  const modelContext = {
    schema_version: "1.0",
    process: {
      process_instance_id: snapshot.process.process_instance_id,
      workspace_dir: snapshot.process.workspace_dir,
      ...(snapshot.process.user ? { user: snapshot.process.user } : {}),
      ...(Object.keys(snapshot.process.attributes).length > 0
        ? { attributes: snapshot.process.attributes }
        : {}),
    },
    ...(snapshot.session ? {
      session: {
        session_id: snapshot.session.session_id,
        workspace_dir: snapshot.session.workspace_dir,
        session_task_dir: snapshot.session.session_task_dir,
        revision: snapshot.session.revision,
        ...(snapshot.session.project_id ? { project_id: snapshot.session.project_id } : {}),
        ...(snapshot.session.project_dir ? { project_dir: snapshot.session.project_dir } : {}),
        ...(Object.keys(snapshot.session.attributes).length > 0
          ? { attributes: snapshot.session.attributes }
          : {}),
      },
    } : {}),
    ...(modelCurrentRun ? { current_run: modelCurrentRun } : {}),
  };
  const json = JSON.stringify(modelContext)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  return `\n\n<runtime_context>\n${json}\n</runtime_context>`;
}

/** Build model-visible context for a history-free internal LLM call. */
export function formatIsolatedRunContextForModel(
  processContext: DeepReadonly<ProcessRuntimeContext>,
  input: unknown,
): string {
  if (input === undefined) return "";
  const run = parseCurrentRunContextInput(input);
  return formatRuntimeContextForModel({
    process: processContext,
    current_run: {
      ...run,
      prompt_run_id: randomUUID(),
      attributes: normalizeAttributes(run.attributes),
    },
  });
}
