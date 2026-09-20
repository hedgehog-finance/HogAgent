import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryManagerExtension } from "../../src/extensions/delivery-manager/index.ts";
import { reconcileHogAgentManifests, recordArtifactRole, startArtifactRun } from "../../src/artifacts/artifact-protocol.ts";
import { deliveryReceiptsFromEntries, deliveryResultsFromEntries } from "../../src/artifacts/file-delivery.ts";
import type { HogAgentConfig, HogAgentContext } from "../../src/utils/types.ts";

describe("delivery-manager lifecycle", () => {
  let ext: DeliveryManagerExtension;
  let workspace: string;
  let root: string;
  let config: HogAgentConfig;
  let context: HogAgentContext;
  let tools: any[];
  let events: any[];
  let entries: any[];
  let onEvent: (event: any) => void;
  let failPersistence: boolean;
  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "hog-delivery-"));
    root = join(workspace, "tasks", "session-1");
    mkdirSync(root, { recursive: true });
    config = { sessionId: "session-1", workspaceDir: workspace, sessionTaskDir: root } as HogAgentConfig;
    tools = []; events = []; entries = []; failPersistence = false;
    context = {
      getConfig: () => config, getSessionId: () => config.sessionId, getWorkspaceDir: () => workspace,
      registerTool: async (tool, registration) => { tools.push({ ...tool as any, registration }); },
      unregisterTool: async () => {}, on: () => () => {}, emitEvent: event => { events.push(event); },
      getHarness: () => ({ subscribe: (listener: any) => { onEvent = listener; return () => {}; } }) as any,
      getLlmTracking: () => ({ sessionId: config.sessionId, taskId: "task-1", workId: "work-1" }),
      getRuntimeContext: () => ({ process: {} as any }),
      captureDeliveryWriter: () => async data => {
        if (failPersistence) throw new Error("disk unavailable");
        entries.push({ type: "custom", customType: "hogagent.file-delivery", data });
      },
      readDeliveryHistory: async () => deliveryResultsFromEntries(entries),
    };
    startArtifactRun(config, "run-1");
    ext = new DeliveryManagerExtension();
    await ext.initialize(context);
  });
  afterEach(async () => { await ext.shutdown(); rmSync(workspace, { recursive: true, force: true }); });
  const requested = (path: string, summary?: string) => ({ path: `tasks/session-1/${path}`, ...(summary ? { summary } : {}) });
  const write = (path: string, body = "report") => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), body); };
  const delivered = () => events.filter(event => event.type === "delivery" && event.path);
  async function invoke(files: any[], persist = true) {
    const result = await tools[0].execute("call-1", { files });
    if (persist && result.details) {
      const message = { role: "toolResult", toolName: "deliver_files", details: result.details };
      entries.push({ type: "message", message });
      onEvent({ type: "message_end", message });
    }
    return result;
  }
  async function finish() { reconcileHogAgentManifests(context); await ext.beforeAgentEnd(); }

  it("retains the extension and tool name and limits the tool to the top level", () => {
    expect(ext.name).toBe("delivery-manager");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "deliver_files", registration: { topLevelOnly: true } });
  });
  it("publishes only after the native tool result has been persisted", async () => {
    write("chart.png");
    const result = await invoke([requested("chart.png", "Chart")], false);
    expect(delivered()).toEqual([]);
    const message = { role: "toolResult", toolName: "deliver_files", details: result.details };
    entries.push({ type: "message", message });
    onEvent({ type: "message_end", message });
    expect(delivered()[0]).toMatchObject({ path: "tasks/session-1/chart.png", description: "Chart", mime_type: "image/png" });
    expect(readFileSync(join(root, "chart.png"), "utf8")).toBe("report");
  });
  it("preserves successful and failed explicit requests without expanding at completion", async () => {
    write("report.md"); write("final-output-extra.pdf");
    const result = await invoke([requested("report.md"), requested("missing.md")]);
    expect(result.details.files).toHaveLength(1);
    expect(result.details.errors).toHaveLength(1);
    await finish();
    expect(delivered().map(file => file.path)).toEqual(["tasks/session-1/report.md"]);
    expect(config.artifactRunState?.explicitFiles).toHaveLength(2);
  });
  it("never broadens an all-failed nonempty request", async () => {
    write("final-output-extra.pdf");
    await invoke([requested("missing.md")]); await finish();
    expect(delivered()).toEqual([]);
    expect(events.some(event => event.requested_files?.length === 1)).toBe(true);
  });
  it("resolves explicit workspace paths once without guessing a same-name Session file", async () => {
    write("report.md");
    expect((await invoke([{ path: "report.md" }])).details.errors).toHaveLength(1);
    await invoke([requested("report.md")]); expect(delivered()).toHaveLength(1);
  });
  it.each(["../outside.md", "tasks/session-1/.hedgehog/artifact-manifest.json", "tasks/session-1/tmp-private.md", "tasks/other/report.md"])("rejects forbidden path %s", async path => {
    write("tmp-private.md"); mkdirSync(join(workspace, "tasks", "other")); writeFileSync(join(workspace, "tasks", "other", "report.md"), "other");
    const result = await invoke([{ path }]); expect(result.details.errors).toHaveLength(1); expect(delivered()).toEqual([]);
  });
  it("rejects a symlink escaping the business root", async () => {
    writeFileSync(join(workspace, "secret.md"), "secret"); symlinkSync(join(workspace, "secret.md"), join(root, "link.md"));
    expect((await invoke([requested("link.md")])).details.errors).toHaveLength(1); expect(delivered()).toEqual([]);
  });
  it("rejects an ordinary filename aliasing internal state inside the business root", async () => {
    mkdirSync(join(root, '.hedgehog')); writeFileSync(join(root, '.hedgehog/private.txt'), 'internal');
    symlinkSync(join(root, '.hedgehog/private.txt'), join(root, 'report.txt'));
    const result = await invoke([requested('report.txt')]);
    expect(result.details.files).toEqual([]); expect(result.details.errors).toHaveLength(1);
  });
  it("honors a locked role policy for explicit and automatic requests", async () => {
    config.artifactRunPolicy = { schema_version: "1.0", delivery: { mode: "deliverables", locked: true, source: "user_protocol", files: [] }, mutation: { mode: "contextual", locked: false, source: "system_default" } };
    write("data-source.csv"); write("final-output-report.pdf");
    const result = await invoke([requested("data-source.csv"), requested("final-output-report.pdf")]);
    expect(result.details.errors[0]).toContain("locked delivery mode"); await finish(); expect(delivered()).toHaveLength(1);
  });
  it("allows a raw companion only through an explicit permitted list", async () => {
    write("data-index.md"); await invoke([requested("data-index.md")]); expect(delivered()).toHaveLength(1);
  });
  it("delivers all new formats and versions in batches, including superseded files", async () => {
    for (let i = 0; i < 55; i++) write(`final-output-${i}.pdf`);
    write("final-output-report.md"); write("final-output-report-v2.md");
    await finish(); expect(delivered()).toHaveLength(57);
    expect(entries.filter(entry => entry.type === "custom").map(entry => entry.data.files.length)).toEqual([50, 7]);
    await ext.beforeAgentEnd(); expect(delivered()).toHaveLength(57);
  });
  it("preserves ordinary explicit deliverable roles in default selection", async () => {
    write("report.md"); recordArtifactRole(root, join(root, "report.md"), "deliverable");
    write("other.md"); write("sub-output-group.md"); await finish();
    expect(delivered().map(file => file.path)).toEqual(["tasks/session-1/report.md"]);
  });
  it("uses admission facts instead of the historical Manifest or future mtime", async () => {
    write("final-output-old.pdf"); utimesSync(join(root, "final-output-old.pdf"), new Date("2040-01-01"), new Date("2040-01-01"));
    startArtifactRun(config, "run-2"); write("final-output-new.pdf"); await finish();
    expect(delivered().map(file => file.path)).toEqual(["tasks/session-1/final-output-new.pdf"]);
  });
  it("detects a same-size modification with preserved mtime", async () => {
    write("final-output-report.pdf", "before"); const date = new Date("2020-01-01"); utimesSync(join(root, "final-output-report.pdf"), date, date);
    startArtifactRun(config, "run-2"); write("final-output-report.pdf", "after!"); utimesSync(join(root, "final-output-report.pdf"), date, date);
    await finish(); expect(delivered()).toHaveLength(1);
  });
  it("does not automatically repeat unchanged earlier output in a new run", async () => {
    write("final-output-report.pdf"); await finish(); startArtifactRun(config, "run-2"); await finish(); expect(delivered()).toHaveLength(1);
    await invoke([requested("final-output-report.pdf")]); expect(delivered()).toHaveLength(2);
  });
  it("accepts unchanged root-relative selected_files", async () => {
    write("report.md"); startArtifactRun(config, "run-2");
    config.artifactRunState!.deliveryDecision = { schema_version: "1.0", type: "delivery_decision", mode: "selected_files", files: [{ path: "report.md" }] };
    await finish(); expect(delivered()).toHaveLength(1);
  });
  it("respects none and defers orchestration deliveries", async () => {
    write("final-output-report.pdf"); ext.setDeliveryRestricted(true);
    expect((await invoke([requested("final-output-report.pdf")])).isError).toBe(true);
    await finish(); expect(delivered()).toEqual([]); ext.setDeliveryRestricted(false);
    config.artifactRunState!.deliveryDecision = { schema_version: "1.0", type: "delivery_decision", mode: "none" };
    await ext.beforeAgentEnd(); expect(delivered()).toEqual([]);
  });
  it("leaves Gateway automatic delivery to Gateway while retaining explicit delivery", async () => {
    config.manifestOwner = "gateway"; startArtifactRun(config, "gateway-run"); write("final-output-report.pdf"); await ext.beforeAgentEnd(); expect(delivered()).toEqual([]);
    await invoke([requested("final-output-report.pdf")]); expect(delivered()).toHaveLength(1);
  });
  it("refuses stale reconciliation and does not broadcast a failed persistence", async () => {
    write("final-output-report.pdf"); await expect(ext.beforeAgentEnd()).rejects.toThrow("reconciliation");
    reconcileHogAgentManifests(context); failPersistence = true; await expect(ext.beforeAgentEnd()).rejects.toThrow("disk unavailable"); expect(delivered()).toEqual([]);
    failPersistence = false; await ext.beforeAgentEnd(); expect(delivered()).toHaveLength(1);
  });
  it("restores receipts after restart and excludes model-authored lookalikes", async () => {
    write("final-output-report.pdf"); await finish(); const actual = entries[0].data;
    entries.push({ type: "message", message: { role: "assistant", details: actual } });
    expect(deliveryReceiptsFromEntries(entries, config.sessionId)).toHaveLength(1);
    await ext.shutdown(); ext = new DeliveryManagerExtension(); await ext.initialize(context); await ext.beforeAgentEnd(); expect(delivered()).toHaveLength(1);
  });
  it("recovers an explicit final list without rediscovering old outputs or resending real receipts", async () => {
    write("report.md"); write("pending.md");
    await invoke([requested("report.md")]);
    const oldRun = config.artifactRunState!.runId;
    startArtifactRun(config, "recovery-run");
    await ext.restoreCompletedDelivery({ schema_version: "1.0", type: "delivery_decision", mode: "selected_files", files: [{ path: "report.md" }, { path: "pending.md" }] }, oldRun);
    events.length = 0;
    await finish();
    expect(delivered().map(event => event.path)).toEqual(["tasks/session-1/pending.md"]);
    startArtifactRun(config, "next-run");
    await invoke([requested("report.md")]);
    expect(delivered().at(-1).path).toBe("tasks/session-1/report.md");
  });
  it("does not convert a recovered empty selection into default automatic discovery", async () => {
    await ext.restoreCompletedDelivery({ schema_version: "1.0", type: "delivery_decision", mode: "selected_files", files: [] }, "previous-run");
    write("final-output-report.md");
    await finish();
    expect(config.artifactRunState?.deliveryDecision?.mode).toBe("none");
    expect(delivered()).toEqual([]);
  });
  it("uses the final-output fallback without changing an explicitly regular role", async () => {
    write("final-output-report.html"); recordArtifactRole(root, join(root, "final-output-report.html"), "regular");
    await finish(); expect(delivered()).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(root, ".hedgehog/artifact-manifest.json"), "utf8"));
    expect(manifest.artifacts[0].role).toBe("regular");
  });

  it("applies locked deliverables to automatic fallback while protecting explicit lists", async () => {
    config.artifactRunPolicy = { schema_version: "1.0", delivery: { mode: "deliverables", locked: true, source: "user_protocol", files: [] }, mutation: { mode: "contextual", locked: false, source: "system_default" } };
    write("final-output-report.html"); recordArtifactRole(root, join(root, "final-output-report.html"), "regular");
    await finish(); expect(delivered()).toHaveLength(1);
    startArtifactRun(config, "explicit-run"); write("final-output-second.html"); recordArtifactRole(root, join(root, "final-output-second.html"), "regular");
    await invoke([requested("final-output-second.html")]); await finish();
    expect(delivered()).toHaveLength(1);
  });

  it("warns once per run for missing or empty final decisions before applying defaults", async () => {
    write("final-output-report.pdf"); await finish(); await ext.beforeAgentEnd();
    expect(events.filter(event => event.type === "warning" && event.message.includes("本轮交付策略"))).toHaveLength(1);
    startArtifactRun(config, "empty-selection");
    config.artifactRunState!.deliveryDecision = { schema_version: "1.0", type: "delivery_decision", mode: "selected_files", files: [] };
    await finish();
    expect(events.filter(event => event.type === "warning" && event.message.includes("本轮交付策略"))).toHaveLength(2);
  });
  it("does not revive invalidated legacy origins when explicitly delivering the changed file", async () => {
    write("data-legacy.json", "original"); mkdirSync(join(root, ".hedgehog"), { recursive: true });
    writeFileSync(join(root, ".hedgehog/artifact-origins.json"), JSON.stringify({ "data-legacy.json": { type: "api", locator: "https://example.com/source" } }));
    reconcileHogAgentManifests(context);
    startArtifactRun(config, "changed-run"); write("data-legacy.json", "changed"); reconcileHogAgentManifests(context);
    const result = await invoke([requested("data-legacy.json")]);
    expect(result.details.files).toHaveLength(1); expect(result.details.files[0].origin).toBeUndefined();
  });
  it("registers one receipt when automatic completion is entered concurrently", async () => {
    write("final-output-report.pdf"); reconcileHogAgentManifests(context);
    await Promise.all([ext.beforeAgentEnd(), ext.beforeAgentEnd()]);
    expect(entries.filter(entry => entry.type === "custom")).toHaveLength(1);
    expect(delivered()).toHaveLength(1);
  });
  it("does not register the rest of an already durable batch again after broadcast failure", async () => {
    write("final-output-a.pdf"); write("final-output-b.pdf");
    const emit = context.emitEvent;
    context.emitEvent = event => { if (event.type === "delivery" && event.path) throw new Error("transport unavailable"); emit(event); };
    reconcileHogAgentManifests(context); await expect(ext.beforeAgentEnd()).rejects.toThrow("transport unavailable");
    context.emitEvent = emit; await ext.beforeAgentEnd();
    expect(entries).toHaveLength(1);
    expect(deliveryReceiptsFromEntries(entries, config.sessionId)).toHaveLength(2);
  });
  it("stops a previous run between batches instead of persisting new-run receipts into its Session", async () => {
    for (let i = 0; i < 51; i++) write(`final-output-${String(i).padStart(2, "0")}.pdf`);
    const capture = context.captureDeliveryWriter!;
    context.captureDeliveryWriter = () => {
      const persist = capture();
      return async result => { await persist(result); startArtifactRun(config, "replacement-run"); };
    };
    reconcileHogAgentManifests(context);
    await expect(ext.beforeAgentEnd()).rejects.toThrow(/run|identity/i);
    expect(entries).toHaveLength(1);
    expect(entries[0].data.run_id).toBe("run-1");
  });
  it("rejects a replaced config after asynchronous delivery-history loading", async () => {
    write("report.md");
    context.readDeliveryHistory = async () => {
      config = { ...config }; startArtifactRun(config, "replacement-run"); return [];
    };
    const result = await invoke([requested("report.md")]);
    expect(result.isError).toBe(true); expect(delivered()).toEqual([]);
  });
  it("keeps an interrupted completion warning on the original Session", async () => {
    write("final-output-report.pdf"); reconcileHogAgentManifests(context);
    context.readDeliveryHistory = async () => { config = { ...config, sessionId: "new-session" }; return []; };
    await expect(ext.beforeAgentEnd()).rejects.toThrow(/identity/i);
    expect(events.filter(event => event.type === "warning").at(-1).session_id).toBe("session-1");
    expect(entries).toEqual([]);
  });

});
