/**
 * Built-in Tools (Pi-compatible)
 *
 * Implements file operation tools following the Pi AgentTool interface:
 * read, write, edit, bash, grep, find, ls
 *
 * These replace the old monolithic file_ops tool.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "../vendor/agent/types.ts";
import { truncateHead, truncateTail, formatSize } from "../vendor/agent/harness/utils/truncate.ts";
import type { BashRuntime } from "./bash-sandbox.ts";
export { getShellCandidates } from "./shell-command.ts";
import type { HogAgentConfig } from "../utils/types.ts";
import {
  prepareArtifactMutation,
  recordArtifactRoleForConfig,
  validateArtifactRole,
  recordArtifactWrite,
  type ArtifactRole,
} from "../artifacts/artifact-protocol.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: undefined };
}

function errorResult(msg: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: `Error: ${msg}` }], details: { error: msg } };
}

function resolveCwd(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

// ─── Read Tool ────────────────────────────────────────────────────────────────

const ReadParams = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative to CWD or absolute)" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Original file line to start at (1-based); use the returned next offset to continue reading" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum requested lines; output is still capped at 2000 lines or 50 KiB. Omitting this does not guarantee the whole file" })),
  section: Type.Optional(Type.String({ description: "Markdown heading to extract (e.g., '## Installation'); overrides offset/limit. Oversized sections require locating and reading original file line ranges instead" })),
  raw: Type.Optional(Type.Boolean({ description: "Skip optional tool-result compression; no extra effect when compression is off. Never bypasses the 2000-line / 50-KiB read limit" })),
});

export function createReadTool(cwdOrGetter: string | (() => string)): AgentTool {
  const getCwd = typeof cwdOrGetter === "function" ? cwdOrGetter : () => cwdOrGetter;
  return {
    name: "read",
    label: "Read File",
    description: "Read file text by original line range or Markdown section. Output including line numbers is capped at 2000 lines or 50 KiB; follow the next offset to continue. Read Skill instructions completely, continuing to EOF when truncated. raw never bypasses these limits.",
    parameters: ReadParams,
    execute: async (_id, rawParams) => {
      const params = rawParams as Static<typeof ReadParams>;
      const filePath = resolveCwd(getCwd(), params.path);
      try {
        if ([params.offset, params.limit].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) {
          return errorResult("offset and limit must be positive integers");
        }
        await access(filePath);
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n");

        // Section extraction for markdown files
        if (params.section) {
          const sectionContent = extractMarkdownSection(content, params.section);
          if (sectionContent === null) {
            return errorResult(`Section not found: "${params.section}"`);
          }
          const sectionLines = sectionContent.split("\n");
          const numbered = sectionLines.map((line, i) => `${i + 1}│${line}`).join("\n");
          if (truncateHead(numbered).truncated) {
            return errorResult("Section exceeds the 2000-line / 50-KiB read limit. Use grep to locate its original file lines, then read with offset and limit. raw does not bypass this limit.");
          }
          return textResult(`File: ${params.path} — Section: ${params.section} (${sectionLines.length} lines)\n\n${numbered}`);
        }

        const offset = Math.max(0, (params.offset ?? 1) - 1);
        if (offset >= lines.length) return errorResult(`offset ${offset + 1} is beyond EOF (${lines.length} lines)`);
        const limit = params.limit ?? lines.length;
        const slice = lines.slice(offset, offset + limit);

        const numbered = slice.map((line, i) => `${offset + i + 1}│${line}`).join("\n");
        const header = `File: ${params.path} (${lines.length} lines total)`;
        const truncated = truncateHead(numbered);
        if (truncated.firstLineExceedsLimit) {
          return errorResult(`Line ${offset + 1} exceeds the 50-KiB read limit. Use an available Bash/script tool to extract only the required fields or text. raw does not bypass this limit.`);
        }
        const end = offset + truncated.outputLines;
        const rangeInfo = params.offset !== undefined || params.limit !== undefined || truncated.truncated
          ? `\nShowing lines ${offset + 1}-${end}` : "";
        const next = end < lines.length
          ? `\n\n[${truncated.truncated ? "Output truncated. " : ""}Continue: read(path=${JSON.stringify(params.path)}, offset=${end + 1}, limit=${Math.min(params.limit ?? 2000, 2000)}). Read all remaining pages for complete Skill instructions.]`
          : "";
        return {
          content: [{ type: "text", text: `${header}${rangeInfo}\n\n${truncated.content}${next}` }],
          details: truncated.truncated ? { truncated: true, skipCompress: true } : undefined,
        };
      } catch (err) {
        return errorResult(`Cannot read file: ${(err as Error).message}`);
      }
    },
  };
}

/** Extract content under a markdown heading until next heading of same or higher level. */
function extractMarkdownSection(content: string, heading: string): string | null {
  const lines = content.split("\n");
  const headingLevel = heading.match(/^(#{1,6})\s/)?.[1].length ?? 0;
  const normalizedHeading = heading.replace(/^#{1,6}\s*/, "").trim().toLowerCase();

  let startIdx = -1;
  let sectionLevel = headingLevel;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (!match) continue;

    const level = match[1].length;
    const text = match[2]!.trim().toLowerCase();

    if (startIdx === -1) {
      // Looking for the target heading (match by text content, ignore level if no level specified)
      if (text === normalizedHeading || line.trim().toLowerCase() === heading.trim().toLowerCase()) {
        startIdx = i;
        sectionLevel = level;
      }
    } else {
      // Found start, look for end (next heading of same or higher level)
      if (level <= sectionLevel) {
        return lines.slice(startIdx + 1, i).join("\n").trim();
      }
    }
  }

  // Found heading but no subsequent heading → read to EOF
  if (startIdx !== -1) {
    return lines.slice(startIdx + 1).join("\n").trim();
  }

  return null;
}

// ─── Write Tool ───────────────────────────────────────────────────────────────

const WriteParams = Type.Object({
  path: Type.String({ description: "Path to write the file (relative to CWD or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
  append: Type.Optional(Type.Boolean({ description: "Append to file instead of overwriting (default: false)" })),
  artifact_role: Type.Optional(Type.Union([
    Type.Literal("intermediate"),
    Type.Literal("raw_data"),
    Type.Literal("regular"),
    Type.Literal("deliverable"),
  ], { description: "Explicit Manifest role for the written file" })),
  artifact_update_mode: Type.Optional(Type.Union([
    Type.Literal("in_place"),
    Type.Literal("new_version"),
  ], { description: "Per-operation update-mode suggestion for an existing regular or deliverable file; a locked run policy overrides it" })),
});

export function createWriteTool(cwdOrGetter: string | (() => string), getArtifactConfig?: () => HogAgentConfig): AgentTool {
  const getCwd = typeof cwdOrGetter === "function" ? cwdOrGetter : () => cwdOrGetter;
  return {
    name: "write",
    label: "Write File",
    description: "Create or overwrite a file. Automatically creates parent directories. Use append: true to append.",
    parameters: WriteParams,
    execute: async (_id, rawParams) => {
      const params = rawParams as Static<typeof WriteParams>;
      const requestedPath = resolveCwd(getCwd(), params.path);
      try {
        const config = getArtifactConfig?.();
        if (config && params.artifact_role) {
          const error = validateArtifactRole(config, requestedPath, params.artifact_role as ArtifactRole);
          if (error) return errorResult(error);
        }
        const mutation = config
          ? prepareArtifactMutation(requestedPath, config, params.artifact_update_mode)
          : { ok: true as const, path: requestedPath, versioned: false, forced: false };
        if (!mutation.ok) return errorResult(mutation.error);
        const filePath = mutation.path;
        await mkdir(dirname(filePath), { recursive: true });
        if (mutation.versioned && params.append && !existsSync(filePath)) {
          const previousContent = await readFile(requestedPath, "utf-8");
          await writeFile(filePath, previousContent + params.content, { flag: "w" });
        } else {
          await writeFile(filePath, params.content, { flag: params.append ? "a" : "w" });
        }
        if (config) recordArtifactWrite(config, filePath, requestedPath);
        if (config && params.artifact_role) {
          try { recordArtifactRoleForConfig(config, filePath, params.artifact_role as ArtifactRole); }
          catch (error) { return errorResult(`File written to ${filePath}, but artifact role registration failed: ${String(error)}. Do not repeat the write.`); }
        }
        const lineCount = params.content.split("\n").length;
        const action = params.append ? "Appended to" : "Wrote";

        // Enhanced confirmation for JSON arrays: show record count
        if (filePath.endsWith(".json") && params.content.length > 500) {
          try {
            const parsed = JSON.parse(params.content);
            if (Array.isArray(parsed)) {
              return textResult(`${action} ${mutation.versioned ? filePath : params.path} (${parsed.length} records, ${params.content.length} bytes)`);
            }
          } catch { /* not valid JSON, fall through */ }
        }

        return textResult(`${action} ${mutation.versioned ? filePath : params.path} (${lineCount} lines, ${params.content.length} bytes)${mutation.versioned ? " [new version]" : ""}${mutation.forced ? ` [run policy forced ${mutation.effectiveMode}]` : ""}`);
      } catch (err) {
        return errorResult(`Cannot write file: ${(err as Error).message}`);
      }
    },
  };
}

// ─── Edit Tool ────────────────────────────────────────────────────────────────

const EditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit" }),
  old_text: Type.String({ description: "Exact text to find and replace" }),
  new_text: Type.String({ description: "Replacement text" }),
  artifact_update_mode: Type.Optional(Type.Union([
    Type.Literal("in_place"),
    Type.Literal("new_version"),
  ], { description: "Per-operation update-mode suggestion for this existing regular or deliverable file; a locked run policy overrides it" })),
});

export function createEditTool(cwdOrGetter: string | (() => string), getArtifactConfig?: () => HogAgentConfig): AgentTool {
  const getCwd = typeof cwdOrGetter === "function" ? cwdOrGetter : () => cwdOrGetter;
  return {
    name: "edit",
    label: "Edit File",
    description: "Edit a file by replacing an exact text snippet with new text. The old_text must match exactly.",
    parameters: EditParams,
    execute: async (_id, rawParams) => {
      const params = rawParams as Static<typeof EditParams>;
      const requestedPath = resolveCwd(getCwd(), params.path);
      try {
        const config = getArtifactConfig?.();
        const mutation = config
          ? prepareArtifactMutation(requestedPath, config, params.artifact_update_mode)
          : { ok: true as const, path: requestedPath, versioned: false, forced: false };
        if (!mutation.ok) return errorResult(mutation.error);
        const filePath = mutation.path;
        const content = await readFile(existsSync(filePath) ? filePath : requestedPath, "utf-8");
        if (!content.includes(params.old_text)) {
          return errorResult(`old_text not found in ${params.path}. Make sure it matches exactly.`);
        }
        const count = content.split(params.old_text).length - 1;
        if (count > 1) {
          return errorResult(`old_text appears ${count} times in ${params.path}. Please use a more specific snippet.`);
        }
        const newContent = content.replace(params.old_text, params.new_text);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, newContent);
        if (config) recordArtifactWrite(config, filePath, requestedPath);
        return textResult(`Edited ${mutation.versioned ? filePath : params.path}: replaced ${params.old_text.split("\n").length} lines with ${params.new_text.split("\n").length} lines${mutation.versioned ? " [new version]" : ""}${mutation.forced ? ` [run policy forced ${mutation.effectiveMode}]` : ""}`);
      } catch (err) {
        return errorResult(`Cannot edit file: ${(err as Error).message}`);
      }
    },
  };
}

// ─── Bash Tool ────────────────────────────────────────────────────────────────

const MAX_BASH_BUFFER = 100 * 1024; // 100KB rolling buffer to prevent OOM
let bashOutputCounter = 0;

const BashParams = Type.Object({
  command: Type.String({
    description: "Single-line shell command. Use named arguments for safe flat scalars; use a unique UTF-8 tmp-*.json parameter file for complex values. Never inline nested JSON.",
  }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
});

function getBashDescription(runtime: BashRuntime): string {
  const shellList = runtime.shells.map((shell) => basename(shell)).join(" → ");
  if (runtime.unrestrictedByPlatform) {
    return "Execute a shell command in platform-required UNSANDBOXED mode. "
      + "Windows does not support the HogAgent file sandbox, so sandboxMode has no effect and child processes have unrestricted filesystem access with HogAgent process permissions. cmd.exe is not supported. Keep commands on one line. Use named arguments for safe flat scalars; for complex values create a unique UTF-8 tmp-*.json with the write tool and use the Skill's documented file option. Never inline nested JSON or mix payload sources. "
      + `Shell: ${shellList}. Timeout default is 30s.`;
  }
  if (runtime.unrestrictedByConfiguration) {
    return "Execute a shell command in operator-configured UNSANDBOXED mode. "
      + "The command and all child processes have unrestricted filesystem access with HogAgent process permissions. "
      + `Shell: ${shellList}. Timeout default is 30s.`;
  }
  if (runtime.backend === "bare-shell") {
    const pythonStatus = runtime.pythonEnvironment
      ? "The managed Python environment remains available. "
      : "The managed Python environment is unavailable. ";
    return "Execute a shell command in degraded UNSANDBOXED mode. "
      + "Sandbox initialization failed, so the command and all child processes have unrestricted filesystem access. "
      + pythonStatus
      + `Shell: ${shellList}. Timeout default is 30s.`;
  }
  return "Execute a shell command inside the operating-system file sandbox. "
    + "File writes use the configured writable runtime grants: workspace, Gateway user projects when supplied, managed temporary and Python paths. Business CWD remains workspace. "
    + `Backend: ${runtime.backend}. Shell: ${shellList}. Timeout default is 30s.`;
}

export function createBashTool(runtime: BashRuntime, getTaskDir?: () => string): AgentTool {
  return {
    name: "bash",
    label: "Bash",
    description: getBashDescription(runtime),
    parameters: BashParams,
    execute: async (_id, rawParams, signal?: AbortSignal) => {
      const params = rawParams as Static<typeof BashParams>;
      const timeout = params.timeout ?? 30000;

      return new Promise<AgentToolResult<unknown>>((resolve) => {
        const candidates = runtime.shells;
        let currentChild: ReturnType<typeof spawn> | undefined;

        const runCandidate = (index: number): void => {
          const candidate = candidates[index];
          if (!candidate) {
            resolve(errorResult(`Command failed: no shell found (${candidates.join(", ")})`));
            return;
          }

          let settled = false;
          let stdout = "";
          let stderr = "";
          let stdoutOverflow = false;
          let stderrOverflow = false;

          const spawnSpec = runtime.buildSpawn(candidate, params.command);
          const child = spawn(spawnSpec.command, spawnSpec.args, {
            cwd: spawnSpec.cwd,
            env: spawnSpec.env,
            timeout,
            windowsHide: true,
          });
          currentChild = child;

          child.stdout?.setEncoding("utf8");
          child.stderr?.setEncoding("utf8");
          child.stdout?.on("data", (chunk: string) => {
            if (!stdoutOverflow) {
              stdout += chunk;
              if (stdout.length > MAX_BASH_BUFFER) {
                stdoutOverflow = true;
              }
            }
          });
          child.stderr?.on("data", (chunk: string) => {
            if (!stderrOverflow) {
              stderr += chunk;
              if (stderr.length > MAX_BASH_BUFFER) {
                stderrOverflow = true;
              }
            }
          });

          child.on("close", (code) => {
            if (settled) return;
            settled = true;
            const parts: string[] = [];

            if (stdout) {
              const truncation = truncateTail(stdout);
              if (truncation.truncated) {
                let fullOutputPath: string | undefined;
                const taskDir = getTaskDir?.();
                if (taskDir) {
                  try {
                    mkdirSync(taskDir, { recursive: true });
                    fullOutputPath = join(taskDir, `bash-output-${++bashOutputCounter}.log`);
                    writeFileSync(fullOutputPath, stdout, "utf-8");
                  } catch { /* ignore write errors */ }
                }
                const hint = fullOutputPath
                  ? `\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} captured lines (${formatSize(truncation.totalBytes)}). Captured output (~100KB): ${fullOutputPath}]`
                  : `\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.totalBytes)})]`;
                parts.push(truncation.content + hint);
              } else {
                parts.push(stdout);
              }
            }

            if (stderr) {
              const stderrTrunc = truncateTail(stderr);
              parts.push(`[stderr]\n${stderrTrunc.content}${stderrTrunc.truncated ? "\n[stderr truncated]" : ""}`);
            }
            if (code !== 0) parts.push(`[exit code: ${code}]`);
            resolve(textResult(parts.join("\n") || "(no output)"));
          });

          child.on("error", (err: NodeJS.ErrnoException) => {
            if (settled) return;
            settled = true;
            if (err.code === "ENOENT" && index + 1 < candidates.length) {
              runCandidate(index + 1);
              return;
            }
            resolve(errorResult(`Command failed: ${err.message}`));
          });
        };

        if (signal) {
          signal.addEventListener("abort", () => currentChild?.kill(), { once: true });
        }

        runCandidate(0);
      });
    },
  };
}

// ─── Grep Tool ────────────────────────────────────────────────────────────────

const GrepParams = Type.Object({
  pattern: Type.String({ description: "Regex pattern to search for" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search in (default: CWD)" })),
  include: Type.Optional(Type.String({ description: "File glob pattern to include (e.g., '*.ts')" })),
});

// Skip files above this size so grep performance is not dominated by large files.
const GREP_MAX_FILE_SIZE = 2 * 1024 * 1024;

export function createGrepTool(cwdOrGetter: string | (() => string)): AgentTool {
  const getCwd = typeof cwdOrGetter === "function" ? cwdOrGetter : () => cwdOrGetter;
  return {
    name: "grep",
    label: "Grep",
    description: "Search file contents using regex. Returns matching lines with file paths and line numbers.",
    parameters: GrepParams,
    execute: async (_id, rawParams) => {
      const params = rawParams as Static<typeof GrepParams>;
      const cwd = getCwd();
      const searchPath = params.path ? resolveCwd(cwd, params.path) : cwd;
      try {
        const regex = new RegExp(params.pattern);
        const includeRegex = params.include ? globToRegExp(params.include) : null;
        const matches: string[] = [];

        for (const filePath of listFiles(searchPath)) {
          if (includeRegex && !includeRegex.test(basename(filePath))) continue;
          // Skip files larger than 2 MB, usually binaries, logs, or lockfiles, to avoid slowing grep with full reads.
          try {
            if (statSync(filePath).size > GREP_MAX_FILE_SIZE) continue;
          } catch {
            continue;
          }
          let content: string;
          try {
            content = readFileSync(filePath, "utf-8");
          } catch {
            continue;
          }
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            if (regex.test(line)) {
              regex.lastIndex = 0;
              const rel = relative(cwd, filePath) || basename(filePath);
              matches.push(`${rel}:${i + 1}:${line}`);
              if (matches.length >= 100) {
                return textResult(`${matches.join("\n")}\n[... truncated to 100 matches]`);
              }
            }
          }
        }

        return textResult(matches.join("\n") || "No matches found.");
      } catch (err) {
        return errorResult(`grep failed: ${(err as Error).message}`);
      }
    },
  };
}

// ─── Find Tool ────────────────────────────────────────────────────────────────

const FindParams = Type.Object({
  pattern: Type.String({ description: "File name glob pattern (e.g., '*.ts', 'config*')" }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: CWD)" })),
});

export function createFindTool(cwdOrGetter: string | (() => string)): AgentTool {
  const getCwd = typeof cwdOrGetter === "function" ? cwdOrGetter : () => cwdOrGetter;
  return {
    name: "find",
    label: "Find Files",
    description: "Find files by name pattern using glob matching. Returns paths relative to CWD.",
    parameters: FindParams,
    execute: async (_id, rawParams) => {
      const params = rawParams as Static<typeof FindParams>;
      const cwd = getCwd();
      const searchPath = params.path ? resolveCwd(cwd, params.path) : cwd;
      try {
        const pattern = globToRegExp(params.pattern);
        const results = listFiles(searchPath)
          .filter((filePath) => pattern.test(basename(filePath)))
          .map((filePath) => relative(cwd, filePath) || basename(filePath))
          .slice(0, 200);
        const truncated = results.length >= 200 ? "\n[... truncated to 200 results]" : "";
        return textResult(results.join("\n") + truncated || "No files found.");
      } catch (err) {
        return errorResult(`find failed: ${(err as Error).message}`);
      }
    },
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

function listFiles(rootPath: string): string[] {
  const rootStat = statSync(rootPath);
  if (rootStat.isFile()) return [rootPath];
  if (!rootStat.isDirectory()) return [];

  const files: string[] = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

// ─── Ls Tool ──────────────────────────────────────────────────────────────────

const LsParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: CWD)" })),
});

export function createLsTool(cwdOrGetter: string | (() => string)): AgentTool {
  const getCwd = typeof cwdOrGetter === "function" ? cwdOrGetter : () => cwdOrGetter;
  return {
    name: "ls",
    label: "List Directory",
    description: "List directory contents with file types and sizes.",
    parameters: LsParams,
    execute: async (_id, rawParams) => {
      const params = rawParams as Static<typeof LsParams>;
      const cwd = getCwd();
      const dirPath = params.path ? resolveCwd(cwd, params.path) : cwd;
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        const lines = entries.map(entry => {
          const fullPath = join(dirPath, entry.name);
          if (entry.isDirectory()) {
            return `📁 ${entry.name}/`;
          }
          try {
            const stat = statSync(fullPath);
            const size = stat.size < 1024 ? `${stat.size}B`
              : stat.size < 1048576 ? `${(stat.size / 1024).toFixed(1)}KB`
              : `${(stat.size / 1048576).toFixed(1)}MB`;
            return `📄 ${entry.name} (${size})`;
          } catch {
            return `📄 ${entry.name}`;
          }
        });
        const relPath = relative(cwd, dirPath) || ".";
        return textResult(`Directory: ${relPath}\n\n${lines.join("\n")}`);
      } catch (err) {
        return errorResult(`Cannot list directory: ${(err as Error).message}`);
      }
    },
  };
}

// ─── All Built-in Tools ───────────────────────────────────────────────────────

/**
 * Create all built-in tools for the given working directory.
 * File tools use this directory as their default CWD. Bash is included only when
 * a previously prepared sandboxed or explicitly degraded runtime is supplied.
 * @param cwdOrGetter - Base working directory (or dynamic getter), typically workspaceDir
 * @param getTaskDir - Optional getter for session task directory (used by bash for overflow output files)
 */
export function createBuiltinTools(
  cwdOrGetter: string | (() => string),
  getTaskDir?: () => string,
  bashRuntime?: BashRuntime,
  getArtifactConfig?: () => HogAgentConfig,
): AgentTool[] {
  const tools = [
    createReadTool(cwdOrGetter),
    createWriteTool(cwdOrGetter, getArtifactConfig),
    createEditTool(cwdOrGetter, getArtifactConfig),
    createGrepTool(cwdOrGetter),
    createFindTool(cwdOrGetter),
    createLsTool(cwdOrGetter),
  ];
  if (bashRuntime) tools.splice(3, 0, createBashTool(bashRuntime, getTaskDir));
  return tools;
}
