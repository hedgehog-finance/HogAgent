---
name: gen-chart
description: >
    Generate charts as PNG/SVG (Vega-Lite v6, Mermaid) or ECharts JSON configurations. You MUST select either “Image Mode” or “ECharts Mode” before generating data.
    Triggers: chart, diagram, graph, flowchart, sequence diagram, mermaid, vega, echarts.
version: 2.4.2
---

# GenChart — Chart & Diagram Generator

Generate charts (Vega-Lite v6) and diagrams (Mermaid) as PNG/SVG images, or ECharts JSON configs.
Two usage scenarios: **Standalone Generation** and **In-text Embedding**.

## Chart Generation modes (Mandatory)

Target modes must be declared prior to data generation. Mixing protocols is strictly prohibited:

* **Image Mode**: Uses the **Vega-Lite v6 JSON specification** or **Mermaid syntax** (outputs PNG/SVG via `vega-chart.mjs` / `mermaid-chart.mjs`).
* **ECharts Mode**: Outputs **ECharts JSON configuration** via `echarts-config.mjs` (no files generated). Use only when the user explicitly requests ECharts.

**Execution Rules:**
1. **Strict Isolation**: Never pass ECharts JSON to `vega-chart.mjs` (this causes rendering failures). Never pass Vega-Lite specifications to `echarts-config.mjs`.
2. **Data Authenticity**: `gen-chart` requires real data inputs. Mock data and placeholders are prohibited.
3. **Default Mode**: Image Mode is the default. Use ECharts Mode only when the user explicitly requests it.

## Scripts

When the Agent creates a JSON specification, write it as UTF-8 with a unique `tmp-gen-chart-<id>.json` basename in the workspace, pass only its path, and delete it after rendering. Do not construct or inline JSON in a shell command. UTF-8 BOM is accepted by the JSON-based scripts.

### vega-chart.mjs — Vega-Lite v6 data charts (line, bar, pie, scatter, etc.)
```bash
node ./scripts/vega-chart.mjs --spec <workspace>/tmp-gen-chart-<id>.json --output <output.png|svg> [--theme=<name>]
```

### mermaid-chart.mjs — Diagrams (flowchart, sequence, class, etc.)
```bash
node ./scripts/mermaid-chart.mjs --spec <input.mmd> --output <output.png|svg> [--theme=<name>]
```

### echarts-config.mjs — ECharts config (JSON output, no files)
```bash
node ./scripts/echarts-config.mjs --spec <workspace>/tmp-gen-chart-<id>.json [--theme=<name>] [--width=<n>] [--height=<n>]
```
Outputs `{ chart, option }` JSON to **stdout**. No files generated.

> Resolve `./scripts/*` to absolute paths using this SKILL.md's directory.

## Supported Chart & Diagram Types

| Mode | Engine | Type | Chart Types |
|------|--------|------|-------------|
| **Image** | Vega-Lite | Data charts | line, bar, area, point (scatter), arc (pie/donut), rect, rule, text + all Vega-Lite marks |
| **Image** | Mermaid | Diagrams | flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, gitgraph |
| **ECharts** | ECharts | Data charts | line, area, bar, horizontal bar, histogram, pie, donut, radar, scatter, bubble |

> Vega-Lite/Mermaid support additional types beyond those listed. ECharts validates against the 10 types above (`"scatter plot"` accepted as an alias of `scatter`).

---

## Scenario A: Standalone Generation

Single chart output, no surrounding text.

**Image Mode (default):**
1. Write input to file in session task dir (NOT inline on CLI)
2. Run: `node <skill_dir>/scripts/<script>.mjs --spec <input> --output <output> [--theme=...]`
3. Deliver the output image file.

**ECharts Mode (opt-in, user must explicitly request):**
1. Write chart def JSON: `{ "chart": "<type>", "option": { ... } }`
2. Run: `node <skill_dir>/scripts/echarts-config.mjs --spec <workspace>/tmp-gen-chart-<id>.json [--theme=<name>]`
3. Deliver the stdout JSON text directly (no files generated).

---

## Scenario B: In-text Embedding

Embed charts in longer body text. Following user requests or system prompts, embed the chart content or citations into the text, or insert placeholders in the text and append a list of charts at the end.

---

## ECharts Details

- **Default size**: 16:9 (800×450), adjustable via `--width=<n>` / `--height=<n>`. Actual rendering size controlled by frontend.
- **Layout margins**: theme presets keep the legend clear of the x-axis labels/title and the chart title row (`legend.offset: 16`, `title.offset: 14`); the ECharts config reserves `grid.bottom: 56` whenever a bottom legend is shown so it never collides with the axis title.
- See `references/echarts-examples.md` for complete examples.

## Best Practices

- **Aspect ratio**: Prefer **16:9**. Image Mode: set `"width": 800, "height": 450` inside the Vega-Lite spec (vega-chart.mjs has no size flags). ECharts Mode: 800×450 is the default.
- **Dates**: Use ISO 8601 (`"2024-01-01"`) for `temporal` fields. Non-ISO formats are auto-fixed but add overhead (see below).
- **Vega-Lite numeric on ordinal axis**: Convert to string via `transform` to avoid rendering issues:
  ```json
  "transform": [{ "calculate": "toString(datum.year)", "as": "year_string" }],
  "encoding": { "x": { "field": "year_string", "type": "ordinal" } }
  ```

