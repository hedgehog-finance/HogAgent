/**
 * HogAgent Structured Logger
 *
 * Outputs structured JSON logs to stderr (stdout reserved for JSONL events in RPC mode).
 * Supports debug/info/warn/error levels with context tagging.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

/** Set the global log level. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Get the current global log level. */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
}

function formatLog(
  level: LogLevel,
  context: string,
  message: string,
  data?: Record<string, unknown>,
): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    ctx: context,
    msg: message,
  };
  if (data && Object.keys(data).length > 0) {
    entry.data = data;
  }
  return JSON.stringify(entry);
}

function writeLog(
  level: LogLevel,
  context: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;
  const line = formatLog(level, context, message, data);
  process.stderr.write(line + "\n");
}

/** Structured logger with context tagging. */
export const logger = {
  debug(context: string, message: string, data?: Record<string, unknown>): void {
    writeLog("debug", context, message, data);
  },

  info(context: string, message: string, data?: Record<string, unknown>): void {
    writeLog("info", context, message, data);
  },

  warn(context: string, message: string, data?: Record<string, unknown>): void {
    writeLog("warn", context, message, data);
  },

  error(context: string, message: string, data?: Record<string, unknown>): void {
    writeLog("error", context, message, data);
  },
};

/** Create a child logger bound to a specific context. */
export function createLogger(context: string) {
  return {
    debug(message: string, data?: Record<string, unknown>): void {
      writeLog("debug", context, message, data);
    },
    info(message: string, data?: Record<string, unknown>): void {
      writeLog("info", context, message, data);
    },
    warn(message: string, data?: Record<string, unknown>): void {
      writeLog("warn", context, message, data);
    },
    error(message: string, data?: Record<string, unknown>): void {
      writeLog("error", context, message, data);
    },
  };
}
