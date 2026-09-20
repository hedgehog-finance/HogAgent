import { getExternalMcpExtension } from "../extensions/external-mcp/index.ts";
import { ExternalMcpClientError } from "../mcp/client-manager.ts";
import { emitEvent } from "../rpc.ts";
import type { RpcCommand } from "../utils/types.ts";

function requestId(command: RpcCommand): string | number | null {
  return typeof command.request_id === "string" || typeof command.request_id === "number"
    ? command.request_id
    : null;
}

async function withMcpResponse(
  command: RpcCommand,
  responseType: string,
  action: () => Promise<unknown>,
): Promise<void> {
  const id = requestId(command);
  try {
    const result = await action();
    emitEvent({ type: responseType, request_id: id, result });
  } catch (error) {
    const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
    emitEvent({
      type: "mcp_error",
      request_id: id,
      command_type: command.type,
      code: typeof record["code"] === "string" ? record["code"] : "INTERNAL",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function requireExtension() {
  const extension = getExternalMcpExtension();
  if (!extension) throw new Error("External MCP Client is unavailable");
  return extension;
}

export function createMcpHandlers() {
  return {
    async onGetMcpServers(command: RpcCommand): Promise<void> {
      await withMcpResponse(command, "mcp_servers", () => requireExtension().getServers());
    },

    async onSaveMcpServers(command: RpcCommand): Promise<void> {
      await withMcpResponse(command, "mcp_servers_saved", () =>
        requireExtension().saveServers(command.config));
    },

    async onProbeMcpServer(command: RpcCommand): Promise<void> {
      await withMcpResponse(command, "mcp_probe_result", async () => {
        if (typeof command.server_name !== "string" || !command.server_name) {
          throw new ExternalMcpClientError("CONFIG", "probe_mcp_server requires 'server_name'");
        }
        return requireExtension().probeServer(command.server_name);
      });
    },

    async onReloadMcpServers(command: RpcCommand): Promise<void> {
      await withMcpResponse(command, "mcp_servers_reloaded", () =>
        requireExtension().reloadServers());
    },
  };
}
