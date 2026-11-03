import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeConfigurationRequest, listConfiguredModels } from "../../src/configuration-service.ts";

let systemDir: string;
beforeEach(() => {
  systemDir = mkdtempSync(join(tmpdir(), "hog-config-service-"));
  vi.stubEnv("HOGAGENT_USER_DIR", systemDir);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(systemDir, { recursive: true, force: true }); });
const write = (settings: unknown) => writeFileSync(join(systemDir, "llm-settings.json"), JSON.stringify(settings));
const read = () => JSON.parse(readFileSync(join(systemDir, "llm-settings.json"), "utf8"));

describe("shared LLM configuration boundaries", () => {
  it('does not seed disabled development Skills or change their saved preferences', async () => {
    const path = join(systemDir, 'skills_config.json');
    writeFileSync(path, JSON.stringify({'hedgehog-news-reports': {'api-key':'unchanged',isLongTaskSpecific:true},'hedgehog-other':{},personal:{'api-key':'personal'}}));
    vi.stubEnv('NODE_ENV','development'); vi.stubEnv('HEDGEHOG_DEV_ENDPOINTS','1');
    await executeConfigurationRequest({type:'sync_credentials',apiKey:'api-production'});
    expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({'hedgehog-news-reports':{'api-key':'unchanged',isLongTaskSpecific:true},'hedgehog-other':{'api-key':'api-production'},personal:{'api-key':'personal'}});
  });
  it("moves managed keys and endpoints together across environments without changing model preferences", async () => {
    write({ provider: "hedgehog", apiKey: "old", modelId: "chosen", baseUrl: "https://api.ciweiai.com/api/llm/v1",
      audit: { provider: "hedgehog", apiKey: "old", modelId: "audit-chosen", baseUrl: "https://api.ciweiai.com/api/llm/v1", maxIterations: 0 } });
    for (const baseUrl of ["http://127.0.0.1:8000/api/llm/v1", "https://api.hogagent.com/api/llm/v1", "https://api.ciweiai.com/api/llm/v1"]) {
      await executeConfigurationRequest({ type: "sync_credentials", llm: { provider: "hedgehog", apiKey: "new", baseUrl } });
      expect(read()).toMatchObject({ apiKey: "new", baseUrl, modelId: "chosen", providerApiKeys: { hedgehog: "new" },
        audit: { apiKey: "new", baseUrl, modelId: "audit-chosen", maxIterations: 0 } });
    }
  });
  it("preserves non-Hedgehog endpoints and a disabled audit during managed synchronization", async () => {
    write({ provider: "custom", apiKey: "personal", baseUrl: "https://private.test/v1", modelId: "chosen", audit: { provider: "close" } });
    await executeConfigurationRequest({ type: "sync_credentials", llm: { apiKey: "managed", baseUrl: "http://127.0.0.1:8000/api/llm/v1" } });
    expect(read()).toMatchObject({ provider: "custom", apiKey: "personal", baseUrl: "https://private.test/v1", modelId: "chosen", audit: { provider: "close" }, providerApiKeys: { hedgehog: "managed" } });
  });
  it('keeps an inactive managed provider endpoint paired for discovery and a later switch', async () => {
    write({provider:'custom',apiKey:'personal',baseUrl:'https://personal.test/v1',audit:{provider:'close'}});
    await executeConfigurationRequest({type:'sync_credentials',llm:{apiKey:'sk-test',baseUrl:'https://api.hogagent.com/api/llm/v1'}});
    const fetch = vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:[{id:'fixture'}]})));
    await listConfiguredModels({provider:'hedgehog'});
    expect(fetch).toHaveBeenCalledWith('https://api.hogagent.com/api/llm/v1/models',expect.objectContaining({headers:{Authorization:'Bearer sk-test'}}));
    await executeConfigurationRequest({type:'save_settings',settings:{provider:'hedgehog'}});
    expect(read()).toMatchObject({apiKey:'sk-test',baseUrl:'https://api.hogagent.com/api/llm/v1',audit:{provider:'close'}});
  });
  it.each([{ audit: { maxIterations: -1 } }, { compaction: { autoCompactThreshold: 2 } }])(
    "rejects invalid runtime values before persisting %j", async settings => {
      write({ provider: "hedgehog", apiKey: "unchanged" });
      await expect(executeConfigurationRequest({ type: "save_settings", settings })).rejects.toThrow("Invalid HogAgent configuration request");
      expect(read()).toEqual({ provider: "hedgehog", apiKey: "unchanged" });
    },
  );
  it("selects the new provider's cached key and drops the previous endpoint on a provider switch", async () => {
    write({ provider: "openai", apiKey: "personal", baseUrl: "https://old.test/v1", modelId: "old",
      providerApiKeys: { openai: "personal", hedgehog: "managed" }, audit: { provider: "close" } });
    await executeConfigurationRequest({ type: "save_settings", settings: { provider: "hedgehog", modelId: "new" } });
    expect(read()).toMatchObject({ provider: "hedgehog", apiKey: "managed", baseUrl: "", modelId: "new", audit: { provider: "close" } });
    await executeConfigurationRequest({ type: "save_settings", settings: { provider: "anthropic" } });
    expect(read()).toMatchObject({ apiKey: "", baseUrl: "", modelId: "" });
  });

  it("merges an audit key patch without erasing the provider or model, and isolates provider changes", async () => {
    write({ provider: "openai", apiKey: "main", providerApiKeys: { hedgehog: "managed" },
      audit: { provider: "openai", apiKey: "audit-old", modelId: "chosen", baseUrl: "https://old.test/v1", maxIterations: 0 } });
    await executeConfigurationRequest({ type: "save_settings", settings: { audit: { apiKey: "audit-new" } } });
    expect(read().audit).toMatchObject({ provider: "openai", apiKey: "audit-new", modelId: "chosen", maxIterations: 0 });
    await executeConfigurationRequest({ type: "save_settings", settings: { audit: { provider: "hedgehog", modelId: "new" } } });
    expect(read().audit).toMatchObject({ provider: "hedgehog", apiKey: "managed", modelId: "new", baseUrl: "", maxIterations: 0 });
    await executeConfigurationRequest({ type: "save_settings", settings: { audit: {} } });
    expect(read().audit).toEqual({});
  });

  it("uses the active provider key for model discovery and does not restore an explicitly cleared key", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "fixture" }] })));
    write({ provider: "hedgehog", apiKey: "active-key", providerApiKeys: { hedgehog: "stale-cache" } });
    expect((await listConfiguredModels({})).models).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: { Authorization: "Bearer active-key" } }));
    fetch.mockClear();
    expect(await listConfiguredModels({ apiKey: "" })).toMatchObject({ models: [], error: "LLM Key is required" });
    write({ provider: "hedgehog", apiKey: "", providerApiKeys: { hedgehog: "stale-cache" } });
    expect(await listConfiguredModels({})).toMatchObject({ models: [], error: "LLM Key is required" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
