#!/usr/bin/env node
/**
 * DOCX to Markdown Converter
 * Usage: node docx-to-markdown.mjs <input.docx> <output.md>
 *
 * Defaults to chain: DOCX → HTML (mammoth) → Markdown (turndown).
 * LLM path preferred when configured for direct conversion.
 */
import { existsSync } from "node:fs";
import { extname } from "node:path";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { parseArgs, log, writeOutput } from "./lib/doc-utils.mjs";
import { loadConfig, hasLlmConfig } from "./lib/config.mjs";
import { parseFileWithLlm } from "./lib/llm-file-parser.mjs";

const USAGE = "docx-to-markdown.mjs <input.docx> <output.md>";
const [inputPath, outputPath] = parseArgs(USAGE, process.argv.slice(2));

if (!existsSync(inputPath)) {
  log("error", `Input file not found: ${inputPath}`);
  process.exit(1);
}

const ext = extname(inputPath).toLowerCase();
if (ext !== ".docx") {
  log("error", `Unsupported file type "${ext}". Supported: .docx`);
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
    // LLM path: direct DOCX → Markdown
    log("info", `Using LLM parsing path: ${inputPath}`);
    markdown = await parseFileWithLlm(inputPath, "DOCX", config);
  } else {
    // Default chain: DOCX → HTML → Markdown
    log("info", `Using chain conversion (DOCX→HTML→MD): ${inputPath}`);
    const result = await mammoth.convertToHtml({ path: inputPath });

    if (result.messages && result.messages.length > 0) {
      for (const msg of result.messages) {
        log("warn", `mammoth: ${msg.type} - ${msg.message}`);
      }
    }

    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    turndown.use(gfm);

    markdown = turndown.turndown(result.value);
  }

  writeOutput(outputPath, markdown);
  console.log(`Markdown generated: ${outputPath}`);
} catch (err) {
  log("error", `DOCX to Markdown conversion failed: ${err.message}`);
  process.exit(1);
}
