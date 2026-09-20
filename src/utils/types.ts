/**
 * HogAgent Core Type Definitions
 *
 * All core interfaces and types for the HogAgent unified AI agent engine.
 */

import type { AgentHarness } from "../vendor/agent/harness/agent-harness.ts";

// ─── Extension System ─────────────────────────────────────────────────────────

/** Extension interface for HogAgent plugins. */
export interface IExtension {
  name: string;
  version: string;
  initialize(context: HogAgentContext, config?: unknown): Promise<void>;
  /** Awaited before a terminal agent_end event is emitted for the current run. */
  beforeAgentEnd?(): Promise<void>;
  /** Awaited when the active Agent run is aborted. */
  onAgentAbort?(): Promise<void>;
  shutdown?(): Promise<void>;
  /**
   * Called after new_session/resume_session replaces the AgentHarness instance.
   * Extensions holding harness event hooks (e.g. tool_result interceptors) must
   * re-attach them to the new harness here — hooks on the old harness are dead.
   */
  onHarnessReplaced?(harness: AgentHarness): void | Promise<void>;
  /**
   * Called when the extension's persisted config changes at runtime
   * (save_settings). Lets loaded extensions apply new settings without a
   * process restart. Extensions disabled at startup are never loaded, so
   * enabling one still requires a restart.
   */
  applyConfigUpdate?(enabled: boolean, config?: unknown): void | Promise<void>;
}

/** Agent context passed to extensions for registration and interaction. */
export interface HogAgentContext {
  /** Register one tool or an array of related tools with one Harness update. */
  registerTool(
    tool: unknown,
    registration?: import("../tool-registry.ts").AgentToolRegistration,
  ): Promise<void>;
  /** Remove a related group with one Harness update; single-tool calls remain supported. */
  unregisterTool(name: string, ...additionalNames: string[]): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => void): () => void;
  emitEvent(event: RpcEvent): void;
  getConfig(): HogAgentConfig;
  getSessionId(): string;
  getWorkspaceDir(): string;
  getHarness(): AgentHarness;
  captureDeliveryWriter?(): (result: import("../artifacts/file-delivery.ts").DeliveryResult) => Promise<void>;
  readDeliveryHistory?(): Promise<import("../artifacts/file-delivery.ts").DeliveryResult[]>;
  /** Get the shared LLM tracking context (session_id / work_id / task_id) */
  getLlmTracking(): import("../llm-metadata-hook.ts").LlmTrackingContext;
  /** Deep read-only snapshot of process, active session, and current Prompt Run context. */
  getRuntimeContext(): import("../runtime-context.ts").DeepReadonly<import("../runtime-context.ts").RuntimeContextSnapshot>;
}

// ─── RPC Protocol ─────────────────────────────────────────────────────────────

/** RPC Command (orchestrator → HogAgent via stdin). */
export interface RpcCommand {
  type: string;
  [key: string]: unknown;
}

/** RPC Event (HogAgent → orchestrator via stdout). */
export interface RpcEvent {
  type: string;
  /** Current session ID, auto-injected by emitEvent (explicit value takes priority) */
  session_id?: string;
  timestamp?: string;
  [key: string]: unknown;
}

// ─── Audit Model ─────────────────────────────────────────────────────────────

/** Audit model configuration */
export interface AuditModelConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  modelId: string;
  minPassScore: number;   // Minimum passing score, default 70
  maxIterations: number;  // Maximum retry count, default 2
}

/** Conversation mode (audit model classification result) */
export type ConversationMode = "quick" | "standard" | "long_task";

/** Audit classification result (only used in long_task mode) */
export interface AuditClassification {
  optimizedPrompt: string;      // Optimized prompt
  goals: string[];              // Goal list (empty for simple tasks)
  acceptanceCriteria: string[]; // Acceptance criteria (empty for simple tasks)
  /** Task complexity: "simple" → direct LLM dialogue, "complex" → full orchestration */
  complexity: "simple" | "complex";
  /** When true, task is clear enough — skip pre-planning clarification questions */
  skipClarification: boolean;
  /** Clarification questions to ask the user before planning (when skipClarification=false) */
  clarificationQuestions?: string[];
}

