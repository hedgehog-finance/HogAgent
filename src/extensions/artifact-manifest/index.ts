import type { HogAgentContext, IExtension } from "../../utils/types.ts";
import { reconcileHogAgentManifests } from "../../artifacts/artifact-protocol.ts";
import { createLogger } from "../../utils/logger.ts";

const log = createLogger("artifact-manifest");

/** Internal disk protocol only: this extension never emits delivery events. */
export class ArtifactManifestExtension implements IExtension {
  name = "artifact-manifest";
  version = "1.0.0";
  private context: HogAgentContext | null = null;

  async initialize(context: HogAgentContext): Promise<void> {
    this.context = context;
  }

  async beforeAgentEnd(): Promise<void> {
    if (!this.context) return;
    reconcileHogAgentManifests(this.context);
  }

  async shutdown(): Promise<void> {
    this.context = null;
    log.info("Shutdown complete");
  }
}
