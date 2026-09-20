/** Standalone workspace instruction initialization and versioned updates. */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STANDALONE_AGENTS_TEMPLATE, STANDALONE_AGENTS_VERSION } from "./standalone-agents-template.ts";

const MANAGED_START = "<!-- hogagent:managed-agents:start -->";
const MANAGED_END = "<!-- hogagent:managed-agents:end -->";
const USER_SECTION = "\n\n# User Rules / 用户自定义规则\n\n";

function versionParts(version: string): bigint[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Invalid HogAgent AGENTS.md template version: ${version}`);
  }
  return version.split(".").map(BigInt);
}

/** Preserve all user text outside our markers, including legacy unmarked files. */
export function mergeStandaloneAgents(existing?: string): string {
  const managed = `${MANAGED_START}\n${STANDALONE_AGENTS_TEMPLATE.trimEnd()}\n${MANAGED_END}`;
  if (existing === undefined || (!existing.includes(MANAGED_START) && !existing.includes(MANAGED_END))) {
    return managed + USER_SECTION + (existing ?? "<!-- Add personal rules here. Everything after the managed section survives template upgrades. -->\n");
  }

  const starts = [...existing.matchAll(/^(?:\uFEFF)?<!-- hogagent:managed-agents:start -->\r?$/gm)];
  const ends = [...existing.matchAll(/^<!-- hogagent:managed-agents:end -->\r?$/gm)];
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index! >= ends[0].index!) {
    throw new Error("Invalid HogAgent AGENTS.md managed markers; restore one complete section before retrying. The file was not changed.");
  }
  const start = starts[0].index! + (starts[0][0].startsWith("\uFEFF") ? 1 : 0);
  const end = ends[0].index! + MANAGED_END.length;
  const versions = [...existing.slice(start, end).matchAll(/^version: (\S+)\r?$/gm)];
  if (versions.length !== 1) {
    throw new Error("Missing or ambiguous HogAgent AGENTS.md template version. The file was not changed.");
  }
  const installed = versionParts(versions[0][1]);
  const bundled = versionParts(STANDALONE_AGENTS_VERSION);
  const difference = installed.findIndex((part, i) => part !== bundled[i]);
  // Preserve same-version edits and never downgrade a workspace opened by a newer HogAgent.
  if (difference === -1 || installed[difference] > bundled[difference]) return existing;
  return existing.slice(0, start) + managed + existing.slice(end);
}

function readExisting(path: string): { content: string; mode: number } | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`Refusing to replace non-regular workspace instructions: ${path}`);
    return { content: readFileSync(path, "utf8"), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Called on standalone workspace selection and agent startup, before instruction snapshots. */
export function ensureStandaloneAgents(workspaceDir: string): void {
  // The host owns managed workspace instructions. Do not read or modify them here.
  if (process.env["HOGAGENT_GATEWAY_MANAGED"] === "1") return;

  const path = join(workspaceDir, "AGENTS.md");
  const existing = readExisting(path);
  const next = mergeStandaloneAgents(existing?.content);
  if (next === existing?.content) return;

  mkdirSync(workspaceDir, { recursive: true });
  const temporary = join(workspaceDir, `.AGENTS.md.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, next, { encoding: "utf8", flag: "wx", mode: existing?.mode ?? 0o600 });
    if (readExisting(path)?.content !== existing?.content) {
      throw new Error(`Workspace instructions changed during initialization: ${path}. Retry startup; the file was not replaced.`);
    }
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
