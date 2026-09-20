#!/usr/bin/env node
/**
 * HogAgent GenPPT — JSON to PowerPoint Generator
 * Usage: node gen-ppt.mjs <tmp-gen-ppt-*.json> <output.pptx> [--theme=<name>] [--target=<viewer>]
 *
 * Options:
 *   --theme=<name>   Override theme from JSON config
 *   --theme=list     Print all available themes and exit
 *   --target=<viewer> Compatibility target: powerpoint, keynote, or universal
 *
 * Reads a JSON configuration file and generates a .pptx presentation
 * using PptxGenJS. Supports 9 layout types, 10 financial color themes,
 * charts, tables, images, and custom positioned elements.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pptxgen from "pptxgenjs";
import { resolveTheme, toPptxTheme, THEME_NAMES } from "./themes.mjs";
import { normalizeAndValidatePptx } from "./pptx-ooxml.mjs";
import { parseGenPptArgs } from "./cli-args.mjs";

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_LAYOUTS = [
  "title", "section", "content", "two-column",
  "image-text", "chart", "table", "closing", "blank",
];

const DEFAULT_THEME = "fintech";
const DEFAULT_TARGET_VIEWER = "powerpoint";
const VALID_TARGET_VIEWERS = new Set(["powerpoint", "keynote", "universal"]);
const MAX_CONFIG_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GEN_PPT_VERSION = JSON.parse(readFileSync(resolve(SCRIPT_DIR, "../package.json"), "utf8")).version;

// Inline formatting tokens: **bold**, *italic*, ~~strike~~, `code`, and HTML tags
// (declared here because top-level `await generate()` runs before later consts)
const INLINE_TOKEN_RE = /(\*\*|\*|~~|`|<\/?(?:strong|b|em|i|u|s|del|strike|sub|sup)\s*>|<br\s*\/?\s*>)/gi;

// HTML tag name → style-state key
const HTML_STATE = {
  strong: "bold", b: "bold", em: "italic", i: "italic", u: "underline",
  s: "strike", del: "strike", strike: "strike", sub: "sub", sup: "sup",
};

// Default PPT theme when --theme=none or unknown theme
const FALLBACK_THEME = {
  name: "Default",
  primary: "1D4ED8", secondary: "215DF2", accent: "818CF8",
  colors: ["1D4ED8", "215DF2", "60A5FA", "818CF8", "A78BFA", "38BDF8"],
  background: "FFFFFF", textColor: "1E293B", subtleText: "64748B",
  tableHeaderBg: "1D4ED8", tableHeaderText: "FFFFFF",
  tableAltRow: "F1F5F9", borderColor: "E2E8F0", decorativeLine: "1D4ED8",
};

const PPTX_SHAPE_TYPES = new Set(Object.values(new pptxgen().ShapeType));
const SHAPE_ALIASES = new Map([
  ["arrow", "rightArrow"],
  ["oval", "ellipse"],
  ["rectangle", "rect"],
  ["roundedRectangle", "roundRect"],
]);

// ── CLI Argument Parsing ─────────────────────────────────────────────────────

let parsedArgs;
try {
  parsedArgs = parseGenPptArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Error [gen-ppt]: ${error.message}`);
  process.exit(1);
}
const [configPath, outputPath] = parsedArgs.positionals;
const themeOverride = parsedArgs.options.theme;
const targetOverride = parsedArgs.options.target?.toLowerCase();

// --theme=list: print available themes and exit
if (themeOverride === "list") {
  if (parsedArgs.positionals.length > 0 || Object.keys(parsedArgs.options).length !== 1) {
    console.error("Error [gen-ppt]: --theme=list cannot be combined with input, output, or other options");
    process.exit(1);
  }
  console.log("Available financial color themes:\n");
  for (const key of THEME_NAMES) {
    const t = resolveTheme(key);
    console.log(`  ${key.padEnd(12)} ${t.name.padEnd(35)} ${t.colors.join(", ")}  bg:${t.background}`);
  }
  process.exit(0);
}

if (parsedArgs.help || !configPath || !outputPath) {
  console.error("Usage: gen-ppt.mjs <tmp-gen-ppt-*.json> <output.pptx> [--theme=<name>] [--target=<viewer>]");
  console.error("  --theme=<name>  Override theme (fintech, bloomberg, oldmoney, ...)");
  console.error("  --theme=list    Print all themes and exit");
  console.error("  --target=<viewer>  powerpoint (default), keynote, or universal");
  process.exit(parsedArgs.help ? 0 : 1);
}
if (resolve(configPath) === resolve(outputPath)) {
  console.error("Error [gen-ppt]: input and output paths must be different");
  process.exit(1);
}
if (!outputPath.toLowerCase().endsWith(".pptx")) {
  console.error("Error [gen-ppt]: output file must use a .pptx extension");
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

try {
  await generate();
} catch (err) {
  console.error(`Error [gen-ppt]: ${err.message}`);
  if (err.hint) console.error(`\nHint: ${err.hint}`);
  process.exit(1);
}

async function generate() {
  // 1. Load and parse config
  const config = loadConfig(configPath);
  const targetViewer = targetOverride || String(config.targetViewer || DEFAULT_TARGET_VIEWER).toLowerCase();
  if (!VALID_TARGET_VIEWERS.has(targetViewer)) {
    throw new Error(`targetViewer "${targetViewer}" is not valid. Use: ${[...VALID_TARGET_VIEWERS].join(", ")}.`);
  }
  assertTargetViewerCompatibility(config, targetViewer);

  // 2. Resolve theme
  const themeName = themeOverride || config.theme || DEFAULT_THEME;
  let theme;
  if (themeName === "none") {
    theme = FALLBACK_THEME;
  } else {
    const raw = resolveTheme(themeName);
    if (!raw) {
      console.warn(`Warning [gen-ppt]: Unknown theme "${themeName}", falling back to "${DEFAULT_THEME}"`);
      theme = toPptxTheme(resolveTheme(DEFAULT_THEME));
    } else {
      theme = toPptxTheme(raw);
    }
  }

  // 3. Apply customTheme overrides
  if (config.customTheme) {
    theme = applyCustomTheme(theme, config.customTheme);
  }

  // 4. Create presentation
  const pres = new pptxgen();

  // Global layout
  pres.layout = config.layout || "LAYOUT_16x9";

  // Metadata
  if (config.title) pres.title = config.title;
  if (config.author) pres.author = config.author;
  if (config.date) pres.subject = config.date;

  // 5. Define slide masters
  defineSlideMasters(pres, theme);

  // 6. Process slides
  const slides = config.slides;
  if (!Array.isArray(slides) || slides.length === 0) {
    throw Object.assign(new Error("config.slides must be a non-empty array"), {
      hint: "Add at least one slide object with a 'layout' field.",
    });
  }

  for (let i = 0; i < slides.length; i++) {
    const slideConfig = slides[i];
    const layout = slideConfig.layout || "content";

    if (!VALID_LAYOUTS.includes(layout)) {
      throw Object.assign(
        new Error(`slide[${i}].layout "${layout}" is not valid.`),
        { hint: `Valid layouts: ${VALID_LAYOUTS.join(", ")}` }
      );
    }

    try {
      renderSlide(pres, slideConfig, theme, layout, i);
    } catch (err) {
      if (err.message.startsWith("slide[")) throw err;
      throw Object.assign(
        new Error(`slide[${i}] (${layout}): ${err.message}`),
        { hint: err.hint }
      );
    }
  }

  // Add branding to last slide
  const logoPath = resolve(SCRIPT_DIR, "logo.png");
  addBranding(pres.slides[pres.slides.length - 1], theme, existsSync(logoPath) ? logoPath : null);

  // 7. Serialize, normalize known PptxGenJS OOXML defects, validate the complete package,
  // then write only the verified result. Never silently fall back to chart images.
  const rawPptx = await pres.write({ outputType: "nodebuffer" });
  const { buffer: verifiedPptx, report } = await normalizeAndValidatePptx(rawPptx);
  writeFileAtomic(outputPath, verifiedPptx);
  const sha256 = createHash("sha256").update(verifiedPptx).digest("hex");
  const themeInfo = theme.name ? ` (theme: ${theme.name})` : "";
  const packageFixCount = report.normalizedContentTypeCount + report.normalizedNotesThemeCount
    + report.normalizedShapeCount + report.normalizedBackgroundCount
    + report.normalizedPresentationCount + report.normalizedBulletSizeCount
    + report.normalizedChartCount + report.normalizedRelationshipCount;
  console.log(`PPTX generated by GenPPT ${GEN_PPT_VERSION}; structural OOXML validation passed: ${resolve(outputPath)}${themeInfo}; target ${targetViewer}; ${report.slideCount} slides, ${report.chartCount} native charts, ${report.relationshipCount} relationships, ${packageFixCount} OOXML fixes; ${verifiedPptx.length} bytes; SHA-256 ${sha256}`);
}

function writeFileAtomic(filePath, data) {
  const absolutePath = resolve(filePath);
  const tempPath = join(dirname(absolutePath), `.${basename(absolutePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, data, { flag: "wx" });
    renameSync(tempPath, absolutePath);
  } finally {
    try { unlinkSync(tempPath); } catch { /* already renamed or never created */ }
  }
}

