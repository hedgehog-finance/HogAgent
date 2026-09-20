/**
 * Shared Theme Definitions
 *
 * 10 built-in financial color themes, mirroring the themes defined in
 * skills/gen-chart/scripts/themes.mjs and skills/gen-ppt/scripts/themes.mjs.
 *
 * Each theme provides: name, colors (6-hex palette), background, and description.
 * Used by:
 *   - Web UI: CSS variable overrides for page styling
 *   - System Prompt: injected as context for LLM-generated visual content
 *   - API: GET/POST /api/user-theme for per-user theme persistence
 */

export interface ThemePreset {
  /** Display name (English) */
  name: string;
  /** 6 hex color strings (dark → light gradient + accents) */
  colors: string[];
  /** Background hex color */
  background: string;
  /** Short description of best use case (English) */
  description: string;
}

/** Default theme key */
export const DEFAULT_THEME = "fintech";

/** 10 built-in financial color themes */
export const THEMES: Record<string, ThemePreset> = {
  // ── High-contrast professional themes ─────────────────────────────
  fintech: {
    name: "Modern FinTech",
    colors: ["#1D4ED8", "#215DF2", "#60A5FA", "#818CF8", "#A78BFA", "#38BDF8"],
    background: "#F8FAFC",
    description: "SaaS dashboards, tech startup decks",
  },
  oldmoney: {
    name: "Old Money",
    colors: ["#0A2540", "#B4975A", "#115E59", "#8B2500", "#D4A76A", "#2E8B6F"],
    background: "#FFFFFF",
    description: "Wealth management, private equity reports",
  },
  bloomberg: {
    name: "Bloomberg / Quant",
    colors: ["#10B981", "#EF4444", "#0EA5E9", "#F59E0B", "#A855F7", "#06B6D4"],
    background: "#09090B",
    description: "Dark dashboards, terminal style",
  },
  economist: {
    name: "Economist",
    colors: ["#0F2B5B", "#D73027", "#4575B4", "#E8A735", "#1B7A5A", "#6C7B8A"],
    background: "#F6F4F0",
    description: "Research publications, data journalism",
  },
  saas: {
    name: "Silicon Valley SaaS",
    colors: ["#635BFF", "#00D4B6", "#FF8A65", "#3B82F6", "#EC4899", "#84CC16"],
    background: "#FFFFFF",
    description: "Product analytics, growth decks",
  },
  // ── Muted themes ──────────────────────────────────────────────────
  mist: {
    name: "Morning Mist",
    colors: ["#64748B", "#7A8C9F", "#8F9FB1", "#9EAEBF", "#B0BFCF", "#C2CEDD"],
    background: "#F1F5F9",
    description: "Muted slate blues, calm professional tone",
  },
  twilight: {
    name: "Twilight",
    colors: ["#776B87", "#8A7D9A", "#9C90AC", "#AFA3BD", "#C0B5CE", "#D1C6DD"],
    background: "#F5F3F7",
    description: "Muted violets, elegant dusk palette",
  },
  parchment: {
    name: "Parchment",
    colors: ["#947E70", "#A69082", "#B5A092", "#C4B1A3", "#D1C0B3", "#DDCFC3"],
    background: "#F5F2EB",
    description: "Warm sepia tones, classic document style",
  },
  azure: {
    name: "Azure",
    colors: ["#5E7B9E", "#728EAF", "#86A0BE", "#9BB1CD", "#ADC1DA", "#BFD1E6"],
    background: "#EAF2F8",
    description: "Pale coastal blues, clean and airy",
  },
  gravel: {
    name: "Gravel",
    colors: ["#73716D", "#868480", "#989691", "#A9A7A2", "#B9B7B2", "#C9C7C2"],
    background: "#F0EFEA",
    description: "Neutral warm grays, understated professional",
  },
};

/** Ordered list of theme keys */
export const THEME_NAMES = Object.keys(THEMES);

/**
 * Resolve a theme name to its preset object.
 * Returns null if name doesn't match any built-in theme.
 */
export function resolveTheme(name: string | undefined | null): ThemePreset | null {
  if (!name) return null;
  const key = name.toLowerCase().trim();
  return THEMES[key] || null;
}

/**
 * Resolve a theme name, falling back to DEFAULT_THEME if not found.
 */
export function resolveThemeOrDefault(name: string | undefined | null): ThemePreset {
  return resolveTheme(name) || THEMES[DEFAULT_THEME];
}

/**
 * Check if a hex background color is dark (luminance < 0.5).
 * Used to determine text color contrast.
 */
export function isDark(hex: string): boolean {
  if (!hex || !hex.startsWith("#")) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}
