import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getSystemDir, getUserConfigDir } from "../config.ts";

const ENV_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
const HEADER_NAME_PATTERN = "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$";
const SERVER_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

const EnvReferenceMapSchema = Type.Record(
  Type.String({ pattern: ENV_NAME_PATTERN }),
  Type.String({ pattern: ENV_NAME_PATTERN }),
  { default: {} },
);

const HeaderReferenceMapSchema = Type.Record(
  Type.String({ pattern: HEADER_NAME_PATTERN }),
  Type.String({ pattern: ENV_NAME_PATTERN }),
  { default: {} },
);

export const ExternalMcpHttpTransportSchema = Type.Object({
  type: Type.Literal("http"),
  url: Type.String({ minLength: 1 }),
  bearerTokenEnv: Type.Optional(Type.String({ pattern: ENV_NAME_PATTERN })),
  headersFromEnv: Type.Optional(HeaderReferenceMapSchema),
}, { additionalProperties: false });

export const ExternalMcpStdioTransportSchema = Type.Object({
  type: Type.Literal("stdio"),
  command: Type.String({ minLength: 1 }),
  args: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  envFromHost: Type.Optional(EnvReferenceMapSchema),
}, { additionalProperties: false });

export const ExternalMcpExposureSchema = Type.Object({
  allowedTools: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
  directTools: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
  resourceUriPrefixes: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
  allowedPrompts: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
}, { additionalProperties: false });

export const ExternalMcpTimeoutsSchema = Type.Object({
  connectMs: Type.Integer({ minimum: 100, maximum: 120_000, default: 10_000 }),
  callMs: Type.Integer({ minimum: 100, maximum: 600_000, default: 60_000 }),
  taskForegroundMs: Type.Integer({ minimum: 0, maximum: 300_000, default: 30_000 }),
}, { additionalProperties: false });

export const ExternalMcpServerSchema = Type.Object({
  name: Type.String({ pattern: SERVER_NAME_PATTERN }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  enabled: Type.Boolean({ default: true }),
  transport: Type.Union([ExternalMcpHttpTransportSchema, ExternalMcpStdioTransportSchema]),
  exposure: ExternalMcpExposureSchema,
  timeouts: Type.Optional(ExternalMcpTimeoutsSchema),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, default: 4 })),
}, { additionalProperties: false });

export const ExternalMcpConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  servers: Type.Array(ExternalMcpServerSchema, { default: [] }),
}, { additionalProperties: false });

export type ExternalMcpServerConfig = Static<typeof ExternalMcpServerSchema>;
export type ExternalMcpConfig = Static<typeof ExternalMcpConfigSchema>;
export type ExternalMcpConfigSource = "system" | "workspace";
export type EffectiveExternalMcpServer = ExternalMcpServerConfig & { source: ExternalMcpConfigSource };

export const EMPTY_EXTERNAL_MCP_CONFIG: ExternalMcpConfig = Object.freeze({
  schemaVersion: 1,
  servers: [],
});

export class ExternalMcpConfigError extends Error {
  readonly code = "CONFIG" as const;
  readonly path: string;

  constructor(path: string, message: string, options?: ErrorOptions) {
    super(`Invalid MCP configuration at ${path}: ${message}`, options);
    this.name = "ExternalMcpConfigError";
    this.path = path;
  }
}

export function getSystemExternalMcpConfigPath(): string {
  return join(getSystemDir(), "mcp-servers.json");
}

export function getWorkspaceExternalMcpConfigPath(workspaceDir: string): string {
  return join(getUserConfigDir(workspaceDir), "mcp-servers.json");
}

export function getExternalMcpCatalogCachePath(): string {
  return join(getSystemDir(), "mcp-catalog-cache.json");
}

function validationMessage(value: unknown): string {
  const errors = [...Value.Errors(ExternalMcpConfigSchema, value)].slice(0, 5);
  if (errors.length === 0) return "configuration does not match schema";
  return errors.map((error) => `${error.path || "/"}: ${error.message}`).join("; ");
}

function validateSemanticRules(config: ExternalMcpConfig, path: string): void {
  const names = new Set<string>();
  for (const server of config.servers) {
    if (names.has(server.name)) {
      throw new ExternalMcpConfigError(path, `duplicate server name '${server.name}'`);
    }
    names.add(server.name);
    if (server.transport.type === "http") {
      let url: URL;
      try {
        url = new URL(server.transport.url);
      } catch {
        throw new ExternalMcpConfigError(path, `invalid HTTP URL for '${server.name}'`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ExternalMcpConfigError(path, `HTTP transport for '${server.name}' must use http:// or https://`);
      }
      if (url.username || url.password) {
        throw new ExternalMcpConfigError(
          path,
          `HTTP transport for '${server.name}' may not embed credentials in its URL; use environment references`,
        );
      }
    }
    const allowed = new Set(server.exposure.allowedTools);
    const allowAll = allowed.has("*");
    const invalidDirect = server.exposure.directTools.filter((name) => !allowAll && !allowed.has(name));
    if (invalidDirect.length > 0) {
      throw new ExternalMcpConfigError(
        path,
        `directTools must be a subset of allowedTools for '${server.name}': ${invalidDirect.join(", ")}`,
      );
    }
  }
}

export function parseExternalMcpConfig(value: unknown, path = "<memory>"): ExternalMcpConfig {
  if (Array.isArray(value)) {
    throw new ExternalMcpConfigError(path, "legacy server arrays are not supported; expected { schemaVersion: 1, servers: [...] }");
  }
  if (!Value.Check(ExternalMcpConfigSchema, value)) {
    throw new ExternalMcpConfigError(path, validationMessage(value));
  }
  const config = structuredClone(value) as ExternalMcpConfig;
  validateSemanticRules(config, path);
  return config;
}

function readConfigFile(path: string): ExternalMcpConfig {
  if (!existsSync(path)) return structuredClone(EMPTY_EXTERNAL_MCP_CONFIG);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ExternalMcpConfigError(path, "path must be a regular file and may not be a symbolic link");
    }
    return parseExternalMcpConfig(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
  } catch (error) {
    if (error instanceof ExternalMcpConfigError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ExternalMcpConfigError(path, message, { cause: error });
  }
}

export function loadSystemExternalMcpConfig(): ExternalMcpConfig {
  return readConfigFile(getSystemExternalMcpConfigPath());
}

export function loadEffectiveExternalMcpServers(workspaceDir: string): EffectiveExternalMcpServer[] {
  const system = readConfigFile(getSystemExternalMcpConfigPath()).servers
    .map((server) => ({ ...server, source: "system" as const }));
  const workspace = readConfigFile(getWorkspaceExternalMcpConfigPath(workspaceDir)).servers
    .map((server) => ({ ...server, source: "workspace" as const }));
  const merged = new Map<string, EffectiveExternalMcpServer>(system.map((server) => [server.name, server]));
  for (const server of workspace) merged.set(server.name, server);
  return [...merged.values()];
}

function atomicWritePrivateJson(path: string, value: unknown): void {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup. Preserve the original write error.
    }
    throw error;
  }
}

export function saveSystemExternalMcpConfig(value: unknown): ExternalMcpConfig {
  const path = getSystemExternalMcpConfigPath();
  const config = parseExternalMcpConfig(value, path);
  atomicWritePrivateJson(path, config);
  return config;
}

export function writePrivateMcpJson(path: string, value: unknown): void {
  atomicWritePrivateJson(path, value);
}
