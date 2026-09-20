import { createHash } from "node:crypto";
import { fingerprintFile } from "../artifacts/artifact-file-facts.ts";
import { deliveryReceiptsFromEntries } from "../artifacts/file-delivery.ts";
import { resolveMarkdownImage } from "./markdown-resources.ts";
/**
 * HogAgent Web UI Server
 *
 * Bridges browser WebSocket connections to HogAgent RPC child processes.
 * Architecture:
 *   Browser (HTML/JS) ←WebSocket→ Web Server (Node.js, port 9108) ←stdin/stdout→ HogAgent process
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { validateSkillName } from "../utils/skill-name.ts";
import { getProjectRoot, getSystemDir, isConversationMode, loadSkillApiConfig, saveSkillApiConfig, loadPersistedLlmSettings, getSystemConfigSnapshot, getSessionsDir } from "../config.ts";
import { installSkillDirectory } from "../utils/skill-installation.ts";
import { extractZipSync } from "../utils/zip.ts";
import {
  sanitizeUser,
  resolveWorkspace,
  ensureDefaultUser,
  loadUserSettings,
  selectRegisteredWebUser,
  getUserTheme,
  setUserTheme,
} from "../user-workspace.ts";
import { THEMES, DEFAULT_THEME, resolveTheme, THEME_NAMES } from "../themes.ts";
import { isPathInside, realPathInside, realPath } from "../utils/path-safety.ts";
import { resolveGitBinary, getGitEnv, clearGitBinaryCache } from "../utils/git-binary.ts";
import { getRuntimeContextCapability } from "../runtime-context.ts";
import { extractBearerToken, loadWebJwtService, type WebJwtService } from "./auth.ts";
import { WebSocketServer, type WebSocket } from "ws";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WebServerOptions {
  port: number;
  defaultWorkspace?: string;
  hogagentPath?: string;
}

interface BrowserMessage {
  type: "rpc_command" | "new_session" | "reconnect";
  command?: Record<string, unknown>;
  session_id?: string;
}

function parseRequestUrl(req: IncomingMessage): URL {
  // Host is caller-controlled and unnecessary for parsing an origin-form
  // request target. A fixed base keeps malformed Host values out of routing.
  return new URL(req.url ?? "/", "http://localhost");
}

function decodeApiPathSegment(value: string, res: ServerResponse): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid URL encoding" }));
    return null;
  }
}

// ─── Helpers: Search Settings ─────────────────────────────────────────────────

/** Resolve search_settings.json path at runtime so HOGAGENT_USER_DIR takes effect. */
function getSearchSettingsPath(): string {
  return join(getSystemDir(), "search_settings.json");
}

/** Read search settings from ~/.hogagent/search_settings.json */
async function loadSearchSettingsFile(): Promise<Record<string, unknown>> {
  try {
    const settingsPath = getSearchSettingsPath();
    if (existsSync(settingsPath)) {
      const content = await readFile(settingsPath, "utf-8");
      return JSON.parse(content);
    }
  } catch { /* ignore */ }
  return {};
}

/** Write search settings to ~/.hogagent/search_settings.json */
async function saveSearchSettingsFile(settings: Record<string, unknown>): Promise<void> {
  await mkdir(getSystemDir(), { recursive: true });
  await writeFile(getSearchSettingsPath(), JSON.stringify(settings, null, 2), "utf-8");
}

/** Search provider → environment variable mapping */
const SEARCH_PROVIDER_ENV_MAP: Record<string, Array<{ field: string; envVar: string }>> = {
  brave:      [{ field: "api_key", envVar: "HOGAGENT_SEARCH_API_KEY" }],
  you:        [{ field: "api_key", envVar: "HOGAGENT_SEARCH_API_KEY" }],
  tavily:     [{ field: "api_key", envVar: "HOGAGENT_SEARCH_API_KEY" }],
  serpapi:    [{ field: "api_key", envVar: "HOGAGENT_SEARCH_API_KEY" }],
  bing:       [{ field: "api_key", envVar: "HOGAGENT_SEARCH_API_KEY" }],
  google:     [
    { field: "api_key", envVar: "HOGAGENT_SEARCH_API_KEY" },
    { field: "cx", envVar: "HOGAGENT_SEARCH_CX" },
  ],
  custom:     [
    { field: "api_key", envVar: "HOGAGENT_SEARCH_API_KEY" },
    { field: "endpoint", envVar: "HOGAGENT_SEARCH_ENDPOINT" },
  ],
  bocha:      [
    { field: "api_key", envVar: "HOGAGENT_BOCHA_API_KEY" },
    { field: "endpoint", envVar: "HOGAGENT_BOCHA_ENDPOINT" },
    { field: "freshness", envVar: "HOGAGENT_BOCHA_FRESHNESS" },
    { field: "categories", envVar: "HOGAGENT_BOCHA_CATEGORIES" },
  ],
  metaso:     [
    { field: "api_key", envVar: "HOGAGENT_METASO_API_KEY" },
    { field: "mode", envVar: "HOGAGENT_METASO_MODE" },
    { field: "range", envVar: "HOGAGENT_METASO_RANGE" },
    { field: "endpoint", envVar: "HOGAGENT_METASO_ENDPOINT" },
  ],
  zhipu:      [
    { field: "api_key", envVar: "HOGAGENT_ZHIPU_API_KEY" },
    { field: "model", envVar: "HOGAGENT_ZHIPU_MODEL" },
    { field: "base_url", envVar: "HOGAGENT_ZHIPU_BASE_URL" },
  ],
  volcengine: [
    { field: "api_key", envVar: "HOGAGENT_VOLCENGINE_API_KEY" },
    { field: "model", envVar: "HOGAGENT_VOLCENGINE_MODEL" },
    { field: "endpoint", envVar: "HOGAGENT_VOLCENGINE_ENDPOINT" },
  ],
};

// ─── Helpers: Persisted Settings & Skill Discovery ─────────────────────────────

/** Read persisted LLM settings via config.ts (single source: <userDir>/llm-settings.json). */
function loadPersistedSettings(): Record<string, unknown> {
  return loadPersistedLlmSettings(true) as unknown as Record<string, unknown>;
}

/** Discover skill names from <project>/skills/ and <workspace>/skills/ */
function discoverSkillsSimple(workspace: string): string[] {
  const skillNames: string[] = [];
  const dirs = [join(getProjectRoot(), "skills"), join(workspace, ".hogagent", "skills")];
  for (const dir of dirs) {
    try {
      if (existsSync(dir)) {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !skillNames.includes(entry.name)) {
            skillNames.push(entry.name);
          }
        }
      }
    } catch { /* ignore */ }
  }
  return skillNames;
}

interface SkillDetail {
  name: string;
  description: string;
  version: string;
  scope: "system" | "user";
}

