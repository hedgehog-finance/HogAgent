import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the actual loader, tool registry, Harness and provider serializer;
// unrelated extension lifecycles are outside this fixture.
vi.mock("../../src/extensions/sub-agent/index.ts", () => ({ SubAgentExtension: class { name = "sub-agent"; async initialize() {} } }));
vi.mock("../../src/extensions/artifact-manifest/index.ts", () => ({ ArtifactManifestExtension: class { name = "artifact-manifest"; async initialize() {} } }));
vi.mock("../../src/extensions/delivery-manager/index.ts", () => ({ DeliveryManagerExtension: class { name = "delivery-manager"; async initialize() {} } }));
vi.mock("../../src/extensions/memory/index.ts", () => ({ MemoryExtension: class { name = "memory"; async initialize() {} } }));
vi.mock("../../src/extensions/external-mcp/index.ts", () => ({ ExternalMcpExtension: class { name = "external-mcp"; async initialize() {} } }));

import { AgentHarness } from "../../src/vendor/agent/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/vendor/agent/harness/env/nodejs.ts";
import { Session } from "../../src/vendor/agent/harness/session/session.ts";
import { InMemorySessionStorage } from "../../src/vendor/agent/harness/session/memory-storage.ts";
import { initializeExtensions, notifyHarnessReplaced, shutdownExtensions } from "../../src/extensions/index.ts";
import { createHogAgentContext } from "../../src/agent-context.ts";
import { AgentToolRegistry } from "../../src/tool-registry.ts";
import { ContentCompressorExtension } from "../../src/extensions/content-compressor/index.ts";
import { createReadTool } from "../../src/tools/builtin-tools.ts";
import { buildSystemPrompt } from "../../src/system-prompt.ts";
import { createModelHandlers } from "../../src/handlers/model-handlers.ts";
import { createSkillHandlers } from "../../src/handlers/skill-handlers.ts";
import { loadConfig, saveSystemConfig } from "../../src/config.ts";
import { beginInstructionSnapshot, endInstructionSnapshot } from "../../src/instruction-snapshot.ts";
import type { Model } from "../../src/vendor/ai/types.ts";
import { registerApiProvider, unregisterApiProviders } from "../../src/vendor/ai/api-registry.ts";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "../../src/vendor/ai/providers/openai-completions.ts";

