#!/usr/bin/env node
/**
 * Basic Chat Example
 *
 * Demo content (v4.0 — Pi internalized edition):
 *   1. Start HogAgent subprocess in RPC mode
 *   2. Wait for ready event and read capability information
 *   3. Send prompt command (using text field)
 *   4. Listen for streaming events (message_start / message_update / message_end)
 *   5. Print assistant replies to console
 *   6. Demonstrate multi-turn conversation (3 exchanges)
 *   7. Graceful shutdown
 *
 * Usage: node examples/basic-chat.ts [--message "your message"]
 */

import { parseArgs } from "node:util";
import { HogAgentRpcClient, colors, colorize, printEvent, sleep } from "./rpc-client.ts";

// ─── Command-line arguments ──────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    message: { type: "string", short: "m" },
    session: { type: "string", short: "s", default: "example-basic" },
    debug: { type: "boolean", short: "d", default: false },
  },
  allowPositionals: true,
});

// ─── Conversation turns ─────────────────────────────────────────────────────

const CONVERSATION: string[] = values.message
  ? [values.message as string]
  : [
      "你好！请用一句话介绍一下你自己。",
      "你能处理哪些类型的任务？",
      "谢谢，再见！",
    ];

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(colorize("═══════════════════════════════════════", colors.bold));
  console.log(colorize("  HogAgent RPC — Basic Chat Example", colors.cyan + colors.bold));
  console.log(colorize("═══════════════════════════════════════", colors.bold));
  console.log();

  const client = new HogAgentRpcClient({ debug: values.debug as boolean });

  // ── Step 1: Start subprocess ────────────────────────────────────────────────
  console.log(colorize("▶ Step 1: Starting HogAgent (RPC mode)...", colors.yellow));

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

  // ── Step 2: Display ready event info ────────────────────────────────────────
  console.log(colorize("✓ HogAgent ready", colors.green + colors.bold));
  console.log(colorize(`  Session ID: ${readyEvent.session_id ?? "—"}`, colors.gray));

  const caps = readyEvent.capabilities as Record<string, unknown> | undefined;
  if (caps) {
    console.log(
      colorize(`  Built-in tools: ${(caps.builtin_tools as string[])?.join(", ") ?? "—"}`, colors.gray)
    );
    console.log(
      colorize(`  Extensions: ${(caps.extensions as string[])?.join(", ") || "none"}`, colors.gray)
    );
    console.log(
      colorize(`  Supports compaction: ${caps.supports_compaction ? "yes" : "no"}`, colors.gray)
    );
  }
  console.log();

  // ── Step 3: Listen for streaming events ─────────────────────────────────────
  console.log(colorize("▶ Step 3: Registering streaming event listeners...", colors.yellow));

  // Capture message_update and print incremental content in real time
  client.on("message_update", (data) => {
    if (data.delta) process.stdout.write(data.delta as string);
  });

  // message_start: new reply begins
  client.on("message_start", (data) => {
    if (data.role !== "assistant") return;
    process.stdout.write(colorize("\nAssistant: ", colors.cyan + colors.bold));
  });

  // message_end: reply ends
  client.on("message_end", (data) => {
    if (data.role !== "assistant") return;
    console.log(); // End with newline
    console.log(colorize("  ─────────────────────────", colors.gray));
  });

  // Listen for error events
  client.on("error", (data) => {
    console.error(colorize(`\n[Error] ${data.error}`, colors.red));
  });

  console.log();

  // ── Step 4: Multi-turn conversation ─────────────────────────────────────────
  console.log(colorize("▶ Step 4: Starting multi-turn conversation...", colors.yellow));
  console.log();

  for (let i = 0; i < CONVERSATION.length; i++) {
    const msg = CONVERSATION[i];
    console.log(colorize(`[Turn ${i + 1}/${CONVERSATION.length}]`, colors.gray));
    console.log(colorize(`User: ${msg}`, colors.white + colors.bold));

    // Subscribe before sending; user/tool message_end events do not finish a turn.
    const response = client.waitForResponse(30000);
    await client.prompt(msg);

    // Wait for the complete agent turn, including any tool calls.
    try {
      await response;
    } catch (error) {
      await client.shutdown();
      throw error;
    }

    // Brief pause between turns
    if (i < CONVERSATION.length - 1) {
      await sleep(500);
    }
  }

  // ── Step 5: Graceful shutdown ───────────────────────────────────────────────
  console.log();
  console.log(colorize("▶ Step 5: Graceful shutdown...", colors.yellow));
  await client.shutdown();
  console.log(colorize("✓ Done", colors.green + colors.bold));
}

main().catch((err) => {
  console.error(colorize(`Uncaught error: ${(err as Error).message}`, colors.red));
  process.exit(1);
});
