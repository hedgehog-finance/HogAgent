#!/usr/bin/env node
/**
 * Delivery Workflow Example
 *
 * Demo content (v4.0 — Pi internalized edition):
 *   1. Generate files with write and deliver them with deliver_files
 *   2. Batch deliver multiple generated files via deliver_files
 *   3. Read delivered files via read
 *   4. Observe delivery event handling on the client side
 *
 * Delivery mechanism overview:
 *   - write: Write content to an explicit authorized path
 *   - deliver_files:  Batch deliver existing files (preserve original filenames)
 *   - read:  Read delivered file contents
 *   - file_delivered: Delivery receipt emitted after successful delivery
 *
 * Usage: node examples/delivery-example.ts
 */

import { parseArgs } from "node:util";
import { HogAgentRpcClient, colors, colorize, sleep } from "./rpc-client.ts";

const { values } = parseArgs({
  options: {
    session: { type: "string", short: "s", default: "example-delivery" },
    debug: { type: "boolean", short: "d", default: false },
  },
  allowPositionals: true,
});

// ─── Delivery event collector ────────────────────────────────────────────────

interface DeliveryEvent {
  path: string;
  mimeType: string;
  size: number;
  timestamp: string;
}

function setupDeliveryListeners(client: HogAgentRpcClient): () => void {
  const deliveries: DeliveryEvent[] = [];

  const offDelivery = client.on("delivery", (data) => {
    const event: DeliveryEvent = {
      path: data.path as string,
      mimeType: data.mime_type as string,
      size: data.size as number,
      timestamp: data.timestamp as string,
    };
    deliveries.push(event);

    console.log();
    console.log(colorize(`  📦 File Delivered`, colors.green + colors.bold));
    console.log(colorize(`     Path: ${event.path}`, colors.green));
    console.log(colorize(`     Type: ${event.mimeType}`, colors.gray));
    console.log(colorize(`     Size: ${event.size} bytes`, colors.gray));
  });

  const offToolStart = client.on("tool_execution_start", (data) => {
    const toolName = data.tool_name as string;
    if (["write", "deliver_files", "read"].includes(toolName)) {
      console.log();
      console.log(colorize(`  ⚙  Delivery tool call: ${toolName}`, colors.magenta + colors.bold));
      if (data.input) {
        const input = data.input as Record<string, unknown>;
        if (input.content) {
          const preview = (input.content as string).slice(0, 80);
          console.log(colorize(`     Content preview: ${preview}...`, colors.dim));
        }
        if (input.files) {
          const fileList = (input.files as Array<{ path: string; summary?: string }>)
            .map((f) => f.summary ? `${f.path} (${f.summary})` : f.path);
          console.log(colorize(`     File list: ${JSON.stringify(fileList)}`, colors.dim));
        }
      }
    }
  });

  const offMessage = client.on("message_update", (data) => {
    if (data.delta) process.stdout.write(data.delta as string);
  });

  const offEnd = client.on("message_end", () => console.log());

  return () => {
    offDelivery();
    offToolStart();
    offMessage();
    offEnd();
    // Print summary
    if (deliveries.length > 0) {
      console.log();
      console.log(colorize(`  📋 Delivery Summary (${deliveries.length} files):`, colors.cyan + colors.bold));
      for (const d of deliveries) {
        console.log(colorize(`     ${d.path} (${d.mimeType}, ${d.size} bytes)`, colors.cyan));
      }
    }
  };
}

// ─── Single task demo ────────────────────────────────────────────────────────

async function demoDeliveryTask(
  client: HogAgentRpcClient,
  title: string,
  prompt: string,
): Promise<void> {
  console.log();
  console.log(colorize("┌─────────────────────────────────────────┐", colors.bold));
  console.log(colorize(`│  ${title.padEnd(39)}│`, colors.bold + colors.yellow));
  console.log(colorize("└─────────────────────────────────────────┘", colors.bold));
  console.log();

  console.log(colorize(`  User: ${prompt}`, colors.white + colors.bold));
  console.log();
  process.stdout.write(colorize("  Assistant: ", colors.cyan + colors.bold));

  const response = client.waitForResponse(60000);
  await client.prompt(prompt);
  await response;

  console.log(colorize("  ────────────────────────────────────────", colors.gray));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(colorize("═══════════════════════════════════════════", colors.bold));
  console.log(colorize("  HogAgent RPC — File Delivery Workflow Example", colors.cyan + colors.bold));
  console.log(colorize("═══════════════════════════════════════════", colors.bold));
  console.log();
  console.log(colorize("  This example demonstrates HogAgent's file delivery mechanism:", colors.gray));
  console.log(colorize("  write / deliver_files / read", colors.gray));

  const client = new HogAgentRpcClient({ debug: values.debug as boolean });

  // Start
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

  // Register delivery event listeners
  const cleanupListeners = setupDeliveryListeners(client);

  // ── Task 1: write (LLM writes content and delivers) ────────────────
  await demoDeliveryTask(
    client,
    "Task 1: write — write and deliver report",
    "请用 write 工具在当前任务目录写一份简短的 A股市场周报摘要（约200字），命名 final-output-report.md，然后用 deliver_files 交付。",
  );

  await sleep(500);

  // ── Task 2: deliver_files (batch deliver existing files) ────────────────────
  await demoDeliveryTask(
    client,
    "Task 2: deliver_files — batch deliver files",
    "请先用 write 在当前任务目录下生成两个文件：final-output-summary.txt（内容为'市场总结'）和 final-output-data.csv（内容为'日期,涨跌幅\\n2024-01-01,0.5%'），然后用 deliver_files 工具一次性交付这两个文件。",
  );

  await sleep(500);

  // ── Task 3: read (read delivered files) ───────────────────────────
  await demoDeliveryTask(
    client,
    "Task 3: read — read delivered files",
    "请用 read 工具读取之前交付的 final-output-report.md 的实际路径，并简要总结其内容。",
  );

  // Clean up listeners and print summary
  cleanupListeners();

  // Shutdown
  console.log();
  console.log(colorize("▶ Graceful shutdown...", colors.yellow));
  await client.shutdown();
  console.log(colorize("✓ File delivery example complete", colors.green + colors.bold));
  console.log();
  console.log(colorize("  Delivery tool quick reference:", colors.gray));
  console.log(colorize("    write({path, content})           → Write a file in the authorized task directory", colors.dim));
  console.log(colorize("    deliver_files({files:[{path, summary?}]}) → Batch deliver existing files (supports descriptions)", colors.dim));
  console.log(colorize("    read({path})                     → Read a delivered file by its actual path", colors.dim));
}

main().catch((err) => {
  console.error(colorize(`Uncaught error: ${(err as Error).message}`, colors.red));
  process.exit(1);
});
