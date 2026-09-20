/**
 * Shared utils: logging, file-type detection, arg validation, output writing.
 * Logs go to stderr; stdout reserved for result summaries.
 */
import { renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const LEVEL_TAG = { info: "INFO", warn: "WARN", error: "ERROR", debug: "DEBUG" };

/** Log to stderr (keeps stdout clean for result capture). */
export function log(level, msg) {
  const tag = LEVEL_TAG[level] || String(level).toUpperCase();
  process.stderr.write(`[${tag}] ${msg}\n`);
}

/** File extension → protocol file_type enum (uppercase). */
export function detectFileType(filePath) {
  const ext = extname(filePath).toLowerCase().replace(".", "");
  const map = {
    pdf: "PDF",
    docx: "DOCX",
    doc: "DOC",
    html: "HTML",
    htm: "HTML",
    md: "MD",
    markdown: "MD",
  };
  return map[ext] || ext.toUpperCase();
}

/**
 * Validate CLI arg count.
 * @param {string} usage Usage string
 * @param {string[]} args Argument array
 * @param {number} expectedCount Exact positional argument count
 * @returns {string[]} Validated args
 */
export function parseArgs(usage, args, expectedCount = 2) {
  if (args?.length === 1 && ["-h", "--help"].includes(args[0])) {
    console.log(`Usage: ${usage}`);
    process.exit(0);
  }
  if (!args || args.length !== expectedCount || args.some((arg) => typeof arg !== "string" || arg.trim() === "" || arg.startsWith("-"))) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  if (expectedCount >= 2 && resolve(args[0]) === resolve(args[1])) {
    console.error("Input and output paths must be different");
    process.exit(1);
  }
  if (expectedCount >= 1) {
    try {
      const input = statSync(args[0]);
      if (!input.isFile() || input.size > 100 * 1024 * 1024) {
        console.error("Input must be a regular file no larger than 100MB");
        process.exit(1);
      }
    } catch (error) {
      console.error(`Input file is not accessible: ${error.message}`);
      process.exit(1);
    }
  }
  return args;
}

/** Write output file and log summary. */
export function writeOutput(path, content) {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, content, { encoding: "utf-8", flag: "wx" });
    renameSync(tempPath, path);
  } finally {
    try { unlinkSync(tempPath); } catch { /* already renamed or never created */ }
  }
  log("info", `Output written: ${path} (${content.length} chars)`);
}
