/**
 * HogAgent RPC Client
 * Reusable utility module for launching and communicating with HogAgent
 * subprocesses via the RPC protocol.
 *
 * All example programs depend on this client.
 *
 * Architecture overview (v4.0 — Pi internalized edition):
 *   - Underlying engine: vendored Pi AgentHarness
 *   - Protocol: JSONL over stdin/stdout
 *   - No more mode / workflow concepts
 *   - Core commands: prompt, follow_up, steer, abort, set_model, set_thinking_level
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { getDefaultWorkspaceDir } from "../src/config.ts";

// ─── ANSI color utilities ────────────────────────────────────────────────────

export const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  // Foreground colors
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

export function colorize(text: string, ...codes: string[]): string {
  return `${codes.join("")}${text}${colors.reset}`;
}

// ─── Type definitions ────────────────────────────────────────────────────────

export interface StartOptions {
  /** Session ID, default "example-session" */
  session?: string;
  /** Working directory, default ~/.hogagent/workspace/ */
  workspace?: string;
  /** Config file path */
  config?: string;
  /** Startup timeout (ms), default 15000 */
  timeout?: number;
}

/** Thinking depth level */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// ─── Event listener types ────────────────────────────────────────────────────

type EventHandler = (data: Record<string, unknown>) => void;

// ─── HogAgent RPC Client ─────────────────────────────────────────────────────

export class HogAgentRpcClient {
  private proc: ChildProcess | null = null;
  private listeners: Map<string, EventHandler[]> = new Map();
  private debug: boolean;

  constructor(options: { debug?: boolean } = {}) {
    this.debug = options.debug ?? false;
  }

  /**
   * Start HogAgent subprocess (RPC mode) and wait for the ready event.
   */
  async start(options: StartOptions = {}): Promise<Record<string, unknown>> {
    const {
      session = "example-session",
      workspace = getDefaultWorkspaceDir(),
      config,
      timeout = 15000,
    } = options;

    // Locate hogagent binary or bin/hogagent.ts
    const binPath = this.resolveHogAgentBin();

    const args: string[] = ["--mode", "rpc", "--session", session, "--workspace", workspace];
    if (config) args.push("--config", config);

    const cmd = process.execPath;
    const cmdArgs = [binPath, ...args];

    if (this.debug) {
      console.log(colorize(`[RPC] Starting: ${cmd} ${cmdArgs.join(" ")}`, colors.gray));
    }

    this.proc = spawn(cmd, cmdArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Forward stderr to console (for debugging)
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      if (this.debug) {
        process.stderr.write(colorize(`[HogAgent stderr] ${chunk.toString()}`, colors.gray));
      }
    });

