#!/usr/bin/env node
/**
 * Full Session Lifecycle Example
 *
 * Demonstrates the complete HogAgent RPC session lifecycle from startup to shutdown (v4.0 — Pi internalized edition):
 *   1. Start HogAgent with custom configuration
 *   2. Read capability declaration from ready event
 *   3. Set model via set_model
 *   4. Set reasoning depth via set_thinking_level
 *   5. Conduct conversation (prompt + follow_up)
 *   6. Guide agent behavior using steer
 *   7. Query state via get_state
 *   8. Explain automatic pre-prompt context protection
 *   9. Create sub-session (new_session)
 *  10. Demonstrate abort mid-stream
 *  11. Graceful shutdown
 *
 * Usage: node examples/full-session.ts
 */

import { parseArgs } from "node:util";
import { HogAgentRpcClient, colors, colorize, printEvent, sleep } from "./rpc-client.ts";

const { values } = parseArgs({
  options: {
    session: { type: "string", short: "s", default: "example-full" },
    model: { type: "string", default: "claude-sonnet-4-20250514" },
    debug: { type: "boolean", short: "d", default: false },
  },
  allowPositionals: true,
});

// ─── Logging utilities ──────────────────────────────────────────────────────

let stepIdx = 0;
function step(label: string): void {
  stepIdx++;
  console.log();
  console.log(
    colorize(`${"─".repeat(50)}`, colors.gray)
  );
  console.log(
    colorize(`  Step ${stepIdx}: ${label}`, colors.cyan + colors.bold)
  );
  console.log(
    colorize(`${"─".repeat(50)}`, colors.gray)
  );
}

function info(msg: string): void {
  console.log(colorize(`  ℹ  ${msg}`, colors.blue));
}

function ok(msg: string): void {
  console.log(colorize(`  ✓  ${msg}`, colors.green + colors.bold));
}

function warn(msg: string): void {
  console.log(colorize(`  ⚠  ${msg}`, colors.yellow));
}

// ─── Streamed response collector ─────────────────────────────────────────────

