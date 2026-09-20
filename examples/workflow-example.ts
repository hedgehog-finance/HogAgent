#!/usr/bin/env node
/**
 * Session Management Example
 *
 * Demo content (v4.0 — Pi internalized edition):
 *   1. Start and conduct initial conversation
 *   2. Use steer to guide agent behavior
 *   3. Observe the automatic pre-prompt context capacity policy
 *   4. Create new session (new_session)
 *   5. Query state via get_state
 *   6. Demonstrate follow_up follow-up questions
 *
 * Notes:
 *   In the Pi internalized architecture, sessions are persisted as JSONL files at
 *   <workspace>/sessions/<session_id>.jsonl
 *   HogAgent checks context capacity before model prompts and compacts automatically when needed.
 *   The legacy compact command is intentionally disabled.
 *
 * Usage: node examples/workflow-example.ts
 */

import { parseArgs } from "node:util";
import { HogAgentRpcClient, colors, colorize, sleep } from "./rpc-client.ts";

const { values } = parseArgs({
  options: {
    session: { type: "string", short: "s", default: "example-session-mgmt" },
    debug: { type: "boolean", short: "d", default: false },
  },
  allowPositionals: true,
});

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(colorize("═══════════════════════════════════════════", colors.bold));
  console.log(colorize("  HogAgent RPC — Session Management Example", colors.cyan + colors.bold));
  console.log(colorize("═══════════════════════════════════════════", colors.bold));
  console.log();
  console.log(colorize("  This example demonstrates session lifecycle management, including:", colors.gray));
  console.log(colorize("  steer guidance, automatic context protection, new_session creation.", colors.gray));

  const client = new HogAgentRpcClient({ debug: values.debug as boolean });

  // ── Step 1: Start ──────────────────────────────────────────────────────────
  console.log();
  console.log(colorize("▶ Step 1: Starting HogAgent...", colors.yellow));
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

  console.log(colorize(`✓ Ready  Session ID: ${readyEvent.session_id ?? "—"}`, colors.green));

  // Listen for common message events
  client.on("message_update", (data) => {
    if (data.delta) process.stdout.write(data.delta as string);
  });
  client.on("message_end", () => console.log());

  // ── Step 2: Initial conversation ──────────────────────────────────────────
  console.log();
  console.log(colorize("▶ Step 2: Sending initial prompt...", colors.yellow));
  console.log(colorize("  User: Please introduce the main sector classifications of the A-share market.", colors.white + colors.bold));
  process.stdout.write(colorize("\n  Assistant: ", colors.cyan + colors.bold));

  const response1 = client.waitForResponse(30000);
  const started = client.once("agent_start", 5000);
  await client.prompt("请介绍一下A股市场的主要板块分类。");
  await started;

  // ── Step 3: Use steer for guidance ─────────────────────────────────────────
  console.log();
  console.log(colorize("▶ Step 3: Using steer to guide agent behavior...", colors.yellow));
  console.log(colorize("  Steering instruction: \"Please use more concise language, one sentence per sector\"", colors.gray));

  await client.steer("请用更简洁的语言，每个板块一句话。");
  console.log(colorize("  ✓ Steer instruction injected", colors.green));

  // ── Step 4: Use follow_up for follow-up ────────────────────────────────────
  console.log();
  console.log(colorize("▶ Step 4: Sending follow_up question...", colors.yellow));
  console.log(colorize("  User: What sub-sectors does the technology sector include?", colors.white + colors.bold));
  process.stdout.write(colorize("\n  Assistant: ", colors.cyan + colors.bold));

  await client.followUp("其中科技板块包含哪些细分领域？");
  await response1;

  // ── Step 5: Query state ────────────────────────────────────────────────────
  console.log();
  console.log(colorize("▶ Step 5: Querying current state via get_state...", colors.yellow));

  await client.getState();
  const stateEvent = await client.once("state", 5000).catch(() => null);
  if (stateEvent) {
    console.log(colorize("  ✓ Received state event:", colors.green));
    console.log(colorize(`    Model: ${stateEvent.model}`, colors.blue));
    console.log(colorize(`    Provider: ${stateEvent.provider}`, colors.blue));
    console.log(colorize(`    Thinking level: ${stateEvent.thinking_level}`, colors.blue));
    console.log(colorize(`    Tool count: ${stateEvent.tool_count}`, colors.blue));
    console.log(colorize(`    Session ID: ${stateEvent.session_id}`, colors.blue));
  } else {
    console.log(colorize("  ⚠ Did not receive state event", colors.yellow));
  }

  // ── Step 6: Automatic context policy ───────────────────────────────────────
  console.log();
  console.log(colorize("▶ Step 6: Context capacity is checked automatically before prompts", colors.yellow));
  console.log(colorize("  Note: manual compact is disabled; compact_* events appear only when the threshold is reached", colors.gray));

  // ── Step 7: Continue conversation after compaction ─────────────────────────
  console.log();
  console.log(colorize("▶ Step 7: Continue conversation after compaction (verify context retained)...", colors.yellow));
  console.log(colorize("  User: Among the technology sectors mentioned earlier, which performed best in 2024?", colors.white + colors.bold));
  process.stdout.write(colorize("\n  Assistant: ", colors.cyan + colors.bold));

  const response3 = client.waitForResponse(30000);
  await client.prompt("刚才提到的科技板块中，哪些在2024年表现最好？");
  await response3;

  // ── Step 8: Create new session ─────────────────────────────────────────────
  console.log();
  console.log(colorize("▶ Step 8: Create new session (new_session)...", colors.yellow));
  console.log(colorize("  Note: Create a brand new empty session, conversation history is not carried over", colors.gray));

  await client.newSession();
  const newSessionEvent = await client.once("session_created", 5000).catch(() => null);
  if (newSessionEvent) {
    console.log(colorize(`  ✓ New session created: ${newSessionEvent.session_id}`, colors.green));
  } else {
    console.log(colorize("  ⚠ Did not receive session_created event", colors.yellow));
  }

  // ── Shutdown ───────────────────────────────────────────────────────────────
  console.log();
  console.log(colorize("▶ Graceful shutdown...", colors.yellow));
  await client.shutdown();
  console.log(colorize("✓ Session management example complete", colors.green + colors.bold));
  console.log();
  console.log(colorize("  Commands demonstrated:", colors.gray));
  console.log(colorize("    prompt → steer → follow_up → get_state → new_session", colors.dim));
}

main().catch((err) => {
  console.error(colorize(`Uncaught error: ${(err as Error).message}`, colors.red));
  process.exit(1);
});
