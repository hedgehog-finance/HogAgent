#!/usr/bin/env node
/** Validate a generated PPTX and optionally open/render it in desktop viewers. */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validatePptxPackage } from "./pptx-ooxml.mjs";
import { parseViewerArgs } from "./cli-args.mjs";

let parsedArgs;
try {
  parsedArgs = parseViewerArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error.message}`);
  console.error("Usage: validate-pptx.mjs <file.pptx> [--libreoffice] [--keynote] [--powerpoint]");
  process.exit(1);
}
const fileArg = parsedArgs.positionals[0];
const viewers = new Set(Object.keys(parsedArgs.options));

if (parsedArgs.help) {
  console.log("Usage: validate-pptx.mjs <file.pptx> [--libreoffice] [--keynote] [--powerpoint]");
  process.exit(0);
}

const inputPath = resolve(fileArg);
if (!existsSync(inputPath)) {
  console.error(`PPTX not found: ${inputPath}`);
  process.exit(1);
}
const inputStat = statSync(inputPath);
if (!inputStat.isFile() || inputStat.size > 250 * 1024 * 1024) {
  console.error("PPTX must be a regular file no larger than 250MB");
  process.exit(1);
}

try {
  const inputBuffer = readFileSync(inputPath);
  const sha256 = createHash("sha256").update(inputBuffer).digest("hex");
  const report = await validatePptxPackage(inputBuffer);
  console.log(`Artifact verified: ${inputPath}; ${inputBuffer.length} bytes; SHA-256 ${sha256}`);
  console.log(`Structural OOXML validation passed: ${report.partCount} parts, ${report.relationshipCount} relationships, ${report.slideCount} slides, ${report.slideMasterCount} slide masters, ${report.notesMasterCount} notes masters, ${report.chartCount} native charts`);

  if (viewers.has("libreoffice")) validateWithLibreOffice(inputPath);
  if (viewers.has("keynote")) validateWithKeynote(inputPath, report);
  if (viewers.has("powerpoint")) validateWithPowerPoint(inputPath);
} catch (error) {
  console.error(`PPTX validation failed: ${error.message}`);
  process.exit(1);
}

function requireNonEmptyFile(filePath, label) {
  if (!existsSync(filePath) || statSync(filePath).size === 0) {
    throw new Error(`${label} did not produce a non-empty render`);
  }
}

function validateWithLibreOffice(filePath) {
  const workDir = mkdtempSync(join(tmpdir(), "gen-ppt-libreoffice-"));
  try {
    const result = spawnSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", workDir, filePath], { encoding: "utf8", shell: false, timeout: 120_000 });
    if (result.error) throw new Error(`LibreOffice is unavailable: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`LibreOffice rejected the PPTX: ${(result.stderr || result.stdout).trim()}`);
    const pdfPath = join(workDir, basename(filePath).replace(/\.pptx$/i, ".pdf"));
    requireNonEmptyFile(pdfPath, "LibreOffice");
    console.log("LibreOffice open/render test passed");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function readBundleValue(appPath, key) {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(appPath, "Contents/Info.plist")], { encoding: "utf8", shell: false, timeout: 10_000 });
  return result.status === 0 ? (result.stdout || "").trim() : "";
}

function installedKeynote() {
  if (process.platform !== "darwin") return null;
  for (const appPath of ["/Applications/Keynote Creator Studio.app", "/Applications/Keynote.app"]) {
    if (!existsSync(appPath)) continue;
    return {
      appPath,
      applicationId: readBundleValue(appPath, "CFBundleIdentifier") || (appPath.includes("Creator Studio") ? "com.apple.Keynote" : "com.apple.iWork.Keynote"),
      version: readBundleValue(appPath, "CFBundleShortVersionString") || "unknown",
    };
  }
  return null;
}