/** Parse YAML frontmatter from SKILL.md content (handles multi-line `>` folded syntax). */
function parseSkillFrontmatterFields(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const lines = match[1]!.split(/\r?\n/);
  const result: Record<string, string> = {};
  let currentKey = "";

  for (const line of lines) {
    // Continuation line (indented, belongs to previous key)
    if (currentKey && /^\s+/.test(line)) {
      result[currentKey] = (result[currentKey] ?? "") + " " + line.trim();
      continue;
    }
    // New key-value pair
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    currentKey = kv[1]!;
    const rawValue = kv[2]!.trim();
    // `>` or `|` folded scalar: value continues on next indented lines
    if (rawValue === ">" || rawValue === "|") {
      result[currentKey] = "";
      continue;
    }
    result[currentKey] = rawValue;
  }
  return result;
}

/** Extract multi-line description from SKILL.md frontmatter, truncated to 100 chars. */
function extractSkillDescription(skillDir: string): string {
  try {
    const mdPath = join(skillDir, "SKILL.md");
    if (existsSync(mdPath)) {
      const content = readFileSync(mdPath, "utf-8");
      const fm = parseSkillFrontmatterFields(content);
      if (fm.description) {
        const desc = fm.description.trim();
        return desc.length > 100 ? desc.slice(0, 100) + "…" : desc;
      }
      // Fallback: first non-frontmatter paragraph
      const lines = content.split("\n");
      let pastFrontmatter = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "---") { pastFrontmatter = !pastFrontmatter; continue; }
        if (!pastFrontmatter) continue;
        if (trimmed && !trimmed.startsWith("#")) {
          return trimmed.slice(0, 100);
        }
      }
    }
  } catch { /* ignore */ }
  return "";
}

/** Extract version from SKILL.md frontmatter, falling back to version.json / package.json. */
function extractSkillVersion(skillDir: string): string {
  try {
    const mdPath = join(skillDir, "SKILL.md");
    if (existsSync(mdPath)) {
      const content = readFileSync(mdPath, "utf-8");
      const fm = parseSkillFrontmatterFields(content);
      if (fm.version) return fm.version.trim();
    }
    for (const file of ["version.json", "package.json"]) {
      const path = join(skillDir, file);
      if (existsSync(path)) {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        if (data.version) return data.version;
      }
    }
  } catch { /* ignore */ }
  return "";
}

/** Discover skills with full details (name, description, version, scope). */
function discoverSkillsDetailed(workspace: string): SkillDetail[] {
  const skills: SkillDetail[] = [];
  const seen = new Set<string>();
  const sources: Array<{ dir: string; scope: "system" | "user" }> = [
    { dir: join(getProjectRoot(), "skills"), scope: "system" },
    { dir: join(workspace, ".hogagent", "skills"), scope: "user" },
  ];
  for (const { dir, scope } of sources) {
    try {
      if (existsSync(dir)) {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !seen.has(entry.name)) {
            seen.add(entry.name);
            const skillDir = join(dir, entry.name);
            skills.push({
              name: entry.name,
              description: extractSkillDescription(skillDir),
              version: extractSkillVersion(skillDir),
              scope,
            });
          }
        }
      }
    } catch { /* ignore */ }
  }
  return skills;
}

/** Discover extensions with scope from system and workspace directories. */
function discoverExtensions(workspace: string): Array<{ name: string; scope: "system" | "user" }> {
  const extensions: Array<{ name: string; scope: "system" | "user" }> = [];
  const seen = new Set<string>();
  const sources: Array<{ dir: string; scope: "system" | "user" }> = [
    { dir: join(getProjectRoot(), "src", "extensions"), scope: "system" },
    { dir: join(workspace, "extensions"), scope: "user" },
  ];
  for (const { dir, scope } of sources) {
    try {
      if (existsSync(dir)) {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !seen.has(entry.name)) {
            seen.add(entry.name);
            extensions.push({ name: entry.name, scope });
          }
        }
      }
    } catch { /* ignore */ }
  }
  return extensions;
}

/** Resolve the target skills directory based on scope. */
function getSkillsTargetDir(workspace: string, scope: string): string {
  return scope === "system"
    ? join(getProjectRoot(), "skills")
    : join(workspace, ".hogagent", "skills");
}

interface ServerMessage {
  type: "rpc_event" | "connection_status" | "error";
  event?: Record<string, unknown>;
  status?: string;
  error?: string;
}

