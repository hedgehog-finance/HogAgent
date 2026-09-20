import { userDirectoryName } from "./user-namespace.ts";
/**
 * HogAgent Configuration Management
 *
 * Handles loading configuration from:
 * - System directory: ~/.hogagent/
 * - Workspace directory: .hogagent/
 * - Environment variables: HOGAGENT_*
 * - CLI arguments
 * - Custom config file (--config)
 *
 * Priority: CLI args > --config file > persisted LLM settings (llm-settings.json)
 *         > workspace config > system config > env vars > defaults
 *
 * Note: llm-settings.json (persisted via WebUI save_settings RPC) overrides env vars
 * for LLM-specific fields (provider, apiKey, baseUrl, modelId, audit, compaction).
 * This is by design — see project documentation for the full priority chain.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, dirname, isAbsolute, normalize, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./utils/logger.ts";
import { getUserTheme } from "./user-workspace.ts";
import { DEFAULT_THEME } from "./themes.ts";
import { HEDGEHOG_DEFAULT_MODEL_ID } from "./model-utils.ts";
import type {
  AuditModelConfig,
  AuditResultEntry,
  ExtensionConfig,
  ExtensionDescriptor,
  HogAgentConfig,
  LlmProviderConfig,
  ModeMetadata,
  ModelConfig,
  SkillDescriptor,
  ConversationMode,
} from "./utils/types.ts";

const log = createLogger("config");

export const DEFAULT_AUDIT_MAX_ITERATIONS = 2;

/** Retry count is intentionally unbounded by product policy, but must be loop-safe. */
export function isValidAuditMaxIterations(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeAuditMaxIterations(value: unknown, source: string): number {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  if (isValidAuditMaxIterations(numeric)) return numeric;
  log.warn("Invalid audit maxIterations; using default", { source, value, fallback: DEFAULT_AUDIT_MAX_ITERATIONS });
  return DEFAULT_AUDIT_MAX_ITERATIONS;
}

// ─── Directory Paths ──────────────────────────────────────────────────────────

/** HogAgent project root (where package.json and node_modules live). */
export function getProjectRoot(): string {
  if (process.env["HOGAGENT_PROJECT_ROOT"]) {
    return process.env["HOGAGENT_PROJECT_ROOT"]!;
  }
  const thisDir = dirname(fileURLToPath(import.meta.url));
  let dir = thisDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "skills"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: walk up from this file looking for package.json
  dir = thisDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return thisDir;
}

/** User-level config directory (~/.hogagent — LLM settings, models cache, etc.). Override with HOGAGENT_USER_DIR env var. */
export function getSystemDir(): string {
  const configured = process.env["HOGAGENT_USER_DIR"];
  if (!configured) return join(homedir(), ".hogagent");
  // A relative directory changes meaning when Gateway starts a child in the installation.
  const paths = process.platform === "win32" ? win32 : { isAbsolute, normalize };
  if (!paths.isAbsolute(configured) || (process.platform === "win32" && /^[\\/](?![\\/])/.test(configured))) {
    throw new Error("HOGAGENT_USER_DIR must be an absolute path (expand shell variables before setting it)");
  }
  return paths.normalize(configured);
}

/** Workspace-level user config directory (<workspaceDir>/.hogagent/). */
export function getUserConfigDir(workspaceDir: string): string {
  return join(workspaceDir, ".hogagent");
}

/** Default workspace directory when none is specified. */
export function getDefaultWorkspaceDir(): string {
  return join(homedir(), ".hogagent", "workspace");
}

/** Native histories are user-scoped and independent of business workspace/archives. */
export function getSessionsDir(userId = "default"): string {
  return join(getSystemDir(), "sessions", userDirectoryName(userId));
}

// ─── Default Configuration ────────────────────────────────────────────────────

const DEFAULT_MODELS: ModelConfig[] = [
  { id: HEDGEHOG_DEFAULT_MODEL_ID, name: "Qwen 3.8 Flash", contextWindow: 500000 },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 500000 },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", contextWindow: 500000 },
  { id: "gpt-4.1", name: "GPT-4.1", contextWindow: 1047576 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1048576 },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1048576 },
  { id: "deepseek-r1", name: "DeepSeek R1", contextWindow: 65536 },
];