describe("compression configuration and actual model tools", () => {
  let root: string;
  let requests: any[];
  let oldUserDir: string | undefined;
  beforeEach(() => {
    registerApiProvider({ api: "openai-completions", stream: streamOpenAICompletions, streamSimple: streamSimpleOpenAICompletions }, "compressor-test");
    root = mkdtempSync(join(tmpdir(), "compressor-runtime-"));
    oldUserDir = process.env.HOGAGENT_USER_DIR;
    process.env.HOGAGENT_USER_DIR = join(root, "config");
    mkdirSync(process.env.HOGAGENT_USER_DIR);
    writeFileSync(join(root, "AGENTS.md"), "Use only actual tools. Read required Skill instructions completely.");
    requests = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(JSON.parse(await request.text()));
      return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    unregisterApiProviders("compressor-test");
    await shutdownExtensions();
    endInstructionSnapshot(root);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (oldUserDir === undefined) delete process.env.HOGAGENT_USER_DIR;
    else process.env.HOGAGENT_USER_DIR = oldUserDir;
    rmSync(root, { recursive: true, force: true });
  });

  async function fixture(enabled?: boolean) {
    if (enabled !== undefined) saveSystemConfig({ extensions: [{ name: "content-compressor", enabled }] });
    const config = loadConfig({ workspaceDir: root });
    const model = {
      id: "test-model", name: "Test", api: "openai-completions", provider: "openai", baseUrl: "http://model.invalid/v1",
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000,
    } as Model<"openai-completions">;
    const registry = new AgentToolRegistry([{ tool: createReadTool(root), registration: { source: "builtin" } }]);
    const session = new Session(new InMemorySessionStorage());
    const makeHarness = () => new AgentHarness({
      env: new NodeExecutionEnv({ cwd: root }), session, model, tools: registry.snapshotTopLevel(),
      getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
      systemPrompt: ({ activeTools }) => buildSystemPrompt({ workspaceDir: root, sessionTaskDir: root, model, skills: [], activeTools }),
    });
    const harnessRef = { current: makeHarness() };
    const context = createHogAgentContext(harnessRef, config, {} as any, {} as any, registry);
    await initializeExtensions(context, config.extensions, root);
    const deps = { harnessRef, config, allSkills: [], currentModeRef: { value: "standard" }, skillsConfig: {}, auditModelObjRef: { value: null } } as any;
    return { config, context, registry, session, harnessRef, makeHarness, modelHandlers: createModelHandlers(deps, {} as any), skillHandlers: createSkillHandlers(deps, {} as any) };
  }

  function lastToolNames(): string[] { return (requests.at(-1)?.tools ?? []).map((tool: any) => tool.function.name); }
  function lastSystem(): string { return requests.at(-1).messages.filter((message: any) => message.role === "system" || message.role === "developer").map((message: any) => message.content).join("\n"); }

  it.each(["collision", "storage"])("leaves no partial tools or compression hook after initialization fails: %s", async failure => {
    const f = await fixture(false);
    if (failure === "collision") await f.context.registerTool({ ...createReadTool(root), name: "query_tool_result" });
    else vi.spyOn(f.session, "appendActiveToolsChange").mockRejectedValue(new Error("session disk unavailable"));
    const before = f.registry.snapshotTopLevel();
    const hook = vi.spyOn(f.harnessRef.current, "on");
    await expect(new ContentCompressorExtension().initialize(f.context)).rejects.toThrow();
    expect(f.registry.snapshotTopLevel()).toEqual(before);
    expect(f.harnessRef.current.getTools()).toEqual(before);
    expect(hook).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps file guidance with default-off in Gateway-managed=%s requests", async managed => {
    vi.stubEnv("HOGAGENT_GATEWAY_MANAGED", managed ? "1" : "0");
    const f = await fixture();
    const reply = await f.harnessRef.current.prompt("hello");
    expect(reply.stopReason, reply.errorMessage).not.toBe("error");
    expect(lastToolNames()).toEqual(["read"]);
    expect(lastSystem()).toContain("continue to EOF");
    expect(lastSystem()).not.toContain("get_tool_details");
    const rawDescription = requests.at(-1).tools[0].function.parameters.properties.raw.description;
    expect(rawDescription).toContain("Never bypasses");
    await f.harnessRef.current.setActiveTools([]);
    await f.harnessRef.current.prompt("quick");
    expect(lastToolNames()).toEqual([]);
    expect(lastSystem()).not.toContain("<data_access_strategies>");
  });

  it.each(["save_settings", "reload_config"])("applies %s before the next request and survives session/tool-set rebuilding", async command => {
    const f = await fixture(true);
    await f.harnessRef.current.prompt("before");
    expect(lastToolNames()).toEqual(["read", "get_tool_details", "query_tool_result"]);
    const retrievalSchema = requests.at(-1).tools.find((tool: any) => tool.function.name === "get_tool_details").function.parameters;
    expect(retrievalSchema.properties.offset).toMatchObject({ type: "integer", minimum: 1, description: expect.stringContaining("cached result") });
    expect(retrievalSchema.properties.lines).toMatchObject({ type: "integer", minimum: 1 });
    if (command === "save_settings") await f.modelHandlers.onSaveSettings({ type: command, systemConfig: { compressorEnabled: false } });
    else {
      saveSystemConfig({ extensions: [{ name: "content-compressor", enabled: false }] });
      await f.skillHandlers.onReloadConfig();
    }
    const events = vi.mocked(process.stdout.write).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events).toContainEqual(expect.objectContaining({
      type: command === "save_settings" ? "settings_saved" : "config_reloaded",
      builtin_tools: ["read"],
      systemConfig: expect.objectContaining({ compressorEnabled: false }),
    }));
    await f.harnessRef.current.prompt("after");
    expect(lastToolNames()).toEqual(["read"]);
    expect(lastSystem()).not.toContain("get_tool_details");
    expect(f.registry.snapshotSubAgent().map(tool => tool.name)).toEqual(["read"]);
    f.harnessRef.current = f.makeHarness();
    await notifyHarnessReplaced(f.harnessRef.current);
    await f.modelHandlers.onSaveSettings({ type: "save_settings", systemConfig: { compressorEnabled: true } });
    await f.harnessRef.current.setActiveTools(f.registry.namesTopLevel());
    await f.harnessRef.current.prompt("still disabled until restart");
    expect(lastToolNames()).toEqual(["read"]);
  });

  it("does not reload configuration during a top-level instruction snapshot", async () => {
    const f = await fixture(true);
    beginInstructionSnapshot(root);
    await expect(f.skillHandlers.onReloadConfig()).rejects.toThrow("current top-level execution");
    expect(f.registry.has("get_tool_details")).toBe(true);
  });

  it("restores the whole registry and scoped tool set if a subscriber fails after the Harness changed", async () => {
    const f = await fixture(true);
    await f.harnessRef.current.setActiveTools(["read", "get_tool_details"]);
    const before = f.registry.namesTopLevel();
    const unsubscribe = f.harnessRef.current.subscribe(event => {
      if (event.type === "tools_update") throw new Error("tool subscriber failed");
    });
    await expect(f.modelHandlers.onSaveSettings({type: "save_settings", systemConfig: {compressorEnabled: false}})).rejects.toThrow("tool subscriber failed");
    expect(f.registry.namesTopLevel()).toEqual(before);
    expect(f.harnessRef.current.getTools().map(tool => tool.name)).toEqual(before);
    expect(f.harnessRef.current.getActiveTools().map(tool => tool.name)).toEqual(["read", "get_tool_details"]);
    unsubscribe();
    const writes = vi.spyOn(f.session, "appendActiveToolsChange");
    await f.modelHandlers.onSaveSettings({type: "save_settings", systemConfig: {compressorEnabled: false}});
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith(["read"]);
  });

  it("keeps the whole tool set and compression hook if session persistence fails throughout disabling", async () => {
    const f = await fixture(true);
    const before = f.harnessRef.current.getActiveTools().map(tool => tool.name);
    const append = f.session.appendActiveToolsChange.bind(f.session);
    let failed = false;
    const write = vi.spyOn(f.session, "appendActiveToolsChange").mockImplementation(async names => {
      if (!names.includes("query_tool_result")) failed = true;
      if (failed) throw new Error("session disk unavailable");
      return append(names);
    });
    await expect(f.modelHandlers.onSaveSettings({ type: "save_settings", systemConfig: { compressorEnabled: false } })).rejects.toThrow("session disk unavailable");
    expect(f.registry.namesTopLevel()).toEqual(before);
    expect(f.harnessRef.current.getActiveTools().map(tool => tool.name)).toEqual(before);
    expect(vi.mocked(process.stdout.write).mock.calls.some(([line]) => JSON.parse(String(line)).type === "settings_saved")).toBe(false);
    write.mockRestore();
    await f.harnessRef.current.prompt("still usable after failed disable");
    expect(lastToolNames()).toEqual(before);
    await f.modelHandlers.onSaveSettings({ type: "save_settings", systemConfig: { compressorEnabled: false } });
    expect(f.registry.namesTopLevel()).toEqual(["read"]);
  });
  it("rejects a string compression switch before writing or changing runtime tools", async () => {
    const f = await fixture(true);
    await expect(f.modelHandlers.onSaveSettings({ type: "save_settings", systemConfig: { compressorEnabled: "false" } }))
      .rejects.toThrow("compressorEnabled must be a boolean");
    expect(loadConfig({ workspaceDir: root }).extensions.find(e => e.name === "content-compressor")?.enabled).toBe(true);
    expect(f.registry.has("get_tool_details")).toBe(true);
  });

});
