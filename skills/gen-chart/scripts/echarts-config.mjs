#!/usr/bin/env node
/**
 * ECharts Chart Configuration Generator
 *
 * Generates an ECharts chart configuration as a JSON string printed to stdout.
 * Does NOT generate any files — the output is ready to embed directly into
 * markdown content (for example, the chart-data section consumed by the frontend
 * BriefingChart component).
 *
 * Usage:
 *   node echarts-config.mjs --spec <tmp-gen-chart-*.json> [--theme=<name>] [--width=<n>] [--height=<n>]
 *
 * Options:
 *   --spec <file>         Input chart definition JSON file (BriefingChartData format)
 *   --theme=<name>        Built-in financial theme preset (default: fintech).
 *                         Use --theme=none to disable theme injection.
 *                         Use --theme=list to print all available themes and exit.
 *   --width=<n>           Chart width in pixels (default: 800, for 16:9 aspect ratio)
 *   --height=<n>          Chart height in pixels (default: 450, for 16:9 aspect ratio)
 *
 * Output format (BriefingChartData):
 *   { "chart": "<type>", "option": { ...ECharts option... } }
 *
 * The output JSON is:
 *   1. Directly renderable via echarts.setOption(option) — theme fully applied
 *   2. Compatible with the frontend BriefingChart pipeline — buildBriefingChartOption()
 *      will process it and apply frontend-specific styling
 */

import { readFileSync, statSync } from "node:fs";
import { resolveTheme, isDark, THEME_NAMES } from "./themes.mjs";
import { parseEchartsArgs, positiveInteger } from "./cli-args.mjs";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 450;
const DEFAULT_THEME = "fintech";

/**
 * Supported chart types — aligned with frontend buildBriefingChartOption().
 * The frontend normalizes chart names via trim().toLowerCase(), so we accept
 * case-insensitive input.
 */
const SUPPORTED_CHART_TYPES = [
  "line",
  "area",
  "bar",
  "horizontal bar",
  "histogram",
  "pie",
  "donut",
  "radar",
  "scatter",
  "scatter plot",
  "bubble",
];

/** Diagnostic warnings collected during processing. */
const warnings = [];

// ─── Argument Parsing ───────────────────────────────────────────────────────