function validateWithKeynote(filePath, report) {
  const keynote = installedKeynote();
  if (!keynote) {
    throw new Error("Keynote open/render test requested, but Keynote is not installed on macOS");
  }
  if (report.generatedByPptxGenJS && report.chartCount > 0) {
    throw new Error(`Keynote compatibility check failed: this PptxGenJS deck contains ${report.chartCount} native chart(s). Keynote can import the PPTX package while rendering PptxGenJS category charts blank (PptxGenJS issue #1396). Replace the charts with PNG images and regenerate with --target=keynote; structural OOXML validity does not fix this viewer limitation.`);
  }
  const expectedSlideCount = report.slideCount;
  const workDir = mkdtempSync(join(tmpdir(), "gen-ppt-keynote-"));
  const pdfPath = join(workDir, "keynote-render.pdf");
  const applicationId = keynote.applicationId.replace(/["\\]/g, "");
  const script = `
on run argv
  set inputAlias to POSIX file (item 1 of argv)
  set outputFile to POSIX file (item 2 of argv)
  set openedDocument to missing value
  try
    tell application id "${applicationId}"
      launch
      activate
      delay 1
      with timeout of 360 seconds
        set openedDocument to open inputAlias
      end timeout
    end tell
    if openedDocument is missing value then error "Keynote did not return the opened PPTX"
    tell application id "${applicationId}"
      with timeout of 360 seconds
        export openedDocument to outputFile as PDF
      end timeout
      set documentName to name of openedDocument
      set slideCount to count of slides of openedDocument
      close openedDocument saving no
    end tell
    return documentName & tab & (slideCount as text)
  on error errorMessage number errorNumber
    if openedDocument is not missing value then
      try
        tell application id "${applicationId}" to close openedDocument saving no
      end try
    end if
    error errorMessage number errorNumber
  end try
end run`;
  try {
    const result = spawnSync("osascript", ["-e", script, filePath, pdfPath], { encoding: "utf8", shell: false, timeout: 750_000 });
    if (result.error) throw new Error(`Keynote automation failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Keynote open/render automation failed in ${basename(keynote.appPath)} ${keynote.version}: ${(result.stderr || result.stdout).trim()}`);
    requireNonEmptyFile(pdfPath, "Keynote");
    const outputLine = (result.stdout || "").trim().split(/\r?\n/).at(-1) || "";
    const separator = outputLine.lastIndexOf("\t");
    const documentName = separator === -1 ? outputLine : outputLine.slice(0, separator);
    const slideCount = Number(separator === -1 ? NaN : outputLine.slice(separator + 1));
    if (!Number.isInteger(slideCount) || slideCount !== expectedSlideCount) {
      throw new Error(`Keynote opened an unexpected document or slide count: ${JSON.stringify(outputLine)}; expected ${expectedSlideCount} slides`);
    }
    console.log(`Keynote open/render test passed in ${basename(keynote.appPath)} ${keynote.version}: ${JSON.stringify(documentName)}, ${slideCount}/${expectedSlideCount} slides, ${statSync(pdfPath).size} PDF bytes`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function validateWithPowerPoint(filePath) {
  if (process.platform !== "darwin") {
    throw new Error("Automated PowerPoint open/render validation is currently supported only on macOS");
  }
  if (!existsSync("/Applications/Microsoft PowerPoint.app")) {
    throw new Error("PowerPoint open/render test requested, but Microsoft PowerPoint is not installed on macOS");
  }
  const workDir = mkdtempSync(join(tmpdir(), "gen-ppt-powerpoint-"));
  const pdfPath = join(workDir, "powerpoint-render.pdf");
  const script = `
on run argv
  set inputPath to item 1 of argv
  set outputPath to item 2 of argv
  tell application "Microsoft PowerPoint"
    with timeout of 360 seconds
      open POSIX file inputPath
      set openedPresentation to active presentation
      save openedPresentation in POSIX file outputPath as save as PDF
      close openedPresentation saving no
    end timeout
  end tell
end run`;
  try {
    const result = spawnSync("osascript", ["-e", script, filePath, pdfPath], { encoding: "utf8", shell: false, timeout: 390_000 });
    if (result.error) throw new Error(`PowerPoint automation failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`PowerPoint rejected the PPTX: ${(result.stderr || result.stdout).trim()}`);
    requireNonEmptyFile(pdfPath, "PowerPoint");
    console.log("PowerPoint open/render test passed");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