const DEFAULT_LLM_PROVIDER: LlmProviderConfig = {
  provider: "hedgehog",
  apiKey: "",
  baseUrl: "https://api.ciweiai.com/api/llm/v1",
  models: DEFAULT_MODELS,
};

function createDefaultConfig(overrides?: Partial<HogAgentConfig>): HogAgentConfig {
  return {
    mode: "rpc",
    sessionId: crypto.randomUUID(),
    workspaceDir: getDefaultWorkspaceDir(),
    sessionTaskDir: "",
    llmProvider: DEFAULT_LLM_PROVIDER,
    extensions: [],
    compaction: { autoCompactThreshold: 0.75 },
    ...overrides,
  };
}

// ─── Persisted LLM Settings ─────────────────────────────────────────────────

export interface PersistedLlmSettings {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  thinkingLevel?: string;
  /** Quick-mode thinking depth override (default "off"), configurable by client */
  quickThinkingLevel?: string;
  providerApiKeys?: Record<string, string>;  // Per-provider API keys
  // Audit model configuration
  audit?: {
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    modelId?: string;
    minPassScore?: number;
    maxIterations?: number;
  };
  // Compaction configuration
  compaction?: {
    autoCompactThreshold?: number;
  };
}

/** Merge endpoint patches without carrying credentials across provider boundaries. */
export function mergeLlmSettingsPatch(current: PersistedLlmSettings, patch: PersistedLlmSettings): PersistedLlmSettings {
  const provider = patch.provider || current.provider || "hedgehog";
  const providerChanged = provider !== (current.provider || "hedgehog");
  const providerApiKeys = { ...current.providerApiKeys, ...patch.providerApiKeys };
  const next: PersistedLlmSettings = { ...current, ...patch, providerApiKeys };
  if (providerChanged) {
    next.apiKey = patch.apiKey ?? providerApiKeys[provider] ?? "";
    next.baseUrl = patch.baseUrl ?? "";
    next.modelId = patch.modelId ?? "";
  }
  if (patch.apiKey !== undefined || providerChanged) providerApiKeys[provider] = next.apiKey ?? "";
  for (const [name, key] of Object.entries(providerApiKeys)) {
    if (!key) delete providerApiKeys[name];
  }
  if (patch.audit) {
    if (Object.keys(patch.audit).length === 0 || patch.audit.provider === "close") {
      next.audit = patch.audit.provider === "close" ? { provider: "close" } : {};
    } else {
      const auditProvider = patch.audit.provider ?? current.audit?.provider;
      const changed = auditProvider !== current.audit?.provider;
      next.audit = {
        ...current.audit, ...patch.audit,
        ...(changed ? {
          apiKey: patch.audit.apiKey ?? (auditProvider ? providerApiKeys[auditProvider] : undefined) ?? "",
          baseUrl: patch.audit.baseUrl ?? "",
          modelId: patch.audit.modelId ?? "",
        } : {}),
      };
    }
  }
  return next;
}

/** Resolve llm-settings.json path at runtime so HOGAGENT_USER_DIR takes effect. */
function getLlmSettingsPath(): string {
  return join(getSystemDir(), "llm-settings.json");
}

/** Load persisted LLM settings from ~/.hogagent/llm-settings.json */
export function loadPersistedLlmSettings(strict = false): PersistedLlmSettings {
  if (strict) return readConfigObjectForWrite(getLlmSettingsPath()) as PersistedLlmSettings;
  const settings = readJsonFile<PersistedLlmSettings>(getLlmSettingsPath());
  if (settings) {
    // Always ensure audit field exists (at minimum {})
    if (settings.audit === undefined) settings.audit = {};
    log.info("Loaded persisted LLM settings", { provider: settings.provider, modelId: settings.modelId });
  }
  return settings ?? { audit: {} };
}

/** Save LLM settings to ~/.hogagent/llm-settings.json */
export function savePersistedLlmSettings(settings: PersistedLlmSettings): void {
  const path = getLlmSettingsPath();
  const existing = readConfigObjectForWrite(path);
  writeConfigObject(path, { ...existing, ...settings });
  log.info("Persisted LLM settings", { provider: settings.provider, modelId: settings.modelId });
}

// ─── System Config ──────────────────────────────────────────────────────────

export const SANDBOX_MODES = ["enabled", "fallback", "disabled"] as const;
export type SandboxMode = typeof SANDBOX_MODES[number];

