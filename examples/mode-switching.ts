#!/usr/bin/env node
/**
 * Thinking Levels Example
 *
 * Demo content (v4.0 — Pi internalized edition):
 *   1. Start with default thinking_level=off
 *   2. Switch to medium (medium reasoning depth)
 *   3. Switch to high (deep reasoning)
 *   4. Send the same question at each level and observe different behavior
 *
 * Thinking level descriptions:
 *   off     — No reasoning output, lowest latency
 *   minimal — Minimal reasoning, internal decisions only
 *   low     — Light reasoning
 *   medium  — Medium reasoning depth
 *   high    — Deep reasoning
 *   xhigh   — Maximum reasoning depth
 *
 * Usage: node examples/mode-switching.ts
 */

import { parseArgs } from "node:util";
import { HogAgentRpcClient, colors, colorize, sleep } from "./rpc-client.ts";
import type { ThinkingLevel } from "./rpc-client.ts";

const { values } = parseArgs({
  options: {
    session: { type: "string", short: "s", default: "example-thinking" },
    debug: { type: "boolean", short: "d", default: false },
  },
  allowPositionals: true,
});

// Prompts to send at each level
const LEVEL_PROMPTS: Record<string, string> = {
  off: "请用一句话解释什么是股票PE估值。",
  medium: "请分析为什么PE估值在不同行业间差异较大，给出2-3个原因。",
  high: "请从多个维度深入分析PE估值的局限性，并建议替代估值方法。",
};

// ─── Level demo function ─────────────────────────────────────────────────────

async function demoThinkingLevel(
  client: HogAgentRpcClient,
  level: ThinkingLevel,
  label: string,
  description: string
): Promise<void> {
  console.log();
  console.log(colorize("┌─────────────────────────────────────┐", colors.bold));
  console.log(colorize(`│  Level: ${level.padEnd(27)}│`, colors.bold + colors.cyan));
  console.log(colorize(`│  ${label.padEnd(35)}│`, colors.bold));
  console.log(colorize("└─────────────────────────────────────┘", colors.bold));
  console.log(colorize(`  Description: ${description}`, colors.gray));
  console.log();

  // Send set_thinking_level command
  console.log(colorize(`  → Sending set_thinking_level: ${level}`, colors.yellow));
  await client.setThinkingLevel(level);

  await sleep(200);

  const prompt = LEVEL_PROMPTS[level] ?? LEVEL_PROMPTS["off"]!;
  console.log(colorize(`  → Sending prompt: "${prompt}"`, colors.yellow));
  console.log();
  process.stdout.write(colorize("  Assistant: ", colors.cyan + colors.bold));

  const offUpdate = client.on("message_update", (data) => {
    if (data.delta) process.stdout.write(data.delta as string);
  });
  try {
    const response = client.waitForResponse(30000);
    await client.prompt(prompt);
    await response;
    console.log();
  } finally {
    offUpdate();
  }

  console.log(colorize("  ──────────────────────────────────", colors.gray));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(colorize("═══════════════════════════════════════════", colors.bold));
  console.log(colorize("  HogAgent RPC — Thinking Levels Example", colors.cyan + colors.bold));
  console.log(colorize("═══════════════════════════════════════════", colors.bold));
  console.log();
  console.log(colorize("  This example will cycle through off / medium / high thinking levels,", colors.gray));
  console.log(colorize("  sending prompts at each level to demonstrate different reasoning depths.", colors.gray));

  const client = new HogAgentRpcClient({ debug: values.debug as boolean });

  // Start HogAgent
  console.log();
  console.log(colorize("▶ Starting HogAgent...", colors.yellow));
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

  // ── Level 1: off ──────────────────────────────────────────────────────────
  await demoThinkingLevel(
    client,
    "off",
    "Reasoning off — Direct reply",
    "Lowest latency, suitable for simple Q&A. No reasoning output."
  );

  await sleep(300);

  // ── Level 2: medium ───────────────────────────────────────────────────────
  await demoThinkingLevel(
    client,
    "medium",
    "Medium reasoning — Moderate analysis",
    "Moderate depth of thinking before responding, balancing speed and quality."
  );

  await sleep(300);

  // ── Level 3: high ─────────────────────────────────────────────────────────
  await demoThinkingLevel(
    client,
    "high",
    "Deep reasoning — In-depth analysis",
    "Deep reasoning mode, suitable for complex problems requiring multi-angle analysis."
  );

  // Shutdown
  console.log();
  console.log(colorize("▶ Graceful shutdown...", colors.yellow));
  await client.shutdown();
  console.log(colorize("✓ Thinking levels example complete", colors.green + colors.bold));
}

main().catch((err) => {
  console.error(colorize(`Uncaught error: ${(err as Error).message}`, colors.red));
  process.exit(1);
});