interface Session {
  /** Reject commands and cross-socket reconnects while replacing this process. */
  transitioning?: boolean;
  id: string;
  /** Business session currently owned by the child; may differ after resume/switch. */
  activeSessionId: string;
  activeMode: string | null;
  busy: boolean;
  orchestrating: boolean;
  pendingActiveSessionId?: string;
  /** Marks the replacement process created after a requested reconnect could not be honored. */
  reconnectFallback?: boolean;
  ws: WebSocket;
  child: ChildProcess | null;
  user: string;
  workspace: string;
  lineBuffer: string;
  stdoutDecoder: StringDecoder;
  stderrBuffer: string;
  hogagentPath: string;
  tools: string[];
  /** Pending disconnect-grace kill timer (set when the client ws closes) */
  disconnectTimer?: NodeJS.Timeout | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Locate the project root by searching for package.json from the current file. */
function findProjectRoot(): string {
  let currentDir = dirname(fileURLToPath(import.meta.url));
  while (currentDir !== dirname(currentDir)) {
    if (existsSync(join(currentDir, "package.json"))) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }
  return process.cwd();
}

function findPublicDir(projectRoot: string): string {
  // Same logic as Gateway Web: prefer dist (packaged artifact), fallback to src (dev mode)
  const candidates = [
    join(projectRoot, "dist/src/web/public"),
    join(projectRoot, "src/web/public"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return resolve(dir);
  }
  const fallback = resolve(candidates[0]);
  console.warn(
    `[HogAgent Web] public directory not found in any candidate: ${candidates.join(', ')}. ` +
    `Falling back to ${fallback} — WebUI static assets will be unavailable (all requests will 404).`
  );
  return fallback;
}

const PROJECT_ROOT = findProjectRoot();
const PUBLIC_DIR = findPublicDir(PROJECT_ROOT);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".zip": "application/zip",
};

const DEFAULT_PORT = 9108;

// ─── HTTP Static File Server ──────────────────────────────────────────────────

function getContentType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  webJwt: WebJwtService,
): Promise<void> {
  let targetPath = resolve(join(PUBLIC_DIR, urlPath));

  // Security: prevent directory traversal
  // Use path-aware containment to prevent traversal and same-prefix sibling matches.
  if (!isPathInside(PUBLIC_DIR, targetPath)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(targetPath);
    if (fileStat.isDirectory()) {
      targetPath = join(targetPath, "index.html");
    }
  } catch {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  try {
    const fileStat = await stat(targetPath);
    if (basename(targetPath) === "index.html") {
      const html = await readFile(targetPath, "utf8");
      const tokenMeta = `<meta name="hogagent-web-token" content="${webJwt.issue()}">`;
      const body = Buffer.from(
        html.includes("</head>") ? html.replace("</head>", `  ${tokenMeta}\n</head>`) : `${tokenMeta}\n${html}`,
        "utf8",
      );
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.byteLength.toString(),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end(body);
      return;
    }
    res.writeHead(200, {
      "Content-Type": getContentType(targetPath),
      "Content-Length": fileStat.size.toString(),
      "Cache-Control": "no-cache",
    });
    createReadStream(targetPath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ─── File Upload / Download API ────────────────────────────────────────────────

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

/** Parse a single file from multipart/form-data body. */
function parseMultipart(req: IncomingMessage): Promise<{ filename: string; data: Buffer } | null> {
  return new Promise((resolvePromise, reject) => {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (!boundaryMatch) { reject(new Error("No boundary in Content-Type")); return; }
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_UPLOAD_SIZE) { req.destroy(); reject(new Error("File too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from(`--${boundary}`);
      // Find first file part
      const parts = body.toString("binary").split(`--${boundary}`);
      for (const part of parts) {
        const filenameMatch = part.match(/filename="([^"]+)"/);
        if (!filenameMatch) continue;
        const filename = filenameMatch[1]!;
        // Split headers from body at double CRLF
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        const bodyStr = part.slice(headerEnd + 4);
        // Remove trailing --\r\n or --
        const trimmed = bodyStr.endsWith("\r\n") ? bodyStr.slice(0, -2) : bodyStr;
        const data = Buffer.from(trimmed, "binary");
        resolvePromise({ filename, data });
        return;
      }
      resolvePromise(null);
    });
    req.on("error", reject);
  });
}

async function handleUpload(req: IncomingMessage, res: ServerResponse, workspace: string): Promise<void> {
  try {
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);
    if (contentLength > MAX_UPLOAD_SIZE) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "File too large (max 50MB)" }));
      return;
    }
    const result = await parseMultipart(req);
    if (!result) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No file found in upload" }));
      return;
    }
    // Sanitize filename
    const sanitized = result.filename.replace(/[\/\\]/g, "_").replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
    const filesDir = join(workspace, "files");
    await mkdir(filesDir, { recursive: true });
    const uniqueName = `${crypto.randomUUID()}-${sanitized}`;
    const filePath = join(filesDir, uniqueName);
    await writeFile(filePath, result.data);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: filePath, name: result.filename, size: result.data.length }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Upload failed: ${msg}` }));
  }
}

async function handleDownload(req: IncomingMessage, res: ServerResponse, workspace: string): Promise<void> {
  try {
    const url = parseRequestUrl(req);
    const sessionId = url.searchParams.get("session");
    const relativePath = url.searchParams.get("path");
    if (!sessionId || !relativePath) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing session or path parameter" }));
      return;
    }
    // Validate sessionId to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid session ID" }));
      return;
    }
    const pathParts = relativePath.replace(/\\/g, "/").split("/");
    if (pathParts.some(part => part === ".." || part === ".hedgehog")) {
      res.writeHead(403); res.end("Access denied"); return;
    }
    const user = sanitizeUser(url.searchParams.get("user") || "default");
    const historyPath = join(getSessionsDir(user), `${sessionId}.jsonl`);
    const history = existsSync(historyPath) ? readFileSync(historyPath, "utf8").split("\n").flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }) : [];
    const receiptId = url.searchParams.get("receipt");
    const matches = deliveryReceiptsFromEntries(history, sessionId).filter(file => file.path === relativePath && (!receiptId || file.id === receiptId));
    const receipt = matches.length === 1 ? matches[0] : undefined;
    if (!receipt) { res.writeHead(403); res.end("No delivery receipt for this Session and path"); return; }
    let resolvedPath = realPathInside(workspace, resolve(workspace, relativePath));
    const recordedPath = realPathInside(receipt.root_path, resolve(receipt.root_path, receipt.root_relative));
    const sessionRoot = realPath(join(workspace, "tasks", sessionId));
    if (!resolvedPath || resolvedPath !== recordedPath || (receipt.root === "session" && realPath(receipt.root_path) !== sessionRoot)) {
      res.writeHead(404); res.end("Delivered file is missing or no longer accessible"); return;
    }
    const currentFingerprint = createHash("sha256").update(JSON.stringify(fingerprintFile(resolvedPath))).digest("hex");
    if (currentFingerprint !== receipt.fingerprint) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Delivered file has changed; request a fresh delivery of the current file." })); return;
    }
    const resource = url.searchParams.get("resource");
    if (resource !== null) {
      resolvedPath = resolveMarkdownImage(resolvedPath, receipt.root_path, resource);
      if (!resolvedPath) { res.writeHead(403); res.end("Image is not referenced by this document or is outside its managed root"); return; }
    }
    let fileStat;
    try {
      fileStat = await stat(resolvedPath);
    } catch {
      console.error(`[download] File not found: ${resolvedPath}`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `File not found: ${relativePath}` }));
      return;
    }
    if (!fileStat.isFile()) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not a file" }));
      return;
    }
    const fileName = basename(resolvedPath);
    const contentType = getContentType(fileName);
    // Images: inline (for preview); others: attachment (for download)
    const isInline = contentType.startsWith("image/") || contentType.startsWith("video/") || contentType.startsWith("audio/");
    const disposition = isInline
      ? `inline; filename="${encodeURIComponent(fileName)}"`
      : `attachment; filename="${encodeURIComponent(fileName)}"`;
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": fileStat.size.toString(),
      "Content-Disposition": disposition,
    });
    createReadStream(resolvedPath).pipe(res);
  } catch (err) {
    console.error("[download] Error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    } else {
      res.end();
    }
  }
}

// ─── Search Settings API ──────────────────────────────────────────────────────

async function handleGetSearchSettings(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const settings = await loadSearchSettingsFile();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ settings }));
}

async function handlePostSearchSettings(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    const { provider, fields } = body as { provider: string; fields: Record<string, string> };

    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'provider' field" }));
      return;
    }

    // Read existing config (preserve other providers' settings)
    const existing = await loadSearchSettingsFile();
    const providers = (existing.providers as Record<string, Record<string, unknown>>) || {};

    // Update current provider's config
    providers[provider] = { ...providers[provider], ...fields };
    // Clean up empty values
    for (const [k, v] of Object.entries(providers[provider])) {
      if (v === "" || v === undefined) delete providers[provider][k];
    }

    const settings: Record<string, unknown> = {
      ...existing,
      provider,
      active_provider: provider,
      providers,
    };
    // Sync top-level api_key if the provider uses a generic key
    if (fields.api_key) {
      settings.api_key = fields.api_key;
    }

    // Write JSON file
    await saveSearchSettingsFile(settings);

    // Update process.env (ensures newly spawned children inherit)
    process.env["HOGAGENT_SEARCH_PROVIDER"] = provider;
    const envMap = SEARCH_PROVIDER_ENV_MAP[provider];
    if (envMap) {
      for (const { field, envVar } of envMap) {
        if (fields[field]) {
          process.env[envVar] = fields[field];
        }
      }
    }

    // Notify all active child processes to clear search cache
    for (const session of sessions.values()) {
      if (session.child?.stdin?.writable) {
        session.child.stdin.write(JSON.stringify({ type: "reset_search_cache" }) + "\n");
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, settings }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Save failed: ${msg}` }));
  }
}