// ── Config Loading ───────────────────────────────────────────────────────────

function loadConfig(filePath) {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`Config file not found: ${absPath}`);
  }
  const configStat = statSync(absPath);
  if (!configStat.isFile() || configStat.size > MAX_CONFIG_BYTES) {
    throw new Error("Config must be a regular JSON file no larger than 100MB");
  }
  try {
    const raw = readFileSync(absPath, "utf-8");
    const config = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("Config root must be a JSON object");
    }
    return config;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw Object.assign(new Error(`Invalid JSON in config file: ${err.message}`), {
        hint: "Check JSON syntax — common issues: trailing commas, unquoted keys, single quotes.",
      });
    }
    throw err;
  }
}

function nativeChartLocations(config) {
  const locations = [];
  if (!Array.isArray(config.slides)) return locations;
  for (const [slideIndex, slide] of config.slides.entries()) {
    if (slide?.chart && slide.chart.type !== "image") locations.push(`slide[${slideIndex}].chart`);
    if (!Array.isArray(slide?.elements)) continue;
    for (const [elementIndex, element] of slide.elements.entries()) {
      if (element?.type !== "chart") continue;
      const chart = element.content || element;
      if (chart.type !== "image") locations.push(`slide[${slideIndex}].elements[${elementIndex}]`);
    }
  }
  return locations;
}

function assertTargetViewerCompatibility(config, targetViewer) {
  if (targetViewer === "powerpoint") return;
  const locations = nativeChartLocations(config);
  if (!locations.length) return;
  throw Object.assign(
    new Error(`${targetViewer} compatibility mode rejects PptxGenJS native charts because Keynote can import the PPTX while rendering these charts blank (${locations.join(", ")}).`),
    { hint: "Render each chart from the same source data as PNG with gen-chart, replace it with {\"type\":\"image\",\"path\":\"/absolute/path/chart.png\"}, and regenerate with --target=keynote (or --target=universal). Use --target=powerpoint only when editable native Office charts are required and Keynote is not a delivery target." },
  );
}

