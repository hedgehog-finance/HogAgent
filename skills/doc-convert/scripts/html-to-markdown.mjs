#!/usr/bin/env node
/**
 * HTML to Markdown Converter
 * Usage: node html-to-markdown.mjs <input.html> <output.md>
 */
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { parseArgs, log, writeOutput } from "./lib/doc-utils.mjs";

const USAGE = "html-to-markdown.mjs <input.html> <output.md>";
const [inputPath, outputPath] = parseArgs(USAGE, process.argv.slice(2));

if (!existsSync(inputPath)) {
  log("error", `Input file not found: ${inputPath}`);
  process.exit(1);
}

const ext = extname(inputPath).toLowerCase();
if (ext !== ".html" && ext !== ".htm") {
  log("error", `Unsupported file type "${ext}". Supported: .html, .htm`);
  process.exit(1);
}
if (![".md", ".markdown"].includes(extname(outputPath).toLowerCase())) {
  log("error", "Output file must use a .md or .markdown extension");
  process.exit(1);
}

log("info", `Converting HTML to Markdown: ${inputPath}`);

try {
  const htmlContent = readFileSync(inputPath, "utf-8");

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  // Enable GFM plugin (tables, strikethrough, task lists)
  turndown.use(gfm);

  const markdown = turndown.turndown(htmlContent);
  writeOutput(outputPath, markdown);
  console.log(`Markdown generated: ${outputPath}`);
} catch (err) {
  log("error", `HTML to Markdown conversion failed: ${err.message}`);
  process.exit(1);
}
