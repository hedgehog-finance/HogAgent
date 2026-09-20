#!/usr/bin/env node
/**
 * Spreadsheet to JSON / Markdown Converter
 * Usage: node convert.mjs <input> <output> [--format=json|markdown] [--sheet=<name|index>]
 */

import { existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import XLSX from "xlsx";
import { markdownTable } from "markdown-table";

// ─── Parse CLI args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
  console.log("Usage: convert.mjs <input> <output> [--format=json|markdown] [--sheet=<name|index>]");
  process.exit(0);
}
const positionals = [];
const options = {};

for (let i = 0; i < args.length; i++) {
  const argument = args[i];
  if (!argument.startsWith("--")) {
    positionals.push(argument);
    continue;
  }

  const separator = argument.indexOf("=");
  const name = argument.slice(2, separator === -1 ? undefined : separator);
  if (!new Set(["format", "sheet"]).has(name)) {
    console.error(`Error: unknown option --${name || argument}`);
    process.exit(1);
  }
  if (Object.prototype.hasOwnProperty.call(options, name)) {
    console.error(`Error: duplicate option --${name}`);
    process.exit(1);
  }
  const value = separator === -1 ? args[i + 1] : argument.slice(separator + 1);
  if (separator === -1) {
    if (value === undefined || value.startsWith("--")) {
      console.error(`Error: --${name} requires a value`);
      process.exit(1);
    }
    i++;
  }
  if (value.trim() === "") {
    console.error(`Error: --${name} requires a non-empty value`);
    process.exit(1);
  }
  options[name] = value;
}

if (positionals.length > 2) {
  console.error(`Error: unexpected positional argument: ${positionals[2]}`);
  process.exit(1);
}

const inputPath = positionals[0];
const outputPath = positionals[1];

if (inputPath && outputPath && resolve(inputPath) === resolve(outputPath)) {
  console.error("Error: input and output paths must be different");
  process.exit(1);
}

if (!inputPath) {
  console.error("Usage: convert.mjs <input> <output> [--format=json|markdown] [--sheet=<name|index>]");
  console.error("");
  console.error("  <input>    .xlsx, .xls, or .csv file");
  console.error("  <output>   output file path (.json or .md)");
  console.error("  --format   json (default) or markdown");
  console.error("  --sheet    sheet name, 0-based index, or 'list' to print all sheet names");
  process.exit(1);
}

// ─── Resolve options ────────────────────────────────────────────────────────
const format = options.format ? options.format.toLowerCase() : "json";
const sheetOption = options.sheet;

if (!["json", "markdown"].includes(format)) {
  console.error(`Error: unsupported format "${format}". Use json or markdown.`);
  process.exit(1);
}

if (sheetOption !== "list" && !outputPath) {
  console.error("Error: <output> path is required unless --sheet=list is used.");
  process.exit(1);
}

if (!existsSync(inputPath)) {
  console.error(`Error: input file not found: ${inputPath}`);
  process.exit(1);
}
const inputStat = statSync(inputPath);
if (!inputStat.isFile() || inputStat.size > 100 * 1024 * 1024) {
  console.error("Error: input must be a regular spreadsheet file no larger than 100MB");
  process.exit(1);
}

const ext = extname(inputPath).toLowerCase();
if (![".xlsx", ".xls", ".csv"].includes(ext)) {
  console.error(`Error: unsupported file type "${ext}". Supported: .xlsx, .xls, .csv`);
  process.exit(1);
}

// ─── Read workbook ──────────────────────────────────────────────────────────
let workbook;
try {
  workbook = XLSX.readFile(inputPath);
} catch (error) {
  console.error(`Error: unable to read workbook: ${error.message}`);
  process.exit(1);
}
if (workbook.SheetNames.length === 0) {
  console.error("Error: workbook contains no sheets");
  process.exit(1);
}

// Handle --sheet=list
if (sheetOption === "list") {
  if (outputPath || options.format !== undefined) {
    console.error("Error: --sheet=list cannot be combined with an output path or --format");
    process.exit(1);
  }
  console.log(JSON.stringify(workbook.SheetNames));
  process.exit(0);
}

// Resolve target sheet
let sheetName;
if (sheetOption !== undefined) {
  const sheetVal = sheetOption;
  const isCanonicalIndex = /^(?:0|[1-9]\d*)$/.test(sheetVal);
  const idx = isCanonicalIndex ? Number(sheetVal) : NaN;
  if (isCanonicalIndex && Number.isSafeInteger(idx)) {
    if (idx >= 0 && idx < workbook.SheetNames.length) {
      sheetName = workbook.SheetNames[idx];
    } else if (workbook.Sheets[sheetVal]) {
      // Index out of range but an exact sheet name match exists
      // (e.g. a sheet literally named "2024") — fall back to name lookup
      sheetName = sheetVal;
    } else {
      console.error(`Error: sheet index ${idx} out of range (0-${workbook.SheetNames.length - 1})`);
      process.exit(1);
    }
  } else {
    if (!workbook.Sheets[sheetVal]) {
      console.error(`Error: sheet "${sheetVal}" not found. Available: ${JSON.stringify(workbook.SheetNames)}`);
      process.exit(1);
    }
    sheetName = sheetVal;
  }
} else {
  sheetName = workbook.SheetNames[0];
}

const sheet = workbook.Sheets[sheetName];

// ─── Convert ────────────────────────────────────────────────────────────────
const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

let outputContent;

if (format === "json") {
  outputContent = JSON.stringify(jsonRows, null, 2);
} else {
  // markdown
  if (jsonRows.length === 0) {
    outputContent = "(empty sheet)";
  } else {
    const headers = Object.keys(jsonRows[0]);
    const dataRows = jsonRows.map(row => headers.map(h => String(row[h] ?? "")));
    outputContent = markdownTable([headers, ...dataRows]);
  }
}

try {
  const tempPath = join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, outputContent, { encoding: "utf-8", flag: "wx" });
    renameSync(tempPath, outputPath);
  } finally {
    try { unlinkSync(tempPath); } catch { /* already renamed or never created */ }
  }
} catch (error) {
  console.error(`Error: unable to write output: ${error.message}`);
  process.exit(1);
}

const rowCount = jsonRows.length;
console.log(`Converted: ${inputPath} [sheet: ${sheetName}] -> ${outputPath} (${format}, ${rowCount} rows)`);