async function collectStreamedResponse(
  client: HogAgentRpcClient,
  timeoutMs = 30000
): Promise<string> {
  process.stdout.write(colorize("\n  Assistant: ", colors.cyan + colors.bold));
  const offUpdate = client.on("message_update", (data) => {
    if (data.delta) process.stdout.write(data.delta as string);
  });
  try {
    return await client.waitForResponse(timeoutMs);
  } finally {
    offUpdate();
    console.log();
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(colorize("═══════════════════════════════════════════════════", colors.bold));
  console.log(colorize("  HogAgent RPC — Full Session Lifecycle Example", colors.cyan + colors.bold));
  console.log(colorize("═══════════════════════════════════════════════════", colors.bold));
  console.log();
  console.log(colorize("  This example demonstrates the complete usage of the HogAgent RPC protocol,", colors.gray));
  console.log(colorize("  covering all major commands and events in the v4.0 Pi internalized architecture.", colors.gray));

  const client = new HogAgentRpcClient({ debug: values.debug as boolean });

  // ── Step 1: Start HogAgent ──────────────────────────────────────────────────
  step("Start HogAgent (RPC mode)");
  info(`Session ID: ${values.session}`);

  let readyEvent: Record<string, unknown>;
  try {
    readyEvent = await client.start({
      session: values.session as string,
      timeout: 20000,
    });
  } catch (err) {
    console.error(colorize(`Startup failed: ${(err as Error).message}`, colors.red));
    process.exit(1);
  }
  ok("HogAgent started successfully");

  // ── Step 2: Read capability declaration ────────────────────────────────────
  step("Parse capability declaration from ready event");
  info(`Session ID: ${readyEvent.session_id ?? "—"}`);
  info(`HogAgent version: ${readyEvent.version ?? "—"}`);

  const caps = readyEvent.capabilities as Record<string, unknown> | undefined;
  if (caps) {
    info(`Built-in tools: ${(caps.builtin_tools as string[])?.join(", ") ?? "—"}`);
    info(`Extensions: ${(caps.extensions as string[])?.join(", ") || "none"}`);
    info(`Installed skills: ${(caps.installed_skills as string[])?.join(", ") || "none"}`);
    info(`Supports compaction: ${caps.supports_compaction ? "yes" : "no"}`);
    info(`Supports sub-agent: ${caps.supports_sub_agent ? "yes" : "no"}`);
  } else {
    warn("Capability declaration not available (capabilities field missing)");
  }

  // ── Step 3: Set model (set_model) ──────────────────────────────────────────
  step("Set LLM model via set_model command");
  info(`Target model: ${values.model}`);
  await client.setModel(values.model as string);
  ok("set_model command sent");

  await sleep(200);

  // ── Step 4: Set thinking level ─────────────────────────────────────────────
  step("Set reasoning depth via set_thinking_level");
  info("Target level: medium");
  await client.setThinkingLevel("medium");
  ok("set_thinking_level command sent");

  await sleep(200);

  // ── Step 5: Get current state (get_state) ──────────────────────────────────
  step("Query current state via get_state");
  await client.getState();
  const stateEvent = await client.once("state", 5000).catch(() => null);
  if (stateEvent) {
    ok("Received state event");
    info(`Model: ${stateEvent.model}`);
    info(`Provider: ${stateEvent.provider}`);
    info(`Thinking level: ${stateEvent.thinking_level}`);
    info(`Tool count: ${stateEvent.tool_count}`);
    info(`Session ID: ${stateEvent.session_id}`);
  } else {
    warn("Did not receive state event");
  }

  // ── Step 6: Conduct conversation ──────────────────────────────────────────
  step("Send prompt for conversation");

  const q1 = "请介绍一下什么是量化投资策略，简要说明主要类型。";
  info(`User: ${q1}`);
  const firstResponse = collectStreamedResponse(client);
  await client.prompt(q1);
  const r1 = await firstResponse;
  ok(`Received response (${r1.length} chars)`);

  // An idle conversation starts its next turn with prompt.
  await sleep(300);
  const q2 = "其中均值回归策略的核心逻辑是什么？";
  info(`Follow-up: ${q2}`);
  const nextResponse = collectStreamedResponse(client);
  const nextStarted = client.once("agent_start", 5000);
  await client.prompt(q2);
  await nextStarted;

  // ── Step 7: Use steer to guide behavior ─────────────────────────────────────
  step("Guide agent behavior using steer");
  info("Steering instruction: Please reply more concisely, each point in no more than 20 words");
  await client.steer("接下来请用更简洁的语言回复，每点不超过20字。");
  ok("Steer instruction injected");
  const r2 = await nextResponse;
  ok(`Received next response (${r2.length} chars)`);

  await sleep(200);

  // ── Step 8: Automatic context protection ────────────────────────────────────
  step("Automatic pre-prompt context protection");
  info("HogAgent compacts only when the next main-model prompt exceeds the configured threshold");
  info("The legacy compact command is disabled, so the session lifecycle has one compaction entry point");

  // ── Step 9: Create new session (new_session) ────────────────────────────────
  step("Create new session via new_session");
  await client.newSession();
  const newSessionEvent = await client.once("session_created", 10000).catch(() => null);
  if (newSessionEvent) {
    ok(`New session created: ${newSessionEvent.session_id ?? "—"}`);
  } else {
    warn("Did not receive session_created event");
  }

  // ── Step 10: Abort mid-stream demo ──────────────────────────────────────────
  step("Demonstrate abort command (stop ongoing generation mid-stream)");
  info("Send a long prompt first, then immediately abort");

  await client.prompt("请列举A股历史上所有重要的政策事件，并详细分析每个事件的市场影响……");
  // Brief wait (ensure generation has started)
  await sleep(800);
  await client.abort();
  ok("Abort command sent");
  await sleep(300);

  // ── Step 11: Graceful shutdown ──────────────────────────────────────────────
  step("Graceful shutdown");
  info("Close stdin → HogAgent detects stdin closure → emits shutdown event → process exits");

  const shutdownPromise = client.once("shutdown", 5000).catch(() => null);
  await client.shutdown();
  const shutdownEvent = await shutdownPromise;
  if (shutdownEvent) {
    ok(`Received shutdown event: ${JSON.stringify(shutdownEvent)}`);
  } else {
    ok("Process has exited");
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log();
  console.log(colorize("═══════════════════════════════════════════════════", colors.bold));
  console.log(colorize("  Full session lifecycle demonstration complete", colors.green + colors.bold));
  console.log(colorize("═══════════════════════════════════════════════════", colors.bold));
  console.log();
  console.log(colorize("  RPC commands demonstrated:", colors.gray));
  console.log(colorize("    start (--mode rpc)  →  set_model  →  set_thinking_level", colors.dim));
  console.log(colorize("    get_state  →  prompt  →  follow_up  →  steer", colors.dim));
  console.log(colorize("    new_session  →  abort  →  shutdown", colors.dim));
  console.log();
  console.log(colorize("  RPC events observed:", colors.gray));
  console.log(colorize("    ready  →  state  →  model_changed  →  thinking_level_changed", colors.dim));
  console.log(colorize("    message_start/update/end  →  optional compact_* lifecycle", colors.dim));
  console.log(colorize("    session_created  →  aborted  →  shutdown", colors.dim));
}

main().catch((err) => {
  console.error(colorize(`Uncaught error: ${(err as Error).message}`, colors.red));
  process.exit(1);
});
