#!/usr/bin/env node
/**
 * Vega-Lite Chart Generator
 * Usage: node vega-chart.mjs <tmp-gen-chart-*.json> <output.png|svg> [options]
 *
 * Options:
 *   -o <output>           Output file path (alternative to positional)
 *   --format=png|svg      Output format (default: inferred from extension)
 *   --palette=<colors>    Custom color palette:
 *                         - Comma-separated hex: "#E63946,#457B9D,#2A9D8F"
 *                         - Named scheme: "dark2", "tableau10", "viridis", etc.
 *   --theme=<name>        Built-in financial theme preset (overrides --palette and background).
 *                         Themes: fintech, oldmoney, bloomberg, economist, saas,
 *                                 mist, twilight, parchment, azure, gravel
 *                         Use --theme=list to show all available themes.
 */

import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as vega from "vega";
import * as vegaLite from "vega-lite";
import { Resvg } from "@resvg/resvg-js";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolveTheme, applyVegaTheme, THEME_NAMES } from "./themes.mjs";
import { parseChartRenderArgs } from "./cli-args.mjs";

// Headless Node has no canvas text measurement; vega's built-in fallback
// (0.8em per char) underestimates full-width CJK glyphs (~1em per char),
// packing horizontal legend entries too tightly so labels overlap.
// Install a CJK-aware estimator so layout matches rendered text width.
const isFullWidth = (cp) =>
  (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xa840 && cp <= 0xd7ff) || (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xffef) ||
  (cp >= 0x20000 && cp <= 0x3ffff);

vega.textMetrics.width = (item, text) => {
  const value = text ?? item.text;
  const lines = Array.isArray(value) ? value : String(value ?? "").split("\n");
  const fs = item.fontSize || 11;
  let max = 0;
  for (const line of lines) {
    let w = 0;
    for (const ch of line) w += isFullWidth(ch.codePointAt(0)) ? 1 : 0.6;
    max = Math.max(max, w);
  }
  return max * fs;
};

