import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareArtifactMutation,
  reconcileHogAgentManifests,
  recordArtifactOrigin,
  recordArtifactRole,
  recordArtifactWrite,
  resolveArtifactFile,
  roleForExisting,
  startArtifactRun,
} from "../../src/artifacts/artifact-protocol.ts";
import { createEditTool } from "../../src/tools/builtin-tools.ts";
import { parseDeliveryDecision, parseLongTaskGroupResult, parseSubAgentResult, stripDeliveryDecision, stripLongTaskGroupResult } from "../../src/protocol/agent-result-schema.ts";
import type { HogAgentConfig, HogAgentContext } from "../../src/utils/types.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hogagent-artifacts-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeContext(workspace: string, taskDir: string, configPatch: Partial<HogAgentConfig> = {}): HogAgentContext {
  const config = {
    mode: "rpc",
    sessionId: "session-1",
    workspaceDir: workspace,
    sessionTaskDir: taskDir,
    llmProvider: { provider: "test", apiKey: "", models: [] },
    extensions: [],
    compaction: { autoCompactThreshold: 0.75 },
    ...configPatch,
  } as HogAgentConfig;
  return {
    registerTool: async () => undefined,
    unregisterTool: async () => undefined,
    on: () => () => undefined,
    emitEvent: () => undefined,
    getConfig: () => config,
    getSessionId: () => config.sessionId,
    getWorkspaceDir: () => workspace,
    getHarness: () => ({}) as HogAgentContext["getHarness"] extends () => infer T ? T : never,
    getLlmTracking: () => ({ sessionId: config.sessionId, workId: "work-1", taskId: "task-1" }),
    getRuntimeContext: () => ({ process: {} as any }),
  };
}