async function handlePostActiveProvider(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    const { active_provider } = body as { active_provider: string };

    if (!active_provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'active_provider' field" }));
      return;
    }

    const existing = await loadSearchSettingsFile();
    existing.active_provider = active_provider;
    existing.provider = active_provider;
    await saveSearchSettingsFile(existing);

    // Update process.env
    process.env["HOGAGENT_SEARCH_PROVIDER"] = active_provider;

    // Notify active child processes to clear search cache
    for (const session of sessions.values()) {
      if (session.child?.stdin?.writable) {
        session.child.stdin.write(JSON.stringify({ type: "reset_search_cache" }) + "\n");
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Save failed: ${msg}` }));
  }
}

// ─── Skills / Extensions / Users / Tools API ────────────────────────────────────

/** Helper to read JSON body from request. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

/** GET /api/users — return registered users and normalize a stale browser selection. */
async function handleGetUsers(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = parseRequestUrl(req);
    const requestedUser = url.searchParams.get("user") || "default";
    const settings = loadUserSettings();
    const users = Object.entries(settings).map(([id, entry]) => ({
      id,
      workspace_dir: entry.workspace_dir,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      users,
      selectedUser: selectRegisteredWebUser(requestedUser),
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/** GET /api/themes — return all available themes */
async function handleGetThemes(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ themes: THEMES, defaultTheme: DEFAULT_THEME }));
}

/** GET /api/user-theme?user=xxx — return user's current theme and full preset */
async function handleGetUserTheme(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = parseRequestUrl(req);
    const user = sanitizeUser(url.searchParams.get("user") || "default");
    const themeKey = getUserTheme(user);
    const preset = resolveTheme(themeKey) || THEMES[DEFAULT_THEME];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ theme: themeKey, preset }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/** POST /api/user-theme — save user's theme selection */
async function handlePostUserTheme(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    const { user, theme } = body as { user: string; theme: string };

    if (!user || !theme) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'user' or 'theme' field" }));
      return;
    }
    if (!THEME_NAMES.includes(theme)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Invalid theme: ${theme}. Available: ${THEME_NAMES.join(", ")}` }));
      return;
    }
    const safeUser = sanitizeUser(user);
    setUserTheme(safeUser, theme);
    const preset = resolveTheme(theme);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, theme, preset }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/** GET /api/skills?user=xxx — return detailed skill list with scope */
async function handleGetSkills(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = parseRequestUrl(req);
    const user = sanitizeUser(url.searchParams.get("user") || "default");
    const workspace = resolveWorkspace(user);
    const skills = discoverSkillsDetailed(workspace);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ skills }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/** DELETE /api/skills/:name?user=xxx&scope=system|user — delete a skill */
async function handleDeleteSkill(
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
): Promise<void> {
  try {
    // Bug 18 fix: Validate skillName to prevent path traversal attacks
    // Issue: skillName comes from URL path params; decodeURIComponent can decode %2F to construct ../../etc
    if (!validateSkillName(skillName)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid skill name" }));
      return;
    }
    const url = parseRequestUrl(req);
    const user = sanitizeUser(url.searchParams.get("user") || "default");
    const scope = url.searchParams.get("scope") || "user";
    const workspace = resolveWorkspace(user);
    const userSkillsDir = join(workspace, ".hogagent", "skills", skillName);
    const systemSkillsDir = join(getProjectRoot(), "skills", skillName);

    // Determine which directory to delete based on scope parameter
    const targetDir = scope === "system" ? systemSkillsDir : userSkillsDir;

    if (!existsSync(targetDir)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Skill '${skillName}' not found in ${scope} skills directory` }));
      return;
    }
    rmSync(targetDir, { recursive: true, force: true });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, scope, deleted: skillName }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/** POST /api/skills/install — install a skill via git clone or ZIP upload */
async function handleInstallSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const contentType = req.headers["content-type"] || "";
    let scope = "user";
    let targetDir: string;
    const url = parseRequestUrl(req);
    const user = sanitizeUser(url.searchParams.get("user") || "default");
    const workspace = resolveWorkspace(user);

    if (contentType.includes("application/json")) {
      // Git URL install
      const body = (await readJsonBody(req)) as { source: string; url: string; scope?: string; name?: string };
      scope = body.scope || "user";
      targetDir = getSkillsTargetDir(workspace, scope);
      await mkdir(targetDir, { recursive: true });
      if (body.source === "git" && body.url) {
        // Validate URL to prevent shell injection — only allow safe URL schemes
        const urlObj = new URL(body.url);
        if (!["http:", "https:", "git:"].includes(urlObj.protocol)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid URL scheme. Only http, https, and git are allowed." }));
          return;
        }
        const name = body.name || basename(body.url).replace(/\.git$/, "");
        // Sanitize skill name to prevent path traversal
        const safeName = name.replace(/[^\w.\-]/g, "_");
        if (!validateSkillName(safeName)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid skill name" }));
          return;
        }
        const result = installSkillDirectory(targetDir, safeName, staging => {
          execFileSync(resolveGitBinary(), ["clone", "--depth", "1", urlObj.href, staging], { timeout: 60000, env: getGitEnv() });
        });
        if (!result.installed) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `已安装 v${result.existingVersion}，上传版本 v${result.incomingVersion} 不更新。请先升级技能版本。` }));
          return;
        }
        const installedVer = result.incomingVersion;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: safeName, version: installedVer }));
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid source. Use 'git'" }));
      return;
    }

    // ZIP upload install
    const multipartResult = await parseMultipart(req);
    if (!multipartResult) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No file found in upload" }));
      return;
    }
    // Extract scope from URL params or default to user
    scope = url.searchParams.get("scope") || "user";
    targetDir = getSkillsTargetDir(workspace, scope);
    const safeSkillName = multipartResult.filename.replace(/\.zip$/i, "").replace(/[^\w.\-]/g, "_");
    if (!validateSkillName(safeSkillName)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid skill name" }));
      return;
    }
    await mkdir(targetDir, { recursive: true });
    // Save ZIP to temp file then extract
    const zipPath = join(targetDir, `.upload-${randomUUID()}.zip`);
    let result: ReturnType<typeof installSkillDirectory>;
    try {
      await writeFile(zipPath, multipartResult.data, { flag: 'wx', mode: 0o600 });
      result = installSkillDirectory(targetDir, safeSkillName, staging => extractZipSync(zipPath, staging));
    } finally {
      try { rmSync(zipPath, { force: true }); }
      catch (error) { console.warn('Skill upload retained for cleanup', zipPath, String(error)); }
    }
    if (!result.installed) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `已安装 v${result.existingVersion}，上传版本 v${result.incomingVersion} 不更新。请先升级技能版本。` }));
      return;
    }
    const installedVer = result.incomingVersion;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: safeSkillName, version: installedVer }));
  } catch (err) {
    // git may be removed at runtime; clear the cache so the next call probes again and reports a helpful error.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      clearGitBinaryCache();
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未找到 git 可执行文件（可能已被卸载），请确认已安装 git 后重试" }));
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Install failed: ${msg}` }));
  }
}