// ── Custom Theme Merge ──────────────────────────────────────────────────────

function applyCustomTheme(theme, custom) {
  const strip = (c) => c ? (c.startsWith("#") ? c.slice(1) : c) : undefined;
  const merged = { ...theme };
  if (custom.primary) merged.primary = strip(custom.primary);
  if (custom.secondary) merged.secondary = strip(custom.secondary);
  if (custom.accent) merged.accent = strip(custom.accent);
  if (custom.background) merged.background = strip(custom.background);
  if (custom.textColor) merged.textColor = strip(custom.textColor);
  if (custom.subtleText) merged.subtleText = strip(custom.subtleText);
  if (custom.colors) merged.colors = custom.colors.map(strip);
  if (custom.borderColor) merged.borderColor = strip(custom.borderColor);
  // Re-derive table colors if primary changed
  if (custom.primary) {
    merged.tableHeaderBg = merged.primary;
    merged.tableHeaderText = isLight(merged.primary) ? "1E293B" : "FFFFFF";
  }
  return merged;
}

function isLight(hex) {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length < 6) return true;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 >= 0.5;
}

function normalizeShapeType(shape) {
  const requested = SHAPE_ALIASES.get(shape) || shape;
  if (!PPTX_SHAPE_TYPES.has(requested)) {
    throw Object.assign(new Error(`Unsupported shape "${shape}".`), {
      hint: "Use a PptxGenJS ShapeType value such as rect, ellipse, roundRect, line, or rightArrow.",
    });
  }
  return requested;
}

// ── Slide Master Definitions ─────────────────────────────────────────────────

function defineSlideMasters(pres, theme) {
  for (const layout of VALID_LAYOUTS) {
    const isTitleLike = layout === "title" || layout === "closing";
    pres.defineSlideMaster({
      title: `MASTER_${layout.toUpperCase().replace("-", "_")}`,
      background: { color: theme.background },
      objects: isTitleLike ? [] : [
        // Thin bottom decorative line
        { rect: { x: 0.5, y: 5.45, w: 9.0, h: 0.015, fill: { color: theme.decorativeLine } } },
      ],
      slideNumber: {
        x: "90%", y: "93%",
        fontSize: 8,
        color: theme.subtleText,
      },
    });
  }
}

// ── Slide Rendering Dispatcher ───────────────────────────────────────────────

function renderSlide(pres, config, theme, layout, index) {
  const masterName = `MASTER_${layout.toUpperCase().replace("-", "_")}`;
  const slide = pres.addSlide({ masterName });

  // Slide-level background override
  if (config.background) {
    const bg = config.background.startsWith("#") ? config.background.slice(1) : config.background;
    slide.background = { color: bg };
  }

  // Speaker notes
  if (config.notes) {
    slide.addNotes(config.notes);
  }

  // Render layout-specific content
  switch (layout) {
    case "title":      renderTitleLayout(slide, config, theme); break;
    case "section":    renderSectionLayout(slide, config, theme); break;
    case "content":    renderContentLayout(slide, config, theme); break;
    case "two-column": renderTwoColumnLayout(slide, config, theme); break;
    case "image-text": renderImageTextLayout(slide, config, theme); break;
    case "chart":      renderChartLayout(slide, config, theme); break;
    case "table":      renderTableLayout(slide, config, theme); break;
    case "closing":    renderClosingLayout(slide, config, theme); break;
    case "blank":      break; // Only custom elements
  }

  // Render custom elements (any layout)
  if (Array.isArray(config.elements)) {
    renderElements(slide, config.elements, theme);
  }
}

// ── Layout: title ────────────────────────────────────────────────────────────

function renderTitleLayout(slide, config, theme) {
  // Optional logo (top-left)
  if (config.logo) {
    renderImage(slide, config.logo, { x: 0.3, y: 0.3, w: 1.2, h: 0.6 });
  }

  // Title
  if (config.title) {
    addFmtText(slide, config.title, {
      x: 0.8, y: 1.5, w: 8.4, h: 1.0,
      fontSize: 36, fontFace: "Calibri", bold: true,
      color: theme.primary, align: "center", valign: "middle",
    });
  }

  // Decorative line
  slide.addShape("rect", {
    x: 1.5, y: 2.55, w: 7.0, h: 0.025,
    fill: { color: theme.decorativeLine },
  });

  // Subtitle
  if (config.subtitle) {
    addFmtText(slide, config.subtitle, {
      x: 0.8, y: 2.7, w: 8.4, h: 0.6,
      fontSize: 18, fontFace: "Calibri",
      color: theme.subtleText, align: "center", valign: "top",
    });
  }

  // Date and author
  const meta = [config.date, config.author].filter(Boolean).join("  |  ");
  if (meta) {
    slide.addText(meta, {
      x: 0.8, y: 3.5, w: 8.4, h: 0.4,
      fontSize: 12, fontFace: "Calibri",
      color: theme.subtleText, align: "center",
    });
  }
}

// ── Layout: section ──────────────────────────────────────────────────────────

