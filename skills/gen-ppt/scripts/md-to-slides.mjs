#!/usr/bin/env node
/**
 * Markdown to HTML Slides Converter
 * Usage: node md-to-slides.mjs <input.md> <output.html> [--theme=<name>] [--title="Title"]
 *
 * Generates a self-contained HTML presentation with:
 * - All CSS/JS inlined
 * - All images (local + URL) embedded as base64 data URIs
 * - Live ECharts rendering via ```echarts fenced blocks (option JSON)
 * - Keyboard/touch/button navigation, overview mode, progress bar
 * - 10 financial color themes matching gen-chart
 *
 * NOTE: This script is part of the gen-ppt skill (Mode B: HTML Web Slides).
 *       Use gen-ppt.mjs for native .pptx output (default mode).
 */

import { readFileSync, writeFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, join, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import hljs from "highlight.js";
import { parseMarkdownSlidesArgs } from "./cli-args.mjs";

// ─── Theme Definitions (matching gen-chart) ──────────────────────────────────

const THEMES = {
  fintech:     { bg: "#F8FAFC", fg: "#1E293B", heading: "#0F172A", accent: "#1D4ED8", muted: "#64748B", codeBg: "#EFF6FF", codeFg: "#1E293B", border: "#DBEAFE", stripe: "#F0F9FF", shadow: "rgba(29,78,216,0.08)", dark: false },
  oldmoney:    { bg: "#FFFFFF", fg: "#1C1917", heading: "#0A2540", accent: "#B4975A", muted: "#78716C", codeBg: "#FAFAF9", codeFg: "#1C1917", border: "#E7E5E4", stripe: "#FAFAF9", shadow: "rgba(10,37,64,0.06)", dark: false },
  bloomberg:   { bg: "#09090B", fg: "#E4E4E7", heading: "#F4F4F5", accent: "#10B981", muted: "#71717A", codeBg: "#18181B", codeFg: "#E4E4E7", border: "#27272A", stripe: "#18181B", shadow: "rgba(0,0,0,0.4)", dark: true },
  economist:   { bg: "#F6F4F0", fg: "#292524", heading: "#0F2B5B", accent: "#D73027", muted: "#78716C", codeBg: "#EDE9E3", codeFg: "#292524", border: "#D6D3D1", stripe: "#EDE9E3", shadow: "rgba(15,43,91,0.06)", dark: false },
  saas:        { bg: "#FFFFFF", fg: "#1E293B", heading: "#0F172A", accent: "#635BFF", muted: "#64748B", codeBg: "#F5F3FF", codeFg: "#1E293B", border: "#E0E7FF", stripe: "#F5F3FF", shadow: "rgba(99,91,255,0.08)", dark: false },
  mist:        { bg: "#F1F5F9", fg: "#334155", heading: "#1E293B", accent: "#64748B", muted: "#94A3B8", codeBg: "#E2E8F0", codeFg: "#334155", border: "#CBD5E1", stripe: "#E2E8F0", shadow: "rgba(100,116,139,0.06)", dark: false },
  twilight:    { bg: "#F5F3F7", fg: "#44403C", heading: "#292524", accent: "#776B87", muted: "#A8A29E", codeBg: "#EDE9F0", codeFg: "#44403C", border: "#D6D3D1", stripe: "#EDE9F0", shadow: "rgba(119,107,135,0.06)", dark: false },
  parchment:   { bg: "#F5F2EB", fg: "#44403C", heading: "#292524", accent: "#947E70", muted: "#A8A29E", codeBg: "#EBE7DF", codeFg: "#44403C", border: "#D6D3D1", stripe: "#EBE7DF", shadow: "rgba(148,126,112,0.06)", dark: false },
  azure:       { bg: "#EAF2F8", fg: "#1E3A5F", heading: "#0C2D48", accent: "#5E7B9E", muted: "#6B7280", codeBg: "#D6E6F2", codeFg: "#1E3A5F", border: "#B6D4E8", stripe: "#D6E6F2", shadow: "rgba(94,123,158,0.08)", dark: false },
  gravel:      { bg: "#F0EFEA", fg: "#44403C", heading: "#1C1917", accent: "#73716D", muted: "#A8A29E", codeBg: "#E7E5E0", codeFg: "#44403C", border: "#D6D3D1", stripe: "#E7E5E0", shadow: "rgba(115,113,109,0.06)", dark: false },
};

const THEME_NAMES = Object.keys(THEMES);
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 30_000;

async function readImageResponse(response) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("image exceeds 50MB");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("image exceeds 50MB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// ─── CLI Args ────────────────────────────────────────────────────────────────

let parsedArgs;
try {
  parsedArgs = parseMarkdownSlidesArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
const [inputPath, outputPath] = parsedArgs.positionals;
const theme = parsedArgs.options.theme || "fintech";
const customTitle = parsedArgs.options.title || null;

if (theme === "list") {
  if (parsedArgs.positionals.length > 0 || Object.keys(parsedArgs.options).length !== 1) {
    console.error("Error: --theme=list cannot be combined with input, output, or other options");
    process.exit(1);
  }
  console.log("Available themes:");
  for (const [key, t] of Object.entries(THEMES)) {
    const label = key === "fintech" ? " (default)" : "";
    console.log(`  ${key.padEnd(12)} — ${t.bg === "#09090B" ? "🌙" : "☀️"}  bg:${t.bg} accent:${t.accent}${label}`);
  }
  process.exit(0);
}

if (parsedArgs.help || !inputPath || !outputPath) {
  console.error('Usage: md-to-slides.mjs <input.md> <output.html> [--theme <name>] [--title "Title"]');
  process.exit(parsedArgs.help ? 0 : 1);
}
if (resolve(inputPath) === resolve(outputPath)) {
  console.error("Error: input and output paths must be different");
  process.exit(1);
}
if (!outputPath.toLowerCase().endsWith(".html")) {
  console.error("Error: output file must use a .html extension");
  process.exit(1);
}
if (!existsSync(inputPath)) {
  console.error(`Error: input file not found: ${inputPath}`);
  process.exit(1);
}
const inputStat = statSync(inputPath);
if (!inputStat.isFile() || inputStat.size > MAX_INPUT_BYTES) {
  console.error("Error: input must be a regular Markdown file no larger than 100MB");
  process.exit(1);
}

if (!THEMES[theme]) {
  console.error(`Unknown theme: ${theme}. Available: ${THEME_NAMES.join(", ")}\nUse --theme=list to preview all themes.`);
  process.exit(1);
}

// ─── Read & Split ────────────────────────────────────────────────────────────

const inputDir = dirname(inputPath);
const raw = readFileSync(inputPath, "utf-8");

// Strip optional YAML frontmatter at the top
let content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

// Split by horizontal rule: --- on its own line (with or without blank lines around it)
const slides = content
  .split(/\r?\n[ \t]*---[ \t]*\r?\n/)
  .map(s => s.trim())
  .filter(Boolean);

if (slides.length === 0) {
  console.error("No slides found in input file");
  process.exit(1);
}

// ─── Configure marked ────────────────────────────────────────────────────────

marked.setOptions({
  gfm: true,
  breaks: false,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
});

// ─── Image Embedding ─────────────────────────────────────────────────────────

const MIME_MAP = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif",
};

function getMimeFromExt(filePath) {
  return MIME_MAP[extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function embedImage(src) {
  try {
    if (src.startsWith("data:")) return src;

    if (src.startsWith("http://") || src.startsWith("https://")) {
      const sourceUrl = new URL(src);
      if (sourceUrl.username || sourceUrl.password) throw new Error("image URL must not contain embedded credentials");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(sourceUrl, { signal: controller.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const finalUrl = new URL(resp.url);
        if (!["http:", "https:"].includes(finalUrl.protocol) || finalUrl.username || finalUrl.password) {
          throw new Error("redirected image URL is not a safe HTTP(S) URL");
        }
        const ct = (resp.headers.get("content-type") || "").split(";")[0].trim();
        if (ct && !ct.startsWith("image/")) throw new Error(`unexpected content type ${ct}`);
        const declaredLength = Number(resp.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) throw new Error("image exceeds 50MB");
        const buffer = await readImageResponse(resp);
        return `data:${ct || "image/png"};base64,${buffer.toString("base64")}`;
      } finally {
        clearTimeout(timeout);
      }
    }

    const localPath = resolve(inputDir, src);
    if (!existsSync(localPath)) throw new Error(`image not found: ${localPath}`);
    const imageStat = statSync(localPath);
    if (!imageStat.isFile() || imageStat.size > MAX_IMAGE_BYTES) throw new Error("local image must be a regular file no larger than 50MB");
    const buffer = readFileSync(localPath);
    return `data:${getMimeFromExt(localPath)};base64,${buffer.toString("base64")}`;
  } catch (err) {
    throw new Error(`Failed to embed image: ${src} (${err.message})`);
  }
}

// ─── ECharts Blocks ──────────────────────────────────────────────────────────
// ```echarts fenced blocks carry an ECharts option JSON (or {chart, option} from
// gen-chart echarts-config.mjs). They are replaced by placeholder divs and
// rendered live in the browser via the ECharts runtime.

const echartsOptions = [];

/**
 * Fix common ECharts layout issues where title/legend overlap with chart area.
 * LLMs frequently set legend.top too small or grid.top too tight.
 */
function fixEchartsLayout(opt) {
  if (!opt || typeof opt !== "object") return opt;
  const hasTitle = opt.title && (opt.title.text || opt.title.subtext);
  const hasLegend = opt.legend && opt.legend.data && opt.legend.data.length > 0;

  if (hasTitle && hasLegend) {
    // Title ~25px + legend ~25px → legend starts at 30, grid needs ≥70px headroom
    if (opt.legend.top == null || Number(opt.legend.top) < 30) {
      opt.legend.top = 30;
    }
    const grids = Array.isArray(opt.grid) ? opt.grid : (opt.grid ? [opt.grid] : []);
    if (grids.length > 0) {
      const g = grids[0];
      const cur = parseFloat(g.top);
      if (isNaN(cur) || cur < 18) {
        g.top = "70";
      } else if (typeof g.top === "string" && g.top.endsWith("%") && cur < 22) {
        g.top = "22%";
      }
    } else if (!opt.grid) {
      opt.grid = { left: "10%", right: "5%", top: 70, bottom: "12%" };
    }
  } else if (hasTitle && !hasLegend) {
    // Title only → grid needs ≥45px headroom
    const grids = Array.isArray(opt.grid) ? opt.grid : (opt.grid ? [opt.grid] : []);
    if (grids.length > 0) {
      const g = grids[0];
      const cur = parseFloat(g.top);
      if (isNaN(cur) || cur < 12) {
        g.top = "45";
      } else if (typeof g.top === "string" && g.top.endsWith("%") && cur < 12) {
        g.top = "12%";
      }
    }
  }
  return opt;
}

function extractEchartsBlocks(markdown) {
  return markdown.replace(/```echarts[^\n]*\n([\s\S]*?)\n```/g, (match, body) => {
    try {
      const parsed = JSON.parse(body);
      const option = parsed && typeof parsed === "object" && parsed.option ? parsed.option : parsed;
      fixEchartsLayout(option);
      const idx = echartsOptions.length;
      echartsOptions.push(option);
      return `\n<div class="echarts-box" data-ec-idx="${idx}"></div>\n`;
    } catch (err) {
      console.error(`Warning: invalid ECharts option JSON in \`\`\`echarts block (${err.message}); rendered as code`);
      return match;
    }
  });
}

// ─── Render Slides ───────────────────────────────────────────────────────────

async function renderSlides() {
  const out = [];
  for (const slide of slides) {
    let html = marked.parse(extractEchartsBlocks(slide));
    const imgRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
    for (const m of [...html.matchAll(imgRegex)]) {
      const embedded = await embedImage(m[1]);
      html = html.replace(m[0], m[0].replace(m[1], embedded));
    }
    out.push(html);
  }
  return out;
}

// ─── Build CSS from theme ────────────────────────────────────────────────────

function buildCSS() {
  const t = THEMES[theme];
  const darkHljs = t.dark ? `
[data-theme="${theme}"] .hljs-keyword,[data-theme="${theme}"] .hljs-selector-tag,[data-theme="${theme}"] .hljs-type{color:#ff7b72}
[data-theme="${theme}"] .hljs-literal,[data-theme="${theme}"] .hljs-number{color:#79c0ff}
[data-theme="${theme}"] .hljs-string,[data-theme="${theme}"] .hljs-doctag{color:#a5d6ff}
[data-theme="${theme}"] .hljs-title,[data-theme="${theme}"] .hljs-section{color:#d2a8ff}
[data-theme="${theme}"] .hljs-variable{color:#ffa657}
[data-theme="${theme}"] .hljs-built_in{color:#79c0ff}
[data-theme="${theme}"] .hljs-meta{color:#e3b341}` : "";

  return `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: ${t.bg}; --fg: ${t.fg}; --heading: ${t.heading}; --accent: ${t.accent};
  --muted: ${t.muted}; --code-bg: ${t.codeBg}; --code-fg: ${t.codeFg};
  --border: ${t.border}; --table-stripe: ${t.stripe};
  --slide-shadow: 0 4px 24px ${t.shadow};
  --progress-fg: ${t.accent};
}

html, body {
  width: 100%; height: 100%; overflow: hidden;
  background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 18px; line-height: 1.6; -webkit-font-smoothing: antialiased;
}

.deck { position: relative; width: 100%; height: 100%; }

.slide {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; justify-content: center; align-items: flex-start;
  padding: 5vh 8vw;
  opacity: 0; visibility: hidden;
  transition: opacity 0.35s ease, transform 0.35s ease;
  transform: translateX(30px);
}
.slide.active { opacity: 1; visibility: visible; transform: translateX(0); }
.slide.prev { transform: translateX(-30px); }

/* Typography */
.slide h1 { font-size: 2.4em; color: var(--heading); margin-bottom: 0.3em; font-weight: 700; }
.slide h2 { font-size: 1.6em; color: var(--heading); margin-bottom: 0.4em; font-weight: 600; }
.slide h3 { font-size: 1.25em; color: var(--heading); margin-bottom: 0.3em; font-weight: 600; }
.slide p  { margin-bottom: 0.6em; }
.slide ul, .slide ol { margin-left: 1.5em; margin-bottom: 0.6em; }
.slide li { margin-bottom: 0.25em; }
.slide blockquote {
  border-left: 4px solid var(--accent); padding: 0.4em 1em; margin: 0.6em 0;
  color: var(--muted); font-style: italic; background: var(--code-bg); border-radius: 0 6px 6px 0;
}
.slide strong { color: var(--heading); }
.slide a { color: var(--accent); text-decoration: none; }
.slide a:hover { text-decoration: underline; }
.slide hr { border: none; border-top: 2px solid var(--border); margin: 1em 0; width: 100%; }

/* Tables */
.slide table { width: 100%; border-collapse: collapse; margin: 0.8em 0; font-size: 0.9em; }
.slide th, .slide td { padding: 0.5em 0.8em; border: 1px solid var(--border); text-align: left; }
.slide th { background: var(--accent); color: #fff; font-weight: 600; }
.slide tr:nth-child(even) td { background: var(--table-stripe); }

/* Code */
.slide code {
  font-family: "SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace;
  font-size: 0.85em; background: var(--code-bg); color: var(--code-fg);
  padding: 0.15em 0.4em; border-radius: 4px;
}
.slide pre {
  background: var(--code-bg); color: var(--code-fg);
  padding: 1em 1.2em; border-radius: 8px; overflow-x: auto;
  margin: 0.6em 0; width: 100%; font-size: 0.82em; line-height: 1.5;
}
.slide pre code { background: none; padding: 0; border-radius: 0; }

/* Images */
.slide img { max-width: 100%; max-height: 60vh; border-radius: 8px; margin: 0.5em 0; box-shadow: var(--slide-shadow); }

/* ECharts containers */
.slide .echarts-box { width: 100%; height: 55vh; min-height: 320px; margin: 0.5em 0; }
.deck.overview .slide .echarts-box { height: 120px; min-height: 0; }

/* Title slide */
.slide:first-child { text-align: center; align-items: center; }
.slide:first-child h1 { font-size: 3em; }
.slide:first-child h2 { font-size: 1.4em; color: var(--muted); font-weight: 400; }

/* Progress bar */
.progress-bar { position: fixed; top: 0; left: 0; height: 3px; background: var(--progress-fg); transition: width 0.3s ease; z-index: 100; }

/* Page counter */
.page-counter {
  position: fixed; bottom: 16px; right: 24px;
  font-size: 13px; color: var(--muted);
  font-family: "SF Mono", Menlo, monospace; z-index: 100; user-select: none;
}

/* Branding footer (last slide) */
.slide-branding {
  position: absolute; bottom: 50px; left: 0; right: 0;
  text-align: center; font-size: 12px; color: var(--muted);
  display: flex; align-items: center; justify-content: center; gap: 8px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.slide-branding img { width: 24px; height: 24px; border-radius: 4px; box-shadow: none; margin: 0; }
.slide-branding a { color: var(--muted); text-decoration: none; }
.slide-branding a:hover { color: var(--accent); }

/* Navigation buttons */
.nav-btn {
  position: fixed; top: 45%; transform: translateY(-50%);
  width: 48px; height: 48px; border: none; border-radius: 50%;
  background: ${t.dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.06)"};
  color: var(--fg); font-size: 20px; cursor: pointer; z-index: 100;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.2s, opacity 0.2s; opacity: 0.5;
  -webkit-user-select: none; user-select: none;
}
.nav-btn:hover { background: ${t.dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.12)"}; opacity: 1; }
.nav-btn:active { transform: translateY(-50%) scale(0.92); }
.nav-btn.disabled { opacity: 0.15; cursor: default; pointer-events: none; }
.nav-prev { left: 16px; }
.nav-next { right: 16px; }
.deck.overview ~ .nav-btn { display: none; }

/* Overview mode */
.deck.overview {
  overflow-y: auto; padding: 24px;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px; align-content: start;
}
.deck.overview .slide {
  position: relative; opacity: 1; visibility: visible; transform: none;
  width: 100%; min-height: 180px; padding: 24px;
  border: 2px solid var(--border); border-radius: 8px;
  cursor: pointer; font-size: 10px; transition: border-color 0.2s;
}
.deck.overview .slide:hover { border-color: var(--accent); }
.deck.overview .slide.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.deck.overview .slide h1 { font-size: 1.4em; }
.deck.overview .slide h2 { font-size: 1.1em; }
.deck.overview .slide pre { font-size: 7px; }

/* highlight.js */
.hljs{color:var(--code-fg);background:var(--code-bg)}
.hljs-comment,.hljs-quote{color:var(--muted);font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-type{color:#d73a49}
.hljs-literal,.hljs-number,.hljs-tag .hljs-attr{color:#005cc5}
.hljs-string,.hljs-doctag,.hljs-template-variable{color:#032f62}
.hljs-title,.hljs-section,.hljs-name,.hljs-selector-id,.hljs-selector-class{color:#6f42c1}
.hljs-variable,.hljs-template-variable{color:#e36209}
.hljs-regexp,.hljs-link{color:#032f62}
.hljs-symbol,.hljs-symbol,.hljs-bullet{color:#005cc5}
.hljs-built_in,.hljs-builtin-name{color:#005cc5}
.hljs-meta{color:#735c0f}
.hljs-deletion{color:#b31d28;background:#ffeef0}
.hljs-addition{color:#22863a;background:#f0fff4}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:bold}
.hljs-attr,.hljs-attribute{color:#005cc5}
.hljs-params{color:var(--code-fg)}
${darkHljs}
`;
}

// ─── JS Navigation ───────────────────────────────────────────────────────────

const JS = `
(function() {
  var deck = document.querySelector('.deck');
  if (!deck) return;
  var slides = Array.prototype.slice.call(deck.querySelectorAll('.slide'));
  if (slides.length === 0) return;
  var progressBar = document.querySelector('.progress-bar');
  var pageCounter = document.querySelector('.page-counter');
  var prevBtn = document.querySelector('.nav-prev');
  var nextBtn = document.querySelector('.nav-next');
  var total = slides.length;
  var current = 0;
  var overviewMode = false;

  function show(index) {
    if (index < 0 || index >= total) return;
    current = index;
    for (var j = 0; j < slides.length; j++) {
      slides[j].classList.remove('active', 'prev');
      if (j < current) slides[j].classList.add('prev');
    }
    slides[current].classList.add('active');
    if (window.__onSlideShown) window.__onSlideShown(slides[current]);
    if (progressBar) progressBar.style.width = ((current + 1) / total * 100) + '%';
    if (pageCounter) pageCounter.textContent = (current + 1) + ' / ' + total;
    if (prevBtn) prevBtn.classList.toggle('disabled', current === 0);
    if (nextBtn) nextBtn.classList.toggle('disabled', current === total - 1);
  }

  function next() { show(current + 1); }
  function prev() { show(current - 1); }

  function toggleOverview() {
    overviewMode = !overviewMode;
    deck.classList.toggle('overview', overviewMode);
    if (overviewMode) {
      deck.scrollTop = slides[current].offsetTop - 40;
    }
  }

  // Keyboard
  document.addEventListener('keydown', function(e) {
    if (overviewMode && e.key === 'Escape') { toggleOverview(); return; }
    switch (e.key) {
      case 'ArrowRight': case ' ': case 'PageDown': e.preventDefault(); next(); break;
      case 'ArrowLeft': case 'PageUp': e.preventDefault(); prev(); break;
      case 'Home': e.preventDefault(); show(0); break;
      case 'End': e.preventDefault(); show(total - 1); break;
      case 'f': case 'F':
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
        break;
      case 'o': case 'O': e.preventDefault(); toggleOverview(); break;
    }
  });

  // Touch swipe
  var touchStartX = 0;
  deck.addEventListener('touchstart', function(e) { touchStartX = e.changedTouches[0].clientX; }, {passive:true});
  deck.addEventListener('touchend', function(e) {
    var diff = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(diff) > 50) { diff < 0 ? next() : prev(); }
  }, {passive:true});

  // Navigation buttons
  if (prevBtn) prevBtn.addEventListener('click', function(e) { e.stopPropagation(); prev(); });
  if (nextBtn) nextBtn.addEventListener('click', function(e) { e.stopPropagation(); next(); });

  // Click in overview
  deck.addEventListener('click', function(e) {
    if (!overviewMode) return;
    var slide = e.target.closest('.slide');
    if (!slide) return;
    var idx = slides.indexOf(slide);
    if (idx >= 0) { show(idx); toggleOverview(); }
  });

  // Initialize
  show(0);
})();
`;

// ─── ECharts Runtime (only injected when ```echarts blocks are present) ─────

const ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js";

function buildEchartsScripts() {
  if (echartsOptions.length === 0) return "";
  const optionsJson = JSON.stringify(echartsOptions).replace(/</g, "\\u003c");
  return `
<script src="${ECHARTS_CDN}"></script>
<script>
(function() {
  var OPTIONS = ${optionsJson};
  var instances = {};
  function initIn(root) {
    if (!window.echarts || !root) return;
    var boxes = root.querySelectorAll('.echarts-box');
    for (var i = 0; i < boxes.length; i++) {
      var idx = boxes[i].getAttribute('data-ec-idx');
      if (instances[idx]) { instances[idx].resize(); continue; }
      var chart = echarts.init(boxes[i], null, { renderer: 'canvas' });
      chart.setOption(OPTIONS[idx]);
      instances[idx] = chart;
    }
  }
  window.__onSlideShown = function(slideEl) { initIn(slideEl); };
  window.addEventListener('resize', function() {
    for (var k in instances) instances[k].resize();
  });
  initIn(document.querySelector('.slide.active'));
})();
</script>`;
}

// Logo is in the same directory as this script (gen-ppt/scripts/logo.png)
const BRANDING_LOGO_SRC = fileURLToPath(new URL('./logo.png', import.meta.url));

// ─── Build HTML ──────────────────────────────────────────────────────────────

async function build() {
  const renderedSlides = await renderSlides();
  const title = customTitle || (slides[0] || "Presentation").split("\n")[0].replace(/^#+\s*/, "").trim();

  // Prepare branding: embed logo as base64 for self-contained output
  let logoDataUri = '';
  try {
    if (existsSync(BRANDING_LOGO_SRC)) {
      logoDataUri = 'data:image/png;base64,' + readFileSync(BRANDING_LOGO_SRC).toString('base64');
    }
  } catch (_) { /* logo optional */ }

  const brandingHtml = logoDataUri
    ? `<div class="slide-branding"><img src="${logoDataUri}" alt="HogAgent"><span>Powered by: <a href="https://ciweiai.com" target="_blank">HogAgent (ciweiai.com)</a></span></div>`
    : `<div class="slide-branding"><span>Powered by: <a href="https://ciweiai.com" target="_blank">HogAgent (ciweiai.com)</a></span></div>`;

  const slidesHtml = renderedSlides
    .map((html, i) => {
      const isLast = i === renderedSlides.length - 1;
      return `<section class="slide${i === 0 ? ' active' : ''}">\n<div class="slide-content">\n${html}\n</div>${isLast ? '\n' + brandingHtml : ''}\n</section>`;
    })
    .join("\n");

  const css = buildCSS();

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title.replace(/</g, "&lt;")}</title>
<style>${css}</style>
</head>
<body>
<div class="progress-bar" style="width:0%"></div>
<div class="deck">
${slidesHtml}
</div>
<div class="page-counter">1 / ${renderedSlides.length}</div>
<button class="nav-btn nav-prev" aria-label="Previous slide">&#8249;</button>
<button class="nav-btn nav-next" aria-label="Next slide">&#8250;</button>
<script>${JS}</script>${buildEchartsScripts()}
</body>
</html>`;

  const absoluteOutputPath = resolve(outputPath);
  const tempOutputPath = join(dirname(absoluteOutputPath), `.${basename(absoluteOutputPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tempOutputPath, html, { encoding: "utf-8", flag: "wx" });
    renameSync(tempOutputPath, absoluteOutputPath);
  } finally {
    try { unlinkSync(tempOutputPath); } catch { /* already renamed or never created */ }
  }

  const size = statSync(outputPath).size;
  const sizeStr = size > 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${(size / 1024).toFixed(1)} KB`;

  const chartNote = echartsOptions.length > 0 ? `, ${echartsOptions.length} echarts` : "";
  console.log(`HTML slides generated: ${outputPath} (${renderedSlides.length} slides${chartNote}, ${sizeStr}, theme: ${theme})`);
}

build().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
