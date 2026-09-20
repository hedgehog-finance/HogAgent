import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isPathInside } from "./utils/path-safety.ts";

/** Process-owned launch configuration, never prompt metadata or an installation root. */
export function gatewayProjectsDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HOGAGENT_GATEWAY_MANAGED !== "1" || !env.HOGAGENT_GATEWAY_PROJECTS_DIR) return undefined;
  if (!isAbsolute(env.HOGAGENT_GATEWAY_PROJECTS_DIR)) throw new Error("Gateway projects directory must be absolute");
  return realpathSync(env.HOGAGENT_GATEWAY_PROJECTS_DIR);
}

export function resolveGatewayProject(projectId?: string, directory?: string): string | undefined {
  if (!projectId && !directory) return undefined;
  const projects = gatewayProjectsDirectory();
  if (!projects || !projectId || !directory || !isAbsolute(directory)) throw new Error("Gateway project binding is incomplete; reconnect the Agent and re-enter the project");
  const canonical = realpathSync(directory);
  if (canonical === projects || !isPathInside(projects, canonical)) throw new Error("Gateway project is outside the authenticated user projects directory");
  return canonical;
}

/** Gateway and standalone layouts deliberately retain different Manifest ownership. */
export function projectDeliverablesDirectory(): string {
  return process.env.HOGAGENT_GATEWAY_MANAGED === "1" ? "artifacts" : "publish";
}