/** Fixed config entry for each skill in skills-config.json */
export interface SkillConfigEntry {
  "api-key"?: string;
  "is-long-task-specific"?: boolean;
  [key: string]: unknown;
}

/** Audit scoring result */
export interface ScoreResult {
  score: number;
  passed: boolean;
  /** No verdict was obtained; score is a placeholder, not a verified grade. */
  skipped?: boolean;
  feedback: string;
  retryFrom: string | null;
}

// ─── Mode Metadata (persisted to sessionTaskDir/mode.json) ────────────────────

/** Audit result entry returned by audit Harness */
export interface AuditResultEntry extends ScoreResult {
  phase: "checkpoint" | "final";
  groupId?: string;
  timestamp: string;
}

/** Session mode metadata (persisted after each classification) */
export interface ModeMetadata {
  mode: ConversationMode;
  optimizedPrompt: string;
  goals?: string[];
  acceptanceCriteria?: string[];
  /** Task complexity from the latest classification */
  complexity?: "simple" | "complex";
  createdAt: string;
  auditResults?: AuditResultEntry[];
  /** First optimizedPrompt ever written — never overwritten once set */
  firstOptimizedPrompt?: string;
  /** First goals array ever written — never overwritten once set */
  firstGoals?: string[];
  /** Rolling history of optimizedPrompts (latest 10 entries, FIFO) */
  optimizedPromptHistory?: string[];
  /** Original user inputs before audit LLM optimization (long_task only, max 20 FIFO) */
  originalUserMessages?: string[];
  /** Number of assistant messages produced during internalMode=true (orchestration statistics).
   *  Not a message position or history presentation boundary. */
  complexAssistantCount?: number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

/** Context compaction configuration (stored in llm-settings.json compaction section) */
export interface CompactionConfig {
  /** Auto-compaction trigger threshold: triggered when context usage ratio reaches this value (0~1, default 0.75) */
  autoCompactThreshold: number;
}

/** Top-level HogAgent configuration. */
export interface HogAgentConfig {
  mode: "interactive" | "rpc";
  sessionId: string;
  workspaceDir: string;
  /** Session-scoped working and conversation-delivery directory: <workspace>/tasks/<session-id>/ */
  sessionTaskDir: string;
  /** Authoritative project directory resolved for the current run. Highest priority for project file operations. */
  projectDir?: string;
  /** Runtime-only Manifest ownership and update choice supplied by the orchestrator. */
  manifestOwner?: "gateway" | "hogagent";
  projectId?: string;
  /** Read-only run policy. User-protocol values are locked; contextual defaults are LLM-overridable. */
  artifactRunPolicy?: ArtifactRunPolicy;
  /** Mutable artifact bookkeeping owned by exactly one prompt/run. */
  artifactRunState?: ArtifactRunState;
  llmProvider: LlmProviderConfig;
  extensions: ExtensionConfig[];
  auditModel?: AuditModelConfig;
  compaction: CompactionConfig;
  /** UI theme key (from user_settings.json), default "fintech" */
  theme?: string;
  /** User identifier (from CLI --user) */
  user?: string;
  /** Memory system configuration (from hogagent.json) */
  memory?: MemoryConfig;
}

export interface ArtifactRunState {
  manifestOwner: "hogagent" | "gateway";
  runId: string;
  createdPaths: Set<string>;
  versionTargets: Map<string, string>;
  sessionId: string;
  roots: string[];
  baselines: Map<string, import("../artifacts/artifact-file-facts.ts").ArtifactBaseline>;
  baselineError?: string;
  reconcileStatus: "pending" | "success" | "failed";
  currentChanges: Map<string, Set<string>>;
  invalidDeliverySelection?: boolean;
  explicitFiles?: Array<{ path: string; summary?: string }>;
  deliveryDecision?: DeliveryDecision;
}

export type DeliveryMode = "none" | "deliverables" | "raw_data" | "selected_files";
export type ArtifactUpdateMode = "in_place" | "new_version";

export interface DeliveryDecision {
  schema_version: "1.0";
  type: "delivery_decision";
  mode: DeliveryMode;
  files?: Array<{ path: string; summary?: string }>;
}

export interface ArtifactRunPolicy {
  schema_version: "1.0";
  delivery: {
    mode: DeliveryMode;
    locked: boolean;
    source: "system_default" | "user_protocol";
    files: string[];
  };
  mutation: {
    mode: "contextual" | ArtifactUpdateMode;
    locked: boolean;
    source: "system_default" | "user_protocol";
  };
}

/** LLM provider configuration. */
export interface LlmProviderConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  models: ModelConfig[];
}

