/**
 * Config loader.
 *
 * Reads the "doc-convert" entry from ~/.hogagent/skills_config.json.
 * Fields: api-key / endpoint / toolType.
 * Env fallback when not set in config file: DOC_CONVERT_API_KEY / DOC_CONVERT_ENDPOINT / DOC_CONVERT_TOOL_TYPE.
 *
 * LLM parsing path enabled when both api-key and endpoint are present.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SKILL_NAME = "doc-convert";

/** Get HogAgent config dir (user-dir name is canonical; system-dir is accepted for portable copies). */
function getSystemDir() {
  return process.env.HOGAGENT_USER_DIR
    || process.env.HOGAGENT_SYSTEM_DIR
    || join(homedir(), ".hogagent");
}

/** Get skills_config.json path. */
function getSkillConfigPath() {
  return join(getSystemDir(), "skills_config.json");
}

/** Read this skill's config entry from skills_config.json. */
function readSkillEntry() {
  const configPath = getSkillConfigPath();
  try {
    const configStat = statSync(configPath);
    if (!configStat.isFile() || configStat.size > 1024 * 1024) throw new Error("config must be a regular file no larger than 1MB");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config root must be a JSON object");
    const entry = config[SKILL_NAME];
    if (entry === undefined) return {};
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${SKILL_NAME} config must be a JSON object`);
    return entry;
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    throw new Error(`Unable to load ${configPath}: ${err.message}`);
  }
}

/**
 * Load full config. Priority: skills_config.json entry > env vars > defaults.
 * @returns {{ apiKey: string, endpoint: string, toolType: string }}
 */
export function loadConfig() {
  const entry = readSkillEntry();
  const apiKey = entry['api-key'] || entry.apiKey || process.env.DOC_CONVERT_API_KEY || "";
  let endpoint = entry.endpoint || process.env.DOC_CONVERT_ENDPOINT || "";
  const toolType = entry.toolType || process.env.DOC_CONVERT_TOOL_TYPE || "prime-sync";
  if (typeof apiKey !== "string" || /[\r\n]/.test(apiKey) || apiKey.length > 8192) {
    throw new Error("DOC_CONVERT_API_KEY must be a single-line string no longer than 8192 characters");
  }
  if (endpoint) {
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error("DOC_CONVERT_ENDPOINT must be a valid HTTP or HTTPS URL");
    }
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      throw new Error("DOC_CONVERT_ENDPOINT must use HTTP or HTTPS");
    }
    if (parsed.username || parsed.password || parsed.hash) {
      throw new Error("DOC_CONVERT_ENDPOINT must not contain credentials or a fragment");
    }
    if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase())) {
      throw new Error("DOC_CONVERT_ENDPOINT must use HTTPS unless it targets loopback");
    }
    endpoint = parsed.toString();
  }
  if ((apiKey && !endpoint) || (!apiKey && endpoint)) {
    throw new Error("LLM parsing requires both DOC_CONVERT_API_KEY and DOC_CONVERT_ENDPOINT");
  }
  if (typeof toolType !== "string" || !toolType.trim() || /[\r\n]/.test(toolType) || toolType.length > 100) {
    throw new Error("DOC_CONVERT_TOOL_TYPE must be a non-empty single-line string no longer than 100 characters");
  }
  return { apiKey, endpoint, toolType: toolType.trim() };
}

/** Check if LLM parsing path is configured (both apiKey and endpoint present). */
export function hasLlmConfig(config) {
  return Boolean(config.apiKey && config.endpoint);
}