export interface SystemConfig {
  /** Bash file-isolation policy. Defaults to disabled. */
  sandboxMode?: SandboxMode;
  /** Legacy boolean: true maps to fallback, false maps to disabled. */
  sandboxEnabled?: boolean;
  /** Enable Anthropic-style cache_control for hedgehog+qwen models */
  explicitCache?: boolean;
  /** Show cache_read/cache_write token stats in UI */
  showCacheStats?: boolean;
  /** Absolute Python interpreter used to create the shared Bash virtual environment. */
  pythonPath?: string;
  /** Extension enabled/config entries (replaces legacy extensions.json) */
  extensions?: ExtensionConfig[];
  /** Memory system configuration */
  memory?: {
    enabled: boolean;
    mcpKbUrl?: string;
  };
}

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && SANDBOX_MODES.includes(value as SandboxMode);
}

/** Normalize current and legacy persisted values without mutating the config. */
export function resolveSandboxMode(config: Pick<SystemConfig, "sandboxMode" | "sandboxEnabled">): SandboxMode {
  if (isSandboxMode(config.sandboxMode)) return config.sandboxMode;
  // Missing config keeps the product default; an explicit malformed value must
  // not silently turn a previously intended sandbox into a direct shell.
  if (config.sandboxMode !== undefined) return "enabled";
  return config.sandboxEnabled === true ? "fallback" : "disabled";
}

/** Resolve hogagent.json path at runtime so HOGAGENT_USER_DIR takes effect. */
function getSystemConfigPath(): string {
  return join(getSystemDir(), "hogagent.json");
}

/** Load system config from ~/.hogagent/hogagent.json */
export function loadSystemConfig(): SystemConfig {
  return readJsonFile<SystemConfig>(getSystemConfigPath()) ?? {};
}

/** Content compression is opt-in; other extensions retain their existing default. */
export function isExtensionEnabled(name: string, extensions: ExtensionConfig[] = []): boolean {
  return extensions.find((entry) => entry.name === name)?.enabled ?? name !== "content-compressor";
}

/** Persisted settings for controls; tool inventories separately report live capability. */
export function getSystemConfigSnapshot(config: SystemConfig = loadSystemConfig()) {
  return {
    sandboxMode: resolveSandboxMode(config),
    explicitCache: config.explicitCache ?? false,
    showCacheStats: config.showCacheStats ?? false,
    compressorEnabled: isExtensionEnabled("content-compressor", config.extensions),
    compressThreshold: (config.extensions?.find(e => e.name === "content-compressor")?.config?.textThreshold as number | undefined) ?? 5000,
    subagentMaxTurns: (config.extensions?.find(e => e.name === "sub-agent")?.config?.maxTurns as number | undefined) ?? 50,
    memoryEnabled: config.memory?.enabled ?? false,
    memoryMcpKbUrl: config.memory?.mcpKbUrl ?? "",
  };
}

/** Save system config to ~/.hogagent/hogagent.json */
export function saveSystemConfig(config: SystemConfig): void {
  writeConfigObject(getSystemConfigPath(), config);
  log.info("Persisted system config", {
    sandboxMode: resolveSandboxMode(config),
    explicitCache: config.explicitCache,
    showCacheStats: config.showCacheStats,
    extensionsCount: config.extensions?.length,
  });
}

// ─── Config Loading ───────────────────────────────────────────────────────────

function configFileError(filePath: string, operation: "read" | "write", error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code || "IO_ERROR";
  const hint = ["EACCES", "EPERM", "EBUSY", "EROFS"].includes(code)
    ? " Check this OS user's directory permissions (including file replacement), read-only attributes, and file locks."
    : "";
  return new Error(`Cannot ${operation} configuration file ${filePath} (${code}).${hint}`, { cause: error });
}

/** Only a missing file means no saved configuration; access failures must surface. */
function readConfigText(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw configFileError(filePath, "read", error);
  }
}

/** Same-directory replacement preserves the original if Windows denies rename. */
function writeConfigObject(filePath: string, value: object): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // POSIX modes do not establish Windows ACLs; Windows inherits the directory ACL.
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600, flag: "wx" });
    renameSync(tempPath, filePath);
  } catch (error) {
    throw configFileError(filePath, "write", error);
  } finally {
    try { unlinkSync(tempPath); } catch { /* renamed, or cleanup denied by the OS */ }
  }
}

