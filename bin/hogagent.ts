#!/usr/bin/env node
/**
 * HogAgent CLI Entry Point
 *
 * Usage:
 *   hogagent --mode rpc --session <id> --user <name> --workspace <path>
 *   hogagent --mode interactive --user <name>
 *
 * Options:
 *   --mode <interactive|rpc>   Operation mode (default: rpc)
 *   --session <id>             Session identifier (auto-generated if not provided)
 *   --user <name>              User identifier for workspace resolution (default: default)
 *   --config <path>            Path to custom config file
 *   --workspace <path>         Workspace directory (registered mapping; fresh default uses ~/.hogagent/workspace)
 *   --runtime-context-file <path>  Absolute process runtime context JSON path
 *   --debug                    Enable debug logging
 *   --help                     Show help
 *   --version                  Show version
 */

import { createInterface } from "node:readline";
import { getVersion } from "../src/version.ts";
import { createHogAgent } from "../src/index.ts";
import { readModeMetadata, type CliArgs } from "../src/config.ts";
import {
  emitEvent,
  installSignalHandlers,
  onShutdown,
  startRpcLoop,
  stopRpcLoop,
} from "../src/rpc.ts";
import { resolveWorkspaceOrExit } from "../src/user-workspace.ts";
import { createLogger, setLogLevel } from "../src/utils/logger.ts";

const log = createLogger("cli");

// ─── Argument Parsing ─────────────────────────────────────────────────────────

