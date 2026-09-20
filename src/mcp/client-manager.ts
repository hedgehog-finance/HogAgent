import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  type ClientCapabilities,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { createLogger } from "../utils/logger.ts";
import type { AgentToolResult } from "../vendor/agent/types.ts";
import {
  loadEffectiveExternalMcpServers,
  type EffectiveExternalMcpServer,
  type ExternalMcpConfig,
  loadSystemExternalMcpConfig,
  saveSystemExternalMcpConfig,
} from "./config.ts";
import { ExternalMcpCatalogCache, fingerprintExternalMcpServer, fingerprintExternalMcpConnection } from "./catalog-cache.ts";
import { ExternalMcpOperationStore } from "./operation-store.ts";
import {
  ExternalMcpTaskAdapter,
  externalMcpTaskSdkMethod,
  isProjectedExternalMcpTaskResult,
} from "./task-adapter.ts";
import type {
  ExternalMcpCatalog,
  ExternalMcpOperation,
  ExternalMcpProbeResult,
  ExternalMcpPromptCatalogEntry,
  ExternalMcpResourceCatalogEntry,
  ExternalMcpResourceTemplateCatalogEntry,
  ExternalMcpToolCatalogEntry,
} from "./types.ts";

const log = createLogger("external-mcp");
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const CATALOG_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CONNECT_MS = 10_000;
const DEFAULT_CALL_MS = 60_000;
const DEFAULT_TASK_FOREGROUND_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_TASK_POLL_MS = 1_000;
const MAX_TASK_POLL_MS = 5_000;

type PassthroughSchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "hogagent";
    readonly validate: (value: unknown) => { value: unknown };
  };
};

const PASSTHROUGH_SCHEMA: PassthroughSchema = {
  "~standard": {
    version: 1,
    vendor: "hogagent",
    validate: (value: unknown) => ({ value }),
  },
};

export type ExternalMcpConnectionStatus = "disabled" | "disconnected" | "connecting" | "connected" | "error";

export interface ExternalMcpServerView {
  config: EffectiveExternalMcpServer;
  status: ExternalMcpConnectionStatus;
  error?: string;
  catalog?: ExternalMcpCatalog;
}

export class ExternalMcpClientError extends Error {
  readonly code: "CONFIG" | "CONNECTION" | "PROTOCOL" | "AUTH" | "TIMEOUT" | "FORBIDDEN" | "NOT_FOUND" | "REMOTE";

  constructor(code: ExternalMcpClientError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExternalMcpClientError";
    this.code = code;
  }
}

interface ClientRuntime {
  config: EffectiveExternalMcpServer;
  client?: Client;
  transport?: Transport;
  connecting?: Promise<Client>;
  status: ExternalMcpConnectionStatus;
  error?: string;
  activeCount: number;
  waiters: Array<() => void>;
  closing: boolean;
}

interface CachedCatalog {
  catalog: ExternalMcpCatalog;
  expiresAt: number;
}