### Auto-fix (Data Format)

Script auto-detects and fixes common LLM data issues (stderr warnings):

| Issue | Symptom | Auto-fix |
|-------|---------|----------|
| Chinese/non-ISO dates + `temporal` | Blank chart | `"2024年1月"` → `"2024-01-01"` |
| String numbers + `quantitative` | Missing marks | `"100"` → `100` |
| Empty `data.values` | Blank chart | Warn + suggest fix |

**Best practice**: Use ISO 8601 dates and numeric values directly so no auto-fix is needed.

### Headless text measurement (CJK)

`vega-chart.mjs` runs in Node without node-canvas, where Vega's built-in text-width fallback (0.8em per char) underestimates full-width CJK glyphs (~1em per char) and packs horizontal legend entries too tightly, overlapping Chinese labels. The script installs a CJK-aware width estimator into `vega.textMetrics.width` so legend/axis layout matches rendered text width. No action required from spec authors.

## Options
- `-o <output>` — Alt output flag
- `--format=svg` — Force SVG (or use `.svg` extension)
- `--theme=<name>` — Financial theme preset, applies to all three scripts. **Default: `fintech`** (auto-applied); `none` to disable; `list` to print all. Mermaid additionally accepts `default`, `dark`, `forest`, `neutral`.

**Output format choice**: Use **PNG** when the chart will be embedded into PPTX/DOCX/PDF (gen-ppt, gen-doc, etc.) — SVG embeds render blank in most office viewers. Use SVG only for web/HTML display.

## Financial Color Themes

`--theme=<key>` for pre-tuned financial color schemes (6 colors + background):

| Key | Name | Colors (6) | BG | Best For |
|-----|------|-----------|-----|----------|
| `fintech` | Modern FinTech | `#1D4ED8 #215DF2 #60A5FA #818CF8 #A78BFA #38BDF8` | `#F8FAFC` | SaaS, tech charts |
| `oldmoney` | Traditional Banking | `#0A2540 #B4975A #115E59 #8B2500 #D4A76A #2E8B6F` | `#FFFFFF` | Wealth mgmt |
| `bloomberg` | Bloomberg / Quant | `#10B981 #EF4444 #0EA5E9 #F59E0B #A855F7 #06B6D4` | `#09090B` | Dark dashboards |
| `economist` | Economist Style | `#0F2B5B #D73027 #4575B4 #E8A735 #1B7A5A #6C7B8A` | `#F6F4F0` | Data journalism |
| `saas` | Silicon Valley SaaS | `#635BFF #00D4B6 #FF8A65 #3B82F6 #EC4899 #84CC16` | `#FFFFFF` | Product analytics |
| `mist` | Morning Mist | `#64748B #7A8C9F #8F9FB1 #9EAEBF #B0BFCF #C2CEDD` | `#F1F5F9` | Muted slate blues |
| `twilight` | Twilight | `#776B87 #8A7D9A #9C90AC #AFA3BD #C0B5CE #D1C6DD` | `#F5F3F7` | Muted violets |
| `parchment` | Parchment | `#947E70 #A69082 #B5A092 #C4B1A3 #D1C0B3 #DDCFC3` | `#F5F2EB` | Warm sepia |
| `azure` | Azure | `#5E7B9E #728EAF #86A0BE #9BB1CD #ADC1DA #BFD1E6` | `#EAF2F8` | Coastal blues |
| `gravel` | Gravel | `#73716D #868480 #989691 #A9A7A2 #B9B7B2 #C9C7C2` | `#F0EFEA` | Neutral grays |

## Dependencies
Vega stack installed in `skills/gen-chart/node_modules/`: `vega` (`^6.3.1`), `vega-lite` (`^6.4.3`), `@resvg/resvg-js` (`^2.6.2`). Mermaid stack in `<hogagent_root>/node_modules/`: `@mermaid-js/mermaid-cli`, `puppeteer`.

The official HogAgent package includes these dependencies. Before using a source checkout or an independently copied Skill, install its declared runtime dependencies with `npm install --omit=dev --prefix '<skill_dir>'`. A `package.json` declaration alone does not install the modules. Mermaid rendering also requires the shared HogAgent dependencies, installed with `npm install --omit=dev --prefix '<hogagent_root>'`.

PNG rendering pipeline: `vega-chart.mjs` renders SVG first (`view.toSVG()`) then rasterizes with `@resvg/resvg-js` at 2x zoom (prebuilt native binary, no compilation). It does NOT use node-canvas — vega's `view.toCanvas()` is deliberately avoided because the `canvas` native package is fragile (prebuild download failures).

Vega-Lite specs should use the v6 schema when `$schema` is included: `https://vega.github.io/schema/vega-lite/v6.json`.

ECharts is NOT a Node.js dependency — frontend loads ECharts 5.5.1 from CDN.

## Execution safety

Chart specs and local Vega data files are limited to 100 MiB; Mermaid inputs are limited to 10 MiB. Vega rejects more than 1,000,000 inline rows, dimensions above 8192 px, render areas above 25,000,000 pixels, URI data sources, and output-format/extension mismatches. Mermaid runs with an argument array, no shell, and a 120-second timeout. File renderers validate a non-empty temporary result before atomically replacing the requested output.
