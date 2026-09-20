import { Type } from "@sinclair/typebox";
import { createLogger } from "../../utils/logger.ts";
import type { AgentTool } from "../../vendor/agent/types.ts";
import type { HogAgentContext, IExtension } from "../../utils/types.ts";
import { ExternalMcpClientManager, allowedDirectToolNames } from "../../mcp/client-manager.ts";
import type { ExternalMcpConfig } from "../../mcp/config.ts";

const log = createLogger("external-mcp");

const META_TOOL_NAMES = [
  "mcp_discover",
  "mcp_call_tool",
  "mcp_read_resource",
  "mcp_get_prompt",
  "mcp_operation",
] as const;

let activeExternalMcpExtension: ExternalMcpExtension | null = null;

export function getExternalMcpExtension(): ExternalMcpExtension | null {
  return activeExternalMcpExtension;
}

function directToolSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "unnamed";
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

export class ExternalMcpExtension implements IExtension {
  name = "external-mcp";
  version = "1.0.0";

  private context?: HogAgentContext;
  private manager?: ExternalMcpClientManager;
  private readonly directToolNames = new Set<string>();
  private readonly directToolFingerprints = new Map<string, string>();
  private readonly ownedToolNames = new Set<string>();
  private pendingToolExposureRefresh = false;
  private metaToolsRegistered = false;