interface InvocationOptions {
  signal?: AbortSignal;
  readOnly?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

function isAllowed(name: string, allowlist: string[]): boolean {
  return allowlist.includes("*") || allowlist.includes(name);
}

function isResourceAllowed(uri: string, prefixes: string[]): boolean {
  return prefixes.includes("*") || prefixes.some((prefix) => uri.startsWith(prefix));
}

function templateAuthorizationUri(uriTemplate: string): string {
  const brace = uriTemplate.indexOf("{");
  return brace < 0 ? uriTemplate : uriTemplate.slice(0, brace);
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function normalizeMcpError(error: unknown): ExternalMcpClientError {
  if (error instanceof ExternalMcpClientError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return new ExternalMcpClientError("AUTH", "External MCP authentication failed", { cause: error });
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return new ExternalMcpClientError("TIMEOUT", "External MCP request timed out", { cause: error });
  }
  if (lower.includes("protocol") || lower.includes("json-rpc") || lower.includes("schema")) {
    return new ExternalMcpClientError("PROTOCOL", "External MCP protocol error", { cause: error });
  }
  return new ExternalMcpClientError("REMOTE", "External MCP request failed", { cause: error });
}

function isConnectionFailure(error: ExternalMcpClientError): boolean {
  return error.code === "CONNECTION" || error.code === "TIMEOUT";
}

function resolvedTimeouts(server: EffectiveExternalMcpServer) {
  return {
    connectMs: server.timeouts?.connectMs ?? DEFAULT_CONNECT_MS,
    callMs: server.timeouts?.callMs ?? DEFAULT_CALL_MS,
    taskForegroundMs: server.timeouts?.taskForegroundMs ?? DEFAULT_TASK_FOREGROUND_MS,
  };
}

function resolveRequiredEnv(envName: string, purpose: string): string {
  const value = process.env[envName];
  if (value === undefined || value.length === 0) {
    throw new ExternalMcpClientError("CONFIG", `Environment variable ${envName} required for ${purpose} is not set`);
  }
  return value;
}

function projectContentBlock(block: unknown): { content: AgentToolResult<unknown>["content"]; detail: unknown } {
  const record = asRecord(block);
  if (!record) return { content: [{ type: "text", text: "[Unsupported MCP content]" }], detail: block };
  const type = asString(record["type"]);
  if (type === "text") {
    return { content: [{ type: "text", text: asString(record["text"]) ?? "" }], detail: block };
  }
  if (type === "image" && typeof record["data"] === "string" && typeof record["mimeType"] === "string") {
    return {
      content: [{ type: "image", data: record["data"], mimeType: record["mimeType"] }],
      detail: block,
    };
  }
  if (type === "audio") {
    return {
      content: [{ type: "text", text: `[MCP audio content: ${asString(record["mimeType"]) ?? "unknown type"}]` }],
      detail: block,
    };
  }
  if (type === "resource_link") {
    const name = asString(record["name"]) ?? "resource";
    const uri = asString(record["uri"]) ?? "unknown URI";
    return { content: [{ type: "text", text: `[MCP resource: ${name}] ${uri}` }], detail: block };
  }
  if (type === "resource") {
    const resource = asRecord(record["resource"]);
    if (resource && typeof resource["text"] === "string") {
      return { content: [{ type: "text", text: resource["text"] }], detail: block };
    }
    if (
      resource
      && typeof resource["blob"] === "string"
      && typeof resource["mimeType"] === "string"
      && resource["mimeType"].startsWith("image/")
    ) {
      return {
        content: [{ type: "image", data: resource["blob"], mimeType: resource["mimeType"] }],
        detail: block,
      };
    }
    return {
      content: [{ type: "text", text: `[Embedded MCP resource: ${asString(resource?.["uri"]) ?? "unknown URI"}]` }],
      detail: block,
    };
  }
  return { content: [{ type: "text", text: `[Unsupported MCP content type: ${type ?? "unknown"}]` }], detail: block };
}

export function projectExternalMcpResult(value: unknown): AgentToolResult<unknown> {
  const record = asRecord(value);
  if (record?.["isError"] === true) {
    return {
      content: [{ type: "text", text: "External MCP server returned an error" }],
      details: { isError: true },
    };
  }
  const blocks = Array.isArray(record?.["content"])
    ? record["content"] as unknown[]
    : Array.isArray(record?.["contents"])
      ? (record["contents"] as unknown[]).map((resource) => ({ type: "resource", resource }))
      : [];
  const projected = blocks.map(projectContentBlock);
  const content = projected.flatMap((item) => item.content);
  if (content.length === 0 && Array.isArray(record?.["messages"])) {
    for (const message of record["messages"] as unknown[]) {
      const messageRecord = asRecord(message);
      const role = asString(messageRecord?.["role"]) ?? "message";
      const messageContent = projectContentBlock(messageRecord?.["content"]);
      for (const block of messageContent.content) {
        content.push(block.type === "text"
          ? { ...block, text: `[${role}] ${block.text}` }
          : block);
      }
    }
  }
  if (record?.["structuredContent"] !== undefined) {
    content.push({ type: "text", text: `Structured result:\n${JSON.stringify(record["structuredContent"], null, 2)}` });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "[External MCP result contained no supported content]" });
  }
  return {
    content,
    details: {
      isError: false,
      ...(record?.["structuredContent"] !== undefined
        ? { structuredContent: record["structuredContent"] }
        : {}),
      contentTypes: blocks.map((block) => asString(asRecord(block)?.["type"]) ?? "unknown"),
    },
  };
}

function operationResult(operation: ExternalMcpOperation): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(operation, null, 2) }],
    details: operation,
  };
}

function resultType(value: unknown): string | undefined {
  return asString(asRecord(value)?.["resultType"]);
}

function isTaskResult(value: unknown): boolean {
  const record = asRecord(value);
  return (resultType(value) === "task" || isProjectedExternalMcpTaskResult(value))
    && typeof record?.["taskId"] === "string";
}

function isInputRequired(value: unknown): boolean {
  return resultType(value) === "input_required";
}

function taskStatus(value: unknown): string | undefined {
  return asString(asRecord(value)?.["status"]);
}

function terminalTaskStatus(status: string | undefined): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

export class ExternalMcpClientManager {
  private readonly workspaceDir: string;
  private readonly runtimes = new Map<string, ClientRuntime>();
  private readonly catalogs = new Map<string, CachedCatalog>();
  private readonly catalogCache = new ExternalMcpCatalogCache();
  private readonly operationStore: ExternalMcpOperationStore;
  private configError?: string;
  private catalogChanged?: (serverName: string) => void;

  constructor(
    workspaceDir: string,
    getSessionId: () => string,
    getSessionTaskDir: () => string,
  ) {
    this.workspaceDir = workspaceDir;
    this.operationStore = new ExternalMcpOperationStore(getSessionId, getSessionTaskDir);
  }

  setCatalogChangedHandler(handler: (serverName: string) => void): void {
    this.catalogChanged = handler;
  }

  async initialize(): Promise<void> {
    await this.reload();
  }

  getSystemConfig(): ExternalMcpConfig {
    return loadSystemExternalMcpConfig();
  }

  async saveSystemConfig(value: unknown): Promise<ExternalMcpConfig> {
    const saved = saveSystemExternalMcpConfig(value);
    await this.reload();
    return saved;
  }

  getConfigError(): string | undefined {
    return this.configError;
  }

  getServer(name: string): EffectiveExternalMcpServer {
    const runtime = this.runtimes.get(name);
    if (!runtime) throw new ExternalMcpClientError("NOT_FOUND", `Unknown external MCP server: ${name}`);
    if (!runtime.config.enabled) throw new ExternalMcpClientError("FORBIDDEN", `External MCP server '${name}' is disabled`);
    return runtime.config;
  }

