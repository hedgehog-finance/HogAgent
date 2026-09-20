#!/usr/bin/env node
/**
 * PDF to Markdown Converter
 * Usage: node pdf-to-markdown.mjs <input.pdf> <output.md>
 *
 * Defaults to local unpdf (pdf.js-based) conversion.
 * LLM path preferred when configured for higher fidelity.
 */
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { extractText } from "unpdf";
import { parseArgs, log, writeOutput } from "./lib/doc-utils.mjs";
import { loadConfig, hasLlmConfig } from "./lib/config.mjs";
import { parseFileWithLlm } from "./lib/llm-file-parser.mjs";

const USAGE = "pdf-to-markdown.mjs <input.pdf> <output.md>";
const [inputPath, outputPath] = parseArgs(USAGE, process.argv.slice(2));

if (!existsSync(inputPath)) {
  log("error", `Input file not found: ${inputPath}`);
  process.exit(1);
}

const ext = extname(inputPath).toLowerCase();
if (ext !== ".pdf") {
  log("error", `Unsupported file type "${ext}". Supported: .pdf`);
  process.exit(1);
}
if (![".md", ".markdown"].includes(extname(outputPath).toLowerCase())) {
  log("error", "Output file must use a .md or .markdown extension");
  process.exit(1);
}

try {
  const config = loadConfig();
  let markdown;

  if (hasLlmConfig(config)) {
    // LLM path: high-fidelity parsing (tables, layout, formulas)
    log("info", `Using LLM parsing path: ${inputPath}`);
    markdown = await parseFileWithLlm(inputPath, "PDF", config);
  } else {
    // Default local path: unpdf (pdf.js-based)
    log("info", `Using local parsing path (unpdf): ${inputPath}`);
    const pdfBuffer = readFileSync(inputPath);
    const pdfData = new Uint8Array(pdfBuffer);
    const { text, totalPages } = await extractText(pdfData, { mergePages: false });
    log("info", `PDF parsed: ${totalPages} pages`);
    // Join page texts with Markdown horizontal rules
    markdown = text.join("\n\n---\n\n");
  }

  writeOutput(outputPath, markdown);
  console.log(`Markdown generated: ${outputPath}`);
} catch (err) {
  log("error", `PDF to Markdown conversion failed: ${err.message}`);
  process.exit(1);
}
