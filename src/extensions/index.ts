/**
 * HogAgent Extension Loader & Registry
 *
 * Loads built-in extensions, including the Artifact Manifest and delivery lifecycle,
 * loads external extensions from system and workspace paths,
 * initializes all extensions in order, and provides shutdown mechanism.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { discoverExtensions, isExtensionEnabled } from "../config.ts";
import { ContentCompressorExtension } from "./content-compressor/index.ts";
import { SubAgentExtension } from "./sub-agent/index.ts";
import { DeliveryManagerExtension } from "./delivery-manager/index.ts";
import { MemoryExtension } from "./memory/index.ts";
import { ArtifactManifestExtension } from "./artifact-manifest/index.ts";
import { ExternalMcpExtension } from "./external-mcp/index.ts";
import { createLogger } from "../utils/logger.ts";
import type { AgentHarness } from "../vendor/agent/harness/agent-harness.ts";
import type {
  ExtensionConfig,
  ExtensionDescriptor,
  HogAgentContext,
  IExtension,
} from "../utils/types.ts";

const log = createLogger("extensions");

// ─── Extension Registry ───────────────────────────────────────────────────────

const loadedExtensions: IExtension[] = [];

/** Get all currently loaded extensions. */
export function getLoadedExtensions(): readonly IExtension[] {
  return loadedExtensions;
}

/** Get the DeliveryManagerExtension instance (if loaded). */
export function getDeliveryManager(): DeliveryManagerExtension | null {
  return (loadedExtensions.find((e) => e.name === "delivery-manager") as DeliveryManagerExtension) ?? null;
}

/** Get extension names. */
export function getExtensionNames(): string[] {
  return loadedExtensions.map((ext) => ext.name);
}

/**
 * Start finalization hooks in registration order before a terminal agent_end.
 * Built-in hooks perform their mutations synchronously before returning their
 * Promise. Artifact reconciliation runs before standalone automatic delivery.
 */