  getViews(): ExternalMcpServerView[] {
    return [...this.runtimes.values()].map((runtime) => ({
      config: structuredClone(runtime.config),
      status: runtime.config.enabled ? runtime.status : "disabled",
      ...(runtime.error ? { error: runtime.error } : {}),
      ...(this.catalogs.get(runtime.config.name)?.catalog
        ? { catalog: structuredClone(this.catalogs.get(runtime.config.name)!.catalog) }
        : {}),
    }));
  }

  async reload(): Promise<void> {
    let servers: EffectiveExternalMcpServer[];
    try {
      servers = loadEffectiveExternalMcpServers(this.workspaceDir);
      this.configError = undefined;
    } catch (error) {
      this.configError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    const nextByName = new Map(servers.map((server) => [server.name, server]));
    const closePromises: Promise<void>[] = [];
    for (const [name, runtime] of this.runtimes) {
      const next = nextByName.get(name);
      if (!next || fingerprintExternalMcpServer(next) !== fingerprintExternalMcpServer(runtime.config)) {
        closePromises.push(this.closeRuntime(runtime));
        this.runtimes.delete(name);
        this.catalogs.delete(name);
      }
    }
    await Promise.allSettled(closePromises);
    for (const server of servers) {
      if (this.runtimes.has(server.name)) continue;
      this.runtimes.set(server.name, {
        config: server,
        status: server.enabled ? "disconnected" : "disabled",
        activeCount: 0,
        waiters: [],
        closing: false,
      });
      const cached = this.catalogCache.get(server);
      if (cached) this.catalogs.set(server.name, { catalog: cached, expiresAt: 0 });
    }
    this.catalogCache.prune(servers);
    this.catalogChanged?.("*");
  }

  getCachedCatalog(serverName: string): ExternalMcpCatalog | undefined {
    const catalog = this.catalogs.get(serverName)?.catalog;
    return catalog ? structuredClone(catalog) : undefined;
  }

  async probe(serverName: string, signal?: AbortSignal): Promise<ExternalMcpProbeResult> {
    const catalog = await this.refreshCatalog(serverName, true, signal);
    return { status: "connected", catalog };
  }

  async refreshCatalog(serverName: string, force = false, signal?: AbortSignal): Promise<ExternalMcpCatalog> {
    const runtime = this.requireRuntime(serverName);
    const cached = this.catalogs.get(serverName);
    if (!force && cached && cached.expiresAt > Date.now()) return structuredClone(cached.catalog);
    const client = await this.connect(runtime, signal);
    const timeout = resolvedTimeouts(runtime.config).callMs;
    try {
      const serverCapabilities = client.getServerCapabilities();
      const supportsTools = serverCapabilities?.tools !== undefined;
      const supportsResources = serverCapabilities?.resources !== undefined;
      const supportsPrompts = serverCapabilities?.prompts !== undefined;
      const requestSignal = combineSignal(signal, timeout);
      const [toolResult, resourceResult, templateResult, promptResult] = await this.withPermit(runtime, async () => {
        return Promise.all([
          supportsTools
            ? client.listTools(undefined, { cacheMode: force ? "refresh" : "use", timeout, signal: requestSignal })
            : Promise.resolve({ tools: [] }),
          supportsResources
            ? client.listResources(undefined, { cacheMode: force ? "refresh" : "use", timeout, signal: requestSignal })
            : Promise.resolve({ resources: [] }),
          supportsResources
            ? client.listResourceTemplates(undefined, { cacheMode: force ? "refresh" : "use", timeout, signal: requestSignal })
            : Promise.resolve({ resourceTemplates: [] }),
          supportsPrompts
            ? client.listPrompts(undefined, { cacheMode: force ? "refresh" : "use", timeout, signal: requestSignal })
            : Promise.resolve({ prompts: [] }),
        ]);
      }, requestSignal);
      const discover = asRecord(client.getDiscoverResult());
      const capabilities = asRecord(discover?.["capabilities"]);
      const extensions = Object.keys(asRecord(capabilities?.["extensions"]) ?? {});
      const serverInfoValue = client.getServerVersion();
      const catalog: ExternalMcpCatalog = {
        serverName,
        ...(serverInfoValue ? { serverInfo: { name: serverInfoValue.name, version: serverInfoValue.version } } : {}),
        ...(client.getNegotiatedProtocolVersion() ? { protocolVersion: client.getNegotiatedProtocolVersion() } : {}),
        ...(client.getProtocolEra() ? { protocolEra: client.getProtocolEra() } : {}),
        extensions,
        tools: (toolResult.tools as unknown[]).map((value) => this.mapTool(value)).filter(Boolean) as ExternalMcpToolCatalogEntry[],
        resources: (resourceResult.resources as unknown[]).map((value) => this.mapResource(value)).filter(Boolean) as ExternalMcpResourceCatalogEntry[],
        resourceTemplates: (templateResult.resourceTemplates as unknown[]).map((value) => this.mapResourceTemplate(value)).filter(Boolean) as ExternalMcpResourceTemplateCatalogEntry[],
        prompts: (promptResult.prompts as unknown[]).map((value) => this.mapPrompt(value)).filter(Boolean) as ExternalMcpPromptCatalogEntry[],
        refreshedAt: new Date().toISOString(),
      };
      this.catalogs.set(serverName, { catalog, expiresAt: Date.now() + CATALOG_TTL_MS });
      this.catalogCache.put(runtime.config, catalog);
      this.catalogChanged?.(serverName);
      return structuredClone(catalog);
    } catch (error) {
      throw normalizeMcpError(error);
    }
  }

  async searchCapabilities(params: {
    query?: string;
    server?: string;
    kind?: "tool" | "resource" | "resource_template" | "prompt";
    limit?: number;
  }, signal?: AbortSignal): Promise<unknown[]> {
    const runtimes = params.server ? [this.requireRuntime(params.server)] : [...this.runtimes.values()];
    const query = params.query?.trim().toLowerCase() ?? "";
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const results: unknown[] = [];
    for (const runtime of runtimes) {
      if (!runtime.config.enabled) continue;
      const catalog = await this.refreshCatalog(runtime.config.name, false, signal);
      const exposure = runtime.config.exposure;
      const add = (kind: string, name: string, value: unknown) => {
        if (params.kind && params.kind !== kind) return;
        const haystack = JSON.stringify(value).toLowerCase();
        if (query && !haystack.includes(query)) return;
        results.push({ server: runtime.config.name, kind, name, capability: value });
      };
      for (const tool of catalog.tools) if (isAllowed(tool.name, exposure.allowedTools)) add("tool", tool.name, tool);
      for (const resource of catalog.resources) if (isResourceAllowed(resource.uri, exposure.resourceUriPrefixes)) add("resource", resource.uri, resource);
      for (const template of catalog.resourceTemplates) {
        if (isResourceAllowed(templateAuthorizationUri(template.uriTemplate), exposure.resourceUriPrefixes)) {
          add("resource_template", template.uriTemplate, template);
        }
      }
      for (const prompt of catalog.prompts) if (isAllowed(prompt.name, exposure.allowedPrompts)) add("prompt", prompt.name, prompt);
      if (results.length >= limit) break;
    }
    return results.slice(0, limit);
  }

  async getCapability(serverName: string, kind: string, name: string, signal?: AbortSignal): Promise<unknown> {
    const runtime = this.requireRuntime(serverName);
    const catalog = await this.refreshCatalog(serverName, false, signal);
    if (kind === "tool") {
      this.assertToolAllowed(runtime.config, name);
      return catalog.tools.find((entry) => entry.name === name)
        ?? this.notFound(kind, serverName, name);
    }
    if (kind === "prompt") {
      this.assertPromptAllowed(runtime.config, name);
      return catalog.prompts.find((entry) => entry.name === name)
        ?? this.notFound(kind, serverName, name);
    }
    if (kind === "resource") {
      this.assertResourceAllowed(runtime.config, name);
      return catalog.resources.find((entry) => entry.uri === name)
        ?? this.notFound(kind, serverName, name);
    }
    if (kind === "resource_template") {
      this.assertResourceAllowed(runtime.config, templateAuthorizationUri(name));
      return catalog.resourceTemplates.find((entry) => entry.uriTemplate === name)
        ?? this.notFound(kind, serverName, name);
    }
    throw new ExternalMcpClientError("CONFIG", `Unknown MCP capability kind: ${kind}`);
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    const runtime = this.requireRuntime(serverName);
    this.assertToolAllowed(runtime.config, toolName);
    const result = await this.request(runtime, "tools/call", { name: toolName, arguments: args }, { signal });
    return this.handleInvocationResult(runtime, "tools/call", { name: toolName, arguments: args }, result, signal);
  }

  async listResources(serverName?: string, signal?: AbortSignal): Promise<unknown[]> {
    const runtimes = serverName ? [this.requireRuntime(serverName)] : [...this.runtimes.values()];
    const resources: unknown[] = [];
    for (const runtime of runtimes) {
      if (!runtime.config.enabled) continue;
      const catalog = await this.refreshCatalog(runtime.config.name, false, signal);
      for (const resource of catalog.resources) {
        if (isResourceAllowed(resource.uri, runtime.config.exposure.resourceUriPrefixes)) {
          resources.push({ server: runtime.config.name, ...resource });
        }
      }
      for (const template of catalog.resourceTemplates) {
        if (isResourceAllowed(templateAuthorizationUri(template.uriTemplate), runtime.config.exposure.resourceUriPrefixes)) {
          resources.push({ server: runtime.config.name, ...template });
        }
      }
    }
    return resources;
  }

  async readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
    const runtime = this.requireRuntime(serverName);
    this.assertResourceAllowed(runtime.config, uri);
    const params = { uri };
    const result = await this.request(runtime, "resources/read", params, { signal, readOnly: true });
    return this.handleInvocationResult(runtime, "resources/read", params, result, signal);
  }