/** PUT /api/skills/:name/config?user=xxx — save skill config to ~/.hogagent/skills_config.json */
async function handleSaveSkillConfig(
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
  sessions: Map<string, Session>,
): Promise<void> {
  try {
    // Bug 19 fix: Validate skillName to prevent path traversal attacks
    if (!validateSkillName(skillName)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid skill name" }));
      return;
    }
    const body = await readJsonBody(req);
    const candidate = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).config
      : undefined;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "config must be an object" }));
      return;
    }
    const config = candidate as Record<string, unknown>;
    if (config.isLongTaskSpecific !== undefined && typeof config.isLongTaskSpecific !== "boolean") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "isLongTaskSpecific must be a boolean" }));
      return;
    }
    saveSkillApiConfig(skillName, config);
    // The skill config is global to this WebUI server. Reuse the existing FIFO
    // reload_config command so every managed child observes it at its next safe boundary.
    const reloadLine = JSON.stringify({ type: "reload_config" }) + "\n";
    for (const session of sessions.values()) {
      if (!session.child?.stdin?.writable) continue;
      try {
        session.child.stdin.write(reloadLine);
      } catch (error) {
        console.warn(`[skills] Failed to notify Web session ${session.id}`, String(error));
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/** GET /api/skills/:name/config?user=xxx — get skill config from ~/.hogagent/skills_config.json */
async function handleGetSkillConfig(
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
): Promise<void> {
  try {
    // Bug 20 fix: Validate skillName to prevent path traversal attacks
    if (!validateSkillName(skillName)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid skill name" }));
      return;
    }
    const allConfig = loadSkillApiConfig();
    const config = allConfig[skillName] || {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ config }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/** GET /api/extensions?user=xxx — return extension list with scope */
async function handleGetExtensions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = parseRequestUrl(req);
    const user = sanitizeUser(url.searchParams.get("user") || "default");
    const workspace = resolveWorkspace(user);
    const extensions = discoverExtensions(workspace);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ extensions }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/** GET /api/tools — return aggregated tools from active sessions */
async function handleGetTools(
  _req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
): Promise<void> {
  const toolSet = new Set<string>();
  // Collect tool names from all active sessions (captured from child ready event)
  for (const session of sessions.values()) {
    for (const t of session.tools) toolSet.add(t);
  }
  // Fallback: if no session has reported tools yet, use known defaults
  if (toolSet.size === 0) {
    for (const t of [
      "read", "write", "edit", "grep", "find", "ls",
      "math_calc", "web_search", "web_fetch",
    ]) toolSet.add(t);
  }
  const tools = Array.from(toolSet).sort().map((name) => ({ name }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ tools }));
}

// ─── HogAgent Child Process Bridge ────────────────────────────────────────────

function spawnHogAgent(
  sessionId: string,
  user: string,
  workspace: string,
  hogagentPath: string,
): ChildProcess {
  // Filter out env vars — sessionId and workspace are passed via CLI args only
  const { HOGAGENT_SESSION_ID: _, HOGAGENT_WORKSPACE_DIR: __, ...cleanEnv } = process.env as Record<string, string>;
  // Fallback: ensure workspace exists before spawn (first-use default workspace may not be created yet)
  if (!existsSync(workspace)) {
    mkdirSync(workspace, { recursive: true });
  }
  const child = spawn(process.execPath, [hogagentPath, "--mode", "rpc", "--session", sessionId, "--user", user, "--workspace", workspace], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: workspace,
    env: cleanEnv,
  });

  return child;
}

function sendToClient(session: Session, message: ServerMessage): void {
  if (session.ws.readyState === 1 /* OPEN */) {
    session.ws.send(JSON.stringify(message));
  }
}

function forwardLineToClient(session: Session, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const event = JSON.parse(trimmed) as Record<string, unknown>;
    const eventSessionId = typeof event.session_id === "string" ? event.session_id : undefined;
    if ((event.type === "ready" || event.type === "state" || event.type === "agent_start") && eventSessionId) {
      session.activeSessionId = eventSessionId;
    }
    const updatesActiveMode = event.type === "ready" || event.type === "state"
      || (event.type === "session_switched" && eventSessionId && eventSessionId === session.pendingActiveSessionId);
    if (updatesActiveMode
      && (typeof event.mode === "string" || event.mode === null)) {
      session.activeMode = event.mode;
    }
    if (event.type === "agent_start") session.busy = true;
    if (event.type === "orchestration_resuming") {
      session.orchestrating = true;
      session.busy = true;
    }
    if (event.type === "orchestration_completed") session.orchestrating = false;
    if (event.type === "agent_end" && !session.orchestrating) session.busy = false;
    if (event.type === "aborted" || event.type === "abort_completed") {
      session.busy = false;
      session.orchestrating = false;
    }
    if (event.type === "session_switched" && eventSessionId && eventSessionId === session.pendingActiveSessionId) {
      session.activeSessionId = eventSessionId;
      session.pendingActiveSessionId = undefined;
    }
    if (event.type === "error" && event.command_type === "switch_session") {
      session.pendingActiveSessionId = undefined;
    }
    // Capture tool names from the child process ready event
    if (event.type === "ready" && event.capabilities) {
      const caps = event.capabilities as Record<string, unknown>;
      if (Array.isArray(caps.builtin_tools)) {
        session.tools = caps.builtin_tools as string[];
      }
    }
    if ((event.type === "settings_saved" || event.type === "config_reloaded") && Array.isArray(event.builtin_tools)) {
      session.tools = event.builtin_tools as string[];
    }
    // Only the authenticated WebUI receives credentials. Return the actual
    // persisted snapshot, including merge results, after a confirmed save.
    if (event.type === "settings_saved" && event.success === true && typeof event.provider === "string") {
      try { event.settings = loadPersistedSettings(); }
      catch (error) {
        sendToClient(session, { type: "rpc_event", event: {
          type: "error", command_type: "save_settings",
          error: `Settings were saved, but reading them back failed: ${error instanceof Error ? error.message : String(error)}`,
        } });
        return;
      }
    }
    const reconnectFallback = event.type === "ready" && session.reconnectFallback === true;
    const webEvent = event.type === "ready"
      ? {
          ...event,
          _web_connection_id: session.id,
          _web_busy: session.busy,
          ...(reconnectFallback ? { _web_reconnect_fallback: true } : {}),
        }
      : (event.type === "agent_end" || event.type === "aborted" || event.type === "abort_completed")
        ? { ...event, _web_busy: session.busy }
        : event;
    sendToClient(session, { type: "rpc_event", event: webEvent });
    if (reconnectFallback) session.reconnectFallback = false;
  } catch {
    sendToClient(session, {
      type: "error",
      error: `Invalid JSONL from HogAgent: ${trimmed.slice(0, 200)}`,
    });
  }
}

