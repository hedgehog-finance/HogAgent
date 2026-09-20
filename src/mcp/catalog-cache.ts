import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { EffectiveExternalMcpServer } from "./config.ts";
import { getExternalMcpCatalogCachePath, writePrivateMcpJson } from "./config.ts";
import type { ExternalMcpCatalog } from "./types.ts";

interface CatalogCacheEntry {
  configFingerprint: string;
  catalog: ExternalMcpCatalog;
}
interface CatalogCacheFile {
  schemaVersion: 1;
  entries: Record<string, CatalogCacheEntry>;
}

function emptyCache(): CatalogCacheFile {
  return { schemaVersion: 1, entries: {} };
}

function isCatalog(value: unknown): value is ExternalMcpCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record["serverName"] === "string"
    && Array.isArray(record["tools"])
    && Array.isArray(record["resources"])
    && Array.isArray(record["resourceTemplates"])
    && Array.isArray(record["prompts"])
    && typeof record["refreshedAt"] === "string";
}

function loadCacheFile(): CatalogCacheFile {
  const path = getExternalMcpCatalogCachePath();
  if (!existsSync(path)) return emptyCache();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyCache();
    const record = parsed as Record<string, unknown>;
    if (record["schemaVersion"] !== 1 || !record["entries"] || typeof record["entries"] !== "object") {
      return emptyCache();
    }
    const entries: Record<string, CatalogCacheEntry> = {};
    for (const [name, value] of Object.entries(record["entries"] as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry["configFingerprint"] !== "string" || !isCatalog(entry["catalog"])) continue;
      entries[name] = {
        configFingerprint: entry["configFingerprint"],
        catalog: entry["catalog"],
      };
    }
    return { schemaVersion: 1, entries };
  } catch {
    return emptyCache();
  }
}

export function fingerprintExternalMcpServer(server: EffectiveExternalMcpServer): string {
  const normalized = {
    ...server,
    source: undefined,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Bind resumable handles to their endpoint, independent of exposure/timeouts. */
export function fingerprintExternalMcpConnection(server: EffectiveExternalMcpServer): string {
  return createHash("sha256").update(JSON.stringify(server.transport)).digest("hex");
}

export class ExternalMcpCatalogCache {
  private cache = loadCacheFile();

  get(server: EffectiveExternalMcpServer): ExternalMcpCatalog | undefined {
    const entry = this.cache.entries[server.name];
    if (!entry || entry.configFingerprint !== fingerprintExternalMcpServer(server)) return undefined;
    return structuredClone(entry.catalog);
  }

  put(server: EffectiveExternalMcpServer, catalog: ExternalMcpCatalog): void {
    this.cache.entries[server.name] = {
      configFingerprint: fingerprintExternalMcpServer(server),
      catalog: structuredClone(catalog),
    };
    this.persist();
  }

  prune(servers: EffectiveExternalMcpServer[]): void {
    const names = new Set(servers.map((server) => server.name));
    let changed = false;
    for (const name of Object.keys(this.cache.entries)) {
      if (names.has(name)) continue;
      delete this.cache.entries[name];
      changed = true;
    }
    if (changed) this.persist();
  }

  private persist(): void {
    writePrivateMcpJson(getExternalMcpCatalogCachePath(), this.cache);
  }
}
