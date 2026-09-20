#!/usr/bin/env node
/**
 * DOCX to HTML Converter
 * Usage: node docx-to-html.mjs <input.docx> <output.html>
 */
import { existsSync } from "node:fs";
import { extname } from "node:path";
import mammoth from "mammoth";
import { parseArgs, log, writeOutput } from "./lib/doc-utils.mjs";

const USAGE = "docx-to-html.mjs <input.docx> <output.html>";
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
if (![".html", ".htm"].includes(extname(outputPath).toLowerCase())) {
  log("error", "Output file must use a .html or .htm extension");
  process.exit(1);
}

log("info", `Converting DOCX to HTML: ${inputPath}`);

try {
  const result = await mammoth.convertToHtml({ path: inputPath });

  // Log mammoth warnings to stderr
  if (result.messages && result.messages.length > 0) {
    for (const msg of result.messages) {
      log("warn", `mammoth: ${msg.type} - ${msg.message}`);
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
${result.value}
</body>
</html>`;

  writeOutput(outputPath, html);
  console.log(`HTML generated: ${outputPath}`);
} catch (err) {
  log("error", `DOCX to HTML conversion failed: ${err.message}`);
  process.exit(1);
}
