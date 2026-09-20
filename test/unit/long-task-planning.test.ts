import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPendingOrchestration,
  executeLongTask,
  runOrchestrationTurn,
  hasPendingOrchestration,
  type LongTaskDeps,
} from "../../src/long-task-orchestrator.ts";
import { resetAllModuleState, setAbortRequested } from "../../src/agent-state.ts";
import { ContextCompactionError } from "../../src/compaction-manager.ts";
import { OrchestrationAbortedError } from "../../src/utils/llm-error.ts";
import type { AssistantMessage } from "../../src/vendor/ai/types.ts";
import type { AuditClassification, RpcEvent } from "../../src/utils/types.ts";

const STEPS = [{ id: "step_1", group: "group_1", description: 'Read the literal string ",}" and [evidence]' }];
const PLAN = JSON.stringify(STEPS);
const CLASSIFICATION: AuditClassification = {
  optimizedPrompt: "筛选可比公司并生成报告",
  goals: ["生成报告"],
  acceptanceCriteria: ["报告完整"],
  complexity: "complex",
  skipClarification: true,
};

function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage } as AssistantMessage;
}

describe("Long Task planning boundary", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "hogagent-planning-"));
  });

  afterEach(() => {
    clearPendingOrchestration();
    resetAllModuleState();
    rmSync(testDir, { recursive: true, force: true });
  });

  function setup(replies: AssistantMessage[]) {
    let activeTools = ["read", "bash", "write"];
    const prompts: Array<{ text: string; tools: string[] }> = [];
    const events: RpcEvent[] = [];
    const mainHarness = {
      getActiveTools: () => activeTools.map(name => ({ name })),
      setActiveTools: vi.fn(async (names: string[]) => { activeTools = [...names]; }),
      setResources: vi.fn(async () => {}),
      prompt: vi.fn(async (text: string) => {
        prompts.push({ text, tools: [...activeTools] });
        // Stop at the execution boundary: no business tools or audit LLM are run.
        if (text.includes("Current Step Group to Execute")) throw new OrchestrationAbortedError();
        const next = replies.shift();
        if (!next) throw new Error("Unexpected extra planning call");
        return next;
      }),
    };
    const deps = {
      mainHarness,
      auditConfig: { maxIterations: 1 },
      allTools: [],
      allSkills: [],
      emitEvent: (event: RpcEvent) => events.push(event),
      workspaceDir: testDir,
      sessionTaskDir: testDir,
      ensureContextCapacity: vi.fn(async () => {}),
    } as unknown as LongTaskDeps;
    return { deps, mainHarness, prompts, events, activeTools: () => activeTools };
  }

  it.each([
    ["plain JSON", response(PLAN)],
    ["fenced JSON", response("```json\n" + PLAN + "\n```")],
    ["split text blocks", { ...response(""), content: [
      { type: "text", text: PLAN.slice(0, 70) },
      { type: "thinking", thinking: "internal reasoning" },
      { type: "text", text: PLAN.slice(70) },
    ] } as AssistantMessage],
    ["bracketed prose and unrelated code fence", response('[Planning]\n```json\n["read"]\n```\n```json\n' + PLAN + '\n```\n[Done]')],
    ["trailing comma without changing string values", response(PLAN.slice(0, -1) + ",]")],
  ])("accepts %s without a format correction", async (_name, reply) => {
    const { deps, prompts, events } = setup([reply]);
    await expect(executeLongTask(CLASSIFICATION, deps)).rejects.toBeInstanceOf(OrchestrationAbortedError);
    expect(JSON.parse(readFileSync(join(testDir, "plan.json"), "utf8"))).toEqual(STEPS);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].tools).toEqual(["read"]);
    expect(prompts[1].tools).toEqual(["read", "bash", "write"]);
    expect(events.filter(event => event.type === "error")).toEqual([]);
  });

  it.each([
    ["prose", response("我先读取相关技能，然后给出计划。")],
    ["empty output", response("")],
    ["truncated output", response(PLAN.slice(0, -1), "length")],
    ["non-step array", response('["read", "write"]')],
    ["missing description", response('[{"id":"step_1"}]')],
    ["duplicate IDs", response(JSON.stringify([...STEPS, ...STEPS]))],
    ["invalid group", response('[{"id":"step_1","description":"read","group":{}}]')],
  ])("corrects %s once with no tools before execution", async (_name, reply) => {
    const { deps, prompts, events } = setup([reply, response(PLAN)]);
    await expect(executeLongTask(CLASSIFICATION, deps)).rejects.toBeInstanceOf(OrchestrationAbortedError);
    expect(prompts).toHaveLength(3);
    expect(prompts.map(prompt => prompt.tools)).toEqual([["read"], [], ["read", "bash", "write"]]);
    expect(prompts[1].text).toContain("Do not execute");
    expect(JSON.parse(readFileSync(join(testDir, "plan.json"), "utf8"))).toEqual(STEPS);
    expect(events.filter(event => event.type === "error")).toEqual([]);
  });

  it("fails after one unsuccessful correction and restores the original tools", async () => {
    const { deps, prompts, events, activeTools } = setup([response("not JSON"), response("[]")]);
    await runOrchestrationTurn(deps, () => executeLongTask(CLASSIFICATION, deps));
    expect(prompts).toHaveLength(2);
    expect(events.filter(event => event.type === "error")).toEqual([
      expect.objectContaining({ error: expect.stringContaining("after one format correction") }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(/simplif|too complex/i);
    expect(activeTools()).toEqual(["read", "bash", "write"]);
    expect(existsSync(join(testDir, "plan.json"))).toBe(false);
    expect(existsSync(join(testDir, "orchestration-state.json"))).toBe(false);
  });

  it.each(["terminated", "429 rate_limit_exceeded", "401 invalid API key"])("preserves provider error %s without format correction", async error => {
    const { deps, prompts, events, activeTools } = setup([response(PLAN, "error", error)]);
    await runOrchestrationTurn(deps, () => executeLongTask(CLASSIFICATION, deps));
    expect(prompts).toHaveLength(1);
    expect(events.filter(event => event.type === "error")).toEqual([
      expect.objectContaining({ error: expect.stringContaining(error) }),
    ]);
    expect(JSON.stringify(events)).not.toContain("did not generate a valid execution plan");
    if (!error.startsWith("401")) {
      expect(events.filter(event => event.type === "error")).toEqual([
        expect.objectContaining({ error: `LLM call failed: ${error}` }),
      ]);
    }
    expect(activeTools()).toEqual(["read", "bash", "write"]);
    expect(existsSync(join(testDir, "plan.json"))).toBe(false);
  });

  it("accepts a valid plan after a known benign provider completion error", async () => {
    const { deps, prompts } = setup([response(PLAN, "error", "finishReason: MALFORMED_FUNCTION_CALL")]);
    await expect(executeLongTask(CLASSIFICATION, deps)).rejects.toBeInstanceOf(OrchestrationAbortedError);
    expect(prompts).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(testDir, "plan.json"), "utf8"))).toEqual(STEPS);
  });

  it("does not fail while the planning response is still pending", async () => {
    const { deps, events, mainHarness } = setup([]);
    let finish!: (reply: AssistantMessage) => void;
    mainHarness.prompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const run = executeLongTask(CLASSIFICATION, deps);
    await vi.waitFor(() => expect(mainHarness.prompt).toHaveBeenCalledTimes(1));
    expect(events.filter(event => event.type === "error")).toEqual([]);
    expect(existsSync(join(testDir, "plan.json"))).toBe(false);
    const settled = expect(run).rejects.toBeInstanceOf(OrchestrationAbortedError);
    finish(response(PLAN));
    await settled;
  });

  it("restores tools and suspends when planning requests clarification", async () => {
    const { deps, prompts, events, activeTools } = setup([response("[ASK_USER]\n1. 哪家公司？")]);
    await executeLongTask({ ...CLASSIFICATION, skipClarification: false }, deps);
    expect(hasPendingOrchestration()).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(events.filter(event => event.type === "error")).toEqual([]);
    expect(activeTools()).toEqual(["read", "bash", "write"]);
  });

  it.each(["abort", "compaction"])("does not bypass %s at the format correction boundary", async boundary => {
    const { deps, prompts, events, activeTools } = setup([response("not a plan")]);
    vi.mocked(deps.ensureContextCapacity).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      if (boundary === "abort") setAbortRequested(true);
      else throw new ContextCompactionError("capacity unavailable");
    });
    await expect(executeLongTask(CLASSIFICATION, deps)).rejects.toBeInstanceOf(
      boundary === "abort" ? OrchestrationAbortedError : ContextCompactionError,
    );
    expect(prompts).toHaveLength(1);
    expect(events.filter(event => event.type === "error")).toEqual([]);
    expect(activeTools()).toEqual(["read", "bash", "write"]);
  });
});