function renderSectionLayout(slide, config, theme) {
  // Section number
  if (config.sectionNumber) {
    slide.addText(config.sectionNumber, {
      x: 0.8, y: 1.2, w: 8.4, h: 0.8,
      fontSize: 48, fontFace: "Calibri", bold: true,
      color: theme.primary, align: "left",
    });
  }

  // Short decorative line
  slide.addShape("rect", {
    x: 0.8, y: 2.05, w: 2.0, h: 0.04,
    fill: { color: theme.decorativeLine },
  });

  // Title
  if (config.title) {
    addFmtText(slide, config.title, {
      x: 0.8, y: 2.2, w: 8.4, h: 0.8,
      fontSize: 32, fontFace: "Calibri", bold: true,
      color: theme.textColor, align: "left",
    });
  }

  // Subtitle
  if (config.subtitle) {
    addFmtText(slide, config.subtitle, {
      x: 0.8, y: 3.2, w: 8.4, h: 0.5,
      fontSize: 14, fontFace: "Calibri",
      color: theme.subtleText, align: "left",
    });
  }
}

// ── Layout: content ──────────────────────────────────────────────────────────

function renderContentLayout(slide, config, theme) {
  renderSlideHeader(slide, config, theme);

  // Bullets or body text
  if (config.bullets && config.bullets.length > 0) {
    renderBullets(slide, config.bullets, {
      x: 0.5, y: 1.2, w: 9.0, h: 3.8,
      fontSize: 16, fontFace: "Calibri",
      color: theme.textColor, valign: "top",
    }, theme);
  } else if (config.body) {
    addFmtText(slide, config.body, {
      x: 0.5, y: 1.2, w: 9.0, h: 3.8,
      fontSize: 16, fontFace: "Calibri",
      color: theme.textColor, valign: "top",
      paraSpaceBefore: 4, paraSpaceAfter: 4,
    });
  }

  renderFootnote(slide, config, theme);
}

// ── Layout: two-column ──────────────────────────────────────────────────────

function renderTwoColumnLayout(slide, config, theme) {
  renderSlideHeader(slide, config, theme);

  // Left column
  if (config.left) {
    renderColumn(slide, config.left, {
      x: 0.5, y: 1.2, w: 4.3, h: 3.8,
    }, theme);
  }

  // Right column
  if (config.right) {
    renderColumn(slide, config.right, {
      x: 5.2, y: 1.2, w: 4.3, h: 3.8,
    }, theme);
  }

  renderFootnote(slide, config, theme);
}

// ── Layout: image-text ──────────────────────────────────────────────────────

function renderImageTextLayout(slide, config, theme) {
  renderSlideHeader(slide, config, theme);

  // Four arrangements via image.position: "left" (default) = image left / text
  // right; "right" = text left / image right; "top" = image top / text bottom;
  // "bottom" = text top / image bottom.
  const position = config.image?.position || "left";
  let imgPos, txtPos, txtFontSize;

  if (position === "top" || position === "bottom") {
    // Vertical split: image gets the larger band, text the remainder
    const imgBand = { x: 0.5, w: 9.0, h: 2.3 };
    const txtBand = { x: 0.5, w: 9.0, h: 1.4 };
    if (position === "top") {
      imgPos = { ...imgBand, y: 1.2 };
      txtPos = { ...txtBand, y: 3.6 };
    } else {
      txtPos = { ...txtBand, y: 1.2 };
      imgPos = { ...imgBand, y: 2.7 };
    }
    txtFontSize = 14;
  } else {
    // Horizontal split (original behavior)
    const imgRight = position === "right";
    imgPos = { x: imgRight ? 5.2 : 0.5, y: 1.2, w: imgRight ? 4.3 : 4.7, h: 3.8 };
    txtPos = { x: imgRight ? 0.5 : 5.5, y: 1.2, w: imgRight ? 4.4 : 3.7, h: 3.8 };
    txtFontSize = 14;
  }

  // Image
  if (config.image) {
    renderImage(slide, config.image, imgPos);
  }

  // Text (bullets or body)
  if (config.bullets && config.bullets.length > 0) {
    renderBullets(slide, config.bullets, {
      ...txtPos,
      fontSize: txtFontSize, fontFace: "Calibri",
      color: theme.textColor, valign: "top",
    }, theme);
  } else if (config.body) {
    addFmtText(slide, config.body, {
      ...txtPos,
      fontSize: txtFontSize, fontFace: "Calibri",
      color: theme.textColor, valign: "top",
    });
  }

  renderFootnote(slide, config, theme);
}

// ── Layout: chart ────────────────────────────────────────────────────────────

function renderChartLayout(slide, config, theme) {
  // Title
  if (config.title) {
    addFmtText(slide, config.title, {
      x: 0.5, y: 0.3, w: 9.0, h: 0.5,
      fontSize: 24, fontFace: "Calibri", bold: true,
      color: theme.primary, align: "left",
    });
  }

  // Subtitle
  if (config.subtitle) {
    addFmtText(slide, config.subtitle, {
      x: 0.5, y: 0.85, w: 9.0, h: 0.3,
      fontSize: 12, fontFace: "Calibri",
      color: theme.subtleText, align: "left",
    });
  }

  // Chart
  if (config.chart) {
    renderChart(slide, config.chart, {
      x: 0.5, y: 1.2, w: 9.0, h: 3.8,
    }, theme);
  }

  renderFootnote(slide, config, theme);
}

// ── Layout: table ────────────────────────────────────────────────────────────

