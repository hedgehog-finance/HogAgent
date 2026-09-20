#!/usr/bin/env node
/**
 * Tool Usage Example
 *
 * Demo content (v4.0 — Pi internalized edition):
 *   1. Send prompts that trigger tool calls (math calculations)
 *   2. Observe tool_execution_start / tool_execution_update / tool_execution_end events
 *   3. See how the final response integrates tool results
 *   4. Demonstrate Pi built-in tools (ls/read file operations)
 *   5. Show how tool results flow back to the LLM
 *
 * Current tool set:
 *   File/shell tools: read, write, edit, bash, grep, find, ls
 *   HogAgent tools: math_calc, web_search, web_fetch, deliver_files
 *   Extension tools: spawn_sub_agent (sub-agent); get_tool_details and query_tool_result only with explicitly enabled content compression (default off)
 *
 * Usage: node examples/tool-usage.ts
 */

import { parseArgs } from "node:util";
import { HogAgentRpcClient, colors, colorize, sleep } from "./rpc-client.ts";

const { values } = parseArgs({
  options: {
    session: { type: "string", short: "s", default: "example-tools" },
    debug: { type: "boolean", short: "d", default: false },
  },
  allowPositionals: true,
});

// ─── Tool call tracing ───────────────────────────────────────────────────────

interface ToolExecution {
  toolName: string;
  callId: string;
  startTime: number;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
}

// ─── Register tool event listeners ───────────────────────────────────────────

function setupToolListeners(client: HogAgentRpcClient): () => void {
  const executions = new Map<string, ToolExecution>();

  const offStart = client.on("tool_execution_start", (data) => {
    const callId = (data.tool_call_id as string) ?? String(Date.now());
    const toolName = (data.tool_name as string) ?? "unknown";
    executions.set(callId, {
      toolName,
      callId,
      startTime: Date.now(),
      input: data.input,
    });
    console.log();
    console.log(colorize(`  ⚙  Tool call started`, colors.magenta + colors.bold));
    console.log(colorize(`     Tool name: ${toolName}`, colors.magenta));
    if (data.input) {
      console.log(
        colorize(`     Input params: ${JSON.stringify(data.input, null, 2).replace(/\n/g, "\n             ")}`, colors.dim)
      );
    }
  });

  const offUpdate = client.on("tool_execution_update", (data) => {
    const callId = (data.tool_call_id as string) ?? "";
    const exec = executions.get(callId);
    if (exec && data.partial_output) {
      process.stdout.write(colorize(`  [Tool output] ${data.partial_output}`, colors.gray));
    }
  });

  const offEnd = client.on("tool_execution_end", (data) => {
    const callId = (data.tool_call_id as string) ?? "";
    const exec = executions.get(callId);
    if (exec) {
      exec.durationMs = Date.now() - exec.startTime;
      exec.output = data.output;
      executions.delete(callId);
      console.log();
      console.log(colorize(`  ✓  Tool call complete`, colors.magenta + colors.bold));
      console.log(colorize(`     Tool name: ${exec.toolName}`, colors.magenta));
      console.log(colorize(`     Duration: ${exec.durationMs}ms`, colors.gray));
      if (data.output !== undefined) {
        const outStr = typeof data.output === "string"
          ? data.output
          : JSON.stringify(data.output, null, 2);
        // Print only first 200 chars
        const preview = outStr.length > 200 ? outStr.slice(0, 200) + "…" : outStr;
        console.log(
          colorize(`     Output result: ${preview.replace(/\n/g, "\n             ")}`, colors.dim)
        );
      }
      console.log();
    }
  });

  // Return cleanup function
  return () => {
    offStart();
    offUpdate();
    offEnd();
  };
}

// ─── Single tool task demo ───────────────────────────────────────────────────

async function demoToolTask(
  client: HogAgentRpcClient,
  title: string,
  prompt: string,
  expectedTools: string[]
): Promise<void> {
  console.log();
  console.log(colorize("┌─────────────────────────────────────────┐", colors.bold));
  console.log(colorize(`│  ${title.padEnd(39)}│`, colors.bold + colors.yellow));
  console.log(colorize("└─────────────────────────────────────────┘", colors.bold));
  console.log(colorize(`  Expected tools: ${expectedTools.join(", ")}`, colors.gray));
  console.log();

  console.log(colorize(`  User: ${prompt}`, colors.white + colors.bold));
  console.log();

  const response = client.waitForResponse(45000);
  await client.prompt(prompt);
  const fullText = await response;

  if (fullText) {
    console.log(colorize("  Assistant final reply:", colors.cyan + colors.bold));
    // Indent each line
    const lines = fullText.split("\n");
    for (const line of lines) {
      console.log(colorize(`  ${line}`, colors.white));
    }
  }

  console.log(colorize("  ────────────────────────────────────────", colors.gray));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(colorize("═══════════════════════════════════════════", colors.bold));
  console.log(colorize("  HogAgent RPC — Tool Usage Example", colors.cyan + colors.bold));
  console.log(colorize("═══════════════════════════════════════════", colors.bold));
  console.log();
  console.log(colorize("  This example demonstrates how HogAgent calls built-in tools,", colors.gray));
  console.log(colorize("  including math calculations, file operations (ls/read), and web_search.", colors.gray));

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
  console.log(colorize("  Tools are enabled by default (Pi internalized architecture, no mode switching needed)", colors.gray));

  // Register tool event listeners
  const cleanupToolListeners = setupToolListeners(client);

  // ── Task 1: Math calculation ────────────────────────────────────────────────
  await demoToolTask(
    client,
    "Math: 2^10 + sqrt(144)",
    "请计算 2的10次方 加上 144的平方根，并解释计算过程。",
    ["math_calc"]
  );

  await sleep(500);

  // ── Task 2: File operations (Pi built-in ls tool) ──────────────────────────
  await demoToolTask(
    client,
    "File ops: List workspace files",
    "请列出当前工作区根目录下的文件和文件夹。",
    ["ls"]
  );

  await sleep(500);

  // ── Task 3: Composite tool call (math_calc + write) ─────────────────────────
  await demoToolTask(
    client,
    "Composite: Calculate and write to file",
    "请计算斐波那契数列的前10项之和，然后将结果保存到工作区的 fibonacci_result.txt 文件中。",
    ["math_calc", "write"]
  );

  // Clean up tool listeners
  cleanupToolListeners();

  // Shutdown
  console.log();
  console.log(colorize("▶ Graceful shutdown...", colors.yellow));
  await client.shutdown();
  console.log(colorize("✓ Tool usage example complete", colors.green + colors.bold));
}

main().catch((err) => {
  console.error(colorize(`Uncaught error: ${(err as Error).message}`, colors.red));
  process.exit(1);
});