  async listPrompts(serverName?: string, signal?: AbortSignal): Promise<unknown[]> {
    const runtimes = serverName ? [this.requireRuntime(serverName)] : [...this.runtimes.values()];
    const prompts: unknown[] = [];
    for (const runtime of runtimes) {
      if (!runtime.config.enabled) continue;
      const catalog = await this.refreshCatalog(runtime.config.name, false, signal);
      for (const prompt of catalog.prompts) {
        if (isAllowed(prompt.name, runtime.config.exposure.allowedPrompts)) {
          prompts.push({ server: runtime.config.name, ...prompt });
        }
      }
    }
    return prompts;
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    args: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    const runtime = this.requireRuntime(serverName);
    this.assertPromptAllowed(runtime.config, promptName);
    const params = { name: promptName, ...(args ? { arguments: args } : {}) };
    const result = await this.request(runtime, "prompts/get", params, { signal, readOnly: true });
    return this.handleInvocationResult(runtime, "prompts/get", params, result, signal);
  }

  async getOperation(operationId: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
    const operation = this.requireOperation(operationId);
    if (operation.kind !== "task" || operation.status !== "working") return operationResult(operation);
    const runtime = this.requireOperationRuntime(operation);
    const updated = await this.pollTaskOnce(runtime, operation, signal);
    return updated.status === "completed" && updated.result !== undefined
      ? projectExternalMcpResult(updated.result)
      : operationResult(updated);
  }