function renderTableLayout(slide, config, theme) {
  // Title
  if (config.title) {
    addFmtText(slide, config.title, {
      x: 0.5, y: 0.3, w: 9.0, h: 0.5,
      fontSize: 24, fontFace: "Calibri", bold: true,
      color: theme.primary, align: "left",
    });
  }

  // Subtitle
  if (config.subtitle) {
    addFmtText(slide, config.subtitle, {
      x: 0.5, y: 0.85, w: 9.0, h: 0.3,
      fontSize: 12, fontFace: "Calibri",
      color: theme.subtleText, align: "left",
    });
  }

  // Table
  if (config.table) {
    renderTable(slide, config.table, {
      x: 0.5, y: 1.2, w: 9.0, h: 3.8,
    }, theme);
  }

  renderFootnote(slide, config, theme);
}

// ── Layout: closing ──────────────────────────────────────────────────────────

function renderClosingLayout(slide, config, theme) {
  // Title
  if (config.title) {
    addFmtText(slide, config.title, {
      x: 0.8, y: 1.8, w: 8.4, h: 0.8,
      fontSize: 36, fontFace: "Calibri", bold: true,
      color: theme.primary, align: "center", valign: "middle",
    });
  }

  // Subtitle
  if (config.subtitle) {
    addFmtText(slide, config.subtitle, {
      x: 0.8, y: 2.8, w: 8.4, h: 0.5,
      fontSize: 14, fontFace: "Calibri",
      color: theme.subtleText, align: "center",
    });
  }

  // Logo
  if (config.logo) {
    renderImage(slide, config.logo, { x: 4.0, y: 3.6, w: 2.0, h: 1.0 });
  }
}

// ── Inline Formatting (simple Markdown + HTML tags) ────────────────────────

/**
 * Parse simple inline Markdown (**bold**, *italic*, ~~strike~~, `code`) and
 * HTML tags (<b>/<strong>, <i>/<em>, <u>, <s>/<del>/<strike>, <sub>, <sup>,
 * <br>, <center>) into PptxGenJS text runs.
 * Underscore emphasis (_x_/__x__) is intentionally NOT supported to avoid
 * false positives on snake_case identifiers. Unpaired Markdown toggles are
 * kept as literal text.
 * Returns { runs, blockOpts }: runs is a plain string when no markup is
 * present, otherwise an array of { text, options }; blockOpts carries
 * paragraph-level options (e.g. align from <center>).
 */
