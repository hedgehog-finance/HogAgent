export type ExternalMcpCapabilityKind = "tool" | "resource" | "resource_template" | "prompt";

export interface ExternalMcpToolCatalogEntry {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
}
export interface ExternalMcpResourceCatalogEntry {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ExternalMcpResourceTemplateCatalogEntry {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ExternalMcpPromptCatalogEntry {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface ExternalMcpCatalog {
  serverName: string;
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
  protocolEra?: "modern" | "legacy";
  extensions: string[];
  tools: ExternalMcpToolCatalogEntry[];
  resources: ExternalMcpResourceCatalogEntry[];
  resourceTemplates: ExternalMcpResourceTemplateCatalogEntry[];
  prompts: ExternalMcpPromptCatalogEntry[];
  refreshedAt: string;
}

export type ExternalMcpOperationStatus =
  | "working"
  | "input_required"
  | "completed"
  | "cancelled"
  | "failed";

export interface ExternalMcpOperation {
  operationId: string;
  sessionId: string;
  serverName: string;
  /** Missing on legacy records, which cannot safely resume remote requests. */
  connectionFingerprint?: string;
  kind: "task" | "input_required";
  status: ExternalMcpOperationStatus;
  method: "tools/call" | "resources/read" | "prompts/get";
  params: Record<string, unknown>;
  remoteTaskId?: string;
  pollIntervalMs?: number;
  requestState?: string;
  inputRequests?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ExternalMcpProbeResult {
  status: "connected";
  catalog: ExternalMcpCatalog;
}
