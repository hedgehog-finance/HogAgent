import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { writePrivateMcpJson } from "./config.ts";
import type { ExternalMcpOperation } from "./types.ts";

const DEFAULT_OPERATION_TTL_MS = 24 * 60 * 60 * 1000;

interface OperationFile {
  schemaVersion: 1;
  operations: ExternalMcpOperation[];
}

function isTerminalStatus(status: ExternalMcpOperation["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function operationPath(sessionTaskDir: string): string {
  mkdirSync(sessionTaskDir, { recursive: true, mode: 0o700 });
  const taskStat = lstatSync(sessionTaskDir);
  if (!taskStat.isDirectory() || taskStat.isSymbolicLink()) {
    throw new Error("MCP operation session directory must be a real directory");
  }
  const taskReal = realpathSync(sessionTaskDir);
  const controlDir = join(taskReal, ".hedgehog");
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const controlStat = lstatSync(controlDir);
  if (!controlStat.isDirectory() || controlStat.isSymbolicLink()) {
    throw new Error("MCP operation control directory must be a real directory");
  }
  const controlReal = realpathSync(controlDir);
  const fromTask = relative(taskReal, controlReal);
  if (fromTask === ".." || fromTask.startsWith(`..${sep}`) || isAbsolute(fromTask)) {
    throw new Error("MCP operation control directory escapes the session directory");
  }
  return join(controlReal, "mcp-operations.json");
}

function isOperation(value: unknown): value is ExternalMcpOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record["operationId"] === "string"
    && typeof record["sessionId"] === "string"
    && typeof record["serverName"] === "string"
    && typeof record["status"] === "string"
    && typeof record["createdAt"] === "string"
    && typeof record["updatedAt"] === "string"
    && typeof record["expiresAt"] === "string";
}

export class ExternalMcpOperationStore {
  private readonly getSessionId: () => string;
  private readonly getSessionTaskDir: () => string;

  constructor(getSessionId: () => string, getSessionTaskDir: () => string) {
    this.getSessionId = getSessionId;
    this.getSessionTaskDir = getSessionTaskDir;
  }

  create(
    operation: Omit<ExternalMcpOperation, "sessionId" | "createdAt" | "updatedAt" | "expiresAt">,
    ttlMs = DEFAULT_OPERATION_TTL_MS,
  ): ExternalMcpOperation {
    const now = new Date();
    const complete: ExternalMcpOperation = {
      ...operation,
      sessionId: this.getSessionId(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    const operations = this.loadCurrent();
    operations.push(complete);
    this.saveCurrent(operations);
    return structuredClone(complete);
  }

  get(operationId: string): ExternalMcpOperation | undefined {
    return this.loadCurrent().find((operation) => operation.operationId === operationId);
  }

  update(operationId: string, patch: Partial<ExternalMcpOperation>): ExternalMcpOperation {
    const operations = this.loadCurrent();
    const index = operations.findIndex((operation) => operation.operationId === operationId);
    if (index < 0) throw new Error(`Unknown MCP operation: ${operationId}`);
    const current = operations[index]!;
    // Terminal operations are immutable. In particular, a Task poll that was
    // already in flight must not resurrect an operation cancelled by abort.
    if (isTerminalStatus(current.status)) return structuredClone(current);
    const next: ExternalMcpOperation = {
      ...current,
      ...patch,
      operationId: current.operationId,
      sessionId: current.sessionId,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    operations[index] = next;
    this.saveCurrent(operations);
    return structuredClone(next);
  }

  listActive(): ExternalMcpOperation[] {
    return this.loadCurrent().filter((operation) =>
      operation.status === "working" || operation.status === "input_required");
  }

  private loadCurrent(): ExternalMcpOperation[] {
    const path = operationPath(this.getSessionTaskDir());
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      const record = parsed as Record<string, unknown>;
      if (record["schemaVersion"] !== 1 || !Array.isArray(record["operations"])) return [];
      const now = Date.now();
      const operations = record["operations"]
        .filter(isOperation)
        .filter((operation) => operation.sessionId === this.getSessionId())
        .filter((operation) => Date.parse(operation.expiresAt) > now);
      if (operations.length !== record["operations"].length) this.saveCurrent(operations);
      return operations;
    } catch {
      return [];
    }
  }

  private saveCurrent(operations: ExternalMcpOperation[]): void {
    const file: OperationFile = { schemaVersion: 1, operations };
    writePrivateMcpJson(operationPath(this.getSessionTaskDir()), file);
  }
}