function parseFormattedText(text) {
  const str = String(text ?? "");
  const blockOpts = {};
  if (!/[*~`<]/.test(str)) return { runs: str, blockOpts };

  let t = str;
  // <center> is paragraph-level: strip tags, set alignment
  if (/<center\s*>/i.test(t)) {
    blockOpts.align = "center";
    t = t.replace(/<\/?center\s*>/gi, "");
  }

  const parts = t.split(INLINE_TOKEN_RE).filter((p) => p !== undefined && p !== "");
  // Unpaired Markdown toggles are literal (e.g. "5 * 3" stays as-is)
  const counts = { "**": 0, "*": 0, "~~": 0, "`": 0 };
  for (const p of parts) if (p in counts) counts[p]++;
  const literal = new Set(Object.keys(counts).filter((k) => counts[k] % 2 === 1));

  const state = { bold: false, italic: false, underline: false, strike: false, code: false, sub: false, sup: false };
  const optsOf = () => {
    const o = {};
    if (state.bold) o.bold = true;
    if (state.italic) o.italic = true;
    if (state.underline) o.underline = true;
    if (state.strike) o.strike = true;
    if (state.code) o.fontFace = "Courier New";
    if (state.sub) o.subscript = true;
    if (state.sup) o.superscript = true;
    return o;
  };

  const runs = [];
  let buf = "";
  let bufOpts = optsOf();
  const flush = () => {
    if (buf) { runs.push({ text: buf, options: { ...bufOpts } }); buf = ""; }
  };
  const toggle = (key) => { flush(); state[key] = !state[key]; bufOpts = optsOf(); };
  const setState = (key, on) => { flush(); state[key] = on; bufOpts = optsOf(); };

  for (const part of parts) {
    if (part === "**" && !literal.has("**")) { toggle("bold"); continue; }
    if (part === "*" && !literal.has("*")) { toggle("italic"); continue; }
    if (part === "~~" && !literal.has("~~")) { toggle("strike"); continue; }
    if (part === "`" && !literal.has("`")) { toggle("code"); continue; }
    if (/^<br\s*\/?\s*>$/i.test(part)) {
      flush();
      if (runs.length > 0) runs[runs.length - 1].options.breakLine = true;
      else runs.push({ text: "", options: { breakLine: true } });
      continue;
    }
    const m = part.match(/^<(\/?)([a-zA-Z]+)\s*>$/);
    if (m && HTML_STATE[m[2].toLowerCase()]) { setState(HTML_STATE[m[2].toLowerCase()], m[1] !== "/"); continue; }
    buf += part;
  }
  flush();

  if (runs.length === 0) return { runs: "", blockOpts };
  // No effective inline markup → keep plain-string behavior
  if (runs.length === 1 && Object.keys(runs[0].options).length === 0) {
    return { runs: runs[0].text, blockOpts };
  }
  return { runs, blockOpts };
}

/** addText with inline Markdown/HTML formatting support. */
function addFmtText(slide, text, opts) {
  const { runs, blockOpts } = parseFormattedText(text);
  slide.addText(runs, { ...opts, ...blockOpts });
}

/** Format a table cell value → string or text-run array. */
function fmtCellText(text) {
  return parseFormattedText(text).runs;
}

// ── Shared Rendering Helpers ─────────────────────────────────────────────────

/** Render slide title + decorative line (used by content, two-column, image-text). */
function renderSlideHeader(slide, config, theme) {
  if (config.title) {
    addFmtText(slide, config.title, {
      x: 0.5, y: 0.3, w: 9.0, h: 0.6,
      fontSize: 24, fontFace: "Calibri", bold: true,
      color: theme.primary, align: "left",
    });
  }
  // Decorative line under title
  slide.addShape("rect", {
    x: 0.5, y: 0.95, w: 9.0, h: 0.02,
    fill: { color: theme.decorativeLine },
  });
}

/** Render footnote at bottom of slide. */
function renderFootnote(slide, config, theme) {
  if (config.footnote) {
    addFmtText(slide, config.footnote, {
      x: 0.5, y: 5.1, w: 9.0, h: 0.3,
      fontSize: 9, fontFace: "Calibri", italic: true,
      color: theme.subtleText, align: "left",
    });
  }
}

/** Render a column with optional title and bullets/body. */
function renderColumn(slide, col, pos, theme) {
  let yOff = pos.y;
  let hRemain = pos.h;

  if (col.title) {
    addFmtText(slide, col.title, {
      x: pos.x, y: yOff, w: pos.w, h: 0.4,
      fontSize: 16, fontFace: "Calibri", bold: true,
      color: theme.primary, align: "left", valign: "top",
    });
    yOff += 0.45;
    hRemain -= 0.45;
  }

  if (col.bullets && col.bullets.length > 0) {
    renderBullets(slide, col.bullets, {
      x: pos.x, y: yOff, w: pos.w, h: hRemain,
      fontSize: 14, fontFace: "Calibri",
      color: theme.textColor, valign: "top",
    }, theme);
  } else if (col.body) {
    addFmtText(slide, col.body, {
      x: pos.x, y: yOff, w: pos.w, h: hRemain,
      fontSize: 14, fontFace: "Calibri",
      color: theme.textColor, valign: "top",
    });
  }
}

/** Render bullets array to slide. Supports string and { text, level, bold, color } items. */
function renderBullets(slide, bullets, pos, theme) {
  const textItems = [];
  for (const bullet of bullets) {
    const item = typeof bullet === "string" ? { text: bullet, level: 0 } : bullet;
    const fontSize = [16, 14, 12][item.level] || 12;
    const baseOpts = {
      fontSize,
      fontFace: "Calibri",
      bold: item.bold || false,
      italic: item.italic || false,
      color: item.color
        ? (item.color.startsWith("#") ? item.color.slice(1) : item.color)
        : theme.textColor,
      paraSpaceBefore: 6,
      paraSpaceAfter: 3,
    };
    const bulletOpts = { indentLevel: item.level || 0, bullet: true };
    const { runs } = parseFormattedText(item.text);
    if (typeof runs === "string") {
      textItems.push({ text: runs, options: { ...baseOpts, ...bulletOpts } });
    } else {
      // Inline-formatted bullet: first run opens the bulleted paragraph,
      // subsequent runs continue on the same line
      runs.forEach((r, i) => {
        textItems.push({
          text: r.text,
          options: { ...baseOpts, ...r.options, ...(i === 0 ? bulletOpts : {}) },
        });
      });
    }
  }
  slide.addText(textItems, pos);
}

/** Parse intrinsic pixel size from PNG/JPEG/GIF/BMP header bytes (no deps). */
function getImageSizePx(buf) {
  // PNG: IHDR width/height at fixed offsets
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: scan for SOFn marker
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  // GIF: logical screen size (little-endian)
  if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // BMP: DIB header (little-endian)
  if (buf.length > 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
  }
  return null;
}

/** Scale image to fit inside the slot preserving aspect ratio, centered. */
function fitImageIntoSlot(px, pos) {
  if (!px || !px.w || !px.h) return pos;
  const imgRatio = px.w / px.h;
  const slotRatio = pos.w / pos.h;
  let w, h;
  if (imgRatio >= slotRatio) {
    w = pos.w;
    h = pos.w / imgRatio;
  } else {
    h = pos.h;
    w = pos.h * imgRatio;
  }
  return {
    x: pos.x + (pos.w - w) / 2,
    y: pos.y + (pos.h - h) / 2,
    w: Math.round(w * 100) / 100,
    h: Math.round(h * 100) / 100,
  };
}

/** Render an image slot (path or base64 data). */
function renderImage(slide, image, pos) {
  if (!image) return;
  let imagePath = image.path;
  // SVG embedding produces a tiny PNG fallback in PptxGenJS that renders blank
  // in most viewers (WPS/older Office/Preview). Prefer a same-name PNG if present.
  if (imagePath && /\.svg$/i.test(imagePath)) {
    const pngPath = imagePath.replace(/\.svg$/i, ".png");
    if (existsSync(pngPath)) {
      console.warn(`Warning [gen-ppt]: SVG replaced with PNG for compatibility: ${pngPath}`);
      imagePath = pngPath;
    } else {
      console.warn(`Warning [gen-ppt]: SVG images render blank in many PPT viewers, use PNG instead: ${imagePath}`);
    }
  }
  const opts = {};
  let sizePx = null;
  if (imagePath) {
    if (!existsSync(imagePath)) {
      console.warn(`Warning [gen-ppt]: Image not found: ${imagePath}`);
      // Render placeholder rectangle
      slide.addShape("roundRect", {
        ...pos,
        fill: { color: "E2E8F0" },
        line: { color: "CBD5E1", width: 1, dashType: "dash" },
      });
      slide.addText(`[Image not found]`, {
        ...pos,
        fontSize: 10, color: "94A3B8", align: "center", valign: "middle",
      });
      return;
    }
    const imageStat = statSync(imagePath);
    if (!imageStat.isFile() || imageStat.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image must be a regular file no larger than 50MB: ${imagePath}`);
    }
    opts.path = imagePath;
    try {
      sizePx = getImageSizePx(readFileSync(imagePath));
    } catch { /* fall back to slot size */ }
  } else if (image.data) {
    opts.data = image.data;
    const b64 = String(image.data).replace(/^data:[^,]*,/, "").replace(/\s/g, "");
    const maximumEncodedLength = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
    if (!b64 || b64.length > maximumEncodedLength
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) {
      throw new Error("Image data must be valid base64 encoding no more than 50MB");
    }
    const imageBuffer = Buffer.from(b64, "base64");
    if (imageBuffer.length > MAX_IMAGE_BYTES) {
      throw new Error("Image data must decode to no more than 50MB");
    }
    sizePx = getImageSizePx(imageBuffer);
  } else {
    return; // No image source
  }
  // Preserve aspect ratio: scale to fit inside the slot, centered
  Object.assign(opts, fitImageIntoSlot(sizePx, pos));
  if (image.alt) opts.altText = image.alt;
  slide.addImage(opts);
}

/** Render a chart slot. */
function renderChart(slide, chart, pos, theme) {
  // Pre-rendered chart image (e.g. produced by the gen-chart skill):
  // { "type": "image", "path": "chart.png" } → delegate to image rendering.
  if (chart.type === "image" && (chart.path || chart.data)) {
    renderImage(slide, chart, pos);
    return;
  }
  if (chart.type === "image") {
    throw new Error("Static image chart requires 'path' or base64 'data'.");
  }

  if (!chart.type || !Array.isArray(chart.data) || chart.data.length === 0) {
    throw new Error("Native chart requires a supported 'type' and a non-empty 'data' array.");
  }

  // Map JSON chart type to PptxGenJS ChartType
  const chartTypeMap = {
    bar: "bar", line: "line", pie: "pie", doughnut: "doughnut",
    area: "area", scatter: "scatter", radar: "radar",
  };
  const chartType = chartTypeMap[chart.type];
  if (!chartType) {
    throw new Error(`Unsupported native chart type "${chart.type}". Supported types: ${Object.keys(chartTypeMap).join(", ")}.`);
  }

  // Build chart data in PptxGenJS format. Scatter charts require a dedicated
  // X-axis series followed by one or more Y series; treating them like a
  // category chart produces valid-looking OOXML with no visible points.
  const data = buildNativeChartData(chart);

  // Merge theme defaults with user options
  const chartOpts = {
    ...pos,
    chartColors: theme.colors,
    showLegend: true,
    legendPos: "b",
    legendFontSize: 10,
    legendColor: theme.textColor,
    titleColor: theme.textColor,
    catAxisLabelColor: theme.textColor,
    valAxisLabelColor: theme.textColor,
    catAxisLineColor: theme.borderColor,
    valAxisLineColor: theme.borderColor,
    showTitle: !!chart.title,
    title: chart.title || "",
    ...(chart.options || {}),
  };

  slide.addChart(chartType, data, chartOpts);
}

function buildNativeChartData(chart) {
  if (chart.type !== "scatter") {
    for (const [index, series] of chart.data.entries()) {
      if (!Array.isArray(series.labels) || !Array.isArray(series.values) || series.values.length === 0) {
        throw new Error(`Chart series[${index}] requires non-empty labels and values arrays.`);
      }
      if (series.labels.length !== series.values.length) {
        throw new Error(`Chart series[${index}] labels and values must have equal length.`);
      }
      if (!series.values.every(Number.isFinite)) {
        throw new Error(`Chart series[${index}] values must contain only finite numbers.`);
      }
      if ((chart.type === "pie" || chart.type === "doughnut") && series.values.some(value => value < 0)) {
        throw new Error(`${chart.type} charts do not support negative values.`);
      }
    }
    return chart.data.map(series => ({
      name: series.name || "",
      labels: series.labels || [],
      values: series.values || [],
    }));
  }

  const xySeries = chart.data.filter(series => Array.isArray(series.xValues) || Array.isArray(series.yValues));
  if (xySeries.length > 0) {
    if (xySeries.length !== chart.data.length) {
      throw new Error("Scatter chart must use xValues/yValues for every series; do not mix scatter data formats.");
    }
    const xValues = xySeries[0].xValues;
    if (!Array.isArray(xValues) || xValues.length === 0) {
      throw new Error("Scatter chart requires a non-empty xValues array.");
    }
    for (const [index, series] of xySeries.entries()) {
      if (!Array.isArray(series.xValues) || !Array.isArray(series.yValues)) {
        throw new Error(`Scatter series[${index}] requires both xValues and yValues.`);
      }
      if (series.xValues.length !== series.yValues.length) {
        throw new Error(`Scatter series[${index}] xValues and yValues must have equal length.`);
      }
      if (![...series.xValues, ...series.yValues].every(Number.isFinite)) {
        throw new Error(`Scatter series[${index}] xValues and yValues must contain only finite numbers.`);
      }
      if (series.xValues.length !== xValues.length || series.xValues.some((value, point) => value !== xValues[point])) {
        throw new Error("PptxGenJS native scatter charts require every series to share the same xValues.");
      }
    }
    return [
      { name: "X Axis", values: xValues },
      ...xySeries.map(series => ({ name: series.name || "", labels: series.labels || [], values: series.yValues })),
    ];
  }

  // Also accept PptxGenJS's native form: first entry is X values, remaining
  // entries are Y series. Require at least one Y series to prevent blank charts.
  if (chart.data.length < 2 || !chart.data.every(series => Array.isArray(series.values))) {
    throw new Error("Scatter chart requires [{name, xValues, yValues}, ...] or an X-axis values series followed by at least one Y values series.");
  }
  const pointCount = chart.data[0].values.length;
  if (pointCount === 0 || chart.data.slice(1).some(series => series.values.length !== pointCount)) {
    throw new Error("Scatter X and Y series must be non-empty and have equal lengths.");
  }
  if (!chart.data.every(series => series.values.every(Number.isFinite))) {
    throw new Error("Scatter X and Y series must contain only finite numbers.");
  }
  return chart.data.map(series => ({ name: series.name || "", labels: series.labels || [], values: series.values }));
}

function assertFiniteOptionTree(value, context) {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${context} must not contain NaN or Infinity.`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteOptionTree(item, `${context}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertFiniteOptionTree(item, `${context}.${key}`);
  }
}

function assertValidMargin(margin, context) {
  if (margin === undefined) return;
  const values = Array.isArray(margin) ? margin : [margin];
  if (![1, 4].includes(values.length) || values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new Error(`${context} must be a non-negative finite number or [top, right, bottom, left].`);
  }
}

function assertPositiveNumberOrArray(value, context) {
  if (value === undefined) return;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some((item) => typeof item !== "number" || !Number.isFinite(item) || item <= 0)) {
    throw new Error(`${context} must be a positive finite number or a non-empty array of positive finite numbers.`);
  }
}

/** Render a table slot. */
function renderTable(slide, table, pos, theme) {
  if (!table.headers && !table.head && !table.rows) {
    console.warn("Warning [gen-ppt]: Table missing 'headers' or 'rows', skipping.");
    return;
  }

  // Accept "head" as an alias of "headers" (common LLM output variant)
  const headers = table.headers || table.head || [];
  const rows = table.rows || [];

  // Build header row with theme styling
  const headerRow = headers.map(h => ({
    text: fmtCellText(h),
    options: {
      bold: true,
      color: theme.tableHeaderText,
      fill: { color: theme.tableHeaderBg },
      fontSize: 12,
      fontFace: "Calibri",
      align: "center",
      valign: "middle",
    },
  }));

  // Build data rows with alternating colors
  const dataRows = rows.map((row, idx) =>
    row.map(cell => {
      if (cell && typeof cell === "object" && Object.hasOwn(cell, "text")) {
        assertValidMargin(cell.options?.margin, `table.rows[${idx}].cell.options.margin`);
        assertFiniteOptionTree(cell.options || {}, `table.rows[${idx}].cell.options`);
        return { text: fmtCellText(cell.text), options: { ...cell.options } };
      }
      return {
        text: fmtCellText(cell),
        options: {
          fontSize: 11,
          fontFace: "Calibri",
          color: theme.textColor,
          fill: { color: idx % 2 === 0 ? theme.background : theme.tableAltRow },
          valign: "middle",
        },
      };
    })
  );

  const tableData = headerRow.length > 0 ? [headerRow, ...dataRows] : dataRows;

  // Merge table options
  const tableOpts = {
    ...pos,
    border: { type: "solid", pt: 0.5, color: theme.borderColor },
    colW: table.colW || undefined,
    rowH: table.rowH || undefined,
    autoPage: table.autoPage !== false,
    ...(table.options || {}),
  };

  assertValidMargin(tableOpts.margin, "table.options.margin");
  assertPositiveNumberOrArray(tableOpts.colW, "table.options.colW");
  assertPositiveNumberOrArray(tableOpts.rowH, "table.options.rowH");
  assertFiniteOptionTree(tableOpts, "table.options");

  slide.addTable(tableData, tableOpts);
}

// ── Custom Elements Rendering ────────────────────────────────────────────────

function renderElements(slide, elements, theme) {
  for (const el of elements) {
    if (!el.type) {
      console.warn("Warning [gen-ppt]: Element missing 'type', skipping.");
      continue;
    }

    const pos = {
      x: el.x || 0, y: el.y || 0,
      w: el.w || 1, h: el.h || 1,
    };

    switch (el.type) {
      case "text":
        addFmtText(slide, el.content || "", {
          ...pos,
          fontSize: 12, fontFace: "Calibri",
          color: theme.textColor,
          ...(el.options || {}),
        });
        break;

      case "image":
        renderImage(slide, el.content || el, pos);
        break;

      case "shape":
        slide.addShape(normalizeShapeType(el.shape || "rect"), {
          ...pos,
          ...(el.options || {}),
        });
        break;

      case "chart":
        renderChart(slide, el.content || el, pos, theme);
        break;

      case "table":
        renderTable(slide, el.content || el, pos, theme);
        break;

      default:
        console.warn(`Warning [gen-ppt]: Unknown element type "${el.type}", skipping.`);
    }
  }
}

// ── Branding Footer ─────────────────────────────────────────────────────────

/** Add "Powered by: HogAgent (ciweiai.com)" footer to the last slide. */
function addBranding(slide, theme, logoPath) {
  if (logoPath) {
    slide.addImage({
      path: logoPath,
      x: 4.84, y: 4.78, w: 0.33, h: 0.33,
    });
  }
  slide.addText("Powered by: HogAgent (ciweiai.com)", {
    x: 2.5, y: 5.12, w: 5.0, h: 0.3,
    fontSize: 9, fontFace: "Calibri",
    color: theme.subtleText, align: "center",
  });
}
