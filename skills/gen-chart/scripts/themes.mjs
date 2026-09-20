/**
 * HogAgent GenChart — 10 Built-in Financial Color Themes
 *
 * Each theme defines: colors (category palette), background, and
 * optional axis/text styling hints for Mermaid themeVariables.
 *
 * Usage: import { THEMES, resolveTheme } from "./themes.mjs";
 */

export const THEMES = {
  // ── High-contrast professional themes ─────────────────────────────
  // Each theme: 6 colors, dark→light gradient + complementary accents.
  fintech: {
    name: "Modern FinTech (Electric Blue)",
    colors: ["#1D4ED8", "#215DF2", "#60A5FA", "#818CF8", "#A78BFA", "#38BDF8"],
    background: "#F8FAFC",
  },
  oldmoney: {
    name: "Old Money (Traditional Banking)",
    colors: ["#0A2540", "#B4975A", "#115E59", "#8B2500", "#D4A76A", "#2E8B6F"],
    background: "#FFFFFF",
  },
  bloomberg: {
    name: "Bloomberg / Quant Dark",
    colors: ["#10B981", "#EF4444", "#0EA5E9", "#F59E0B", "#A855F7", "#06B6D4"],
    background: "#09090B",
  },
  economist: {
    name: "Economist / Data Journalism",
    colors: ["#0F2B5B", "#D73027", "#4575B4", "#E8A735", "#1B7A5A", "#6C7B8A"],
    background: "#F6F4F0",
  },
  saas: {
    name: "Silicon Valley SaaS",
    colors: ["#635BFF", "#00D4B6", "#FF8A65", "#3B82F6", "#EC4899", "#84CC16"],
    background: "#FFFFFF",
  },

  // ── Muted themes — monochromatic gradient, 3 original + 3 interpolated ──
  mist: {
    name: "Morning Mist (cool)",
    colors: ["#64748B", "#7A8C9F", "#8F9FB1", "#9EAEBF", "#B0BFCF", "#C2CEDD"],
    background: "#F1F5F9",
  },
  twilight: {
    name: "Twilight (dusk)",
    colors: ["#776B87", "#8A7D9A", "#9C90AC", "#AFA3BD", "#C0B5CE", "#D1C6DD"],
    background: "#F5F3F7",
  },
  parchment: {
    name: "Parchment (warm)",
    colors: ["#947E70", "#A69082", "#B5A092", "#C4B1A3", "#D1C0B3", "#DDCFC3"],
    background: "#F5F2EB",
  },
  azure: {
    name: "Azure (coastal)",
    colors: ["#5E7B9E", "#728EAF", "#86A0BE", "#9BB1CD", "#ADC1DA", "#BFD1E6"],
    background: "#EAF2F8",
  },
  gravel: {
    name: "Gravel (earth)",
    colors: ["#73716D", "#868480", "#989691", "#A9A7A2", "#B9B7B2", "#C9C7C2"],
    background: "#F0EFEA",
  },
};

export const THEME_NAMES = Object.keys(THEMES);

/**
 * Resolve a theme name to its preset object.
 * Returns null if name doesn't match any built-in theme.
 */
export function resolveTheme(name) {
  if (!name) return null;
  const key = name.toLowerCase().trim();
  return THEMES[key] || null;
}

/**
 * Resolve the primary mark type from a Vega-Lite spec.
 * Returns null if mark type cannot be determined (e.g., layered/composed specs).
 */
function resolveMarkType(spec) {
  if (!spec.mark) return null;
  // "mark": "bar" → "bar"
  if (typeof spec.mark === "string") return spec.mark;
  // "mark": { "type": "line", ... } → "line"
  if (typeof spec.mark === "object" && spec.mark.type) return spec.mark.type;
  return null;
}

/**
 * Apply a theme preset to a Vega/Vega-Lite spec's config.
 * Injects category color range, background, 16:9 aspect ratio,
 * padding, text colors, and axis styling (horizontal grid only).
 */