function handleChildOutput(session: Session, chunk: Buffer): void {
  const data = session.stdoutDecoder.write(chunk);
  session.lineBuffer += data;

  let newlineIndex: number;
  while ((newlineIndex = session.lineBuffer.indexOf("\n")) !== -1) {
    const line = session.lineBuffer.slice(0, newlineIndex);
    session.lineBuffer = session.lineBuffer.slice(newlineIndex + 1);
    forwardLineToClient(session, line);
  }
}

function createSession(
  ws: WebSocket,
  user: string,
  workspace: string,
  hogagentPath: string,
  sessionId?: string,
): Session {
  const id = sessionId || crypto.randomUUID();

  const session: Session = {
    id,
    activeSessionId: id,
    activeMode: null,
    busy: false,
    orchestrating: false,
    ws,
    child: null,
    user,
    workspace,
    lineBuffer: "",
    stdoutDecoder: new StringDecoder("utf8"),
    stderrBuffer: "",
    hogagentPath,
    tools: [],
  };

  return session;
}

/** Spawn the HogAgent child process for a session. */
function spawnChildForSession(session: Session): void {
  if (session.child) return;  // Already spawned

  const child = spawnHogAgent(session.id, session.user, session.workspace, session.hogagentPath);
  session.child = child;

  child.stdout?.on("data", (chunk: Buffer) => {
    handleChildOutput(session, chunk);
  });

  // Buffer stderr before ready event for better error reporting on startup failure
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8").trim();
    if (text) {
      session.stderrBuffer += text + "\n";
      sendToClient(session, {
        type: "rpc_event",
        event: { type: "stderr", text },
      });
    }
  });

  child.on("error", (err) => {
    sendToClient(session, {
      type: "error",
      error: `HogAgent process error: ${err.message}`,
    });
  });

  child.on("exit", (code, signal) => {
    sendToClient(session, {
      type: "connection_status",
      status: "disconnected",
    });
    // ws.CLOSED/CLOSING are class constants (3/2, always truthy) — must compare readyState
    if (session.ws.readyState !== session.ws.CLOSED && session.ws.readyState !== session.ws.CLOSING) {
      // Include buffered stderr in error message for startup failures
      const stderrMsg = session.stderrBuffer.trim();
      const errorMsg = stderrMsg
        ? `HogAgent process exited (code=${code ?? "unknown"}): ${stderrMsg}`
        : `HogAgent process exited (code=${code ?? "unknown"}, signal=${signal ?? "none"})`;
      sendToClient(session, {
        type: "rpc_event",
        event: { type: "error", error: errorMsg },
      });
    }
  });
}