/** Model configuration entry. */
export interface ModelConfig {
  id: string;
  name: string;
  contextWindow: number;
}

/** Extension configuration entry. */
export interface ExtensionConfig {
  name: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

/** Memory system configuration (stored in hogagent.json memory field). */
export interface MemoryConfig {
  /** Whether the memory extension is enabled */
  enabled: boolean;
  /** Gateway KB MCP Server URL (e.g. "http://127.0.0.1:59101") */
  mcpKbUrl?: string;
}

// ─── Capabilities ─────────────────────────────────────────────────────────────

/** Capabilities reported in the ready event. */
export interface Capabilities {
  extensions: string[];
  builtin_tools: string[];
  installed_skills: string[];
  supports_compaction: boolean;
  supports_sub_agent: boolean;
  supports_llm_chat: boolean;
  /** Gateway-owned project binding plus the process-owned shared projects directory. */
  supports_gateway_projects?: boolean;
  /** Read-only history bypasses Prompt execution without changing the Harness. */
  supports_concurrent_history_read?: boolean;
  /** Native, hidden runtime-context injection supported by this process. */
  runtime_context: {
    schema_version: "1.0";
    scopes: ["process", "session", "current_run"];
    transports: {
      process: ["cli_file", "programmatic"];
      session: ["new_session", "resume_session", "prompt"];
      current_run: ["prompt"];
    };
    session_persistence: "memory_only";
    session_eviction: "lru_inactive";
    legacy_prompt_metadata: true;
    attributes_model_visible: true;
    limits: {
      max_json_depth: number;
      process_max_bytes: number;
      session_max_bytes: number;
      current_run_max_bytes: number;
      max_session_contexts: number;
    };
  };
  llmProvider?: {
    provider: string;
    apiKey?: string;
    baseUrl: string;
    models?: ModelConfig[];
  };
  currentModel?: string;
  thinkingLevel?: string;
  /** Quick-mode thinking depth override (default "off") */
  quickThinkingLevel?: string;
  auditModel?: {
    provider?: string;
    modelId?: string;
    baseUrl?: string;
    apiKey?: string;
    minPassScore?: number;
    maxIterations?: number;
    configured: boolean;
  };
  /** Explicit cache toggle state (from ~/.hogagent/hogagent.json) */
  explicitCache?: boolean;
  /** System config values exposed to frontend (from ~/.hogagent/hogagent.json) */
  systemConfig?: {
    /** Bash sandbox policy: strict, fallback to direct shell, or direct shell. */
    sandboxMode: "enabled" | "fallback" | "disabled";
    explicitCache: boolean;
    showCacheStats: boolean;
    compressorEnabled: boolean;
    compressThreshold: number;
    subagentMaxTurns: number;
    /** Enable cross-session persistent memory (Gateway KB MCP) */
    memoryEnabled: boolean;
    /** Gateway KB MCP Server URL for memory */
    memoryMcpKbUrl: string;
  };
}

// ─── Skill Discovery ──────────────────────────────────────────────────────────

/** Discovered skill descriptor. */
export interface SkillDescriptor {
  name: string;
  path: string;
  source: "project" | "workspace";
}

/** Discovered extension descriptor. */
export interface ExtensionDescriptor {
  name: string;
  path: string;
  source: "system" | "workspace";
}
