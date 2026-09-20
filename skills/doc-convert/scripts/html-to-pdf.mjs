#!/usr/bin/env node
/**
 * HTML to PDF Converter (Puppeteer-based)
 *
 * Renders HTML in headless Chrome and exports to PDF.
 * Automatically waits for ECharts charts to finish rendering before capture.
 *
 * Usage: node html-to-pdf.mjs <input.html> <output.pdf> [--timeout=15000]
 */

import { readFileSync, existsSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import puppeteer from "puppeteer";

const args = process.argv.slice(2);
if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
  console.log("Usage: node html-to-pdf.mjs <input.html> <output.pdf> [--timeout <milliseconds>]");
  process.exit(0);
}

const positionals = [];
let timeoutValue;
for (let i = 0; i < args.length; i++) {
  const argument = args[i];
  if (!argument.startsWith("--")) {
    positionals.push(argument);
    continue;
  }
  const separator = argument.indexOf("=");
  const name = argument.slice(2, separator === -1 ? undefined : separator);
  if (name !== "timeout") {
    console.error(`Error: unknown option --${name || argument}`);
    process.exit(1);
  }
  if (timeoutValue !== undefined) {
    console.error("Error: duplicate option --timeout");
    process.exit(1);
  }
  timeoutValue = separator === -1 ? args[i + 1] : argument.slice(separator + 1);
  if (separator === -1) {
    if (timeoutValue === undefined || timeoutValue.startsWith("--")) {
      console.error("Error: --timeout requires an integer value");
      process.exit(1);
    }
    i++;
  }
}

const [inputPath, outputPath] = positionals;
if (!inputPath || !outputPath || positionals.length !== 2) {
  console.error("Usage: node html-to-pdf.mjs <input.html> <output.pdf> [--timeout <milliseconds>]");
  process.exit(1);
}
if (timeoutValue !== undefined && !/^[1-9]\d*$/.test(timeoutValue)) {
  console.error("Error: --timeout must be a positive integer");
  process.exit(1);
}
const ECHARTS_WAIT_MS = timeoutValue === undefined ? 10000 : Number(timeoutValue);
if (!Number.isSafeInteger(ECHARTS_WAIT_MS) || ECHARTS_WAIT_MS > 600000) {
  console.error("Error: --timeout must be between 1 and 600000 milliseconds");
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
  console.error("Error: input must be a regular HTML file no larger than 100MB");
  process.exit(1);
}
const htmlContent = readFileSync(absInputPath, "utf-8");
let outputTempDir;
let tempOutputPath;
try {
  outputTempDir = mkdtempSync(join(dirname(absOutputPath), ".tmp-doc-convert-output-"));
  tempOutputPath = join(outputTempDir, "output.pdf");
} catch (error) {
  console.error(`Error: output directory is not writable: ${error.message}`);
  process.exit(1);
}

const launchArgs = ["--font-render-hinting=none"];
if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
  launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
}
let browser;
try {
  browser = await puppeteer.launch({
    headless: "shell",
    args: launchArgs,
  });
  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: "networkidle0", timeout: 30000 });

  // Wait for ECharts to finish rendering (if any charts exist on the page)
  const chartsFound = await page.evaluate(() => {
    const containers = document.querySelectorAll("[_echarts_instance_]");
    return containers.length;
  });

  if (chartsFound > 0) {
    console.log(`Detected ${chartsFound} ECharts container(s), waiting for render...`);
    let renderOk = false;
    await page.waitForFunction(
      () => {
        const containers = document.querySelectorAll("[_echarts_instance_]");
        if (containers.length === 0) return true;
        // All containers must have a rendered canvas with non-zero dimensions
        return Array.from(containers).every((el) => {
          const canvas = el.querySelector("canvas");
          return canvas && canvas.width > 0 && canvas.height > 0;
        });
      },
      { timeout: ECHARTS_WAIT_MS }
    ).then(() => { renderOk = true; })
     .catch(() => {
      throw new Error(`ECharts render timeout after ${ECHARTS_WAIT_MS}ms`);
    });
    if (renderOk) console.log("ECharts render complete");
  }

  await page.pdf({
    path: tempOutputPath,
    format: "A4",
    printBackground: true,
    margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
  });
  const outputStat = statSync(tempOutputPath);
  if (!outputStat.isFile() || outputStat.size === 0 || outputStat.size > 250 * 1024 * 1024) {
    throw new Error("converter produced an empty, invalid, or oversized PDF");
  }
  renameSync(tempOutputPath, absOutputPath);

  console.log(`PDF generated: ${outputPath}`);
} catch (error) {
  console.error(`Error: HTML to PDF conversion failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (outputTempDir) rmSync(outputTempDir, { recursive: true, force: true });
}
