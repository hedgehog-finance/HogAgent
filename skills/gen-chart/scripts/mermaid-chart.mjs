#!/usr/bin/env node
/**
 * Mermaid Diagram Generator
 * Usage: node mermaid-chart.mjs <input.mmd> <output.png|svg> [options]
 *
 * Options:
 *   -o <output>           Output file path (alternative to positional)
 *   --format=png|svg      Output format (default: inferred from extension)
 *   --palette=<colors>    Custom color palette (comma-separated hex):
 *                         "#E63946,#457B9D,#2A9D8F,#E9C46A"
 *   --theme=<name>        Color theme — financial presets OR Mermaid built-in:
 *                         Financial: fintech, oldmoney, bloomberg, economist, saas,
 *                                    mist, twilight, parchment, azure, gravel
 *                         Mermaid:   default, dark, forest, neutral
 *                         Use --theme=list to show all financial themes.
 */

import { writeFileSync, existsSync, mkdtempSync, renameSync, rmSync, accessSync, constants, statSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, platform } from "node:os";
import { createRequire } from "node:module";
import { resolveTheme, toMermaidThemeVars, isDark, THEME_NAMES } from "./themes.mjs";
import { parseChartRenderArgs } from "./cli-args.mjs";

const IS_WIN = platform() === "win32";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let parsedArgs;
try {
  parsedArgs = parseChartRenderArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
const { spec: inputPath, output: outputPath, palette, theme: themeArg } = parsedArgs.options;
let { format } = parsedArgs.options;
const outputExtension = outputPath?.toLowerCase().match(/\.(png|svg)$/)?.[1];

// --theme=list: print available themes and exit
if (themeArg === "list") {
  if (parsedArgs.positionals.length > 0 || Object.keys(parsedArgs.options).length !== 1) {
    console.error("Error: --theme=list cannot be combined with input, output, or other options");
    process.exit(1);
  }
  console.log("Available financial color themes:\n");
  for (const key of THEME_NAMES) {
    const t = resolveTheme(key);
    console.log(`  ${key.padEnd(12)} ${t.name.padEnd(35)} ${t.colors.join(", ")}  bg:${t.background}`);
  }
  console.log("\nMermaid built-in themes: default, dark, forest, neutral");
  process.exit(0);
}

if (parsedArgs.help || !inputPath || !outputPath) {
  console.error("Usage: mermaid-chart.mjs --spec <input.mmd> [-o] <output.png|svg> [--format=png|svg] [--palette=<colors>] [--theme=<name>]");
  console.error("  --palette: comma-separated hex colors (e.g. \"#E63946,#457B9D,#2A9D8F\")");
  console.error("  --theme:   financial preset (fintech, bloomberg, ...) or Mermaid built-in (default, dark, forest, neutral)");
  console.error("             use --theme=list to show all financial themes");
  process.exit(parsedArgs.help ? 0 : 1);
}

if (!outputExtension) {
  console.error("Error: output file must use a .png or .svg extension");
  process.exit(1);
}
if (!format) {
  format = outputExtension;
} else {
  format = format.toLowerCase();
  if (!new Set(["png", "svg"]).has(format)) {
    console.error(`Error: unsupported format "${format}". Use png or svg.`);
    process.exit(1);
  }
  if (format !== outputExtension) {
    console.error(`Error: --format=${format} does not match output extension .${outputExtension}`);
    process.exit(1);
  }
}

const absInput = resolve(inputPath);
const absOutput = resolve(outputPath);
const renderOutput = join(dirname(absOutput), `.${basename(absOutput)}.${process.pid}.${Date.now()}.tmp.${format}`);
if (absInput === absOutput) {
  console.error("Error: input and output paths must be different");
  process.exit(1);
}
if (!existsSync(absInput)) {
  console.error(`Error: Mermaid input file not found: ${absInput}`);
  process.exit(1);
}
const inputStat = statSync(absInput);
if (!inputStat.isFile() || inputStat.size > 10 * 1024 * 1024) {
  console.error("Error: Mermaid input must be a regular file no larger than 10MB");
  process.exit(1);
}

// Prefer the package's JavaScript entry point and invoke it with the current Node
// executable. This keeps process execution structured on every platform and avoids
// passing user-controlled paths through cmd.exe or another shell.
let mmdcCommand;
let mmdcPrefixArgs = [];
try {
  const packageEntry = require.resolve("@mermaid-js/mermaid-cli");
  const cliEntry = join(dirname(packageEntry), "cli.js");
  if (existsSync(cliEntry)) {
    mmdcCommand = process.execPath;
    mmdcPrefixArgs = [cliEntry];
  }
} catch { /* fall through to executable lookup */ }

// Fallback: find a native executable. Windows .cmd/.bat shims are intentionally
// rejected because they require shell execution; install the package locally instead.
let mmdcPath;
let searchDir = __dirname;
const binNames = IS_WIN ? ["mmdc.exe", "mmdc"] : ["mmdc"];
for (let i = 0; i < 10 && !mmdcCommand && !mmdcPath; i++) {
  for (const name of binNames) {
    const candidate = resolve(searchDir, "node_modules", ".bin", name);
    if (existsSync(candidate)) {
      mmdcPath = candidate;
      break;
    }
  }
  const parent = dirname(searchDir);
  if (parent === searchDir) break;
  searchDir = parent;
}

// Fallback: scan PATH directly. This avoids launching which/where and keeps
// executable discovery independent of any shell.
if (!mmdcCommand && !mmdcPath) {
  const pathExtensions = IS_WIN
    ? ["", ...(process.env.PATHEXT || ".EXE;.COM").split(";")]
      .filter((extension) => !/\.(?:cmd|bat)$/i.test(extension))
    : [""];
  const candidates = (process.env.PATH || "").split(IS_WIN ? ";" : ":").filter(Boolean)
    .flatMap((directory) => pathExtensions.map((extension) => join(directory, `mmdc${extension.toLowerCase()}`)));
  mmdcPath = candidates.find((candidate) => {
    try {
      accessSync(candidate, IS_WIN ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

if (!mmdcCommand && !mmdcPath) {
  console.error("Error: mmdc not found. Run: cd <hogagent_root> && npm install");
  process.exit(1);
}
if (!mmdcCommand) mmdcCommand = mmdcPath;

// Resolve theme: financial preset or Mermaid built-in
// Default theme: fintech (pass --theme=none to disable)
const DEFAULT_THEME = "fintech";
const mermaidBuiltinThemes = ["default", "dark", "forest", "neutral"];
const effectiveTheme = themeArg === "none" ? null : (themeArg || (palette ? null : DEFAULT_THEME));
const finTheme = resolveTheme(effectiveTheme);
const mermaidTheme = !finTheme && effectiveTheme && mermaidBuiltinThemes.includes(effectiveTheme) ? effectiveTheme : null;
if (effectiveTheme && !finTheme && !mermaidTheme) {
  console.error(`Error: unknown theme "${effectiveTheme}". Use --theme=list to see supported themes.`);
  process.exit(1);
}

// Build Mermaid config
let configFile = null;
let configDir = null;
if (finTheme) {
  // Financial theme preset: generate themeVariables
  const vars = toMermaidThemeVars(finTheme);
  const dark = isDark(finTheme.background);
  const mermaidConfig = {
    theme: "default",
    themeVariables: vars,
    // Force node fill & text via CSS to ensure consistency across Mermaid versions
    themeCSS: [
      `.node rect, .node polygon, .node path, .node circle { fill: ${vars.primaryColor} !important; stroke: ${vars.primaryBorderColor} !important; }`,
      `.node .label, .node text, .nodeLabel { color: ${vars.primaryTextColor} !important; fill: ${vars.primaryTextColor} !important; }`,
      `.edgeLabel, .edgeLabel rect { background-color: ${finTheme.background} !important; color: ${dark ? "#E2E8F0" : "#334155"} !important; }`,
      `.edgeLabel p { background-color: ${finTheme.background} !important; }`,
      `#flowchart-circle-0 circle, #flowchart-circle-1 circle { fill: ${vars.primaryColor} !important; }`,
    ].join("\n"),
  };
  configDir = mkdtempSync(join(tmpdir(), "tmp-gen-chart-mermaid-"));
  configFile = join(configDir, "config.json");
  writeFileSync(configFile, JSON.stringify(mermaidConfig, null, 2));
} else if (palette) {
  // Custom palette
  const colors = palette.split(",").map((c) => c.trim());
  if (colors.length > 12 || colors.some((color) => !/^#[0-9a-f]{6}$/i.test(color))) {
    console.error("Error: --palette must contain 1-12 comma-separated six-digit hex colors");
    process.exit(1);
  }
  const [primary, secondary, tertiary, note] = [
    colors[0] || "#4C78A8",
    colors[1] || "#F58518",
    colors[2] || "#E45756",
    colors[3] || colors[0] || "#4C78A8",
  ];
  const mermaidConfig = {
    theme: mermaidTheme || "default",
    themeVariables: {
      primaryColor: primary,
      primaryTextColor: "#ffffff",
      primaryBorderColor: primary,
      secondaryColor: secondary,
      tertiaryColor: tertiary,
      lineColor: primary,
      noteBkgColor: note,
      noteTextColor: "#ffffff",
    },
  };
  configDir = mkdtempSync(join(tmpdir(), "tmp-gen-chart-mermaid-"));
  configFile = join(configDir, "config.json");
  writeFileSync(configFile, JSON.stringify(mermaidConfig, null, 2));
}

// Build argument list (array form avoids shell quoting pitfalls across platforms)
const mmdcArgs = ["-i", absInput, "-o", renderOutput, "--outputFormat", format, "--backgroundColor", "transparent"];
if (configFile) {
  mmdcArgs.push("--configFile", configFile);
} else if (mermaidTheme) {
  mmdcArgs.push("--theme", mermaidTheme);
}

try {
  const result = spawnSync(mmdcCommand, [...mmdcPrefixArgs, ...mmdcArgs], { stdio: "pipe", shell: false, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : "";
    throw new Error(stderr || `mmdc exited with code ${result.status}`);
  }
  if (!existsSync(renderOutput)) throw new Error("mmdc exited successfully but did not create the output file");
  const outputStat = statSync(renderOutput);
  if (!outputStat.isFile() || outputStat.size === 0) throw new Error("mmdc created an empty or invalid output file");
  renameSync(renderOutput, absOutput);
  const info = finTheme ? ` (theme: ${finTheme.name})` : "";
  console.log(`Diagram generated: ${outputPath}${info}`);
} catch (err) {
  console.error(`Mermaid CLI error: ${err.message}`);
  process.exit(1);
} finally {
  try { unlinkSync(renderOutput); } catch { /* already renamed or never created */ }
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}