export async function notifyBeforeAgentEnd(): Promise<boolean> {
  let completed = true;
  for (const ext of loadedExtensions) {
    if (!ext.beforeAgentEnd) continue;
    try {
      await ext.beforeAgentEnd();
    } catch (err) {
      completed = false;
      log.error("Extension beforeAgentEnd failed", {
        name: ext.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return completed;
}

/** Notify extensions that the active Agent run is being aborted. */
export async function notifyAgentAbort(): Promise<void> {
  await Promise.all(loadedExtensions.flatMap((ext) => {
    if (!ext.onAgentAbort) return [];
    return [ext.onAgentAbort().catch((error) => {
      log.warn("Extension abort hook failed", {
        name: ext.name,
        error: error instanceof Error ? error.message : String(error),
      });
    })];
  }));
}

// ─── Built-in Extensions ──────────────────────────────────────────────────────

/**
 * Load built-in extensions.
 * These are located in src/extensions/<name>/index.ts and registered at compile time.
 */
function getBuiltinExtensions(): IExtension[] {
  return [
    new ContentCompressorExtension(),
    new SubAgentExtension(),
    new ArtifactManifestExtension(),
    new DeliveryManagerExtension(),
    new MemoryExtension(),
    new ExternalMcpExtension(),
  ];
}

// ─── External Extension Loading ───────────────────────────────────────────────

/** Attempt to load an extension from a file path. */
async function loadExternalExtension(descriptor: ExtensionDescriptor): Promise<IExtension | null> {
  const entryPoint = join(descriptor.path, "index.js");
  if (!existsSync(entryPoint)) {
    log.warn("Extension entry point not found", {
      name: descriptor.name,
      path: entryPoint,
    });
    return null;
  }

  try {
    const mod = await import(entryPoint) as { default?: IExtension };
    const extension = mod.default;
    if (!extension || !extension.name || !extension.initialize) {
      log.warn("Extension module does not export a valid IExtension", {
        name: descriptor.name,
      });
      return null;
    }
    return extension;
  } catch (err) {
    log.error("Failed to load external extension", {
      name: descriptor.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Load and initialize all extensions (built-in + discovered).
 *
 * @param context - The HogAgent context passed to each extension for initialization
 * @param extensionConfigs - Extension configurations from HogAgentConfig
 * @param workspaceDir - Workspace directory for discovering external extensions
 */
export async function initializeExtensions(
  context: HogAgentContext,
  extensionConfigs: ExtensionConfig[],
  workspaceDir: string,
): Promise<void> {
  log.info("Initializing extensions");

  // 1. Load built-in extensions
  const builtins = getBuiltinExtensions();

  // 2. Discover and load external extensions
  const discovered = discoverExtensions(workspaceDir);
  const externals: IExtension[] = [];

  for (const descriptor of discovered) {
    const ext = await loadExternalExtension(descriptor);
    if (ext) {
      externals.push(ext);
    }
  }

  // 3. Combine all extensions
  const allExtensions = [...builtins, ...externals];

  // 4. Filter by effective configuration (content compression is opt-in).
  const enabledExtensions = allExtensions.filter((ext) => {
    // The Artifact Manifest is an internal completion protocol, not an optional
    // user feature. It must remain active even if an old config marks it false.
    if (ext.name === "artifact-manifest") return true;
    return isExtensionEnabled(ext.name, extensionConfigs);
  });

  // 5. Initialize in order
  for (const ext of enabledExtensions) {
    try {
      const config = extensionConfigs.find((c) => c.name === ext.name);
      await ext.initialize(context, config?.config);
      loadedExtensions.push(ext);
      log.info("Extension initialized", { name: ext.name, version: ext.version });
    } catch (err) {
      log.error("Extension initialization failed", {
        name: ext.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("Extensions initialization complete", { count: loadedExtensions.length });
}

// ─── Runtime Notifications ─────────────────────────────────────────────

/**
 * Notify loaded extensions that the AgentHarness instance was replaced
 * (new_session/resume_session). Extensions with harness-bound hooks re-attach here.
 */
export async function notifyHarnessReplaced(harness: AgentHarness): Promise<void> {
  for (const ext of loadedExtensions) {
    if (!ext.onHarnessReplaced) continue;
    try {
      await ext.onHarnessReplaced(harness);
      log.debug("Extension re-attached to new harness", { name: ext.name });
    } catch (err) {
      log.error("Extension onHarnessReplaced failed", {
        name: ext.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Push a runtime config change (save_settings) to a loaded extension.
 * No-op when the extension is not loaded or doesn't support runtime updates.
 */
export async function notifyExtensionConfigChanged(name: string, enabled: boolean, config?: unknown): Promise<void> {
  const ext = loadedExtensions.find((e) => e.name === name);
  if (!ext?.applyConfigUpdate) return;
  try {
    await ext.applyConfigUpdate(enabled, config);
    log.info("Extension configuration processed", { name, requestedEnabled: enabled });
  } catch (err) {
    log.error("Extension applyConfigUpdate failed", {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Apply the persisted snapshot at an idle RPC boundary; never load new extensions. */
export async function applyExtensionConfigUpdates(extensionConfigs: ExtensionConfig[]): Promise<void> {
  for (const ext of loadedExtensions) {
    const entry = extensionConfigs.find((candidate) => candidate.name === ext.name);
    await notifyExtensionConfigChanged(ext.name, isExtensionEnabled(ext.name, extensionConfigs), entry?.config);
  }
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

/** Shutdown all loaded extensions in reverse order. */
export async function shutdownExtensions(): Promise<void> {
  log.info("Shutting down extensions");

  // Shutdown in reverse initialization order
  const reversed = [...loadedExtensions].reverse();
  for (const ext of reversed) {
    if (ext.shutdown) {
      try {
        await ext.shutdown();
        log.info("Extension shutdown", { name: ext.name });
      } catch (err) {
        log.error("Extension shutdown failed", {
          name: ext.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  loadedExtensions.length = 0;
  log.info("All extensions shut down");
}
