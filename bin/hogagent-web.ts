#!/usr/bin/env node
/**
 * HogAgent Web UI Server CLI Entry Point
 *
 * Usage:
 *   hogagent-web [--port 9108] [--default-workspace <path>]
 *
 * Starts an HTTP/WebSocket server that bridges browser connections to
 * HogAgent RPC child processes.
 */

import { startWebServer } from "../src/web/server.ts";

// ─── Argument Parsing ─────────────────────────────────────────────────────────

interface ParsedArgs {
  port: number;
  defaultWorkspace?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    port: 9108,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--port":
        {
          const val = argv[++i];
          const num = val ? Number.parseInt(val, 10) : NaN;
          if (Number.isNaN(num) || num <= 0) {
            process.stderr.write(`Invalid port: ${val}\n`);
            process.exit(1);
          }
          args.port = num;
        }
        break;
      case "--default-workspace":
      case "--workspace":
        args.defaultWorkspace = argv[++i] ?? process.cwd();
        break;
      case "--help":
      case "-h":
        args.help = true;
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
HogAgent Web UI Server

Usage:
  hogagent-web [options]

Options:
  --port <number>              Web server port (default: 9108)
  --default-workspace <path>   Default workspace directory (default: ~/.hogagent/workspace/)
  --help, -h                   Show this help
`;
  process.stdout.write(help.trim() + "\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsedArgs = parseArgs(process.argv);

  if (parsedArgs.help) {
    showHelp();
    process.exit(0);
  }

  console.log("Starting HogAgent Web UI Server...");
  const server = await startWebServer({
    port: parsedArgs.port,
    defaultWorkspace: parsedArgs.defaultWorkspace,
  });

  const url = `http://localhost:${server.port}`;
  console.log(`Default workspace: ${server.defaultWorkspace}`);
  console.log(`HogAgent Web UI is running at ${url}`);
  console.log("Press Ctrl+C to stop.");

  const handleShutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    await server.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
  process.on("SIGINT", () => void handleShutdown("SIGINT"));
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Failed to start HogAgent Web UI Server:", message);
  process.exit(1);
});
