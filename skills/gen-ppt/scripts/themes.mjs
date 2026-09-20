/**
 * HogAgent GenPPT — Financial Color Themes for PowerPoint
 *
 * Reuses the same 10 financial themes from gen-chart.
 * Converts hex colors to PptxGenJS format (no # prefix)
 * and adds PPT-specific derived properties.
 *
 * Usage: import { resolveTheme, toPptxTheme, THEME_NAMES } from "./themes.mjs";
 */

export const THEMES = {
  // ── High-contrast professional themes ─────────────────────────────
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

/** Check if a hex color is dark (luminance < 0.5). */
export function isDark(hex) {
  const h = stripHex(hex);
  if (!h || h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

/** Strip # prefix from hex color. Returns as-is if no # present. */
function stripHex(hex) {
  if (!hex) return "";
  return hex.startsWith("#") ? hex.slice(1) : hex;
}

/** Return light or dark text color based on background luminance. */
function textOn(hex) {
  return isDark(hex) ? "F8FAFC" : "1E293B";
}

/**
 * Convert a gen-chart theme to a PptxGenJS-compatible theme object.
 * Strips # from hex colors and adds PPT-specific derived properties.
 */
export function toPptxTheme(theme) {
  const colors = theme.colors.map(stripHex);
  const bg = stripHex(theme.background);
  const dark = isDark(theme.background);

  return {
    name: theme.name,
    // Core palette
    primary: colors[0],
    secondary: colors[1],
    accent: colors[3] || colors[1],
    colors,
    // Background & text
    background: bg,
    textColor: dark ? "F8FAFC" : "1E293B",
    subtleText: dark ? "94A3B8" : "64748B",
    // Table styling
    tableHeaderBg: colors[0],
    tableHeaderText: textOn(colors[0]),
    tableAltRow: dark ? "18181B" : "F1F5F9",
    // Borders & lines
    borderColor: dark ? "334155" : "E2E8F0",
    decorativeLine: colors[0],
  };
}