    // Parse stdout JSONL and trigger events
    const rl = createInterface({
      input: this.proc.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        if (this.debug) {
          console.log(
            colorize(`[RPC ←] ${JSON.stringify(event)}`, colors.gray + colors.dim)
          );
        }
        const type = event.type as string;
        const handlers = this.listeners.get(type) ?? [];
        const wildcards = this.listeners.get("*") ?? [];
        for (const h of [...handlers, ...wildcards]) {
          h(event);
        }
      } catch {
        if (this.debug) {
          console.warn(colorize(`[RPC] Cannot parse line: ${trimmed}`, colors.yellow));
        }
      }
    });

    // Wait for ready event (with timeout)
    const readyEvent = await this.once("ready", timeout);
    return readyEvent;
  }

  /**
   * Send any RPC command (serialized as JSONL and written to stdin).
   */
  async sendCommand(command: Record<string, unknown>): Promise<void> {
    if (!this.proc || !this.proc.stdin) {
      throw new Error("HogAgent process not started");
    }
    const line = JSON.stringify(command) + "\n";
    if (this.debug) {
      console.log(colorize(`[RPC →] ${JSON.stringify(command)}`, colors.cyan + colors.dim));
    }
    return new Promise((resolve, reject) => {
      this.proc!.stdin!.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ─── Convenience command methods ───────────────────────────────────────────

  /** Send user message */
  async prompt(message: string): Promise<void> {
    await this.sendCommand({ type: "prompt", text: message });
  }

  /** Follow-up (append question in current conversation context) */
  async followUp(message: string): Promise<void> {
    await this.sendCommand({ type: "follow_up", text: message });
  }

  /** Guide agent behavior (does not trigger a new turn, injected as directive) */
  async steer(instruction: string): Promise<void> {
    await this.sendCommand({ type: "steer", text: instruction });
  }

  /** Abort current generation */
  async abort(): Promise<void> {
    await this.sendCommand({ type: "abort" });
  }

  /** Set LLM model */
  async setModel(modelId: string): Promise<void> {
    await this.sendCommand({ type: "set_model", model_id: modelId });
  }

  /** Set thinking depth level */
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.sendCommand({ type: "set_thinking_level", level });
  }

  /** Query current state */
  async getState(): Promise<void> {
    await this.sendCommand({ type: "get_state" });
  }

  /** Create new session */
  async newSession(): Promise<void> {
    await this.sendCommand({ type: "new_session" });
  }

  /** Set LLM Provider configuration */
  async setLlmProvider(config: Record<string, unknown>): Promise<void> {
    await this.sendCommand({ type: "set_llm_provider", provider: config });
  }

  /** Install skill */
  async installSkill(name: string): Promise<void> {
    await this.sendCommand({ type: "install_skill", name });
  }

  /** Reload configuration */
  async reloadConfig(): Promise<void> {
    await this.sendCommand({ type: "reload_config" });
  }

  // ─── Event listeners ───────────────────────────────────────────────────────

  /**
   * Register event listener, returns cancel function.
   * event="*" listens to all events.
   */
  on(event: string, handler: EventHandler): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
    return () => {
      const updated = (this.listeners.get(event) ?? []).filter((h) => h !== handler);
      this.listeners.set(event, updated);
    };
  }

  /**
   * Wait for a single specified event, returns event data. Supports timeout.
   */
  once(event: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = this.on(event, (data) => {
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(data);
      });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`Waiting for event "${event}" timed out (${timeoutMs}ms)`));
        }, timeoutMs);
      }
    });
  }

  /**
   * Wait for a complete Quick/Standard turn (agent_end), including tool calls.
   * Register this promise before sending the prompt to avoid missing fast replies.
   */
  waitForResponse(timeoutMs = 60000): Promise<string> {
    return new Promise((resolve, reject) => {
      let fullText = "";
      let started = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          offStart();
          offUpdate();
          offEnd();
          offAbort();
          reject(new Error(`Waiting for response timed out (${timeoutMs}ms)`));
        }, timeoutMs);
      };

      const offStart = this.on("message_start", (data) => {
        if (data.role !== "assistant") return;
        started = true;
        fullText = "";
        resetTimer();
      });

      const offUpdate = this.on("message_update", (data) => {
        if (started) {
          fullText += (data.delta as string) ?? "";
          resetTimer();
        }
      });

      const finish = (error?: Error) => {
        if (timer) clearTimeout(timer);
        offStart();
        offUpdate();
        offEnd();
        offAbort();
        if (error) reject(error);
        else resolve(fullText);
      };
      const offEnd = this.on("agent_end", (data) => {
        finish(data.reason === "completed" ? undefined : new Error(`Agent ended: ${data.reason}`));
      });
      const offAbort = this.on("aborted", () => finish(new Error("Agent aborted")));

      resetTimer();
    });
  }

  /**
   * Shut down the HogAgent subprocess.
   */
  async shutdown(): Promise<void> {
    if (!this.proc) return;
    // Close stdin to trigger HogAgent graceful shutdown
    this.proc.stdin?.end();
    // Wait for process to exit (up to 5 seconds)
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.proc?.kill("SIGTERM");
        resolve();
      }, 5000);
      this.proc?.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
  }

  // ─── Internal utilities ────────────────────────────────────────────────────

  private resolveHogAgentBin(): string {
    // Prefer compiled output
    const distBin = resolve(fileURLToPath(import.meta.url), "../../dist/bin/hogagent.js");
    if (existsSync(distBin)) return distBin;

    // Fall back to bin/hogagent.ts using Node.js native TypeScript support
    const tsBin = resolve(fileURLToPath(import.meta.url), "../../bin/hogagent.ts");
    if (existsSync(tsBin)) return tsBin;

    throw new Error("HogAgent entry point missing; run this example from a complete checkout.");
  }
}

// ─── Utility functions ───────────────────────────────────────────────────────

/**
 * Pretty-print RPC event (with colors).
 */
export function printEvent(event: Record<string, unknown>): void {
  const type = event.type as string;
  const ts = event.timestamp ? colorize(` [${event.timestamp}]`, colors.gray) : "";

  const typeColors: Record<string, string> = {
    ready: colors.green + colors.bold,
    message_start: colors.cyan,
    message_update: colors.cyan,
    message_end: colors.cyan + colors.bold,
    tool_execution_start: colors.magenta,
    tool_execution_update: colors.magenta,
    tool_execution_end: colors.magenta + colors.bold,
    task_created: colors.yellow,
    task_progress: colors.yellow,
    task_checkpoint: colors.yellow + colors.bold,
    task_complete: colors.green + colors.bold,
    error: colors.red + colors.bold,
    state: colors.blue,
    shutdown: colors.gray,
  };

  const color = typeColors[type] ?? colors.white;
  console.log(`${colorize(`● ${type}`, color)}${ts}`);

  // Print key fields
  if (type === "message_update" && event.delta) {
    process.stdout.write(event.delta as string);
  } else if (type === "message_end") {
    if (event.delta) process.stdout.write(event.delta as string);
    console.log(); // Newline
  } else if (type === "error") {
    console.log(colorize(`  Error: ${event.error}`, colors.red));
  } else if (type === "tool_execution_start") {
    console.log(colorize(`  Tool: ${event.tool_name}`, colors.magenta));
    if (event.input) console.log(colorize(`  Input: ${JSON.stringify(event.input)}`, colors.dim));
  } else if (type === "tool_execution_end") {
    console.log(colorize(`  Tool complete: ${event.tool_name}`, colors.magenta));
  } else if (type === "task_checkpoint") {
    console.log(colorize(`  Task ID: ${event.task_id}  Workflow: ${event.workflow_id}`, colors.yellow));
  } else if (type === "task_complete") {
    console.log(colorize(`  Deliverables: ${JSON.stringify(event.deliverables)}`, colors.green));
  }
}

/**
 * Sleep utility function.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