function killSession(session: Session): void {
  // Cancel any pending disconnect-grace timer
  if (session.disconnectTimer) {
    clearTimeout(session.disconnectTimer);
    session.disconnectTimer = null;
  }
  const child = session.child;
  if (!child) return;  // Child was never spawned
  // Remove all event listeners BEFORE killing to prevent exit handler
  // from sending events to the (potentially reassigned) session
  child.stdout?.removeAllListeners("data");
  child.stderr?.removeAllListeners("data");
  child.removeAllListeners("error");
  child.removeAllListeners("exit");
  if (child.exitCode === null && child.signalCode === null) {
    if (!child.killed) child.kill("SIGTERM");
    // Force kill after timeout
    const forceKillTimer = setTimeout(() => {
      // killed means a signal was sent, not that the process has exited.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5000);
    forceKillTimer.unref();
    child.once("exit", () => clearTimeout(forceKillTimer));
  }
  session.child = null;
}

// ─── WebSocket Handling ───────────────────────────────────────────────────────

/** Sockets superseded by a reconnect — their close/error handlers must not kill the session's child. */
const replacedSockets = new WeakSet<WebSocket>();

/** Grace period after client disconnect before the child process is killed.
 *  Allows page refreshes / brief network drops to reconnect without losing running tasks. */
const DISCONNECT_GRACE_MS = 60_000;

/** Schedule a delayed kill after client disconnect; cancelled if the client reconnects in time. */
function scheduleDisconnectKill(session: Session, sessions: Map<string, Session>): void {
  if (!session.child) return;
  if (session.disconnectTimer) return;  // Already scheduled
  console.log(`[ws] Client disconnected, keeping session ${session.id} alive for ${DISCONNECT_GRACE_MS / 1000}s grace period`);
  session.disconnectTimer = setTimeout(() => {
    session.disconnectTimer = null;
    console.log(`[ws] Grace period expired for session ${session.id}, killing child`);
    killSession(session);
    sessions.delete(session.id);
  }, DISCONNECT_GRACE_MS);
}

function setupWebSocket(
  wss: WebSocketServer,
  hogagentPath: string,
  sessions: Map<string, Session>,
  onSession: (session: Session) => void,
): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = parseRequestUrl(req);
    const requestedUser = sanitizeUser(url.searchParams.get("user") || "default");
    const explicitWs = url.searchParams.get("workspace") || undefined;
    // Explicit workspace registration keeps its requested user. A normal WebUI
    // connection with stale browser state falls back to the provisioned default.
    const user = explicitWs ? requestedUser : selectRegisteredWebUser(requestedUser);
    let workspace: string;
    let persisted: Record<string, unknown>;
    try {
      workspace = resolveWorkspace(user, explicitWs);
      persisted = loadPersistedSettings();
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", error: err instanceof Error ? err.message : String(err) }));
      ws.close();
      return;
    }
    let session = createSession(ws, user, workspace, hogagentPath);
    onSession(session);

    // Spawn child process immediately on WebSocket connection
    spawnChildForSession(session);

    sendToClient(session, {
      type: "connection_status",
      status: "connected",
    });

    // Send initial ready event with persisted settings so UI can initialize
    // Mark with _serverInit so client can distinguish from HogAgent's ready
    sendToClient(session, {
      type: "rpc_event",
      event: {
        type: "ready",
        session_id: session.activeSessionId,
        _web_connection_id: session.id,
        _web_busy: session.busy,
        _serverInit: true,
        capabilities: {
          systemConfig: getSystemConfigSnapshot(),
          extensions: [],
          builtin_tools: [],
          installed_skills: discoverSkillsSimple(workspace),
          supports_compaction: true,
          supports_sub_agent: true,
          supports_llm_chat: true,
          runtime_context: getRuntimeContextCapability(),
          llmProvider: persisted.provider ? {
            provider: persisted.provider as string,
            baseUrl: (persisted.baseUrl as string) || "",
            apiKey: (persisted.apiKey as string) || "",
            providerApiKeys: (persisted.providerApiKeys as Record<string, string>) || {},
            models: [],
          } : undefined,
          currentModel: (persisted.modelId as string) || undefined,
          thinkingLevel: (persisted.thinkingLevel as string) || undefined,
          auditModel: persisted.audit ? {
            provider: (persisted.audit as Record<string, unknown>).provider as string || undefined,
            modelId: (persisted.audit as Record<string, unknown>).modelId as string || undefined,
            baseUrl: (persisted.audit as Record<string, unknown>).baseUrl as string || undefined,
            apiKey: (persisted.audit as Record<string, unknown>).apiKey as string || undefined,
            minPassScore: (persisted.audit as Record<string, unknown>).minPassScore as number,
            maxIterations: (persisted.audit as Record<string, unknown>).maxIterations as number,
            configured: !!((persisted.audit as Record<string, unknown>).provider && (persisted.audit as Record<string, unknown>).provider !== "close"),
          } : { configured: false },
        },
      },
    });

    async function handleMessage(data: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
      // Reconnection transfers ownership of session.ws. Late messages from the
      // replaced socket must not dispatch commands or report errors to its successor.
      if (replacedSockets.has(ws)) return;
      let raw: string;
      if (Array.isArray(data)) {
        raw = Buffer.concat(data).toString("utf-8");
      } else if (Buffer.isBuffer(data)) {
        raw = data.toString("utf-8");
      } else {
        raw = Buffer.from(data).toString("utf-8");
      }

      let message: BrowserMessage;
      try {
        message = JSON.parse(raw) as BrowserMessage;
      } catch {
        sendToClient(session, { type: "error", error: "Invalid JSON message" });
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)
        || typeof message.type !== "string") {
        sendToClient(session, { type: "error", error: "Message must be an object with a type field" });
        return;
      }

      if (session.transitioning) {
        sendToClient(session, { type: "error", error: "Session is switching; wait for the new session ready event" });
        return;
      }

      // Reconnect to existing session (client reconnection after network interruption)
      if (message.type === "reconnect" && message.session_id) {
        const oldSession = sessions.get(message.session_id);
        if (oldSession && (oldSession.user !== user || oldSession.workspace !== workspace)) {
          sendToClient(session, { type: "error", error: "Requested session belongs to a different WebUI user or workspace" });
          return;
        }
        if (oldSession?.transitioning) {
          sendToClient(session, { type: "error", error: "Requested session is switching; reconnect after it finishes" });
          return;
        }
        if (oldSession?.child && !oldSession.child.killed
          && oldSession.child.exitCode === null && oldSession.child.signalCode === null) {
          if (oldSession === session) return;
          // Found existing session with alive child — reattach
          const oldWs = oldSession.ws;
          // Close old dead ws BEFORE reassigning session to prevent its
          // close/error handler from killing the shared session's child process.
          // Mark the OLD socket as replaced so its own close/error handlers become
          // no-ops (a closure flag here would only affect THIS new socket's handlers).
          replacedSockets.add(oldWs);
          try { oldWs.close(); } catch {}
          // Cancel any pending disconnect-grace kill for the resumed session
          if (oldSession.disconnectTimer) {
            clearTimeout(oldSession.disconnectTimer);
            oldSession.disconnectTimer = null;
          }
          oldSession.ws = ws;
          // Remove the dummy session from map
          sessions.delete(session.id);
          killSession(session);
          // Switch to old session for this closure
          session = oldSession;

          // Existing child callbacks capture the Session object and read its ws
          // dynamically. Reuse them so decoding and stderr diagnostics stay intact.

          // Send connected + ready with existing session_id
          sendToClient(session, { type: "connection_status", status: "connected" });
          const persisted = loadPersistedSettings();
          sendToClient(session, {
            type: "rpc_event",
            event: {
              type: "ready",
              session_id: session.activeSessionId,
              mode: session.activeMode,
              _reconnect: true,  // Mark as reconnect so client preserves state
              _web_connection_id: session.id,
              _web_busy: session.busy,
              capabilities: {
                systemConfig: getSystemConfigSnapshot(),
                extensions: [],
                builtin_tools: session.tools,
                installed_skills: discoverSkillsSimple(workspace),
                supports_compaction: true,
                supports_sub_agent: true,
                supports_llm_chat: true,
                runtime_context: getRuntimeContextCapability(),
                llmProvider: persisted.provider ? {
                  provider: persisted.provider as string,
                  baseUrl: (persisted.baseUrl as string) || "",
                  apiKey: (persisted.apiKey as string) || "",
                  providerApiKeys: (persisted.providerApiKeys as Record<string, string>) || {},
                  models: [],
                } : undefined,
                currentModel: (persisted.modelId as string) || undefined,
                thinkingLevel: (persisted.thinkingLevel as string) || undefined,
              },
            },
          });
          console.log(`[ws] Reconnected to existing session ${session.id}`);
          return;
        }
        // Old session not found or child dead — kill dummy session and spawn fresh one
        console.log(`[ws] Reconnect failed for ${message.session_id}, creating new session`);
        if (oldSession && oldSession !== session) {
          killSession(oldSession);
          sessions.delete(oldSession.id);
        }
        killSession(session);
        sessions.delete(session.id);
        session = createSession(ws, user, workspace, hogagentPath);
        session.reconnectFallback = true;
        onSession(session);
        spawnChildForSession(session);
        sendToClient(session, { type: "connection_status", status: "connected" });
        return;
      }

      if (message.type === "new_session") {
        const previousSession = session;
        previousSession.transitioning = true;
        try {
          console.log(`[ws] new_session: killing old session ${session.id}`);
          // Send graceful shutdown command to old child BEFORE killing,
          // so it can flush session data and complete cleanup callbacks
          if (session.child?.stdin?.writable) {
            try {
              session.child.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
            } catch { /* ignore write errors on dying process */ }
          }
          sendToClient(session, {
            type: "connection_status",
            status: "disconnected",
          });
          // Wait for the child to actually exit (flush session data + shutdown callbacks)
          // before SIGTERM — a fixed 300ms was too short for graceful cleanup.
          if (session.child) {
            const oldChild = session.child;
            await new Promise<void>((r) => {
              const finish = () => {
                clearTimeout(timer);
                oldChild.removeListener("exit", finish);
                r();
              };
              const timer = setTimeout(finish, 1500);
              oldChild.once("exit", finish);
              if (oldChild.exitCode !== null || oldChild.signalCode !== null) finish();
            });
          }
          killSession(session);
          sessions.delete(session.id);
          if (ws.readyState !== ws.OPEN || replacedSockets.has(ws)) return;
          session = createSession(ws, user, workspace, hogagentPath);
          onSession(session);
          // Spawn child process immediately for new session
          spawnChildForSession(session);
          console.log(`[ws] new_session: spawned child for session ${session.id}`);
          sendToClient(session, {
            type: "connection_status",
            status: "connected",
          });
          // Do NOT send premature ready event here.
          // The child process will emit the real ready event when RPC loop starts.
          return;
        } finally {
          previousSession.transitioning = false;
        }
      }

      if (message.type === "rpc_command" && message.command) {
        const commandType = message.command.type as string;

        // Child is always spawned on connection, send command directly
        if (!session.child) {
          sendToClient(session, {
            type: "error",
            error: "HogAgent process not ready",
          });
          return;
        }
        const line = JSON.stringify(message.command) + "\n";
        if (session.child.stdin?.writable) {
          if (commandType === "switch_session" && message.command.read_only !== true
            && typeof message.command.session_id === "string") {
            session.pendingActiveSessionId = message.command.session_id;
          }
          if (commandType === "prompt") {
            session.busy = true;
            if (typeof message.command.text === "string" && message.command.text.trim()
              && isConversationMode(message.command.mode)) {
              // The WebUI sends the selected mode on every prompt. Keep the
              // reconnect snapshot aligned while the child is running.
              session.activeMode = message.command.mode;
            }
          }
          session.child.stdin.write(line);
        } else {
          sendToClient(session, {
            type: "error",
            error: "HogAgent stdin is not writable",
          });
        }
        return;
      }

      sendToClient(session, { type: "error", error: `Unknown message type: ${message.type}` });
    }

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      void handleMessage(data).catch(err => {
        sendToClient(session, { type: "error", error: err instanceof Error ? err.message : String(err) });
      });
    });

    ws.on("close", () => {
      if (replacedSockets.has(ws)) return;  // This ws was superseded by reconnect — do nothing
      // Grace period: don't kill immediately — page refresh / brief drop can reconnect
      scheduleDisconnectKill(session, sessions);
    });

    ws.on("error", () => {
      if (replacedSockets.has(ws)) return;
      console.error("WebSocket transport error");
      scheduleDisconnectKill(session, sessions);
    });
  });
}

