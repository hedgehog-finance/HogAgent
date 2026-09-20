/** Session-free management API. HogAgent owns its configuration and provider discovery. */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getProjectRoot, getSystemDir, loadPersistedLlmSettings, loadSkillApiConfig, mergeLlmSettingsPatch, savePersistedLlmSettings, saveSkillApiConfig, type PersistedLlmSettings } from "./config.ts";
import { fetchModelsForProvider } from "./model-updater.ts";
import { HEDGEHOG_DEFAULT_MODEL_ID } from "./model-utils.ts";

const Fields = Type.Record(Type.String(), Type.Unknown());
const EndpointFields = {
  provider: Type.Optional(Type.String()), apiKey: Type.Optional(Type.String()),
  baseUrl: Type.Optional(Type.String()), modelId: Type.Optional(Type.String()),
};
const Settings = Type.Object({
  ...EndpointFields,
  providerApiKeys: Type.Optional(Type.Record(Type.String(), Type.String())),
  audit: Type.Optional(Type.Union([Type.Object({
    ...EndpointFields,
    minPassScore: Type.Optional(Type.Number()),
    maxIterations: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  }, { additionalProperties: true }), Type.Null()])),
  compaction: Type.Optional(Type.Object({
    autoCompactThreshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 })),
  }, { additionalProperties: true })),
}, { additionalProperties: true });
const Llm = Type.Object({ apiKey: Type.String(), provider: Type.Optional(Type.String()), model: Type.Optional(Type.String()), baseUrl: Type.Optional(Type.String()) }, { additionalProperties: false });
export const ConfigurationRequestSchema = Type.Union([
  Type.Object({ type: Type.Literal("get_settings") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("save_settings"), settings: Settings }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("sync_credentials"), llm: Type.Optional(Llm), apiKey: Type.Optional(Type.String()), workspace: Type.Optional(Type.String()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("refresh_models"), provider: Type.Optional(Type.String()), baseUrl: Type.Optional(Type.String()), apiKey: Type.Optional(Type.String()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("configure_skill"), name: Type.String(), config: Fields }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("get_skill_config"), name: Type.String() }, { additionalProperties: false }),
]);
export type ConfigurationRequest = Static<typeof ConfigurationRequestSchema>;

/** Shared with the in-session refresh_models RPC; credentials never come from Gateway keys.json. */
export async function listConfiguredModels(input: { provider?: string; baseUrl?: string; apiKey?: string }) {
  const settings = loadPersistedLlmSettings(true);
  const provider = input.provider || settings.provider || "hedgehog";
  const baseUrl = input.baseUrl ?? (provider === settings.provider ? settings.baseUrl : undefined);
  const apiKey = input.apiKey ?? (provider === (settings.provider || "hedgehog") ? settings.apiKey : undefined)
    ?? settings.providerApiKeys?.[provider];
  const models = await fetchModelsForProvider(provider, baseUrl, apiKey);
  return { provider, baseUrl: baseUrl || "", modelId: settings.modelId || "", models,
    ...(models.length ? {} : { error: apiKey || provider === "custom" ? `${provider} has no available models` : "LLM Key is required" }) };
}

function syncLlm(input: Static<typeof Llm>): PersistedLlmSettings {
  const current = loadPersistedLlmSettings(true);
  const provider = input.provider || "hedgehog";
  const next = structuredClone(current);
  next.providerApiKeys = { ...current.providerApiKeys };
  if (input.apiKey) next.providerApiKeys[provider] = input.apiKey;
  else delete next.providerApiKeys[provider];
  const baseUrl = input.baseUrl || (provider === "hedgehog" ? "https://api.ciweiai.com/api/llm/v1" : undefined);
  if (!current.provider || current.provider === provider) {
    next.provider = provider;
    next.apiKey = input.apiKey;
    if (!current.modelId && input.apiKey) next.modelId = input.model || (provider === "hedgehog" ? HEDGEHOG_DEFAULT_MODEL_ID : "");
    if (!current.baseUrl && baseUrl && input.apiKey) next.baseUrl = baseUrl;
  }
  if (current.audit?.provider === provider) {
    next.audit = { ...current.audit, apiKey: input.apiKey };
    if (!next.audit.baseUrl && baseUrl && input.apiKey) next.audit.baseUrl = baseUrl;
  }
  if (JSON.stringify(next) !== JSON.stringify(current)) savePersistedLlmSettings(next);
  return next;
}

function syncSkillKeys(apiKey: string, workspace?: string): void {
  const config = loadSkillApiConfig(true);
  const names = new Set(Object.keys(config).filter(name => name.startsWith("hedgehog-")));
  const dirs = [join(getSystemDir(), "skills"), join(getProjectRoot(), "skills"), ...(workspace ? [join(workspace, ".hogagent", "skills")] : [])];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("hedgehog-") && existsSync(join(dir, entry.name, "SKILL.md"))) names.add(entry.name);
    }
  }
  for (const name of names) {
    if (config[name]?.["api-key"] !== apiKey) saveSkillApiConfig(name, { "api-key": apiKey });
  }
}

export async function executeConfigurationRequest(input: unknown): Promise<Record<string, unknown>> {
  if (!Value.Check(ConfigurationRequestSchema, input)) throw new Error("Invalid HogAgent configuration request");
  switch (input.type) {
    case "get_settings": return { settings: loadPersistedLlmSettings(true) };
    case "save_settings": {
      const current = loadPersistedLlmSettings(true);
      const patch = { ...input.settings } as PersistedLlmSettings;
      if (input.settings.audit === null) delete patch.audit;
      savePersistedLlmSettings(mergeLlmSettingsPatch(current, patch));
      return { settings: loadPersistedLlmSettings(true) };
    }
    case "sync_credentials": {
      const settings = input.llm ? syncLlm(input.llm) : loadPersistedLlmSettings(true);
      if (input.apiKey !== undefined) syncSkillKeys(input.apiKey, input.workspace);
      return { settings };
    }
    case "refresh_models": return listConfiguredModels(input);
    case "configure_skill":
      saveSkillApiConfig(input.name, input.config);
      return { ok: true };
    case "get_skill_config": return { config: loadSkillApiConfig(true)[input.name] || {} };
  }
}