/** Malformed runtime JSON keeps the existing fallback; I/O failures are explicit. */
function readJsonFile<T>(filePath: string): T | undefined {
  const content = readConfigText(filePath);
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content) as T;
  } catch {
    log.warn("Invalid configuration JSON", { path: filePath });
    return undefined;
  }
}

/** Refuse to overwrite a malformed shared configuration during a merge write. */
function readConfigObjectForWrite(filePath: string): Record<string, unknown> {
  const content = readConfigText(filePath);
  if (content === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new SyntaxError(`Invalid configuration JSON: ${filePath}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid configuration object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

/** Extract configuration from environment variables. */
function loadEnvConfig(): Partial<HogAgentConfig> {
  const config: Partial<HogAgentConfig> = {};

  // LLM provider from env
  const apiKey = process.env["HOGAGENT_LLM_API_KEY"];
  const provider = process.env["HOGAGENT_LLM_PROVIDER"];
  const baseUrl = process.env["HOGAGENT_LLM_BASE_URL"];
  if (apiKey || provider || baseUrl) {
    config.llmProvider = {
      ...DEFAULT_LLM_PROVIDER,
      ...(provider && { provider }),
      ...(apiKey && { apiKey }),
      ...(baseUrl && { baseUrl }),
    };
  }

  return config;
}

/** CLI argument overrides. */
export interface CliArgs {
  mode?: "interactive" | "rpc";
  sessionId?: string;
  configPath?: string;
  workspaceDir?: string;
  user?: string;
  /** Absolute JSON file path used to initialize process runtime context. */
  runtimeContextFile?: string;
  /** Programmatic alternative to runtimeContextFile. */
  processRuntimeContext?: import("./runtime-context.ts").ProcessRuntimeContextInput;
}

/**
 * Load the full HogAgent configuration.
 * Priority: CLI args > --config file > llm-settings.json > workspace config > system config > env vars > defaults
 */
export function loadConfig(cliArgs?: CliArgs): HogAgentConfig {
  log.info("Loading configuration");

  // 1. Start with defaults
  const config = createDefaultConfig();

  // 2. Apply environment variables (lowest priority above defaults)
  const envConfig = loadEnvConfig();
  Object.assign(config, envConfig);

  // 3. Load extension configs from hogagent.json (replaces legacy extensions.json)
  const sysCfg = loadSystemConfig();
  config.extensions.push(...(sysCfg.extensions ?? []));

  // 3.5. Load memory system configuration from hogagent.json
  if (sysCfg.memory) {
    config.memory = sysCfg.memory;
  }

  // 5.5. Apply persisted LLM settings (from WebUI save_settings RPC)
  // Note: llm-settings.json has higher priority than env vars for LLM-specific fields.
  // Priority: llm-settings.json > llmConfig (env) > agent.env
  const persisted = loadPersistedLlmSettings();
  if (persisted.provider) {
    config.llmProvider = {
      ...config.llmProvider,
      provider: persisted.provider,
      ...(persisted.apiKey !== undefined && { apiKey: persisted.apiKey }),
      ...(persisted.baseUrl !== undefined && { baseUrl: persisted.baseUrl }),
    };
    // Also set env var so child processes and getApiKeyAndHeaders can find it
    if (persisted.apiKey !== undefined) process.env["HOGAGENT_LLM_API_KEY"] = persisted.apiKey;
    if (persisted.provider) process.env["HOGAGENT_LLM_PROVIDER"] = persisted.provider;
    if (persisted.baseUrl !== undefined) process.env["HOGAGENT_LLM_BASE_URL"] = persisted.baseUrl;
  }

  // 5.6. Load audit model configuration
  // Priority: llm-settings.json audit block > env vars > undefined
  const auditFromSettings = persisted.audit;
  const auditProvider = auditFromSettings?.provider ?? process.env["HOGAGENT_AUDIT_PROVIDER"];
  const auditApiKey = auditFromSettings?.apiKey ?? process.env["HOGAGENT_AUDIT_API_KEY"];
  const auditBaseUrl = auditFromSettings?.baseUrl ?? process.env["HOGAGENT_AUDIT_BASE_URL"];
  const auditModelId = auditFromSettings?.modelId ?? process.env["HOGAGENT_AUDIT_MODEL_ID"];
  const hasPersistedAuditMaxIterations = Boolean(auditFromSettings)
    && Object.prototype.hasOwnProperty.call(auditFromSettings, "maxIterations");
  const rawAuditMaxIterations = hasPersistedAuditMaxIterations
    ? auditFromSettings!.maxIterations
    : process.env["HOGAGENT_AUDIT_MAX_ITERATIONS"] ?? DEFAULT_AUDIT_MAX_ITERATIONS;
  // Explicitly disable audit model: provider is empty string or "close" (default behavior)
  if (auditProvider === "close" || auditProvider === "") {
    config.auditModel = undefined;
    log.info("Audit model explicitly closed", { provider: auditProvider });
  } else if (auditProvider && auditModelId && (auditApiKey || auditProvider === "custom")) {
    config.auditModel = {
      provider: auditProvider,
      apiKey: auditApiKey ?? "",
      baseUrl: auditBaseUrl,
      modelId: auditModelId,
      minPassScore: auditFromSettings?.minPassScore
        ?? Number(process.env["HOGAGENT_AUDIT_MIN_PASS_SCORE"] ?? 70),
      maxIterations: normalizeAuditMaxIterations(
        rawAuditMaxIterations,
        hasPersistedAuditMaxIterations ? "llm-settings.json" : "HOGAGENT_AUDIT_MAX_ITERATIONS",
      ),
    };
    log.info("Audit model configured", { provider: auditProvider, modelId: auditModelId });
  }

  // 5.7. Load compaction settings
  const persistedThreshold = persisted.compaction?.autoCompactThreshold;
  const validThreshold = typeof persistedThreshold === "number"
    && Number.isFinite(persistedThreshold)
    && persistedThreshold > 0
    && persistedThreshold < 1;
  if (persistedThreshold !== undefined && !validThreshold) {
    log.warn("Invalid auto-compaction threshold; using default", { value: persistedThreshold, default: 0.75 });
  }
  config.compaction = { autoCompactThreshold: validThreshold ? persistedThreshold : 0.75 };

  // 6. Load custom config file (config source, does NOT override CLI args)
  if (cliArgs?.configPath) {
    const custom = readJsonFile<Partial<HogAgentConfig>>(cliArgs.configPath);
    if (custom) {
      Object.assign(config, custom);
    }
  }

  // 7. Apply CLI args (highest priority)
  if (cliArgs?.mode) config.mode = cliArgs.mode;
  if (cliArgs?.sessionId) config.sessionId = cliArgs.sessionId;
  if (cliArgs?.workspaceDir) config.workspaceDir = resolve(cliArgs.workspaceDir);

  const finalThreshold = config.compaction?.autoCompactThreshold;
  if (typeof finalThreshold !== "number" || !Number.isFinite(finalThreshold)
    || finalThreshold <= 0 || finalThreshold >= 1) {
    log.warn("Invalid effective auto-compaction threshold; using default", {
      value: finalThreshold,
      default: 0.75,
    });
    config.compaction = { autoCompactThreshold: 0.75 };
  }
  log.info("Compaction config loaded", { ...config.compaction });

  // 8. Compute sessionTaskDir from workspaceDir + sessionId
  if (!config.sessionTaskDir) {
    config.sessionTaskDir = join(config.workspaceDir, "tasks", config.sessionId);
  }

  // 9. Load user identifier and theme from user_settings.json
  if (cliArgs?.user) {
    config.user = cliArgs.user;
    config.theme = getUserTheme(cliArgs.user);
  } else {
    config.theme = DEFAULT_THEME;
  }

  log.info("Configuration loaded", {
    mode: config.mode,
    sessionId: config.sessionId,
    provider: config.llmProvider.provider,
    extensionCount: config.extensions.length,
    auditModel: config.auditModel ? config.auditModel.modelId : "none",
  });

  return config;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/** Discover skills from project and workspace directories. Workspace overrides project. */
export function discoverSkills(workspaceDir: string): SkillDescriptor[] {
  const skills: SkillDescriptor[] = [];

  const projectSkillsDir = join(getProjectRoot(), "skills");
  const wsSkillsDir = join(workspaceDir, ".hogagent", "skills");

  // Project skills (bundled with hogagent)
  if (existsSync(projectSkillsDir)) {
    try {
      const entries = readdirSync(projectSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          skills.push({ name: entry.name, path: join(projectSkillsDir, entry.name), source: "project" });
        }
      }
    } catch {
      log.warn("Failed to read project skills directory");
    }
  }

  // Workspace skills override system ones by name
  if (existsSync(wsSkillsDir)) {
    try {
      const entries = readdirSync(wsSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const idx = skills.findIndex((s) => s.name === entry.name);
          const descriptor: SkillDescriptor = {
            name: entry.name,
            path: join(wsSkillsDir, entry.name),
            source: "workspace",
          };
          if (idx >= 0) {
            skills[idx] = descriptor;
          } else {
            skills.push(descriptor);
          }
        }
      }
    } catch {
      log.warn("Failed to read workspace skills directory");
    }
  }

  log.info("Skills discovered", { count: skills.length });
  return skills;
}

/** Discover extensions from system and workspace directories. */
export function discoverExtensions(workspaceDir: string): ExtensionDescriptor[] {
  const extensions: ExtensionDescriptor[] = [];

  const systemExtDir = join(getSystemDir(), "extensions");
  const wsExtDir = join(workspaceDir, "extensions");

  // System extensions
  if (existsSync(systemExtDir)) {
    try {
      const entries = readdirSync(systemExtDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          extensions.push({ name: entry.name, path: join(systemExtDir, entry.name), source: "system" });
        }
      }
    } catch {
      log.warn("Failed to read system extensions directory");
    }
  }

  // Workspace extensions override
  if (existsSync(wsExtDir)) {
    try {
      const entries = readdirSync(wsExtDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const idx = extensions.findIndex((e) => e.name === entry.name);
          const descriptor: ExtensionDescriptor = {
            name: entry.name,
            path: join(wsExtDir, entry.name),
            source: "workspace",
          };
          if (idx >= 0) {
            extensions[idx] = descriptor;
          } else {
            extensions.push(descriptor);
          }
        }
      }
    } catch {
      log.warn("Failed to read workspace extensions directory");
    }
  }

  log.info("Extensions discovered", { count: extensions.length });
  return extensions;
}

// ─── Skill Config (unified: API keys + mode visibility) ─────────────────────

/** Path to ~/.hogagent/skills_config.json — stores per-skill config (API keys, mode flags). */
export function getSkillApiConfigPath(): string {
  return join(getSystemDir(), "skills_config.json");
}

/** Skill config entry stored in skills_config.json. */
export interface SkillApiConfigEntry {
  'api-key'?: string;
  isLongTaskSpecific?: boolean;
  [key: string]: unknown;
}

/**
 * Load skill configuration from ~/.hogagent/skills_config.json.
 * This unified file stores API keys (via configure_skill RPC) and mode flags.
 * Returns empty object when file does not exist.
 */
export function loadSkillApiConfig(strict = false): Record<string, SkillApiConfigEntry> {
  const parsed = strict ? readConfigObjectForWrite(getSkillApiConfigPath()) : readJsonFile<unknown>(getSkillApiConfigPath());
  const config = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, SkillApiConfigEntry>
    : {};
  if (parsed !== undefined && parsed !== null && config !== parsed) {
    log.warn("Ignoring malformed skill config root");
  }
  for (const [name, rawEntry] of Object.entries(config)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      if (strict) throw new Error(`Invalid Skill configuration: ${name}`);
      delete config[name];
      log.warn("Ignoring malformed skill config entry", { skill: name });
      continue;
    }
    const entry = rawEntry as SkillApiConfigEntry;
    const rawFlag = entry.isLongTaskSpecific as unknown;
    if (rawFlag === "true" || rawFlag === "false") {
      entry.isLongTaskSpecific = rawFlag === "true";
    } else if (rawFlag !== undefined && typeof rawFlag !== "boolean") {
      delete entry.isLongTaskSpecific;
      log.warn("Ignoring invalid isLongTaskSpecific skill config", { skill: name });
    }
  }
  log.info("Skill config loaded", { entries: Object.keys(config).length });
  return config;
}

/**
 * Save (merge) a single skill's config into ~/.hogagent/skills_config.json.
 * Creates the file and directory if they don't exist.
 */
export function saveSkillApiConfig(skillName: string, entry: SkillApiConfigEntry): void {
  const configPath = getSkillApiConfigPath();
  // Shared by standalone and Gateway-managed HogAgent, including API keys.
  const existing = readConfigObjectForWrite(configPath) as Record<string, SkillApiConfigEntry>;
  const previous = existing[skillName];
  const previousEntry = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous
    : {};
  Object.defineProperty(existing, skillName, {
    value: { ...previousEntry, ...entry },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  writeConfigObject(configPath, existing);
  log.info("Skill config saved", { skill: skillName });
}

// ─── Mode Metadata (sessionTaskDir/mode.json) ─────────────────────────────

const CONVERSATION_MODES = new Set<ConversationMode>(["quick", "standard", "long_task"]);

export function isConversationMode(value: unknown): value is ConversationMode {
  return typeof value === "string" && CONVERSATION_MODES.has(value as ConversationMode);
}

/** Read mode metadata from sessionTaskDir/mode.json. Returns null if not found. */
export function readModeMetadata(sessionTaskDir: string): ModeMetadata | null {
  const filePath = join(sessionTaskDir, "mode.json");
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || !isConversationMode((parsed as Record<string, unknown>).mode)) {
      log.warn("Ignoring mode metadata with invalid conversation mode", { filePath });
      return null;
    }
    return parsed as ModeMetadata;
  } catch (error) {
    log.warn("Ignoring unreadable mode metadata", { filePath, error: String(error) });
    return null;
  }
}

/**
 * Write mode metadata to sessionTaskDir/mode.json with smart merge.
 * - Preserves firstOptimizedPrompt and firstGoals (set only on first write)
 * - Appends each optimizedPrompt to a rolling history (max 10 entries)
 * - Preserves existing auditResults
 */
export function writeModeMetadata(sessionTaskDir: string, metadata: ModeMetadata): void {
  const filePath = join(sessionTaskDir, "mode.json");

  // Read existing metadata for merge
  const existing = readModeMetadata(sessionTaskDir);

  // Freeze legacy fallback fields before overwriting the rolling values. Older
  // mode files may predate firstOptimizedPrompt/firstGoals.
  const existingFirstPrompt = existing?.firstOptimizedPrompt || existing?.optimizedPrompt;
  const existingFirstGoals = existing?.firstGoals?.length
    ? existing.firstGoals
    : existing?.goals;
  if (existingFirstPrompt) {
    metadata.firstOptimizedPrompt = existingFirstPrompt;
  } else if (!existingFirstGoals?.length && metadata.optimizedPrompt) {
    metadata.firstOptimizedPrompt = metadata.optimizedPrompt;
  }

  if (existingFirstGoals?.length) {
    metadata.firstGoals = existingFirstGoals;
  } else if (metadata.goals && metadata.goals.length > 0) {
    metadata.firstGoals = metadata.goals;
  }

  // Append to optimizedPrompt history (max 10, FIFO)
  const history = existing?.optimizedPromptHistory?.slice() || [];
  if (metadata.optimizedPrompt && metadata.optimizedPrompt !== history[history.length - 1]) {
    history.push(metadata.optimizedPrompt);
  }
  metadata.optimizedPromptHistory = history.slice(-10);

  // Preserve existing auditResults if not provided in new metadata
  if (existing?.auditResults && !metadata.auditResults) {
    metadata.auditResults = existing.auditResults;
  }

  // Preserve and append originalUserMessages (max 20, FIFO)
  const originals = existing?.originalUserMessages?.slice() || [];
  if (metadata.originalUserMessages) {
    for (const msg of metadata.originalUserMessages) {
      if (msg && msg !== originals[originals.length - 1]) {
        originals.push(msg);
      }
    }
  }
  metadata.originalUserMessages = originals.slice(-20);

  // Preserve complexAssistantCount (use max to handle process restarts where counter resets to 0)
  const newCount = metadata.complexAssistantCount ?? 0;
  const existingCount = existing?.complexAssistantCount ?? 0;
  metadata.complexAssistantCount = Math.max(newCount, existingCount);

  writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}

/** Append an audit result entry to the auditResults array in mode.json. */
export function appendAuditResult(sessionTaskDir: string, result: AuditResultEntry): void {
  const meta = readModeMetadata(sessionTaskDir);
  if (!meta) return; // Nothing to append to
  if (!meta.auditResults) meta.auditResults = [];
  meta.auditResults.push(result);
  writeModeMetadata(sessionTaskDir, meta);
}

/** Delete mode.json from sessionTaskDir (used on new session). */
export function deleteModeMetadata(sessionTaskDir: string): void {
  const filePath = join(sessionTaskDir, "mode.json");
  try {
    unlinkSync(filePath);
  } catch {
    // File may not exist — that's fine
  }
}
