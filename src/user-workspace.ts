/**
 * User-Workspace Management Module
 *
 * Manages per-user workspace mappings persisted in ~/.hogagent/user_settings.json.
 * Supports:
 *   - Register: user + workspace → save mapping
 *   - Lookup: user → find registered workspace
 *   - Error: user not found and no explicit workspace → throw
 *
 * Used by all entry points: CLI (interactive/rpc), Web server, Gateway adapter.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "./utils/logger.ts";
import { DEFAULT_THEME, THEME_NAMES } from "./themes.ts";

const log = createLogger("user-workspace");

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface UserSettingsEntry {
  workspace_dir: string;
  /** UI theme key, defaults to "fintech" */
  theme?: string;
}

export type UserSettings = Record<string, UserSettingsEntry>;

// ─── Paths ─────────────────────────────────────────────────────────────────────

function getSettingsDir(): string {
  const base = process.env["HOGAGENT_USER_DIR"] || join(homedir(), ".hogagent");
  return base;
}

function getSettingsPath(): string {
  return join(getSettingsDir(), "user_settings.json");
}

function getDefaultWorkspace(): string {
  return join(getSettingsDir(), "workspace");
}

/** Ensure a workspace directory exists (idempotent). Prevents first-use ENOENT when spawning child processes. */
function ensureWorkspaceDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log.info("Workspace directory created", { dir });
  }
}

// ─── Load / Save ───────────────────────────────────────────────────────────────

/** Load user settings from ~/.hogagent/user_settings.json. Returns empty object if file doesn't exist. */
export function loadUserSettings(): UserSettings {
  const path = getSettingsPath();
  if (!existsSync(path)) {
    return Object.create(null) as UserSettings;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    return Object.assign(Object.create(null), JSON.parse(raw)) as UserSettings;
  } catch (err) {
    log.warn("Failed to load user settings", { path, error: String(err) });
    return {};
  }
}

/** Save user settings to ~/.hogagent/user_settings.json. Creates directory if needed. */
export function saveUserSettings(data: UserSettings): void {
  const dir = getSettingsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = getSettingsPath();
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
  log.debug("User settings saved", { path });
}

// ─── Sanitize ──────────────────────────────────────────────────────────────────

/** Validate user identifier: only allows [a-zA-Z0-9_-]. */
export function sanitizeUser(user: string): string {
  if (!user || !user.trim() || user.includes("\0")) {
    throw new Error(`Invalid user identifier: "${user}". A non-empty identity without NUL is required.`);
  }
  return user;
}

// ─── Resolve ───────────────────────────────────────────────────────────────────

/**
 * Resolve workspace for a given user.
 *
 * Logic:
 *   1. user + explicitWorkspace → register mapping and return workspace
 *   2. user only (no explicitWorkspace) → lookup registered workspace
 *   3. user not found and no workspace → throw error
 */
export function resolveWorkspace(user: string, explicitWorkspace?: string): string {
  const safeUser = sanitizeUser(user);

  if (explicitWorkspace) {
    // Gateway and standalone launches share the mapping used by WebUI/CLI.
    const resolved = resolve(explicitWorkspace);
    registerWorkspace(safeUser, resolved);
    ensureWorkspaceDir(resolved);
    log.info("Workspace registered", { user: safeUser, workspace: resolved });
    return resolved;
  }

  // Lookup
  const settings = loadUserSettings();
  const entry = settings[safeUser];
  if (entry && entry.workspace_dir) {
    ensureWorkspaceDir(entry.workspace_dir);
    log.debug("Workspace found", { user: safeUser, workspace: entry.workspace_dir });
    return entry.workspace_dir;
  }

  // Not found
  throw new Error(
    `User "${safeUser}" not registered. Provide workspace to register: --user ${safeUser} --workspace /path`
  );
}

/**
 * Select a registered user for the Web UI.
 *
 * Browser-local state can outlive a user mapping. WebUI treats that stale
 * selection as a request for the always-provisioned default user, while the
 * CLI/RPC workspace resolver remains strict for unknown users.
 */
export function selectRegisteredWebUser(user: string): string {
  const safeUser = sanitizeUser(user);
  const settings = loadUserSettings();
  return settings[safeUser]?.workspace_dir ? safeUser : "default";
}

/** Register a user → workspace mapping and persist to disk. Preserves existing fields (e.g. theme). */
export function registerWorkspace(user: string, dir: string): void {
  const settings = loadUserSettings();
  settings[user] = { ...settings[user], workspace_dir: dir };
  saveUserSettings(settings);
}

/**
 * Ensure the Web UI's "default" user has a workspace.
 *
 * An explicit workspace is authoritative for this server launch and updates
 * only the default user's mapping while preserving fields such as theme. When
 * omitted, an existing mapping is reused; first use falls back to
 * <HOGAGENT_USER_DIR>/workspace.
 */
export function ensureDefaultUser(explicitWorkspace?: string): string {
  const settings = loadUserSettings();
  const workspace = explicitWorkspace
    ? resolve(explicitWorkspace)
    : settings["default"]?.workspace_dir || getDefaultWorkspace();
  const existing = settings["default"];
  if (!existing || existing.workspace_dir !== workspace) {
    settings["default"] = { ...existing, workspace_dir: workspace };
    saveUserSettings(settings);
    log.info(existing ? "Default user workspace updated" : "Default user registered", { workspace });
  }
  ensureWorkspaceDir(workspace);
  return workspace;
}

// ─── Theme Helpers ────────────────────────────────────────────────────────────

/** Get a user's theme. Returns DEFAULT_THEME if not set or user not found. */
export function getUserTheme(user: string): string {
  const settings = loadUserSettings();
  const entry = settings[user];
  if (entry?.theme && THEME_NAMES.includes(entry.theme)) {
    return entry.theme;
  }
  return DEFAULT_THEME;
}

/** Set a user's theme and persist to disk. Validates theme key exists. */
export function setUserTheme(user: string, theme: string): void {
  if (!THEME_NAMES.includes(theme)) {
    throw new Error(`Invalid theme: "${theme}". Available: ${THEME_NAMES.join(", ")}`);
  }
  const settings = loadUserSettings();
  if (!settings[user]) {
    log.warn("User not found when setting theme, creating entry", { user });
    settings[user] = { workspace_dir: getDefaultWorkspace() };
  }
  settings[user].theme = theme;
  saveUserSettings(settings);
  log.info("User theme saved", { user, theme });
}

// ─── CLI Helper ────────────────────────────────────────────────────────────────

/**
 * Resolve workspace or exit the process with code 1.
 * Used by hogagent CLI entry point (both interactive and RPC modes).
 */
export function resolveWorkspaceOrExit(user: string, explicitWorkspace?: string): string {
  try {
    return resolveWorkspace(user, explicitWorkspace);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Workspace resolution failed", { user, error: msg });
    process.exit(1);
  }
}
