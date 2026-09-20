#!/usr/bin/env node
/**
 * Markdown to PDF Converter
 * Usage: node md-to-pdf.mjs <input.md> <output.pdf> [--css="custom.css"]
 */

import { readFileSync, writeFileSync, mkdtempSync, renameSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, extname, join } from "node:path";
import { mdToPdf } from "md-to-pdf";

const args = process.argv.slice(2);
if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
  console.log("Usage: md-to-pdf.mjs <input.md> <output.pdf> [--css <custom.css>]");
  process.exit(0);
}

const positionals = [];
let cssPath;
for (let i = 0; i < args.length; i++) {
  const argument = args[i];
  if (!argument.startsWith("--")) {
    positionals.push(argument);
    continue;
  }
  const separator = argument.indexOf("=");
  const name = argument.slice(2, separator === -1 ? undefined : separator);
  if (name !== "css") {
    console.error(`Error: unknown option --${name || argument}`);
    process.exit(1);
  }
  if (cssPath !== undefined) {
    console.error("Error: duplicate option --css");
    process.exit(1);
  }
  cssPath = separator === -1 ? args[i + 1] : argument.slice(separator + 1);
  if (separator === -1) {
    if (cssPath === undefined || cssPath.startsWith("--")) {
      console.error("Error: --css requires a file path");
      process.exit(1);
    }
    i++;
  }
  if (!cssPath) {
    console.error("Error: --css requires a non-empty file path");
    process.exit(1);
  }
}

const [inputPath, outputPath] = positionals;
if (!inputPath || !outputPath || positionals.length !== 2) {
  console.error("Usage: md-to-pdf.mjs <input.md> <output.pdf> [--css <custom.css>]");
  process.exit(1);
}
const absInputPath = resolve(inputPath);
const absOutputPath = resolve(outputPath);
if (absInputPath === absOutputPath) {
  console.error("Error: input and output paths must be different");
  process.exit(1);
}
if (extname(absOutputPath).toLowerCase() !== ".pdf") {
  console.error("Error: output path must end in .pdf");
  process.exit(1);
}
if (!existsSync(absInputPath)) {
  console.error(`Error: input file not found: ${absInputPath}`);
  process.exit(1);
}
const inputStat = statSync(absInputPath);
if (!inputStat.isFile() || inputStat.size > 100 * 1024 * 1024) {
  console.error("Error: input must be a regular Markdown file no larger than 100MB");
  process.exit(1);
}

let customCss = "";
if (cssPath) {
  try {
    const cssStat = statSync(cssPath);
    if (!cssStat.isFile() || cssStat.size > 5 * 1024 * 1024) throw new Error("CSS must be a regular file no larger than 5MB");
    customCss = readFileSync(cssPath, "utf-8");
  } catch (error) {
    console.error(`Error: unable to read --css file "${cssPath}": ${error.message}`);
    process.exit(1);
  }
}

// Read and preprocess markdown content
const imgDir = dirname(absInputPath);
let content = readFileSync(absInputPath, "utf-8");

/** MIME type lookup for image extensions */
const MIME_MAP = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp" };

/**
 * Convert a local image path to a base64 data URI.
 * Returns the original src if the file doesn't exist or is a remote URL.
 */
function toDataUri(src) {
  if (src.startsWith("data:")) return src;
  if (src.startsWith("http://") || src.startsWith("https://")) {
    const remote = new URL(src);
    if (remote.username || remote.password) throw new Error("remote image URL must not contain embedded credentials");
    return remote.toString();
  }
  const imgPath = resolve(imgDir, src);
  try {
    const imageStat = statSync(imgPath);
    if (!imageStat.isFile() || imageStat.size > 50 * 1024 * 1024) {
      throw new Error("local image must be a regular file no larger than 50MB");
    }
    const ext = extname(imgPath).toLowerCase();
    const mime = MIME_MAP[ext] || "image/png";
    const base64 = readFileSync(imgPath).toString("base64");
    return `data:${mime};base64,${base64}`;
  } catch (error) {
    throw new Error(`Unable to embed local image ${imgPath}: ${error.message}`);
  }
}

/**
 * Fix 1: marked does not parse markdown syntax inside HTML blocks (like <div>).
 * Convert ![alt](src) inside <div> wrappers to HTML <img> with base64 data URIs.
 */
content = content.replace(
  /<div[^>]*>\s*!\[([^\]]*)\]\(([^)]+)\)\s*<\/div>/g,
  (_match, alt, src) => {
    const dataUri = toDataUri(src);
    return `<p style="text-align:center"><img src="${dataUri}" alt="${alt}" style="max-width:100%" /></p>`;
  }
);

/**
 * Fix 2: Also convert plain markdown images ![alt](src) to HTML <img> with base64.
 * This ensures all local images are embedded regardless of their context.
 */
content = content.replace(
  /!\[([^\]]*)\]\(([^)]+)\)/g,
  (_match, alt, src) => {
    const dataUri = toDataUri(src);
    if (dataUri === src) return _match; // No conversion needed (remote URL or missing file)
    return `<img src="${dataUri}" alt="${alt}" style="max-width:100%" />`;
  }
);

// Write preprocessed content to a temp file
const tempDir = mkdtempSync(join(tmpdir(), "tmp-doc-convert-"));
const tempPath = join(tempDir, "preprocessed.md");
let outputTempDir;
let tempOutputPath;
try {
  outputTempDir = mkdtempSync(join(dirname(absOutputPath), ".tmp-doc-convert-output-"));
  tempOutputPath = join(outputTempDir, "output.pdf");
} catch (error) {
  rmSync(tempDir, { recursive: true, force: true });
  console.error(`Error: output directory is not writable: ${error.message}`);
  process.exit(1);
}
writeFileSync(tempPath, content, "utf-8");

const launchArgs = [];
if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
  launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
}

let converted = false;
try {
  await mdToPdf(
    { path: tempPath },
    {
      dest: tempOutputPath,
      css: customCss || undefined,
      pdf_options: { format: "A4", margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" } },
      launch_options: {
        headless: "shell",
        args: launchArgs,
      },
    }
  );
  const outputStat = statSync(tempOutputPath);
  if (!outputStat.isFile() || outputStat.size === 0 || outputStat.size > 250 * 1024 * 1024) {
    throw new Error("converter produced an empty, invalid, or oversized PDF");
  }
  renameSync(tempOutputPath, absOutputPath);
  converted = true;
} catch (error) {
  console.error(`Error: Markdown to PDF conversion failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  // Clean up temp file
  rmSync(tempDir, { recursive: true, force: true });
  if (outputTempDir) rmSync(outputTempDir, { recursive: true, force: true });
}

if (converted) console.log(`PDF generated: ${outputPath}`);