interface ParsedArgs {
  mode: "interactive" | "rpc";
  sessionId?: string;
  configPath?: string;
  workspaceDir?: string;
  user?: string;
  runtimeContextFile?: string;
  debug: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    mode: "rpc",
    debug: false,
    help: false,
    version: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--mode":
        {
          const val = argv[++i];
          if (val === "interactive" || val === "rpc") {
            args.mode = val;
          } else {
            process.stderr.write(`Invalid mode: ${val}. Use 'interactive' or 'rpc'.\n`);
            process.exit(1);
          }
        }
        break;
      case "--session":
        args.sessionId = argv[++i];
        break;
      case "--config":
        args.configPath = argv[++i];
        break;
      case "--workspace":
        args.workspaceDir = argv[++i];
        break;
      case "--user":
        args.user = argv[++i];
        break;
      case "--runtime-context-file":
        args.runtimeContextFile = argv[++i];
        if (!args.runtimeContextFile) {
          process.stderr.write("--runtime-context-file requires an absolute JSON file path.\n");
          process.exit(1);
        }
        break;
      case "--debug":
        args.debug = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`);
        process.exit(1);
    }
  }

  return args;
}

function showHelp(): void {
  const help = `
HogAgent - Unified AI Agent Engine

Usage:
  hogagent [options]

Options:
  --mode <interactive|rpc>  Operation mode (default: rpc)
  --session <id>            Session identifier
  --user <name>             User identifier for workspace resolution (default: default)
  --config <path>           Path to custom config file (config source, does NOT override CLI args)
  --workspace <path>        Workspace directory (registered mapping; fresh default uses ~/.hogagent/workspace)
  --runtime-context-file <path>
                            Absolute JSON file used for process runtime context
  --debug                   Enable debug logging
  --help, -h                Show this help
  --version, -v             Show version

Environment Variables:
  HOGAGENT_LLM_API_KEY      LLM API key (long-lived, overridden by llm-settings.json)
  HOGAGENT_LLM_PROVIDER     LLM provider name (e.g. hedgehog, openai, anthropic, google)
  HOGAGENT_LLM_BASE_URL     LLM API base URL
  HOGAGENT_USER_DIR         User config directory (default: ~/.hogagent)
  HOGAGENT_PROJECT_ROOT     HogAgent project root (auto-detected if not set)
  HOGAGENT_AUDIT_PROVIDER   Audit model provider
  HOGAGENT_AUDIT_API_KEY    Audit model API key
  HOGAGENT_AUDIT_BASE_URL   Audit model base URL
  HOGAGENT_AUDIT_MODEL_ID   Audit model ID
  HOGAGENT_AUDIT_MIN_PASS_SCORE  Audit min pass score (default: 75)
  HOGAGENT_AUDIT_MAX_ITERATIONS  Audit max iterations (default: 3)

Configuration Priority (high -> low):
  CLI args > --config file > llm-settings.json > workspace config > system config > env vars > defaults

Note: llm-settings.json (saved via WebUI) overrides env vars for LLM-specific fields.
`;
  process.stderr.write(help.trim() + "\n");
}

function showVersion(): void {
  process.stderr.write(`hogagent v${getVersion()}\n`);
}

// ─── Interactive Mode ─────────────────────────────────────────────────────────

async function runInteractive(cliArgs: CliArgs): Promise<void> {
  const user = cliArgs.user || "default";
  cliArgs.workspaceDir = resolveWorkspaceOrExit(user, cliArgs.workspaceDir);
  const instance = await createHogAgent({ ...cliArgs, mode: "interactive" });

  process.stderr.write("HogAgent Interactive Mode\n");
  process.stderr.write(`Session: ${instance.config.sessionId}\n`);
  process.stderr.write("Type your prompt (Ctrl+D to exit):\n\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: "hogagent> ",
  });

  // Subscribe to harness events for interactive output
  instance.harness.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const msg = event.message;
      if ("content" in msg && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ("text" in block && block.text) {
            process.stderr.write("\n" + block.text + "\n\n");
          }
        }
      }
      rl.prompt();
    }
  });

  rl.prompt();

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (trimmed === "/quit" || trimmed === "/exit") {
      rl.close();
      return;
    }

    if (trimmed === "/abort") {
      instance.harness.abort();
      rl.prompt();
      return;
    }

    void instance.harness.prompt(trimmed).catch((err: unknown) => {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      rl.prompt();
    });
  });

  rl.on("close", () => {
    process.stderr.write("\nGoodbye.\n");
    void instance.shutdown().then(() => process.exit(0));
  });
}

// ─── RPC Mode ─────────────────────────────────────────────────────────────────

async function runRpc(cliArgs: CliArgs): Promise<void> {
  const user = cliArgs.user || "default";
  cliArgs.workspaceDir = resolveWorkspaceOrExit(user, cliArgs.workspaceDir);
  const instance = await createHogAgent({ ...cliArgs, mode: "rpc" });

  // Install signal handlers for graceful shutdown
  installSignalHandlers();

  // Register instance shutdown callback for SIGTERM/SIGINT
  onShutdown(async () => {
    await instance.shutdown();
  });

  // Emit ready event with capabilities
  const capabilities = instance.getCapabilities();
  emitEvent({
    type: "ready",
    session_id: instance.config.sessionId,
    version: getVersion(),
    capabilities,
    has_incomplete_orchestration: instance.hasIncompleteOrchestration(),
    // Existing sessions report their validated persisted mode; new sessions remain unset.
    mode: readModeMetadata(instance.config.sessionTaskDir)?.mode ?? null,
  });

  // Start the RPC loop
  startRpcLoop();

  log.info("RPC mode started", { sessionId: instance.config.sessionId });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsedArgs = parseArgs(process.argv);

  if (parsedArgs.help) {
    showHelp();
    process.exit(0);
  }

  if (parsedArgs.version) {
    showVersion();
    process.exit(0);
  }

  if (parsedArgs.debug) {
    setLogLevel("debug");
  }

  const cliArgs: CliArgs = {
    mode: parsedArgs.mode,
    sessionId: parsedArgs.sessionId,
    configPath: parsedArgs.configPath,
    workspaceDir: parsedArgs.workspaceDir,
    user: parsedArgs.user,
    runtimeContextFile: parsedArgs.runtimeContextFile,
  };

  log.info("HogAgent starting", { mode: parsedArgs.mode });

  try {
    if (parsedArgs.mode === "interactive") {
      await runInteractive(cliArgs);
    } else {
      await runRpc(cliArgs);
    }
  } catch (err) {
    log.error("Fatal error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

void main();