// ─── Server Factory ───────────────────────────────────────────────────────────

export interface WebServer {
  server: Server;
  wss: WebSocketServer;
  port: number;
  defaultWorkspace: string;
  sessions: Map<string, Session>;
  shutdown(): Promise<void>;
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const port = options.port ?? DEFAULT_PORT;
  // A supplied WebUI workspace is authoritative for the default user. Without
  // one, preserve the user's registered mapping and create the standard
  // <HOGAGENT_USER_DIR>/workspace only on first use.
  const defaultWorkspace = ensureDefaultUser(options.defaultWorkspace);
  const webJwt = loadWebJwtService();

  const hogagentPath = options.hogagentPath
    ? resolve(options.hogagentPath)
    : resolve(join(PROJECT_ROOT, "dist/bin/hogagent.js"));

  const sessions = new Map<string, Session>();

  const httpServer = createServer((req, res) => {
    let url: URL;
    try {
      url = parseRequestUrl(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request target" }));
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const token = extractBearerToken(req.headers.authorization);
      if (!token || !webJwt.verify(token)) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }
    // API routes (before static files)
    if (url.pathname === "/api/upload" && req.method === "POST") {
      const user = sanitizeUser(url.searchParams.get("user") || "default");
      let workspace: string;
      try { workspace = resolveWorkspace(user); } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      void handleUpload(req, res, workspace);
      return;
    }
    if (url.pathname === "/api/download" && req.method === "GET") {
      const user = sanitizeUser(url.searchParams.get("user") || "default");
      let workspace: string;
      try { workspace = resolveWorkspace(user); } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      void handleDownload(req, res, workspace);
      return;
    }
    if (url.pathname === "/api/search-settings" && req.method === "GET") {
      void handleGetSearchSettings(req, res);
      return;
    }
    if (url.pathname === "/api/search-settings" && req.method === "POST") {
      void handlePostSearchSettings(req, res, sessions);
      return;
    }
    if (url.pathname === "/api/active-search-provider" && req.method === "POST") {
      void handlePostActiveProvider(req, res, sessions);
      return;
    }
    // Users API
    if (url.pathname === "/api/users" && req.method === "GET") {
      void handleGetUsers(req, res);
      return;
    }
    // Themes API — list all themes
    if (url.pathname === "/api/themes" && req.method === "GET") {
      void handleGetThemes(req, res);
      return;
    }
    // User theme API — get/set per-user theme
    if (url.pathname === "/api/user-theme" && req.method === "GET") {
      void handleGetUserTheme(req, res);
      return;
    }
    if (url.pathname === "/api/user-theme" && req.method === "POST") {
      void handlePostUserTheme(req, res);
      return;
    }
    // Skills API — detailed list
    if (url.pathname === "/api/skills" && req.method === "GET") {
      void handleGetSkills(req, res);
      return;
    }
    // Skills install
    if (url.pathname === "/api/skills/install" && req.method === "POST") {
      void handleInstallSkill(req, res);
      return;
    }
    // Skill config — GET/PUT
    const skillConfigMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/config$/);
    if (skillConfigMatch && (req.method === "GET" || req.method === "PUT")) {
      const skillName = decodeApiPathSegment(skillConfigMatch[1]!, res);
      if (skillName === null) return;
      if (req.method === "GET") void handleGetSkillConfig(req, res, skillName);
      else void handleSaveSkillConfig(req, res, skillName, sessions);
      return;
    }
    // Skill delete
    const skillDeleteMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (skillDeleteMatch && req.method === "DELETE") {
      const skillName = decodeApiPathSegment(skillDeleteMatch[1]!, res);
      if (skillName === null) return;
      void handleDeleteSkill(req, res, skillName);
      return;
    }
    // Extensions API
    if (url.pathname === "/api/extensions" && req.method === "GET") {
      void handleGetExtensions(req, res);
      return;
    }
    // Tools API
    if (url.pathname === "/api/tools" && req.method === "GET") {
      void handleGetTools(req, res, sessions);
      return;
    }
    void serveStatic(req, res, url.pathname, webJwt);
  });

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient(info, done) {
      const address = httpServer.address();
      const activePort = typeof address === "object" && address ? address.port : port;
      const allowedOrigins = new Set([
        `http://localhost:${activePort}`,
        `http://127.0.0.1:${activePort}`,
      ]);
      const origin = info.req.headers.origin;
      if (!origin || !allowedOrigins.has(origin)) {
        done(false, 403, "Forbidden");
        return;
      }
      let url: URL;
      try {
        url = parseRequestUrl(info.req);
      } catch {
        done(false, 400, "Bad Request");
        return;
      }
      const token = url.searchParams.get("token");
      if (!token || !webJwt.verify(token)) {
        done(false, 401, "Unauthorized");
        return;
      }
      done(true);
    },
  });

  setupWebSocket(wss, hogagentPath, sessions, (session) => {
    sessions.set(session.id, session);
    // Child may not be spawned yet, so we check before adding listener
    // The exit handler will be added when child is spawned in spawnChildForSession
  });

  return new Promise((resolvePromise, reject) => {
    httpServer.on("error", (err) => {
      reject(err);
    });

    httpServer.listen(port, "127.0.0.1", () => {
      const address = httpServer.address();
      const activePort = typeof address === "object" && address ? address.port : port;
      const serverInstance: WebServer = {
        server: httpServer,
        wss,
        port: activePort,
        defaultWorkspace,
        sessions,
        async shutdown() {
          return new Promise<void>((resolveShutdown) => {
            wss.clients.forEach((client) => {
              client.terminate();
            });
            for (const session of sessions.values()) {
              killSession(session);
            }
            httpServer.close(() => {
              wss.close(() => {
                resolveShutdown();
              });
            });
          });
        },
      };
      resolvePromise(serverInstance);
    });
  });
}
