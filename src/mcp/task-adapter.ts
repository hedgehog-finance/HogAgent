import type {
  JSONRPCMessage,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/client";

const TASK_METHOD_ALIAS_PREFIX = "io.hogagent.internal.task-extension/";
const TASK_METHODS = new Set(["tasks/get", "tasks/update", "tasks/cancel"]);
const TASK_RESULT_MARKER = "io.hogagent.internal/task-result";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isResponse(message: JSONRPCMessage): message is JSONRPCMessage & {
  id: string | number;
  result: Record<string, unknown>;
} {
  const record = asRecord(message);
  return (typeof record?.["id"] === "string" || typeof record?.["id"] === "number")
    && asRecord(record["result"]) !== undefined;
}

/**
 * Narrow transport projection for the io.modelcontextprotocol/tasks extension.
 *
 * SDK 2.0 intentionally treats the historical core `tasks/*` vocabulary as
 * unavailable on a 2026 connection. The external Tasks extension retains
 * those wire methods, so HogAgent sends internal custom aliases through the
 * SDK and translates only at the transport seam. Task terminal results are
 * lifted into a complete SDK result and restored after validation.
 */
export class ExternalMcpTaskAdapter implements Transport {
  readonly hasPerRequestStream?: boolean;
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];

  private readonly inner: Transport;
  private readonly taskRequestIds = new Set<string | number>();

  constructor(inner: Transport) {
    this.inner = inner;
    this.hasPerRequestStream = inner.hasPerRequestStream;
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.inner.setSupportedProtocolVersions?.(versions);
  }

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => {
      this.onmessage?.(this.projectIncoming(message), extra);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const record = asRecord(message);
    const method = typeof record?.["method"] === "string" ? record["method"] : undefined;
    if (method?.startsWith(TASK_METHOD_ALIAS_PREFIX)) {
      const wireMethod = method.slice(TASK_METHOD_ALIAS_PREFIX.length);
      if (!TASK_METHODS.has(wireMethod)) throw new Error(`Unsupported external MCP Task method: ${wireMethod}`);
      const id = record?.["id"];
      if (typeof id === "string" || typeof id === "number") this.taskRequestIds.add(id);
      await this.inner.send({ ...message, method: wireMethod } as JSONRPCMessage, options);
      return;
    }
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    this.taskRequestIds.clear();
    await this.inner.close();
  }

  private projectIncoming(message: JSONRPCMessage): JSONRPCMessage {
    if (!isResponse(message)) return message;
    const result = message.result;
    const isTaskRequest = this.taskRequestIds.delete(message.id);
    if (result["resultType"] === "task") {
      return {
        ...message,
        result: {
          ...result,
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "private",
          content: Array.isArray(result["content"]) ? result["content"] : [],
          [TASK_RESULT_MARKER]: true,
        },
      } as JSONRPCMessage;
    }
    if (isTaskRequest && result["resultType"] !== "input_required") {
      return {
        ...message,
        result: {
          ...result,
          resultType: "complete",
          ttlMs: typeof result["ttlMs"] === "number" ? result["ttlMs"] : 0,
          cacheScope: result["cacheScope"] === "public" ? "public" : "private",
        },
      } as JSONRPCMessage;
    }
    return message;
  }
}

export function externalMcpTaskSdkMethod(method: string): string {
  if (!TASK_METHODS.has(method)) return method;
  return `${TASK_METHOD_ALIAS_PREFIX}${method}`;
}

export function isProjectedExternalMcpTaskResult(value: unknown): boolean {
  return asRecord(value)?.[TASK_RESULT_MARKER] === true;
}