describe("HogAgent artifact protocol", () => {
  it("keeps indexed raw data protected after its origin expires, despite an older regular override", () => {
    const root = tempRoot(); const context = makeContext(root, root); const config = context.getConfig();
    startArtifactRun(config, "source-run"); const file = join(root, "captured.json"); writeFileSync(file, "original");
    recordArtifactRole(root, file, "regular"); recordArtifactOrigin(root, file, { type: "api", locator: "https://example.com/data" });
    reconcileHogAgentManifests(context);
    writeFileSync(file, "changed");
    expect(roleForExisting(file, config)).toBe("raw_data");
    expect(prepareArtifactMutation(file, config, "in_place")).toMatchObject({ ok: false });
  });
  it("records saved raw data with a sanitized origin and never lists Manifest itself", () => {
    const workspace = tempRoot();
    const taskDir = join(workspace, "tasks", "session-1");
    mkdirSync(taskDir, { recursive: true });
    const rawPath = join(taskDir, "captured-page.md");
    writeFileSync(rawPath, "raw");
    recordArtifactOrigin(taskDir, rawPath, {
      type: "web_fetch",
      locator: "https://example.com/article?signature=secret#part",
    });

    reconcileHogAgentManifests(makeContext(workspace, taskDir));
    const manifest = JSON.parse(readFileSync(join(taskDir, ".hedgehog", "artifact-manifest.json"), "utf-8"));
    expect(manifest.artifacts[0]).toMatchObject({
      path: "captured-page.md",
      role: "raw_data",
      access: "none",
      origin: { locator: "https://example.com/article" },
    });
    expect(manifest.artifacts.some((artifact: { path: string }) => artifact.path.startsWith(".hedgehog/"))).toBe(false);

    writeFileSync(rawPath, "changed");
    reconcileHogAgentManifests(makeContext(workspace, taskDir));
    reconcileHogAgentManifests(makeContext(workspace, taskDir));
    const repeated = JSON.parse(readFileSync(join(taskDir, ".hedgehog", "artifact-manifest.json"), "utf-8"));
    expect(repeated.integrity).toMatchObject({ status: "warning" });
    expect(repeated.integrity.warnings).toContain("Raw data was modified in place: captured-page.md");
  });

  it("rebuilds a malformed current Manifest instead of blocking task finalization", () => {
    const workspace = tempRoot();
    const taskDir = join(workspace, "tasks", "session-1");
    mkdirSync(join(taskDir, ".hedgehog"), { recursive: true });
    writeFileSync(join(taskDir, "notes.md"), "work");
    writeFileSync(join(taskDir, ".hedgehog", "artifact-manifest.json"), '{"schema_version":"1.0","artifacts":"invalid"}');

    reconcileHogAgentManifests(makeContext(workspace, taskDir));
    const manifest = JSON.parse(readFileSync(join(taskDir, ".hedgehog", "artifact-manifest.json"), "utf-8"));
    expect(manifest).toMatchObject({ schema_version: "1.0", revision: 1 });
    expect(manifest.artifacts).toHaveLength(1);
  });

  it("does not inherit a valid Manifest from another Session identity", () => {
    const workspace = tempRoot();
    const taskDir = join(workspace, "tasks", "session-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "notes.md"), "work");
    const firstContext = makeContext(workspace, taskDir);
    reconcileHogAgentManifests(firstContext);
    const first = JSON.parse(readFileSync(join(taskDir, ".hedgehog", "artifact-manifest.json"), "utf-8"));
    expect(first.revision).toBe(1);

    const secondContext = makeContext(workspace, taskDir, { sessionId: "session-2" });
    reconcileHogAgentManifests(secondContext);
    const second = JSON.parse(readFileSync(join(taskDir, ".hedgehog", "artifact-manifest.json"), "utf-8"));
    expect(second).toMatchObject({ revision: 1, session_id: "session-2" });
    expect(second.changes.map((change: { path: string }) => change.path)).toEqual(["notes.md"]);
  });

  it("leaves Gateway-owned Manifest reconciliation to Gateway", () => {
    const workspace = tempRoot();
    const taskDir = join(workspace, "tasks", "session-1");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "final-output-report.md"), "report");

    reconcileHogAgentManifests(makeContext(workspace, taskDir, { manifestOwner: "gateway" }));

    expect(existsSync(join(taskDir, ".hedgehog", "artifact-manifest.json"))).toBe(false);
  });

  it("blocks raw-data mutation and creates a version target for existing regular files", () => {
    const workspace = tempRoot();
    const taskDir = join(workspace, "tasks", "session-1");
    mkdirSync(taskDir, { recursive: true });
    const rawPath = join(taskDir, "data-source.json");
    const reportPath = join(taskDir, "report.md");
    writeFileSync(rawPath, "{}");
    writeFileSync(reportPath, "v1");
    const context = makeContext(workspace, taskDir);
    reconcileHogAgentManifests(context);

    expect(prepareArtifactMutation(rawPath, context.getConfig())).toMatchObject({ ok: false });
    context.getConfig().artifactRunPolicy = {
      schema_version: "1.0",
      delivery: { mode: "deliverables", locked: false, source: "system_default", files: [] },
      mutation: { mode: "new_version", locked: true, source: "user_protocol" },
    };
    const mutation = prepareArtifactMutation(reportPath, context.getConfig());
    expect(mutation).toMatchObject({ ok: true, versioned: true });
    if (mutation.ok) {
      expect(existsSync(mutation.path)).toBe(false);
      const reserved = prepareArtifactMutation(reportPath, context.getConfig());
      expect(reserved).toMatchObject({ ok: true, path: mutation.path, versioned: true });
      writeFileSync(mutation.path, 'v2');
      recordArtifactWrite(context.getConfig(), mutation.path, reportPath);
      const repeated = prepareArtifactMutation(reportPath, context.getConfig());
      expect(repeated).toMatchObject({ ok: true, path: mutation.path, versioned: true });
    }
    reconcileHogAgentManifests(context);
  });

  it("does not create a version file when edit validation fails", async () => {
    const workspace = tempRoot();
    const taskDir = join(workspace, "tasks", "session-1");
    mkdirSync(taskDir, { recursive: true });
    const reportPath = join(taskDir, "report.md");
    writeFileSync(reportPath, "original");
    const context = makeContext(workspace, taskDir, {
      artifactRunPolicy: {
        schema_version: "1.0",
        delivery: { mode: "deliverables", locked: false, source: "system_default", files: [] },
        mutation: { mode: "new_version", locked: true, source: "user_protocol" },
      },
    });
    reconcileHogAgentManifests(context);
    const edit = createEditTool(workspace, () => context.getConfig());
    const result = await edit.execute("edit-1", { path: reportPath, old_text: "missing", new_text: "replacement" });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("old_text not found") });
    expect(existsSync(join(taskDir, "report-v2.md"))).toBe(false);
  });

  it("resets artifact bookkeeping for each run", () => {
    const workspace = tempRoot();
    const taskDir = join(workspace, "tasks", "session-1");
    mkdirSync(taskDir, { recursive: true });
    const notesPath = join(taskDir, "notes.md");
    writeFileSync(notesPath, "notes");
    const context = makeContext(workspace, taskDir);
    reconcileHogAgentManifests(context);
    startArtifactRun(context.getConfig(), "run-1");
    recordArtifactWrite(context.getConfig(), notesPath);
    expect(prepareArtifactMutation(notesPath, context.getConfig())).toMatchObject({ ok: true, versioned: false });
    startArtifactRun(context.getConfig(), "run-2");
    expect(prepareArtifactMutation(notesPath, context.getConfig())).toMatchObject({ ok: true, versioned: true });
  });

  it("honors an explicit raw-data classification in the mutation guard", () => {
    const workspace = tempRoot();
    const taskDir = join(workspace, "tasks", "session-1");
    mkdirSync(taskDir, { recursive: true });
    const rawPath = join(taskDir, "api-response.json");
    writeFileSync(rawPath, "{}");
    recordArtifactRole(taskDir, rawPath, "raw_data");
    const context = makeContext(workspace, taskDir);

    expect(prepareArtifactMutation(rawPath, context.getConfig())).toMatchObject({ ok: false });
    reconcileHogAgentManifests(context);
  });

  it("accepts only discriminator-backed JSON at the reply tail", () => {
    expect(parseLongTaskGroupResult('text\n{"schema_version":"1.0","type":"long_task_group_result","summary":"ok","content":"done","output_files":[],"notes_for_next_group":""}')).toBeDefined();
    expect(parseLongTaskGroupResult('{"schema_version":"1.0","type":"long_task_group_result","summary":"ok","content":"file summary","output_files":["tasks/session-1/report.md"],"notes_for_next_group":""}')).toBeDefined();
    expect(stripLongTaskGroupResult('text\n```json\n{"type":"long_task_group_result","schema_version":"1.0","summary":"ok","content":"done","output_files":[],"notes_for_next_group":""}\n```')).toBe('text');
    expect(parseLongTaskGroupResult('{"summary":"legacy","content":"x","output_files":[]}')).toBeUndefined();
    expect(parseSubAgentResult('{"schema_version":"1.0","type":"sub_agent_result","summary":"ok","content":"done","output_files":[]} trailing')).toBeUndefined();
    const deliveryText = 'done\n{"schema_version":"1.0","type":"delivery_decision","mode":"selected_files","files":[{"path":"report.md"}]}';
    expect(parseDeliveryDecision(deliveryText)).toMatchObject({ mode: "selected_files", files: [{ path: "report.md" }] });
    expect(stripDeliveryDecision(deliveryText)).toBe("done");
    expect(parseDeliveryDecision('{"schema_version":"1.0","type":"delivery_decision","mode":"selected_files","files":[]}')).toBeUndefined();
    expect(parseDeliveryDecision('{"schema_version":"1.0","type":"delivery_decision","mode":"selected_files","files":[{"path":"../secret.md"}]}')).toBeUndefined();
  });

  it("uses contextual update defaults and forces a locked protocol mode", () => {
    const workspace = tempRoot();
    const taskDir = join(workspace, "tasks", "session-1");
    const projectDir = join(workspace, "projects", "demo");
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(join(projectDir, "src"), { recursive: true });
    mkdirSync(join(projectDir, "publish"), { recursive: true });
    const sourcePath = join(projectDir, "src", "app.ts");
    const reportPath = join(projectDir, "publish", "report.md");
    writeFileSync(sourcePath, "source");
    writeFileSync(reportPath, "report");
    const context = makeContext(workspace, taskDir, { projectDir });
    reconcileHogAgentManifests(context);

    expect(prepareArtifactMutation(sourcePath, context.getConfig())).toMatchObject({ ok: true, versioned: false, effectiveMode: "in_place" });
    expect(prepareArtifactMutation(reportPath, context.getConfig())).toMatchObject({ ok: true, versioned: true, effectiveMode: "new_version" });

    context.getConfig().artifactRunPolicy = {
      schema_version: "1.0",
      delivery: { mode: "none", locked: false, source: "system_default", files: [] },
      mutation: { mode: "new_version", locked: true, source: "user_protocol" },
    };
    expect(prepareArtifactMutation(sourcePath, context.getConfig(), "in_place")).toMatchObject({
      ok: true,
      versioned: true,
      effectiveMode: "new_version",
      forced: true,
    });
  });

  it("does not apply artifact update guards to project control files outside publish/src/data", () => {
    const workspace = tempRoot();
    const taskDir = join(workspace, "tasks", "session-1");
    const projectDir = join(workspace, "projects", "demo");
    const planPath = join(projectDir, "plans", "plan-1.md");
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(join(projectDir, "plans"), { recursive: true });
    writeFileSync(planPath, "# Plan");
    const context = makeContext(workspace, taskDir, { projectDir });

    expect(prepareArtifactMutation(planPath, context.getConfig())).toEqual({ ok: true, path: planPath, versioned: false });
  });

  it("resolves Manifest-relative Project paths before colliding workspace paths", () => {
    const workspace = tempRoot();
    const taskDir = join(workspace, "tasks", "session-1");
    const projectDir = join(workspace, "projects", "demo");
    mkdirSync(join(workspace, "publish"), { recursive: true });
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(join(projectDir, "publish"), { recursive: true });
    writeFileSync(join(workspace, "publish", "report.md"), "wrong workspace file");
    writeFileSync(join(projectDir, "publish", "report.md"), "project report");
    const context = makeContext(workspace, taskDir, { projectDir });
    reconcileHogAgentManifests(context);

    expect(resolveArtifactFile("publish/report.md", context.getConfig())).toMatchObject({
      absolutePath: realpathSync(join(projectDir, "publish", "report.md")),
      rootRelative: "publish/report.md",
      root: "project",
      role: "deliverable",
    });
  });
});
