import { isAbsolute } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { ArtifactRunPolicyContract } from "../protocol/generated-contracts.ts";
import type {
  ArtifactRunPolicy,
  ArtifactUpdateMode,
  DeliveryDecision,
  DeliveryMode,
  HogAgentConfig,
} from "../utils/types.ts";

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateRunPolicy = ajv.compile(ArtifactRunPolicyContract) as ValidateFunction<ArtifactRunPolicy>;

export function isArtifactRunPolicy(value: unknown): value is ArtifactRunPolicy {
  return validateRunPolicy(value);
}

export function defaultArtifactRunPolicy(projectScoped: boolean): ArtifactRunPolicy {
  return {
    schema_version: "1.0",
    delivery: {
      mode: projectScoped ? "none" : "deliverables",
      locked: false,
      source: "system_default",
      files: [],
    },
    mutation: { mode: "contextual", locked: false, source: "system_default" },
  };
}

export function normalizeDeliveryPath(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  if (!normalized || normalized.endsWith("/") || isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts.includes(".hedgehog")) return undefined;
  return normalized;
}

export function effectiveDeliveryDecision(config: HogAgentConfig): DeliveryDecision {
  const policy = config.artifactRunPolicy ?? defaultArtifactRunPolicy(Boolean(config.projectDir));
  if (policy.delivery.locked || !config.artifactRunState?.deliveryDecision
    || (config.artifactRunState.deliveryDecision.mode === "selected_files" && !config.artifactRunState.deliveryDecision.files?.length)) {
    return {
      schema_version: "1.0",
      type: "delivery_decision",
      mode: policy.delivery.mode,
      ...(policy.delivery.mode === "selected_files"
        ? { files: policy.delivery.files.map((path) => ({ path })) }
        : {}),
    };
  }
  return config.artifactRunState.deliveryDecision;
}

/** Completed-run recovery can reuse an explicit list, never rediscover old outputs. */
export function recoveryDeliveryDecision(decision: DeliveryDecision | undefined): DeliveryDecision {
  return decision?.mode === "none" || (decision?.mode === "selected_files" && decision.files?.length)
    ? decision : { schema_version: "1.0", type: "delivery_decision", mode: "none" };
}

export function resolveArtifactUpdateMode(
  config: HogAgentConfig,
  role: "intermediate" | "raw_data" | "regular" | "deliverable",
  requested?: ArtifactUpdateMode,
): { mode: ArtifactUpdateMode; forced: boolean } {
  const policy = config.artifactRunPolicy ?? defaultArtifactRunPolicy(Boolean(config.projectDir));
  if (policy.mutation.locked && policy.mutation.mode !== "contextual") {
    return { mode: policy.mutation.mode, forced: requested !== undefined && requested !== policy.mutation.mode };
  }
  if (requested) return { mode: requested, forced: false };
  if (role === "intermediate") return { mode: "in_place", forced: false };
  if (config.projectDir && role === "regular") return { mode: "in_place", forced: false };
  return { mode: "new_version", forced: false };
}

export function deliveryModeAllowsRole(mode: DeliveryMode, role: "intermediate" | "raw_data" | "regular" | "deliverable"): boolean {
  if (role === "intermediate" || mode === "none") return false;
  if (mode === "deliverables") return role === "deliverable";
  if (mode === "raw_data") return role === "raw_data";
  return true;
}