export function applyVegaTheme(spec, theme) {
  spec.config = spec.config || {};
  spec.config.background = theme.background;
  spec.config.range = spec.config.range || {};
  spec.config.range.category = theme.colors;

  // ── Mark-type-specific styling ──────────────────────────────────
  const markType = resolveMarkType(spec);

  const hasColorEnc = spec.encoding?.color != null;

  // Bar / Rect: thin stroke for readability between adjacent bars
  if (!markType || ["bar", "rect"].includes(markType)) {
    spec.config.bar = spec.config.bar || {};
    if (!spec.config.bar.stroke) spec.config.bar.stroke = "#94A3B8";
    if (!spec.config.bar.strokeWidth) spec.config.bar.strokeWidth = 0.5;
  }

  // Line / Trail: proper stroke width + theme color for single-series
  if (!markType || ["line", "trail"].includes(markType)) {
    spec.config.line = spec.config.line || {};
    if (!spec.config.line.strokeWidth) spec.config.line.strokeWidth = 2.5;
    if (!hasColorEnc && !spec.config.line.color) {
      spec.config.line.color = theme.colors[0];
    }
  }

  // Area: primary theme color + semi-transparent fill
  if (!markType || markType === "area") {
    spec.config.area = spec.config.area || {};
    if (!hasColorEnc && !spec.config.area.color) {
      spec.config.area.color = theme.colors[0];
    }
    if (!spec.config.area.fillOpacity) spec.config.area.fillOpacity = 0.4;
  }

  // Point / Circle / Square (scatter): reasonable size + theme color
  if (!markType || ["point", "circle", "square"].includes(markType)) {
    spec.config.point = spec.config.point || {};
    if (!spec.config.point.size) spec.config.point.size = 50;
    if (!hasColorEnc && !spec.config.point.color) {
      spec.config.point.color = theme.colors[0];
    }
  }

  // Tick: theme color for single-series + fillOpacity for color visibility
  if (!markType || markType === "tick") {
    spec.config.tick = spec.config.tick || {};
    if (!spec.config.tick.fillOpacity) spec.config.tick.fillOpacity = 0.8;
    if (!hasColorEnc && !spec.config.tick.color) {
      spec.config.tick.color = theme.colors[0];
    }
  }

  // Arc (pie/donut): thin stroke for slice separation
  if (!markType || markType === "arc") {
    spec.config.arc = spec.config.arc || {};
    if (!spec.config.arc.stroke) spec.config.arc.stroke = "#94A3B8";
    if (!spec.config.arc.strokeWidth) spec.config.arc.strokeWidth = 0.5;
  }

  // Generic mark stroke fallback (for rect, etc.)
  spec.config.mark = spec.config.mark || {};
  if (!spec.config.mark.stroke) spec.config.mark.stroke = "#94A3B8";
  if (!spec.config.mark.strokeWidth) spec.config.mark.strokeWidth = 0.5;

  // 16:9 default dimensions (only if not already set)
  if (spec.width == null) spec.width = 640;
  if (spec.height == null) spec.height = 360;

  // Padding
  if (!spec.padding) {
    spec.padding = { top: 30, right: 30, bottom: 30, left: 30 };
  }

  // Axis & text colors derived from background luminance
  const dark = isDark(theme.background);
  const textColor = dark ? "#D4D4D8" : "#3F3F46";
  const gridColor = dark ? "#27272A" : "#E4E4E7";
  const domainColor = dark ? "#3F3F46" : "#D4D4D8";

  spec.config.axis = spec.config.axis || {};
  const ax = spec.config.axis;
  if (!ax.labelColor) ax.labelColor = textColor;
  if (!ax.titleColor) ax.titleColor = textColor;
  if (!ax.gridColor) ax.gridColor = gridColor;
  if (!ax.domainColor) ax.domainColor = domainColor;
  if (!ax.tickColor) ax.tickColor = domainColor;

  // Axis X: no vertical grid lines
  spec.config.axisX = spec.config.axisX || {};
  if (spec.config.axisX.grid == null) spec.config.axisX.grid = false;

  // Axis Y: horizontal grid lines
  spec.config.axisY = spec.config.axisY || {};
  if (spec.config.axisY.grid == null) spec.config.axisY.grid = true;

  // Legend text
  spec.config.legend = spec.config.legend || {};
  if (!spec.config.legend.labelColor) spec.config.legend.labelColor = textColor;
  if (!spec.config.legend.titleColor) spec.config.legend.titleColor = textColor;
  // Breathing room so the legend stays clear of the x-axis labels/title
  // (orient bottom) and of the chart title row (orient top).
  if (spec.config.legend.offset == null) spec.config.legend.offset = 16;

  // Title
  spec.config.title = spec.config.title || {};
  if (!spec.config.title.color) spec.config.title.color = textColor;
  if (!spec.config.title.subtitleColor) spec.config.title.subtitleColor = textColor;
  // Keep the title row clear of a top-oriented legend below it.
  if (spec.config.title.offset == null) spec.config.title.offset = 14;
}

/**
 * Build Mermaid themeVariables from a theme preset.
 * Text colors are derived from NODE fill colors (not canvas background)
 * to ensure readability regardless of background luminance.
 */
export function toMermaidThemeVars(theme) {
  const [primary, secondary, tertiary] = theme.colors;
  const noteBkg = theme.colors[3] || primary;
  const secColor = secondary || primary;
  const terColor = tertiary || primary;

  // Text color contrast helper: light text on dark fills, dark text on light fills
  const textOn = (hex) => isDark(hex) ? "#F8FAFC" : "#1E293B";
  const borderOn = (hex) => isDark(hex) ? "#334155" : "#CBD5E1";

  return {
    // Node colors
    primaryColor: primary,
    primaryTextColor: textOn(primary),
    primaryBorderColor: primary,
    secondaryColor: secColor,
    secondaryTextColor: textOn(secColor),
    secondaryBorderColor: secColor,
    tertiaryColor: terColor,
    tertiaryTextColor: textOn(terColor),
    tertiaryBorderColor: terColor,

    // Lines & edges
    lineColor: isDark(theme.background) ? "#94A3B8" : "#64748B",
    edgeLabelBackground: theme.background,

    // Notes
    noteBkgColor: noteBkg,
    noteTextColor: textOn(noteBkg),
    noteBorderColor: noteBkg,

    // Clusters (subgraphs)
    clusterBkg: isDark(theme.background) ? "#1E293B" : "#F1F5F9",
    clusterBorder: isDark(theme.background) ? "#334155" : "#CBD5E1",

    // Canvas & general text
    mainBkg: theme.background,
    textColor: isDark(theme.background) ? "#E2E8F0" : "#334155",
    nodeBorder: primary,
    titleColor: isDark(theme.background) ? "#F1F5F9" : "#1E293B",
  };
}

/** Check if a hex background color is dark (luminance < 0.5). */
export function isDark(hex) {
  if (!hex || !hex.startsWith("#")) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}