let parsedArgs;
try {
  parsedArgs = parseChartRenderArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
const { spec: specPath, output: outputPath, palette, theme: themeName } = parsedArgs.options;
let { format } = parsedArgs.options;
const outputExtension = outputPath?.toLowerCase().match(/\.(png|svg)$/)?.[1];

// --theme=list: print available themes and exit
if (themeName === "list") {
  if (parsedArgs.positionals.length > 0 || Object.keys(parsedArgs.options).length !== 1) {
    console.error("Error: --theme=list cannot be combined with input or other options");
    process.exit(1);
  }
  console.log("Available financial color themes:\n");
  for (const key of THEME_NAMES) {
    const t = resolveTheme(key);
    console.log(`  ${key.padEnd(12)} ${t.name.padEnd(35)} ${t.colors.join(", ")}  bg:${t.background}`);
  }
  process.exit(0);
}

if (parsedArgs.help || !specPath || !outputPath) {
  console.error("Usage: vega-chart.mjs --spec <tmp-gen-chart-*.json> [-o] <output.png|svg> [--format=png|svg] [--palette=<colors>] [--theme=<name>]");
  console.error("  --palette: comma-separated hex colors or named scheme (tableau10, dark2, viridis, etc.)");
  console.error("  --theme:   built-in financial theme (fintech, bloomberg, oldmoney, ...) or 'list' to show all");
  process.exit(parsedArgs.help ? 0 : 1);
}
if (resolve(specPath) === resolve(outputPath)) {
  console.error("Error: input and output paths must be different");
  process.exit(1);
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

let specJson;
try {
  const specStat = statSync(specPath);
  if (!specStat.isFile() || specStat.size > 100 * 1024 * 1024) throw new Error("spec must be a regular file no larger than 100MB");
  specJson = JSON.parse(readFileSync(specPath, "utf-8").replace(/^\uFEFF/, ""));
} catch (error) {
  console.error(`Error: failed to read/parse spec file "${specPath}": ${error.message}`);
  process.exit(1);
}
if (!specJson || typeof specJson !== "object" || Array.isArray(specJson)) {
  console.error("Error: Vega-Lite spec must be a JSON object");
  process.exit(1);
}
const specDir = dirname(resolve(specPath));
const MAX_INLINE_ROWS = 1_000_000;
const MAX_RENDER_DIMENSION = 8_192;
const MAX_RENDER_PIXELS = 25_000_000;

function validateResourceBounds(spec, context = "spec") {
  for (const dimension of ["width", "height"]) {
    const value = spec[dimension];
    if (typeof value === "number" && (!Number.isFinite(value) || value <= 0 || value > MAX_RENDER_DIMENSION)) {
      throw new Error(`${context}.${dimension} must be greater than 0 and at most ${MAX_RENDER_DIMENSION}`);
    }
    const step = value && typeof value === "object" && !Array.isArray(value) ? value.step : undefined;
    if (step !== undefined && (typeof step !== "number" || !Number.isFinite(step) || step <= 0 || step > MAX_RENDER_DIMENSION)) {
      throw new Error(`${context}.${dimension}.step must be greater than 0 and at most ${MAX_RENDER_DIMENSION}`);
    }
  }
  if (typeof spec.width === "number" && typeof spec.height === "number" && spec.width * spec.height > MAX_RENDER_PIXELS) {
    throw new Error(`${context} render area exceeds ${MAX_RENDER_PIXELS} pixels`);
  }
  if (Array.isArray(spec.data?.values) && spec.data.values.length > MAX_INLINE_ROWS) {
    throw new Error(`${context}.data.values exceeds ${MAX_INLINE_ROWS} rows`);
  }
  if (spec.spec && typeof spec.spec === "object") validateResourceBounds(spec.spec, `${context}.spec`);
  if (Array.isArray(spec.layer)) {
    for (let i = 0; i < spec.layer.length; i++) validateResourceBounds(spec.layer[i], `${context}.layer[${i}]`);
  }
  for (const key of ["concat", "vconcat", "hconcat"]) {
    if (Array.isArray(spec[key])) {
      for (let i = 0; i < spec[key].length; i++) validateResourceBounds(spec[key][i], `${context}.${key}[${i}]`);
    }
  }
}

/**
 * Inline external data files referenced via data.url.
 * Vega-Lite compile() does not resolve local file URLs, so we read them
 * and replace url with values before compilation.
 * Handles top-level spec, layer specs, and nested composite specs.
 */
function inlineExternalData(spec) {
  // Top-level data.url
  if (typeof spec.data?.url === "string" && /^[a-z][a-z0-9+.-]*:/i.test(spec.data.url)) {
    throw new Error("Remote and URI-based Vega data sources are not supported; use inline values or a local JSON file");
  }
  if (typeof spec.data?.url === "string") {
    const dataPath = isAbsolute(spec.data.url) ? spec.data.url : resolve(specDir, spec.data.url);
    try {
      const dataStat = statSync(dataPath);
      if (!dataStat.isFile() || dataStat.size > 100 * 1024 * 1024) throw new Error("data file must be a regular file no larger than 100MB");
      spec.data.values = JSON.parse(readFileSync(dataPath, "utf-8").replace(/^\uFEFF/, ""));
      delete spec.data.url;
    } catch (error) {
      throw new Error(`Unable to inline Vega data file "${dataPath}": ${error.message}`);
    }
  }

  // Layer specs: each layer may have its own data.url
  if (Array.isArray(spec.layer)) {
    for (const layer of spec.layer) {
      inlineExternalData(layer);
    }
  }

  // Nested composite spec (facet / concat / vconcat / hconcat)
  if (spec.spec) inlineExternalData(spec.spec);
  for (const key of ["concat", "vconcat", "hconcat"]) {
    if (Array.isArray(spec[key])) for (const child of spec[key]) inlineExternalData(child);
  }

  return spec;
}

try {
  inlineExternalData(specJson);
  validateResourceBounds(specJson);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

// ─── Data Validation & Auto-fix ─────────────────────────────────────────────

/** Diagnostic warnings collected during spec sanitization. */
const warnings = [];

/**
 * Detect and convert Chinese/non-standard date strings to ISO 8601.
 * Handles Chinese year/month/day date strings, "2024-1", "2024/1", and similar forms.
 * Returns the converted string, or null if not a recognizable date.
 */
function convertChineseDate(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();

  // Pattern: a Chinese date containing year and month, with an optional day.
  let m = v.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?$/);
  if (m) {
    const [, y, mo, d] = m;
    return d ? `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` : `${y}-${mo.padStart(2, "0")}-01`;
  }

  // Pattern: a Chinese month and optional day without a year.
  m = v.match(/^(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?$/);
  if (m) {
    const [, mo, d] = m;
    const year = new Date().getFullYear();
    return d ? `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` : `${year}-${mo.padStart(2, "0")}-01`;
  }

  // Pattern: "2024-1" or "2024/1" (year-month without day, zero-pad)
  m = v.match(/^(\d{4})[/-](\d{1,2})(?:[/-](\d{1,2}))?$/);
  if (m) {
    const [, y, mo, d] = m;
    return d ? `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` : `${y}-${mo.padStart(2, "0")}-01`;
  }

  // Pattern: "2024Q1", "2024-Q1" etc.
  m = v.match(/^(\d{4})\s*-?\s*[Qq](\d)$/);
  if (m) {
    const quarterMonth = { "1": "01", "2": "04", "3": "07", "4": "10" };
    return `${m[1]}-${quarterMonth[m[2]]}-01`;
  }

  return null;
}

/**
 * Collect all encoding definitions from a spec (handles layer, concat, facet).
 * Returns an array of { encoding, mark } objects.
 */
function collectEncodings(spec) {
  const result = [];
  if (spec.encoding && spec.mark) {
    result.push({ encoding: spec.encoding, mark: spec.mark });
  }
  if (Array.isArray(spec.layer)) {
    for (const layer of spec.layer) {
      result.push(...collectEncodings(layer));
    }
  }
  if (spec.spec) {
    result.push(...collectEncodings(spec.spec));
  }
  for (const key of ["concat", "vconcat", "hconcat"]) {
    if (Array.isArray(spec[key])) {
      for (const sub of spec[key]) {
        result.push(...collectEncodings(sub));
      }
    }
  }
  return result;
}

/**
 * Sanitize data values based on encoding type declarations.
 * - temporal fields: convert Chinese dates to ISO
 * - quantitative fields: coerce string numbers to numbers
 * Modifies values in-place and records warnings.
 */
function sanitizeDataForEncoding(values, encoding, context) {
  if (!encoding || !Array.isArray(values) || values.length === 0) return;

  const temporalFields = [];
  const quantitativeFields = [];

  for (const [ch, enc] of Object.entries(encoding)) {
    if (!enc?.field || !enc?.type) continue;
    if (enc.type === "temporal") temporalFields.push(enc.field);
    if (enc.type === "quantitative") quantitativeFields.push(enc.field);
  }

  let dateFixCount = 0;
  let numFixCount = 0;
  let nullDateCount = 0;

  for (const row of values) {
    // Fix temporal fields
    for (const field of temporalFields) {
      const val = row[field];
      if (val == null) continue;
      const converted = convertChineseDate(val);
      if (converted && converted !== String(val).trim()) {
        row[field] = converted;
        dateFixCount++;
      } else if (typeof val === "string" && isNaN(Date.parse(val))) {
        // Cannot parse at all
        nullDateCount++;
      }
    }
    // Fix quantitative fields
    for (const field of quantitativeFields) {
      const val = row[field];
      if (val == null) continue;
      if (typeof val === "string") {
        const num = Number(val.replace(/[,%¥$€]/g, "").trim());
        if (!isNaN(num)) {
          row[field] = num;
          numFixCount++;
        }
      }
    }
  }

  if (dateFixCount > 0) {
    warnings.push(`[${context}] Auto-fixed ${dateFixCount} date values (Chinese/non-standard format \u2192 ISO 8601)`);
  }
  if (nullDateCount > 0) {
    warnings.push(`[${context}] \u26a0 ${nullDateCount} date values cannot be parsed as temporal type; consider type:"ordinal" or fix date format`);
  }
  if (numFixCount > 0) {
    warnings.push(`[${context}] Auto-converted ${numFixCount} string values to number (quantitative fields should not contain strings)`);
  }
}

/**
 * Detect if all quantitative color values are identical (or nearly so).
 * This catches cases where the LLM manually filled data with a placeholder value
 * instead of computing actual values (e.g., DCF sensitivity matrix all set to -1.82).
 */
function detectUniformQuantitativeColor(values, encoding, context) {
  if (!encoding?.color || encoding.color.type !== "quantitative") return;
  const field = encoding.color.field;
  if (!field) return;

  const nums = values
    .map((row) => row[field])
    .filter((v) => typeof v === "number" && !isNaN(v));
  if (nums.length < 2) return;

  const min = nums.reduce((current, value) => Math.min(current, value), Infinity);
  const max = nums.reduce((current, value) => Math.max(current, value), -Infinity);
  const range = max - min;

  // All identical or within 0.1% of each other
  if (range < Math.abs(min) * 0.001 || range < 0.01) {
    warnings.push(
      `[${context}] \u26a0\u26a0 color field "${field}" has uniform values (${nums[0]}), chart will show no variation. ` +
      `Verify data source — computational charts (e.g. sensitivity analysis) must call the relevant skill for real calculated results; do not manually fabricate values.`
    );
  }
}

/**
 * Main spec sanitization: walk through all data + encoding combinations
 * and fix common LLM-generated data issues.
 */
function sanitizeSpec(spec) {
  const values = spec.data?.values;
  if (!Array.isArray(values) || values.length === 0) {
    if (values && values.length === 0) {
      warnings.push("\u26a0 data.values is empty array, chart will have no data");
    }
    return spec;
  }

  const encodings = collectEncodings(spec);
  if (encodings.length === 0) {
    // No encoding found — try top-level
    if (spec.encoding) {
      sanitizeDataForEncoding(values, spec.encoding, "top-level");
      detectUniformQuantitativeColor(values, spec.encoding, "top-level");
    }
    return spec;
  }

  for (let i = 0; i < encodings.length; i++) {
    const { encoding } = encodings[i];
    const ctx = encodings.length > 1 ? `layer[${i}]` : "spec";
    sanitizeDataForEncoding(values, encoding, ctx);
    detectUniformQuantitativeColor(values, encoding, ctx);
  }

  return spec;
}

// Run sanitization before any theme/point/bar processing
sanitizeSpec(specJson);

/**
 * Detect encoding fields that don't exist in the data rows.
 * This catches the silent-empty-chart case where the spec references
 * field names that mismatch the actual data (e.g. spec uses "macd" but
 * data has "macd_MACD"). Walks nested specs, tracking the effective
 * data values (child data overrides parent).
 */
const missingFields = new Set();

function detectMissingFields(spec, inheritedValues) {
  const values = Array.isArray(spec.data?.values) ? spec.data.values : inheritedValues;

  if (spec.encoding && Array.isArray(values) && values.length > 0) {
    // Sample up to 5 rows — field counts as present if any sampled row has it
    const sample = values.slice(0, 5);
    for (const enc of Object.values(spec.encoding)) {
      const field = enc?.field;
      if (!field || typeof field !== "string") continue;
      if (field.includes(".") || field.includes("[")) continue; // nested accessor — skip
      const calculated = calculatedFields.has(field);
      if (!calculated && !sample.some((row) => row != null && field in row)) {
        missingFields.add(field);
      }
    }
  }

  if (Array.isArray(spec.layer)) for (const l of spec.layer) detectMissingFields(l, values);
  if (spec.spec) detectMissingFields(spec.spec, values);
  for (const key of ["concat", "vconcat", "hconcat"]) {
    if (Array.isArray(spec[key])) for (const sub of spec[key]) detectMissingFields(sub, values);
  }
}

// Fields produced by transforms (calculate/fold/aggregate/...) are not in raw data
const calculatedFields = new Set();
function collectTransformFields(spec) {
  for (const t of spec.transform ?? []) {
    if (t.as) {
      for (const a of Array.isArray(t.as) ? t.as : [t.as]) calculatedFields.add(a);
    }
    if (Array.isArray(t.aggregate)) for (const a of t.aggregate) a?.as && calculatedFields.add(a.as);
    if (Array.isArray(t.joinaggregate)) for (const a of t.joinaggregate) a?.as && calculatedFields.add(a.as);
    if (Array.isArray(t.window)) for (const w of t.window) w?.as && calculatedFields.add(w.as);
  }
  if (Array.isArray(spec.layer)) for (const l of spec.layer) collectTransformFields(l);
  if (spec.spec) collectTransformFields(spec.spec);
  for (const key of ["concat", "vconcat", "hconcat"]) {
    if (Array.isArray(spec[key])) for (const sub of spec[key]) collectTransformFields(sub);
  }
}

collectTransformFields(specJson);
detectMissingFields(specJson);
if (missingFields.size > 0) {
  console.error(`[vega-chart] \u274c encoding references fields not found in data: ${[...missingFields].join(", ")}`);
  const sampleKeys = Object.keys((specJson.data?.values ?? [])[0] ?? {});
  if (sampleKeys.length > 0) {
    console.error(`[vega-chart] Actual data fields: ${sampleKeys.join(", ")}`);
  }
  console.error(`[vega-chart] Chart will render empty; fix spec field names and retry`);
  process.exit(1);
}

/**
 * Detect if spec is Vega-Lite (vs raw Vega).
 * Checks $schema field first, then falls back to structural detection:
 * Vega-Lite uses "mark" (singular) + "encoding", Vega uses "marks" (plural).
 */
function isVegaLiteSpec(spec) {
  if (spec["$schema"]?.includes("vega-lite")) return true;
  if (spec.mark && spec.encoding && !spec.marks) return true;
  return false;
}

/**
 * Count the maximum number of data points in any single series.
 * Returns 0 for external data (data.url) or missing data — caller should
 * default to showing points when the count is unknown.
 */
function getMaxSeriesLength(spec) {
  const values = spec.data?.values;
  if (!Array.isArray(values)) return 0;

  const colorField = spec.encoding?.color?.field;
  if (!colorField) return values.length;

  // Multi-series: group by color field, return max group size
  const counts = {};
  for (const row of values) {
    const key = row[colorField];
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.values(counts).reduce((maximum, count) => Math.max(maximum, count), 0);
}

/** Apply or remove point overlay on a single line-mark container. */
const LINE_POINT_SIZE = 9; // Vega-Lite size = pixel area; 9 ≈ 3px diameter

function applyPointToMark(container, show) {
  const mark = container.mark;
  if (!mark) return;
  const markType = typeof mark === "string" ? mark : mark.type;
  if (markType !== "line") return;
  if (show) {
    // Don't override if user already configured point
    if (typeof mark === "object" && mark.point !== undefined) return;
    if (typeof mark === "string") {
      container.mark = { type: mark, point: { size: LINE_POINT_SIZE } };
    } else {
      mark.point = { size: LINE_POINT_SIZE };
    }
  } else {
    // Force-hide points when series is too long (> threshold)
    if (typeof mark === "string") {
      container.mark = { type: mark, point: false };
    } else {
      mark.point = false;
    }
  }
}

/**
 * Enforce data-point overlay policy on line marks of a Vega-Lite spec.
 * - Series ≤ 15 points: show ≈3px data points (unless user already configured)
 * - Series > 15 points: force-hide data points (overrides any spec setting)
 * - Handles top-level mark, layer specs, and nested composite specs
 */
const LINE_POINT_THRESHOLD = 15;

function injectLinePointOverlay(spec) {
  if (!isVegaLiteSpec(spec)) return spec;

  // Layered spec: evaluate each layer independently
  if (Array.isArray(spec.layer)) {
    for (const layer of spec.layer) {
      const maxLen = getMaxSeriesLength(layer);
      applyPointToMark(layer, maxLen <= LINE_POINT_THRESHOLD);
    }
    return spec;
  }

  // Top-level mark
  const maxLen = getMaxSeriesLength(spec);
  applyPointToMark(spec, maxLen <= LINE_POINT_THRESHOLD);

  // Nested composite spec (facet / concat / vconcat / hconcat)
  if (spec.spec) injectLinePointOverlay(spec.spec);
  return spec;
}

/**
 * Find the best field to use as a color encoding for theme palette injection.
 * Priority: first nominal/ordinal field in encoding, then first field from data.
 * Returns null if no suitable field is found.
 */
function findColorField(spec) {
  const enc = spec.encoding || {};
  // Collect fields already used in encoding channels — don't re-use them as color
  const usedFields = new Set();
  for (const ch of ["x", "y", "column", "row", "detail"]) {
    const e = enc[ch];
    if (e?.field) usedFields.add(e.field);
  }
  // Check each encoding channel for a nominal/ordinal field not already used
  for (const ch of ["x", "y", "column", "row", "detail"]) {
    const e = enc[ch];
    if (e && e.field && !usedFields.has(e.field) && (e.type === "nominal" || e.type === "ordinal")) {
      return e.field;
    }
  }
  // Fallback: first string field from inline data that is NOT already used
  const vals = spec.data?.values;
  if (Array.isArray(vals) && vals.length > 0) {
    const first = vals[0];
    for (const key of Object.keys(first)) {
      if (!usedFields.has(key) && typeof first[key] === "string") return key;
    }
  }
  return null;
}

/**
 * Inject color encoding into a spec and its layers.
 * Handles top-level encoding, layer specs, and nested composite specs.
 */
function injectColorEncoding(spec) {
  if (!isVegaLiteSpec(spec)) return;

  // Top-level encoding
  if (spec.encoding && !spec.encoding.color) {
    const colorField = findColorField(spec);
    if (colorField) {
      spec.encoding.color = { field: colorField, type: "nominal" };
    }
  }

  // Layer specs: each layer may need its own color encoding
  if (Array.isArray(spec.layer)) {
    for (const layer of spec.layer) {
      if (layer.encoding && !layer.encoding.color) {
        const colorField = findColorField(layer);
        if (colorField) {
          layer.encoding.color = { field: colorField, type: "nominal" };
        }
      }
    }
  }

  // Nested composite spec
  if (spec.spec) injectColorEncoding(spec.spec);
  for (const key of ["concat", "vconcat", "hconcat"]) {
    if (Array.isArray(spec[key])) {
      for (const sub of spec[key]) injectColorEncoding(sub);
    }
  }
}

// Apply theme preset (takes priority over --palette)
// Default theme: fintech (pass --theme=none to disable)
const DEFAULT_THEME = "fintech";
const effectiveTheme = themeName === "none" ? null : (themeName || (palette ? null : DEFAULT_THEME));
const theme = resolveTheme(effectiveTheme);
if (theme) {
  // Auto-inject color encoding BEFORE applying theme so hasColorEnc is accurate.
  // Without a color encoding, config.range.category has no effect and
  // all marks render in the same default blue.
  injectColorEncoding(specJson);
  applyVegaTheme(specJson, theme);
} else if (palette) {
  // Auto-inject color encoding if missing (before palette injection)
  injectColorEncoding(specJson);
  // Inject palette into spec config
  const isHexList = palette.includes("#") || palette.includes(",");
  const colorRange = isHexList
    ? palette.split(",").map((c) => c.trim())
    : palette;

  specJson.config = specJson.config || {};
  specJson.config.range = specJson.config.range || {};
  if (isHexList) {
    specJson.config.range.category = colorRange;
  } else {
    specJson.config.range.category = { scheme: colorRange };
  }
}

// Inject data point overlays into line marks (skip if series > 15 points)
injectLinePointOverlay(specJson);

/**
 * Auto-fix mixed line+bar charts:
 * - Bar marks on temporal x-axis get extremely thin bands; force a pixel width.
 * - First/last data points get clipped by axis lines; add scale padding.
 */
const BAR_WIDTH_PX = 18;
const TEMPORAL_PADDING_PX = 20;

function fixBarRendering(container) {
  if (!container?.encoding?.x) return;
  const xEnc = container.encoding.x;

  // Bar on temporal axis → force pixel width (temporal band is near-zero)
  if (container.mark?.type === "bar" || (typeof container.mark === "string" && container.mark === "bar")) {
    if (xEnc.type === "temporal" || xEnc.type === "ordinal") {
      if (xEnc.type === "temporal") {
        container.mark = typeof container.mark === "string"
          ? { type: "bar", width: BAR_WIDTH_PX }
          : { ...container.mark, width: BAR_WIDTH_PX };
      }
      // Add band padding for ordinal to give bars breathing room
      if (xEnc.type === "ordinal" && !xEnc.scale?.padding) {
        xEnc.scale = { ...(xEnc.scale || {}), padding: 0.3 };
      }
    }
  }

  // Temporal x-axis: add edge padding so first/last points aren't clipped
  if (xEnc.type === "temporal" && !xEnc.scale?.padding) {
    xEnc.scale = { ...(xEnc.scale || {}), padding: TEMPORAL_PADDING_PX };
  }
}

function applyBarFix(spec) {
  if (!isVegaLiteSpec(spec)) return spec;

  if (Array.isArray(spec.layer)) {
    for (const layer of spec.layer) fixBarRendering(layer);
    return spec;
  }

  fixBarRendering(spec);
  if (spec.spec) applyBarFix(spec.spec);
  return spec;
}

applyBarFix(specJson);

// Compile Vega-Lite to Vega if needed
let vegaSpec;
if (isVegaLiteSpec(specJson)) {
  vegaSpec = vegaLite.compile(specJson).spec;
} else {
  vegaSpec = specJson;
}

const view = new vega.View(vega.parse(vegaSpec), { renderer: "none" });
await view.runAsync();

/**
 * Rasterize an SVG string to PNG via resvg (prebuilt native, no node-canvas needed).
 * vega's view.toCanvas() requires the `canvas` native package, which is fragile
 * (native build / prebuild download); the SVG-first path avoids it entirely.
 * Renders at 2x for crisp output on high-DPI displays.
 */
const PNG_SCALE = 2;

async function renderPng(view) {
  const svg = await view.toSVG();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: PNG_SCALE },
    background: "#ffffff",
  });
  return resvg.render().asPng();
}

let renderedOutput;
if (format === "svg") {
  renderedOutput = await view.toSVG();
} else {
  try {
    const png = await renderPng(view);
    renderedOutput = Buffer.from(png);
  } catch (err) {
    console.error(`[vega-chart] \u274c PNG rendering failed: ${err.message}`);
    console.error(`[vega-chart] Fallback: output SVG instead, then rasterize with a proper SVG renderer.`);
    console.error(`[vega-chart]   node vega-chart.mjs ${specPath} ${outputPath.replace(/\.png$/i, ".svg")}`);
    console.error(`[vega-chart]   \u26a0 Do NOT use macOS sips for SVG\u2192PNG: it ignores width/viewBox and emits a fixed-size canvas (cropped, wrong aspect ratio).`);
    process.exit(1);
  }
}

// ─── Post-render diagnostics ────────────────────────────────────────────────

/**
 * Check if the rendered view contains any visible data marks.
 * Inspects the primary data set of the compiled Vega spec.
 */
function checkViewHasData(view, vegaSpec) {
  try {
    // Get the primary data source name
    const dataName = vegaSpec.data?.[0]?.name || "source_0";
    const dataset = view.data(dataName);
    if (!dataset || dataset.length === 0) return false;
    // Check if any data items survived filtering/parsing
    return dataset.length > 0;
  } catch {
    return true; // Cannot determine — assume OK
  }
}

const hasData = checkViewHasData(view, vegaSpec);

view.finalize();

// Print warnings
if (warnings.length > 0) {
  console.error("[vega-chart] Data diagnostics:");
  for (const w of warnings) {
    console.error(`  ${w}`);
  }
}

const themeInfo = theme ? ` (theme: ${theme.name})` : "";
if (!hasData) {
  console.error(`[vega-chart] \u26a0 Chart has no data! Please check:`);
  console.error(`  1. data.values is not empty`);
  console.error(`  2. encoding.field matches data field names`);
  console.error(`  3. temporal field values are ISO 8601 format (e.g. "2024-01-01")`);
  console.error(`  4. quantitative field values are numeric`);
  console.error(`Chart was not written because no data survived validation: ${outputPath}${themeInfo}`);
  process.exitCode = 1;
} else {
  const tempPath = join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, renderedOutput, { flag: "wx" });
    renameSync(tempPath, outputPath);
  } finally {
    try { unlinkSync(tempPath); } catch { /* already renamed or never created */ }
  }
  console.log(`Chart generated: ${outputPath}${themeInfo}`);
}