let parsedArgs;
try {
  parsedArgs = parseEchartsArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
const { spec: specPath, theme: themeName } = parsedArgs.options;
let width;
let height;
try {
  width = positiveInteger(parsedArgs.options.width, "width", DEFAULT_WIDTH);
  height = positiveInteger(parsedArgs.options.height, "height", DEFAULT_HEIGHT);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

// --theme=list: print available themes and exit
if (themeName === "list") {
  if (parsedArgs.positionals.length > 0 || Object.keys(parsedArgs.options).length !== 1) {
    console.error("Error: --theme=list cannot be combined with input or other options");
    process.exit(1);
  }
  console.error("Available financial color themes:\n");
  for (const key of THEME_NAMES) {
    const t = resolveTheme(key);
    console.error(`  ${key.padEnd(12)} ${t.name.padEnd(35)} ${t.colors.join(", ")}  bg:${t.background}`);
  }
  process.exit(0);
}

if (parsedArgs.help || !specPath) {
  console.error("Usage: echarts-config.mjs --spec <tmp-gen-chart-*.json> [--theme=<name>] [--width=<n>] [--height=<n>]");
  console.error("  --theme:   built-in financial theme (fintech, bloomberg, oldmoney, ...) or 'list' to show all");
  console.error("  --width:   chart width in pixels (default: 800)");
  console.error("  --height:  chart height in pixels (default: 450)");
  console.error("  Output: { chart, option } JSON to stdout — no files generated");
  process.exit(parsedArgs.help ? 0 : 1);
}

// ─── Read & Parse Chart Definition ──────────────────────────────────────────

let chartDef;
try {
  const specStat = statSync(specPath);
  if (!specStat.isFile() || specStat.size > 100 * 1024 * 1024) throw new Error("spec must be a regular file no larger than 100MB");
  const raw = readFileSync(specPath, "utf-8");
  chartDef = JSON.parse(raw.replace(/^\uFEFF/, ""));
} catch (err) {
  console.error(`Error: Failed to read/parse spec file "${specPath}": ${err.message}`);
  process.exit(1);
}

// ─── Validation ─────────────────────────────────────────────────────────────

if (!chartDef || typeof chartDef !== "object" || Array.isArray(chartDef)) {
  console.error("Error: Chart definition must be a JSON object with { chart, option }");
  process.exit(1);
}

const chartName = typeof chartDef.chart === "string" ? chartDef.chart.trim().toLowerCase() : "";
if (!chartName) {
  console.error("Error: Missing required field \"chart\" (e.g., \"line\", \"bar\", \"pie\")");
  process.exit(1);
}

if (!SUPPORTED_CHART_TYPES.includes(chartName)) {
  console.error(`Error: Unsupported chart type "${chartDef.chart}".`);
  console.error(`  Supported types: ${SUPPORTED_CHART_TYPES.join(", ")}`);
  process.exit(1);
}

if (!chartDef.option || typeof chartDef.option !== "object" || Array.isArray(chartDef.option)) {
  console.error("Error: Missing or invalid \"option\" field (must be an ECharts option object)");
  process.exit(1);
}

if (!chartDef.option.series) {
  console.error("Error: option.series is required (array of ECharts series objects)");
  process.exit(1);
}

// ─── Data Cleanup ───────────────────────────────────────────────────────────

/**
 * Convert Chinese/non-standard date strings to ISO 8601.
 * Handles Chinese year/month/day date strings, "2024-1", "2024/1", "2024Q1", and similar forms.
 */
function convertChineseDate(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();

  let m = v.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?$/);
  if (m) {
    const [, y, mo, d] = m;
    return d ? `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` : `${y}-${mo.padStart(2, "0")}-01`;
  }

  m = v.match(/^(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?$/);
  if (m) {
    const [, mo, d] = m;
    const year = new Date().getFullYear();
    return d ? `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` : `${year}-${mo.padStart(2, "0")}-01`;
  }

  m = v.match(/^(\d{4})[/-](\d{1,2})(?:[/-](\d{1,2}))?$/);
  if (m) {
    const [, y, mo, d] = m;
    return d ? `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` : `${y}-${mo.padStart(2, "0")}-01`;
  }

  m = v.match(/^(\d{4})\s*-?\s*[Qq](\d)$/);
  if (m) {
    const quarterMonth = { "1": "01", "2": "04", "3": "07", "4": "10" };
    return `${m[1]}-${quarterMonth[m[2]]}-01`;
  }

  return null;
}

/**
 * Coerce a string value to a number if it represents a numeric value.
 * Strips common currency/percentage symbols: %, ¥, $, €, commas.
 * Returns the original value if it cannot be coerced.
 */
function coerceStringNumber(value) {
  if (typeof value !== "string") return value;
  const cleaned = value.replace(/[,%¥$€\s]/g, "").trim();
  if (cleaned === "" || cleaned === "-") return value;
  const num = Number(cleaned);
  if (!isNaN(num) && isFinite(num)) return num;
  return value;
}

/**
 * Check if a value is a plain object (not array, not null).
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Clean a series data array:
 * - Convert string numbers to numbers (e.g., "100" → 100, "3.14%" → 3.14)
 * - Preserve objects (e.g., { value: 100, name: "A" }) — coerce their value field
 */
function cleanSeriesData(data) {
  if (!Array.isArray(data)) return data;

  let numFixCount = 0;

  const cleaned = data.map((item) => {
    if (typeof item === "string") {
      const coerced = coerceStringNumber(item);
      if (typeof coerced === "number") {
        numFixCount++;
        return coerced;
      }
      return item;
    }

    if (isPlainObject(item)) {
      const result = { ...item };
      if (item.value !== undefined) {
        const coerced = coerceStringNumber(item.value);
        if (typeof coerced === "number" && typeof item.value === "string") {
          numFixCount++;
          result.value = coerced;
        }
      }
      // Handle nested array values (e.g., scatter: [x, y, size])
      if (Array.isArray(item.value)) {
        result.value = item.value.map((v) => {
          const coerced = coerceStringNumber(v);
          if (typeof coerced === "number" && typeof v === "string") numFixCount++;
          return coerced;
        });
      }
      return result;
    }

    if (Array.isArray(item)) {
      return item.map((v) => {
        const coerced = coerceStringNumber(v);
        if (typeof coerced === "number" && typeof v === "string") numFixCount++;
        return coerced;
      });
    }

    return item;
  });

  if (numFixCount > 0) {
    warnings.push(`自动转换 ${numFixCount} 个字符串数值为 number`);
  }

  return cleaned;
}

/**
 * Clean xAxis/yAxis category data:
 * - Convert Chinese dates to ISO 8601 (for temporal axes)
 * - Coerce string numbers to numbers (for value axes)
 */
function cleanAxisData(axis) {
  if (!axis) return axis;

  const cleanSingle = (ax) => {
    if (!isPlainObject(ax) || !Array.isArray(ax.data)) return ax;
    const result = { ...ax };

    let dateFixCount = 0;

    result.data = ax.data.map((value) => {
      if (typeof value === "string") {
        const converted = convertChineseDate(value);
        if (converted && converted !== value.trim()) {
          dateFixCount++;
          return converted;
        }
      }
      return value;
    });

    if (dateFixCount > 0) {
      warnings.push(`自动修复 ${dateFixCount} 个日期值（中文/非标准格式 → ISO 8601）`);
    }

    return result;
  };

  if (Array.isArray(axis)) {
    return axis.map(cleanSingle);
  }
  return cleanSingle(axis);
}

// Apply data cleanup to the option
const option = { ...chartDef.option };

if (Array.isArray(option.series)) {
  option.series = option.series.map((s) => {
    if (!isPlainObject(s)) return s;
    return { ...s, data: cleanSeriesData(s.data) };
  });
} else if (isPlainObject(option.series)) {
  option.series = { ...option.series, data: cleanSeriesData(option.series.data) };
}

if (option.xAxis) option.xAxis = cleanAxisData(option.xAxis);
if (option.yAxis) option.yAxis = cleanAxisData(option.yAxis);

// ─── Theme Application ──────────────────────────────────────────────────────

/**
 * Apply a financial theme preset to the ECharts option.
 * Injects color palette, background, text colors, tooltip, legend, and grid.
 * Only fills in defaults — does NOT override values already present in the option.
 */
function applyEChartsTheme(option, theme) {
  const dark = isDark(theme.background);
  const textColor = dark ? "#D4D4D8" : "#3F3F46";
  const titleColor = dark ? "#F1F5F9" : "#1E293B";
  const axisLineColor = dark ? "#3F3F46" : "#E4E4E7";
  const splitLineColor = dark ? "#27272A" : "#F4F4F5";
  const tooltipBg = dark ? "rgba(9,9,11,0.94)" : "rgba(29,41,59,0.94)";

  // Color palette (category range)
  if (!option.color) {
    option.color = theme.colors;
  }

  // Background
  if (!option.backgroundColor) {
    option.backgroundColor = theme.background;
  }

  // Global text style
  if (!option.textStyle) {
    option.textStyle = {
      color: textColor,
      fontFamily: "PingFang SC, sans-serif",
    };
  }

  // Title styling
  if (isPlainObject(option.title)) {
    option.title = {
      ...option.title,
      textStyle: option.title.textStyle || {
        color: titleColor,
        fontSize: 14,
        fontWeight: 600,
      },
    };
  }

  // Tooltip
  if (!option.tooltip) {
    const isPie = chartName === "pie" || chartName === "donut";
    const isRadar = chartName === "radar";
    const isLine = chartName === "line" || chartName === "area";
    option.tooltip = {
      trigger: (isPie || isRadar) ? "item" : "axis",
      confine: true,
      backgroundColor: tooltipBg,
      borderWidth: 0,
      padding: [7, 9],
      extraCssText: "box-shadow:0 6px 18px rgba(15,23,42,0.16);border-radius:6px;",
      axisPointer: isLine ? {
        show: true,
        type: "line",
        lineStyle: { color: axisLineColor, width: 1 },
      } : undefined,
      textStyle: {
        color: "#FFFFFF",
        fontSize: 11,
      },
    };
  }

  // Legend (show when multiple series or pie/donut)
  if (!option.legend) {
    const seriesCount = Array.isArray(option.series) ? option.series.length : 1;
    const isPieOrDonut = chartName === "pie" || chartName === "donut";
    const shouldShow = seriesCount > 1 || isPieOrDonut;
    if (shouldShow) {
      option.legend = {
        show: true,
        bottom: 0,
        icon: "roundRect",
        itemWidth: 8,
        itemHeight: 6,
        itemGap: 8,
        textStyle: {
          color: textColor,
          fontSize: 10,
        },
      };
    }
  }

  // Grid for cartesian charts (not pie/donut/radar)
  const isPieOrDonut = chartName === "pie" || chartName === "donut";
  const isRadar = chartName === "radar";
  if (!isPieOrDonut && !isRadar && !option.grid) {
    const hasTitle = isPlainObject(option.title) && typeof option.title.text === "string" && option.title.text.trim().length > 0;
    const isHorizontal = chartName === "horizontal bar";
    const hasLegend = isPlainObject(option.legend) && option.legend.show !== false;
    option.grid = {
      top: hasTitle ? 68 : 28,
      left: isHorizontal ? 78 : 24,
      right: isHorizontal ? 34 : 24,
      // Reserve room for the bottom legend row so it stays clear of the
      // x-axis labels and axis title (matches frontend gridBottom logic).
      bottom: hasLegend ? 56 : 32,
      containLabel: true,
    };
  }

  // Axis styling (fill in defaults, don't override existing axisLabel/axisLine/etc.)
  const fillAxisDefaults = (axis, axisType) => {
    if (!isPlainObject(axis)) return axis;
    return {
      ...axis,
      type: axis.type || axisType,
      axisLine: axis.axisLine || { show: false },
      axisTick: axis.axisTick || { show: false },
      axisLabel: axis.axisLabel || {
        color: textColor,
        fontSize: 10,
        hideOverlap: true,
      },
      splitLine: axis.splitLine || (axisType === "value" ? {
        show: true,
        lineStyle: { color: splitLineColor, type: "solid" },
      } : { show: false }),
    };
  };

  if (option.xAxis && !isPieOrDonut && !isRadar) {
    const xType = chartName === "horizontal bar" ? "value" : "category";
    if (Array.isArray(option.xAxis)) {
      option.xAxis = option.xAxis.map((ax) => fillAxisDefaults(ax, xType));
    } else {
      option.xAxis = fillAxisDefaults(option.xAxis, xType);
    }
  }

  if (option.yAxis && !isPieOrDonut && !isRadar) {
    const yType = chartName === "horizontal bar" ? "category" : "value";
    if (Array.isArray(option.yAxis)) {
      option.yAxis = option.yAxis.map((ax) => fillAxisDefaults(ax, yType));
    } else {
      option.yAxis = fillAxisDefaults(option.yAxis, yType);
    }
  }

  // Radar indicator styling
  if (isRadar && isPlainObject(option.radar)) {
    option.radar = {
      ...option.radar,
      axisName: option.radar.axisName || {
        color: textColor,
        fontSize: 10,
      },
      splitLine: option.radar.splitLine || {
        lineStyle: { color: axisLineColor },
      },
      splitArea: option.radar.splitArea || {
        areaStyle: {
          color: ["rgba(21,93,252,0.018)", "rgba(21,93,252,0.055)"],
        },
      },
      axisLine: option.radar.axisLine || {
        lineStyle: { color: axisLineColor },
      },
    };
  }
}

// Resolve and apply theme
const effectiveTheme = themeName === "none" ? null : (themeName || DEFAULT_THEME);
const theme = resolveTheme(effectiveTheme);

if (effectiveTheme && !theme) {
  console.error(`Warning: Unknown theme "${effectiveTheme}". Available themes: ${THEME_NAMES.join(", ")}. Falling back to no theme.`);
}

if (theme) {
  applyEChartsTheme(option, theme);
}

// Disable animation for consistent static rendering (matches frontend behavior)
if (option.animation === undefined) {
  option.animation = false;
  option.animationDuration = 0;
}

// ─── Output ─────────────────────────────────────────────────────────────────

const result = {
  chart: chartName,
  option,
};

// Print warnings to stderr
if (warnings.length > 0) {
  console.error("[echarts-config] 数据诊断:");
  for (const w of warnings) {
    console.error(`  ${w}`);
  }
}

const themeInfo = theme ? ` (theme: ${theme.name})` : "";
console.error(`[echarts-config] ECharts 配置已生成${themeInfo}，尺寸 ${width}x${height} (16:9)`);

// Print JSON result to stdout (no trailing newline beyond what JSON.stringify provides)
process.stdout.write(JSON.stringify(result, null, 2));