  async respondOperation(
    operationId: string,
    responses: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    const operation = this.requireOperation(operationId);
    if (operation.status !== "input_required") {
      throw new ExternalMcpClientError("FORBIDDEN", `MCP operation '${operationId}' is not waiting for input`);
    }
    const runtime = this.requireOperationRuntime(operation);
    // A suspended operation can outlive a settings change. Recheck its original
    // capability before replaying the call or supplying new Task input.
    if (operation.method === "tools/call") {
      this.assertToolAllowed(runtime.config, asString(operation.params["name"]) ?? "");
    } else if (operation.method === "prompts/get") {
      this.assertPromptAllowed(runtime.config, asString(operation.params["name"]) ?? "");
    } else if (operation.method === "resources/read") {
      this.assertResourceAllowed(runtime.config, asString(operation.params["uri"]) ?? "");
    }
    if (operation.kind === "task") {
      await this.request(runtime, "tasks/update", {
        taskId: operation.remoteTaskId,
        inputResponses: responses,
      }, { signal });
      const working = this.operationStore.update(operationId, {
        status: "working",
        inputRequests: undefined,
      });
      return this.waitForTask(runtime, working, signal);
    }
    const params = {
      ...operation.params,
      inputResponses: responses,
      ...(operation.requestState ? { requestState: operation.requestState } : {}),
    };
    const result = await this.request(runtime, operation.method, params, {
      signal,
      readOnly: operation.method !== "tools/call",
    });
    const handled = await this.handleInvocationResult(runtime, operation.method, operation.params, result, signal, operationId);
    return handled;
  }

  async cancelOperation(operationId: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
    const operation = this.requireOperation(operationId);
    if (terminalTaskStatus(operation.status)) return operationResult(operation);
    const runtime = this.requireOperationRuntime(operation);
    // Publish local cancellation before contacting the remote server so two
    // concurrent abort paths cannot send duplicate Task cancellation calls.
    const cancelled = this.operationStore.update(operationId, { status: "cancelled" });
    if (operation.kind === "task" && operation.remoteTaskId) {
      try {
        await this.request(runtime, "tasks/cancel", { taskId: operation.remoteTaskId }, { signal });
      } catch (error) {
        log.warn("External MCP task cancellation was not acknowledged", {
          server: operation.serverName,
          operationId,
          error: normalizeMcpError(error).message,
        });
      }
    }
    return operationResult(cancelled);
  }

