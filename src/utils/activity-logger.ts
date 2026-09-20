/**
 * HogAgent Activity Logger
 *
 * Records structured activity logs for agent sessions.
 * Each session gets a log file with YAML frontmatter and timestamped entries.
 *
 * Log file format:
 * ---
 * Created: YYYY-MM-DDThh:mm:ss
 * Session: [session-id]
 * Prompt: [core instruction summary]
 * Status: [running/error/completed]
 * Updated: YYYY-MM-DDThh:mm:ss
 * ---
 *
 * [hh:mm:ss] [call llm/execute tool/operate file]
 * Operate: [input content, max 100 chars + ...]
 * Output: [return value summary, max 50 chars + ...]
 */

import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogAction = "call llm" | "execute tool" | "operate file";
export type LogStatus = "running" | "error" | "completed";

export interface ActivityLogger {
  /** Initialize log file with frontmatter */
  init(sessionId: string, prompt: string): void;
  /** Record an operation entry */
  log(action: LogAction, input: string, output: string): void;
  /** Update the Output field of the most recent log entry */
  updateLastOutput(output: string): void;
  /** Update the Status field in frontmatter */
  setStatus(status: LogStatus): void;
  /** Close the logger (no more writes) */
  close(): void;
}

/** Truncate string to maxLen, append "..." if truncated */
function truncate(s: string, maxLen: number): string {
  const clean = s.replace(/\n/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen) + "...";
}

/** Format current time as hh:mm:ss */
function timeNow(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** Format current datetime as YYYY-MM-DDThh:mm:ss */
function datetimeNow(): string {
  return new Date().toISOString().slice(0, 19);
}

/** Create an activity logger that writes to the specified file path. */
export function createActivityLogger(logFilePath: string): ActivityLogger {
  let initialized = false;
  let closed = false;

  function writeFrontmatter(sessionId: string, prompt: string): void {
    const now = datetimeNow();
    // Ensure parent directory exists (may be missing after workspace cleanup or session reuse)
    mkdirSync(dirname(logFilePath), { recursive: true });
    const content = [
      "---",
      `Created: ${now}`,
      `Session: ${sessionId}`,
      `Prompt: ${truncate(prompt, 100)}`,
      `Status: running`,
      `Updated: ${now}`,
      "---",
      "",
    ].join("\n");
    writeFileSync(logFilePath, content, "utf-8");
  }

  function updateFrontmatterField(field: string, value: string): void {
    if (!existsSync(logFilePath)) return;
    const content = readFileSync(logFilePath, "utf-8");
    const updated = content.replace(
      new RegExp(`^(${field}: ).*$`, "m"),
      `$1${value}`,
    );
    // Also update the "Updated" timestamp
    const withTimestamp = updated.replace(
      /^Updated: .*$/m,
      `Updated: ${datetimeNow()}`,
    );
    writeFileSync(logFilePath, withTimestamp, "utf-8");
  }

  return {
    init(sessionId: string, prompt: string): void {
      if (initialized || closed) return;
      writeFrontmatter(sessionId, prompt);
      initialized = true;
    },

    log(action: LogAction, input: string, output: string): void {
      if (closed || !initialized) return;
      // If the previous turn set status to "completed", reset it to "running"
      // This handles multi-turn sessions where agent_end fires after each prompt
      updateFrontmatterField("Status", "running");
      const entry = [
        `[${timeNow()}] [${action}]`,
        `Operate: ${truncate(input, 100)}`,
        `Output: ${truncate(output, 50)}`,
        "",
      ].join("\n");
      appendFileSync(logFilePath, entry + "\n", "utf-8");
    },

    updateLastOutput(output: string): void {
      if (closed || !initialized) return;
      if (!existsSync(logFilePath)) return;
      const content = readFileSync(logFilePath, "utf-8");
      // Find the last "Output: " line and replace its content
      const lines = content.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith("Output: ")) {
          lines[i] = `Output: ${truncate(output, 50)}`;
          break;
        }
      }
      writeFileSync(logFilePath, lines.join("\n"), "utf-8");
    },

    setStatus(status: LogStatus): void {
      if (closed || !initialized) return;
      updateFrontmatterField("Status", status);
    },

    close(): void {
      if (closed) return;
      closed = true;
    },
  };
}