  async initialize(context: HogAgentContext): Promise<void> {
    this.context = context;
    this.manager = new ExternalMcpClientManager(
      context.getWorkspaceDir(),
      () => context.getSessionId(),
      () => context.getConfig().sessionTaskDir,
    );
    this.manager.setCatalogChangedHandler(() => {
      this.pendingToolExposureRefresh = true;
    });
    try {
      await this.manager.initialize();
    } catch (error) {
      log.error("External MCP configuration could not be loaded", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await this.reconcileToolExposure();
      activeExternalMcpExtension = this;
    } catch (error) {
      await this.cleanupOwnedTools();
      await this.manager.close().catch(() => undefined);
      this.manager = undefined;
      this.context = undefined;
      throw error;
    }
  }

  async beforeAgentEnd(): Promise<void> {
    if (this.pendingToolExposureRefresh) await this.reconcileToolExposure();
  }

  async shutdown(): Promise<void> {
    if (activeExternalMcpExtension === this) activeExternalMcpExtension = null;
    await this.manager?.close();
    this.manager = undefined;
    this.context = undefined;
  }

  async getServers(): Promise<unknown> {
    const manager = this.requireManager();
    let systemConfig: ExternalMcpConfig | undefined;
    let error = manager.getConfigError();
    try {
      systemConfig = manager.getSystemConfig();
    } catch (configError) {
      error = configError instanceof Error ? configError.message : String(configError);
    }
    return {
      schemaVersion: 1,
      systemConfig,
      effectiveServers: manager.getViews(),
      ...(error ? { error } : {}),
    };
  }

  async saveServers(value: unknown): Promise<unknown> {
    const manager = this.requireManager();
    const config = await manager.saveSystemConfig(value);
    await this.reconcileToolExposure();
    return { config, effectiveServers: manager.getViews() };
  }

  async probeServer(serverName: string, signal?: AbortSignal): Promise<unknown> {
    const result = await this.requireManager().probe(serverName, signal);
    await this.reconcileToolExposure();
    return result;
  }

  async reloadServers(): Promise<unknown> {
    await this.requireManager().reload();
    await this.reconcileToolExposure();
    return this.getServers();
  }

  async onAgentAbort(): Promise<void> {
    if (!this.manager?.getViews().some((view) => view.config.enabled)) return;
    await this.manager.cancelActiveOperations();
  }

  private requireManager(): ExternalMcpClientManager {
    if (!this.manager) throw new Error("External MCP Client is not initialized");
    return this.manager;
  }

  private async registerOwnedTool(
    tool: AgentTool,
    registration: { source: "external_mcp"; topLevelOnly: true },
  ): Promise<void> {
    await this.context!.registerTool(tool, registration);
    this.ownedToolNames.add(tool.name);
  }

  private async cleanupOwnedTools(): Promise<void> {
    const context = this.context;
    if (!context) return;
    for (const name of [...this.ownedToolNames].reverse()) {
      await context.unregisterTool(name).catch(() => undefined);
      this.ownedToolNames.delete(name);
      this.directToolNames.delete(name);
      this.directToolFingerprints.delete(name);
    }
  }

  private async registerMetaTools(): Promise<void> {
    if (this.metaToolsRegistered) return;
    const manager = this.requireManager();
    const registration = { source: "external_mcp", topLevelOnly: true } as const;
    const previouslyOwned = new Set(this.ownedToolNames);
    const tools: AgentTool[] = [
      {
        name: "mcp_discover",
        label: "Discover External MCP Capabilities",
        description: "Search or inspect authorized external MCP capabilities, or list authorized resources and prompts.",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("search"),
            Type.Literal("get"),
            Type.Literal("list_resources"),
            Type.Literal("list_prompts"),
          ]),
          query: Type.Optional(Type.String()),
          server: Type.Optional(Type.String()),
          kind: Type.Optional(Type.Union([
            Type.Literal("tool"),
            Type.Literal("resource"),
            Type.Literal("resource_template"),
            Type.Literal("prompt"),
          ])),
          name: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
        }),
        execute: async (_id: string, params: any, signal?: AbortSignal) => {
          if (params.action === "search") {
            return jsonResult(await manager.searchCapabilities({
              query: params.query,
              server: params.server,
              kind: params.kind,
              limit: params.limit,
            }, signal));
          }
          if (params.action === "get") {
            if (!params.server || !params.kind || !params.name) {
              throw new Error("mcp_discover action=get requires server, kind, and name");
            }
            return jsonResult(await manager.getCapability(
              params.server,
              params.kind,
              params.name,
              signal,
            ));
          }
          if (params.action === "list_resources") {
            return jsonResult(await manager.listResources(params.server, signal));
          }
          if (params.action === "list_prompts") {
            return jsonResult(await manager.listPrompts(params.server, signal));
          }
          throw new Error(`Unsupported mcp_discover action: ${String(params.action)}`);
        },
      },
      {
        name: "mcp_call_tool",
        label: "Call External MCP Tool",
        description: "Call one explicitly allowlisted tool on an external MCP server.",
        parameters: Type.Object({
          server: Type.String(),
          tool: Type.String(),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { default: {} })),
        }),
        execute: async (_id: string, params: any, signal?: AbortSignal) =>
          manager.callTool(params.server, params.tool, params.arguments ?? {}, signal),
      },
      {
        name: "mcp_read_resource",
        label: "Read External MCP Resource",
        description: "Read one authorized external MCP resource URI.",
        parameters: Type.Object({ server: Type.String(), uri: Type.String() }),
        execute: async (_id: string, params: any, signal?: AbortSignal) =>
          manager.readResource(params.server, params.uri, signal),
      },
      {
        name: "mcp_get_prompt",
        label: "Get External MCP Prompt",
        description: "Render one explicitly authorized prompt from an external MCP server.",
        parameters: Type.Object({
          server: Type.String(),
          prompt: Type.String(),
          arguments: Type.Optional(Type.Record(Type.String(), Type.String())),
        }),
        execute: async (_id: string, params: any, signal?: AbortSignal) =>
          manager.getPrompt(params.server, params.prompt, params.arguments, signal),
      },
      {
        name: "mcp_operation",
        label: "Control External MCP Operation",
        description: "Inspect, resume, or cancel a persisted external MCP Task or multi-round operation.",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("get"),
            Type.Literal("respond"),
            Type.Literal("cancel"),
          ]),
          operation_id: Type.String(),
          responses: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        execute: async (_id: string, params: any, signal?: AbortSignal) => {
          if (params.action === "get") {
            return manager.getOperation(params.operation_id, signal);
          }
          if (params.action === "respond") {
            if (!params.responses || typeof params.responses !== "object" || Array.isArray(params.responses)) {
              throw new Error("mcp_operation action=respond requires responses");
            }
            return manager.respondOperation(params.operation_id, params.responses, signal);
          }
          if (params.action === "cancel") {
            return manager.cancelOperation(params.operation_id, signal);
          }
          throw new Error(`Unsupported mcp_operation action: ${String(params.action)}`);
        },
      },
    ];
    try {
      for (const tool of tools) await this.registerOwnedTool(tool, registration);
      this.metaToolsRegistered = true;
    } catch (error) {
      for (const name of [...this.ownedToolNames].reverse()) {
        if (previouslyOwned.has(name)) continue;
        await this.context?.unregisterTool(name).catch(() => undefined);
        this.ownedToolNames.delete(name);
      }
      throw error;
    }
  }

  private async unregisterMetaTools(): Promise<void> {
    if (!this.metaToolsRegistered || !this.context) return;
    for (const name of META_TOOL_NAMES) {
      if (!this.ownedToolNames.has(name)) continue;
      await this.context.unregisterTool(name);
      this.ownedToolNames.delete(name);
    }
    this.metaToolsRegistered = false;
  }

  private async reconcileToolExposure(): Promise<void> {
    const context = this.context;
    const manager = this.manager;
    if (!context || !manager) return;
    const hasEnabledServer = manager.getViews().some((view) => view.config.enabled);
    if (!hasEnabledServer) {
      for (const name of [...this.directToolNames]) {
        await context.unregisterTool(name);
        this.directToolNames.delete(name);
        this.directToolFingerprints.delete(name);
        this.ownedToolNames.delete(name);
      }
      await this.unregisterMetaTools();
      this.pendingToolExposureRefresh = false;
      return;
    }
    await this.registerMetaTools();
    const desired = new Map<string, AgentTool>();
    const desiredOrigins = new Map<string, string>();
    const desiredFingerprints = new Map<string, string>();
    for (const view of manager.getViews()) {
      if (!view.config.enabled || !view.catalog) continue;
      for (const toolName of allowedDirectToolNames(view.config)) {
        const definition = view.catalog.tools.find((tool) => tool.name === toolName);
        if (!definition) continue;
        const directName = `mcp__${directToolSlug(view.config.name)}__${directToolSlug(toolName)}`;
        const origin = `${view.config.name}/${toolName}`;
        if (desired.has(directName)) {
          throw new Error(`External MCP direct tool name collision: ${origin} and ${desiredOrigins.get(directName)}`);
        }
        desiredOrigins.set(directName, origin);
        desiredFingerprints.set(directName, JSON.stringify({
          origin,
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema,
        }));
        desired.set(directName, {
          name: directName,
          label: definition.title ?? `${view.config.name}: ${toolName}`,
          description: definition.description ?? `External MCP tool ${toolName} from ${view.config.name}`,
          parameters: definition.inputSchema as any,
          execute: async (_id: string, params: unknown, signal?: AbortSignal) =>
            manager.callTool(
              view.config.name,
              toolName,
              params && typeof params === "object" && !Array.isArray(params)
                ? params as Record<string, unknown>
                : {},
              signal,
            ),
        });
      }
    }

    const existingNames = new Set(context.getHarness().getTools().map((tool) => tool.name));
    for (const name of desired.keys()) {
      if (existingNames.has(name) && !this.directToolNames.has(name)) {
        throw new Error(`External MCP direct tool collides with existing HogAgent tool '${name}'`);
      }
    }

    for (const name of [...this.directToolNames]) {
      if (
        desired.has(name)
        && this.directToolFingerprints.get(name) === desiredFingerprints.get(name)
      ) continue;
      await context.unregisterTool(name);
      this.directToolNames.delete(name);
      this.directToolFingerprints.delete(name);
      this.ownedToolNames.delete(name);
    }
    for (const [name, tool] of desired) {
      if (this.directToolNames.has(name)) continue;
      await this.registerOwnedTool(tool, { source: "external_mcp", topLevelOnly: true });
      this.directToolNames.add(name);
      this.directToolFingerprints.set(name, desiredFingerprints.get(name)!);
    }
    this.pendingToolExposureRefresh = false;
  }
}