  async cancelActiveOperations(): Promise<void> {
    await Promise.allSettled(this.operationStore.listActive().map((operation) =>
      this.cancelOperation(operation.operationId)));
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => this.closeRuntime(runtime)));
  }

  private requireRuntime(name: string): ClientRuntime {
    if (this.configError) throw new ExternalMcpClientError("CONFIG", this.configError);
    const runtime = this.runtimes.get(name);
    if (!runtime) throw new ExternalMcpClientError("NOT_FOUND", `Unknown external MCP server: ${name}`);
    if (!runtime.config.enabled) throw new ExternalMcpClientError("FORBIDDEN", `External MCP server '${name}' is disabled`);
    return runtime;
  }

  private requireOperationRuntime(operation: ExternalMcpOperation): ClientRuntime {
    const runtime = this.requireRuntime(operation.serverName);
    if (operation.connectionFingerprint !== fingerprintExternalMcpConnection(runtime.config)) {
      throw new ExternalMcpClientError("FORBIDDEN",
        "MCP operation connection configuration changed or is unverified; start a new operation");
    }
    return runtime;
  }

  private requireOperation(operationId: string): ExternalMcpOperation {
    const operation = this.operationStore.get(operationId);
    if (!operation) throw new ExternalMcpClientError("NOT_FOUND", `Unknown MCP operation: ${operationId}`);
    return operation;
  }

  private async connect(runtime: ClientRuntime, signal?: AbortSignal): Promise<Client> {
    if (runtime.client && runtime.status === "connected") return runtime.client;
    if (!runtime.connecting) {
      runtime.status = "connecting";
      runtime.error = undefined;
      runtime.connecting = this.openConnection(runtime).finally(() => {
        runtime.connecting = undefined;
      });
    }
    // One caller aborting must not tear down a shared connection attempt used
    // by other concurrent calls. It only stops that caller's wait.
    return awaitWithSignal(runtime.connecting, signal);
  }

  private async openConnection(runtime: ClientRuntime): Promise<Client> {
    const server = runtime.config;
    const timeout = resolvedTimeouts(server).connectMs;
    let transport: Transport | undefined;
    const clientCapabilities: ClientCapabilities = {
      elicitation: { form: {}, url: {} },
      extensions: { [TASKS_EXTENSION]: {} },
    };
    const client = new Client(
      { name: "hogagent-external-mcp-client", version: "1.0.0" },
      {
        capabilities: clientCapabilities,
        versionNegotiation: { mode: "auto", probe: { timeoutMs: timeout, maxRetries: 0 } },
        inputRequired: { autoFulfill: false, maxRounds: 10 },
        defaultCacheTtlMs: CATALOG_TTL_MS,
        listChanged: {
          tools: { onChanged: () => void this.refreshCatalog(server.name, true).catch(() => undefined) },
          resources: { onChanged: () => void this.refreshCatalog(server.name, true).catch(() => undefined) },
          prompts: { onChanged: () => void this.refreshCatalog(server.name, true).catch(() => undefined) },
        },
      },
    );
    client.setRequestHandler("elicitation/create", async () => ({ action: "decline" }));
    try {
      if (server.transport.type === "http") {
        const headers: Record<string, string> = {};
        for (const [header, envName] of Object.entries(server.transport.headersFromEnv ?? {})) {
          headers[header] = resolveRequiredEnv(envName, `${server.name} header ${header}`);
        }
        const bearerTokenEnv = server.transport.bearerTokenEnv;
        transport = new StreamableHTTPClientTransport(new URL(server.transport.url), {
          ...(bearerTokenEnv ? {
            authProvider: { token: async () => resolveRequiredEnv(bearerTokenEnv, `${server.name} bearer token`) },
          } : {}),
          ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
          onInsufficientScope: "throw",
        });
      } else {
        const env = getDefaultEnvironment();
        for (const [targetName, hostName] of Object.entries(server.transport.envFromHost ?? {})) {
          env[targetName] = resolveRequiredEnv(hostName, `${server.name} stdio environment`);
        }
        const stdioTransport = new StdioClientTransport({
          command: server.transport.command,
          args: server.transport.args,
          cwd: server.transport.cwd,
          env,
          stderr: "pipe",
        });
        // Always drain child stderr but never copy arbitrary server output into
        // HogAgent logs, where arguments or credentials could be exposed.
        stdioTransport.stderr?.on("data", () => undefined);
        transport = stdioTransport;
      }
      const adaptedTransport = new ExternalMcpTaskAdapter(transport);
      runtime.transport = adaptedTransport;
      await client.connect(adaptedTransport, { timeout, signal: AbortSignal.timeout(timeout) });
      runtime.client = client;
      runtime.status = "connected";
      // Observe Client lifecycle without replacing the SDK's transport handlers;
      // they settle in-flight requests and clear their timers on disconnect.
      client.onclose = () => {
        if (runtime.closing) return;
        runtime.client = undefined;
        runtime.transport = undefined;
        runtime.status = "disconnected";
      };
      client.onerror = (error) => {
        runtime.error = normalizeMcpError(error).message;
      };
      return client;
    } catch (error) {
      try { await transport?.close(); } catch { /* best effort */ }
      runtime.client = undefined;
      runtime.transport = undefined;
      runtime.status = "error";
      const normalized = normalizeMcpError(error);
      runtime.error = normalized.message;
      throw normalized.code === "REMOTE"
        ? new ExternalMcpClientError("CONNECTION", normalized.message, { cause: error })
        : normalized;
    }
  }

  private async closeRuntime(runtime: ClientRuntime): Promise<void> {
    runtime.closing = true;
    while (runtime.waiters.length > 0) runtime.waiters.shift()?.();
    const drainDeadline = Date.now() + Math.min(resolvedTimeouts(runtime.config).callMs, 30_000);
    while (runtime.activeCount > 0 && Date.now() < drainDeadline) await wait(25);
    try {
      if (runtime.client) await runtime.client.close();
      else await runtime.transport?.close();
    } finally {
      runtime.client = undefined;
      runtime.transport = undefined;
      runtime.status = runtime.config.enabled ? "disconnected" : "disabled";
      runtime.closing = false;
    }
  }

  private async waitForPermit(runtime: ClientRuntime, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const index = runtime.waiters.indexOf(wake);
        if (index >= 0) runtime.waiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      runtime.waiters.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async withPermit<T>(
    runtime: ClientRuntime,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const limit = runtime.config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    while (runtime.activeCount >= limit) {
      await this.waitForPermit(runtime, signal);
      if (runtime.closing) {
        throw new ExternalMcpClientError("CONNECTION", `External MCP server '${runtime.config.name}' is reloading`);
      }
    }
    if (runtime.closing) throw new ExternalMcpClientError("CONNECTION", `External MCP server '${runtime.config.name}' is reloading`);
    runtime.activeCount++;
    try {
      return await operation();
    } finally {
      runtime.activeCount--;
      runtime.waiters.shift()?.();
    }
  }

  private async request(
    runtime: ClientRuntime,
    method: string,
    params: Record<string, unknown>,
    options: InvocationOptions,
  ): Promise<unknown> {
    const invoke = async () => {
      const client = await this.connect(runtime, options.signal);
      const timeout = resolvedTimeouts(runtime.config).callMs;
      const requestSignal = combineSignal(options.signal, timeout);
      const request = client.request.bind(client) as unknown as (
        request: { method: string; params: Record<string, unknown> },
        schema: PassthroughSchema,
        requestOptions: Record<string, unknown>,
      ) => Promise<unknown>;
      return this.withPermit(runtime, () => request(
        { method: externalMcpTaskSdkMethod(method), params },
        PASSTHROUGH_SCHEMA,
        {
          timeout,
          maxTotalTimeout: timeout,
          signal: requestSignal,
          allowInputRequired: true,
        },
      ), requestSignal);
    };
    try {
      return await invoke();
    } catch (error) {
      const normalized = normalizeMcpError(error);
      if (!options.readOnly || !isConnectionFailure(normalized)) throw normalized;
      await this.closeRuntime(runtime);
      return invoke();
    }
  }

  private async handleInvocationResult(
    runtime: ClientRuntime,
    method: ExternalMcpOperation["method"],
    params: Record<string, unknown>,
    result: unknown,
    signal?: AbortSignal,
    existingOperationId?: string,
  ): Promise<AgentToolResult<unknown>> {
    if (isTaskResult(result)) {
      const record = asRecord(result)!;
      if (!this.serverSupportsTasksExtension(runtime)) {
        const remoteTaskId = asString(record["taskId"]);
        if (remoteTaskId) {
          await this.request(runtime, "tasks/cancel", { taskId: remoteTaskId }, { signal }).catch(() => undefined);
        }
        throw new ExternalMcpClientError(
          "PROTOCOL",
          `External MCP server '${runtime.config.name}' returned a Task without declaring ${TASKS_EXTENSION}`,
        );
      }
      const operation = existingOperationId
        ? this.operationStore.update(existingOperationId, {
            kind: "task",
            status: "working",
            remoteTaskId: asString(record["taskId"]),
            pollIntervalMs: Number(record["pollIntervalMs"]) || DEFAULT_TASK_POLL_MS,
            inputRequests: undefined,
            requestState: undefined,
          })
        : this.operationStore.create({
            operationId: randomUUID(),
            serverName: runtime.config.name,
            connectionFingerprint: fingerprintExternalMcpConnection(runtime.config),
            kind: "task",
            status: "working",
            method,
            params,
            remoteTaskId: asString(record["taskId"]),
            pollIntervalMs: Number(record["pollIntervalMs"]) || DEFAULT_TASK_POLL_MS,
          });
      return this.waitForTask(runtime, operation, signal);
    }
    if (isInputRequired(result)) {
      const record = asRecord(result)!;
      const patch = {
        kind: "input_required" as const,
        status: "input_required" as const,
        requestState: asString(record["requestState"]),
        inputRequests: asRecord(record["inputRequests"]) ?? {},
        result: undefined,
      };
      const operation = existingOperationId
        ? this.operationStore.update(existingOperationId, patch)
        : this.operationStore.create({
            operationId: randomUUID(),
            serverName: runtime.config.name,
            connectionFingerprint: fingerprintExternalMcpConnection(runtime.config),
            method,
            params,
            ...patch,
          });
      return operationResult(operation);
    }
    if (existingOperationId) {
      const completed = this.operationStore.update(existingOperationId, {
        status: "completed",
        result,
        inputRequests: undefined,
      });
      if (completed.status !== "completed") return operationResult(completed);
    }
    return projectExternalMcpResult(result);
  }

  private async waitForTask(
    runtime: ClientRuntime,
    operation: ExternalMcpOperation,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    const foregroundMs = resolvedTimeouts(runtime.config).taskForegroundMs;
    const deadline = Date.now() + foregroundMs;
    let current = operation;
    try {
      while (foregroundMs > 0 && Date.now() < deadline && current.status === "working") {
        const interval = Math.min(
          Math.max(current.pollIntervalMs ?? DEFAULT_TASK_POLL_MS, 250),
          MAX_TASK_POLL_MS,
          Math.max(deadline - Date.now(), 0),
        );
        if (interval > 0) await wait(interval, signal);
        current = await this.pollTaskOnce(runtime, current, signal);
      }
    } catch (error) {
      if (signal?.aborted) {
        await this.cancelOperation(current.operationId).catch(() => undefined);
      }
      throw error;
    }
    return current.status === "completed" && current.result !== undefined
      ? projectExternalMcpResult(current.result)
      : operationResult(current);
  }

  private async pollTaskOnce(
    runtime: ClientRuntime,
    operation: ExternalMcpOperation,
    signal?: AbortSignal,
  ): Promise<ExternalMcpOperation> {
    if (!operation.remoteTaskId) {
      return this.operationStore.update(operation.operationId, {
        status: "failed",
        error: "Remote task id is missing",
      });
    }
    const result = await this.request(runtime, "tasks/get", { taskId: operation.remoteTaskId }, { signal, readOnly: true });
    const record = asRecord(result) ?? {};
    const status = taskStatus(result);
    if (status === "input_required") {
      return this.operationStore.update(operation.operationId, {
        status: "input_required",
        inputRequests: asRecord(record["inputRequests"]) ?? {},
        error: undefined,
      });
    }
    if (status === "completed") {
      return this.operationStore.update(operation.operationId, {
        status: "completed",
        result: record["result"] ?? result,
        inputRequests: undefined,
      });
    }
    if (status === "cancelled") {
      return this.operationStore.update(operation.operationId, { status: "cancelled", result });
    }
    if (status === "failed") {
      return this.operationStore.update(operation.operationId, {
        status: "failed",
        error: "External MCP task failed",
        result: undefined,
      });
    }
    if (status !== "working") {
      return this.operationStore.update(operation.operationId, {
        status: "failed",
        error: "External MCP task returned an invalid status",
        result: undefined,
      });
    }
    return this.operationStore.update(operation.operationId, {
      status: "working",
      pollIntervalMs: Number(record["pollIntervalMs"]) || operation.pollIntervalMs,
    });
  }

  private mapTool(value: unknown): ExternalMcpToolCatalogEntry | undefined {
    const record = asRecord(value);
    const name = asString(record?.["name"]);
    const inputSchema = asRecord(record?.["inputSchema"]);
    if (!name || !inputSchema) return undefined;
    return {
      name,
      ...(asString(record?.["title"]) ? { title: asString(record?.["title"]) } : {}),
      ...(asString(record?.["description"]) ? { description: asString(record?.["description"]) } : {}),
      inputSchema,
      ...(asRecord(record?.["outputSchema"]) ? { outputSchema: asRecord(record?.["outputSchema"]) } : {}),
      ...(asRecord(record?.["annotations"]) ? { annotations: asRecord(record?.["annotations"]) } : {}),
      ...(asRecord(record?.["execution"]) ? { execution: asRecord(record?.["execution"]) } : {}),
    };
  }

  private mapResource(value: unknown): ExternalMcpResourceCatalogEntry | undefined {
    const record = asRecord(value);
    const uri = asString(record?.["uri"]);
    const name = asString(record?.["name"]);
    if (!uri || !name) return undefined;
    return {
      uri,
      name,
      ...(asString(record?.["title"]) ? { title: asString(record?.["title"]) } : {}),
      ...(asString(record?.["description"]) ? { description: asString(record?.["description"]) } : {}),
      ...(asString(record?.["mimeType"]) ? { mimeType: asString(record?.["mimeType"]) } : {}),
    };
  }

  private mapResourceTemplate(value: unknown): ExternalMcpResourceTemplateCatalogEntry | undefined {
    const record = asRecord(value);
    const uriTemplate = asString(record?.["uriTemplate"]);
    const name = asString(record?.["name"]);
    if (!uriTemplate || !name) return undefined;
    return {
      uriTemplate,
      name,
      ...(asString(record?.["title"]) ? { title: asString(record?.["title"]) } : {}),
      ...(asString(record?.["description"]) ? { description: asString(record?.["description"]) } : {}),
      ...(asString(record?.["mimeType"]) ? { mimeType: asString(record?.["mimeType"]) } : {}),
    };
  }

  private mapPrompt(value: unknown): ExternalMcpPromptCatalogEntry | undefined {
    const record = asRecord(value);
    const name = asString(record?.["name"]);
    if (!name) return undefined;
    const args = Array.isArray(record?.["arguments"])
      ? (record!["arguments"] as unknown[]).flatMap((argument) => {
          const item = asRecord(argument);
          const argumentName = asString(item?.["name"]);
          return argumentName ? [{
            name: argumentName,
            ...(asString(item?.["description"]) ? { description: asString(item?.["description"]) } : {}),
            ...(typeof item?.["required"] === "boolean" ? { required: item["required"] } : {}),
          }] : [];
        })
      : undefined;
    return {
      name,
      ...(asString(record?.["title"]) ? { title: asString(record?.["title"]) } : {}),
      ...(asString(record?.["description"]) ? { description: asString(record?.["description"]) } : {}),
      ...(args ? { arguments: args } : {}),
    };
  }

  private assertToolAllowed(server: EffectiveExternalMcpServer, name: string): void {
    if (!isAllowed(name, server.exposure.allowedTools)) {
      throw new ExternalMcpClientError("FORBIDDEN", `Tool '${name}' is not allowed for external MCP server '${server.name}'`);
    }
  }

  private serverSupportsTasksExtension(runtime: ClientRuntime): boolean {
    const cached = this.catalogs.get(runtime.config.name)?.catalog;
    if (cached?.extensions.includes(TASKS_EXTENSION)) return true;
    const discover = asRecord(runtime.client?.getDiscoverResult());
    const capabilities = asRecord(discover?.["capabilities"]);
    return Object.hasOwn(asRecord(capabilities?.["extensions"]) ?? {}, TASKS_EXTENSION);
  }

  private assertPromptAllowed(server: EffectiveExternalMcpServer, name: string): void {
    if (!isAllowed(name, server.exposure.allowedPrompts)) {
      throw new ExternalMcpClientError("FORBIDDEN", `Prompt '${name}' is not allowed for external MCP server '${server.name}'`);
    }
  }

  private assertResourceAllowed(server: EffectiveExternalMcpServer, uri: string): void {
    if (!isResourceAllowed(uri, server.exposure.resourceUriPrefixes)) {
      throw new ExternalMcpClientError("FORBIDDEN", `Resource URI is not allowed for external MCP server '${server.name}'`);
    }
  }

  private notFound(kind: string, server: string, name: string): never {
    throw new ExternalMcpClientError("NOT_FOUND", `${kind} '${name}' was not found on external MCP server '${server}'`);
  }
}

export function allowedDirectToolNames(server: EffectiveExternalMcpServer): string[] {
  return uniqueStrings(server.exposure.directTools)
    .filter((name) => isAllowed(name, server.exposure.allowedTools));
}
