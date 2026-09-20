---
name: gen-ppt
description: >
    Generate presentations as editable PPTX from JSON (default) or self-contained HTML slides from Markdown when explicitly requested. Keep text, shapes, and tables editable; use native charts only for PowerPoint targets and PNG charts for Keynote/universal targets. Use for slide decks, pitch decks, meeting presentations, PowerPoint/PPTX, HTML/web slides, Markdown-to-slides, and interactive browser presentations. Does not create .key files, Google Slides-only exports, or video.
version: 2.4.3
---

# GenPPT — Presentation Generator

## Choose the output

| Mode | Use when | Input → output | Script |
|---|---|---|---|
| PPTX (default) | Any ordinary presentation request | JSON → editable `.pptx` | `scripts/gen-ppt.mjs` |
| HTML (opt-in) | User explicitly asks for HTML/web/browser/interactive slides | Markdown → self-contained `.html` | `scripts/md-to-slides.mjs` |

Resolve scripts relative to this SKILL.md and use absolute paths for all I/O files.

HTML slide images may use native absolute paths (including Windows drive paths) or paths relative to the Markdown file. Prefer forward slashes in Markdown/HTML image attributes on Windows.

## PPTX workflow

Create the UTF-8 JSON configuration with the Agent's file-writing tool as a unique workspace file named `tmp-gen-ppt-<id>.json`; do not assemble it with shell text or place it under `.hedgehog/`. Pass the path positionally and remove the temporary configuration after generation. UTF-8 BOM is accepted.

1. Choose the delivery target before designing charts:
   - `powerpoint`: retain editable native `bar`, `line`, `pie`, `doughnut`, `area`, `scatter`, and `radar` charts.
   - `keynote` or `universal`: render charts from the same source data as PNG with `gen-chart`, then use `{ "type": "image", "path": "/absolute/path/chart.png" }`. Current Keynote can import schema-valid PptxGenJS category charts as blank; the generator therefore rejects native charts for these targets. Preserve labels/title/meaning and disclose that PNG charts are not natively editable.
2. Read `references/json-schema.md` before writing configuration. Use `references/examples.md` for complete patterns.
3. Generate with the matching target:

```bash
node <skill_dir>/scripts/gen-ppt.mjs <workspace>/tmp-gen-ppt-<id>.json <output.pptx> [--theme=<name>] [--target=powerpoint|keynote|universal]
```

4. Validate structurally and in every available target viewer:

```bash
node <skill_dir>/scripts/validate-pptx.mjs <output.pptx> [--libreoffice] [--keynote] [--powerpoint]
```

`--keynote` recognizes Keynote and Keynote Creator Studio and rejects PptxGenJS decks that retain native charts. Use `--powerpoint` as the release gate for PowerPoint delivery; if unavailable, report the deck as PowerPoint-unverified. LibreOffice is supplementary and cannot certify PowerPoint or Keynote behavior. Never label a structural-only run as viewer-validated.

5. Deliver only the exact tested artifact. Give every revision a unique basename containing GenPPT `v2.4.3` plus a task ID or timestamp; report its absolute path, byte count, and SHA-256.

### Configuration essentials

- Layouts: `title`, `section`, `content`, `two-column`, `image-text`, `chart`, `table`, `closing`, `blank`; every slide also accepts `elements`.
- `image-text` accepts `image.position`: `left`, `right`, `top`, or `bottom`; images scale proportionally.
- Scatter series require matching `xValues`/`yValues`; all series must share X values.
- Inline text supports `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, and the documented HTML tags. Underscore emphasis is intentionally unsupported.
- Use absolute PNG/JPG paths for PPTX images; avoid SVG. Nest options inside `chart.options`/`table.options`; use `headers`, not `head`.

Minimal configuration:

```json
{
  "theme": "fintech",
  "targetViewer": "powerpoint",
  "slides": [
    { "layout": "title", "title": "My Presentation", "subtitle": "Created with GenPPT" },
    { "layout": "content", "title": "Key Points", "bullets": ["First", "Second"] }
  ]
}
```

### Integrity policy

Do not bypass generation or validation failures. The generator repairs known PptxGenJS package, presentation ordering, bullet, shape/text, notes-master/theme, image MIME, chart XML/category/relationship, and embedded-workbook defects, then performs namespace-aware OOXML and relationship validation. Read `references/ooxml-validation.md` when changing generation, auditing compatibility, or diagnosing a failed deck.

### References

- `references/json-schema.md` — complete JSON fields and constraints
- `references/examples.md` — six complete configurations, including universal PNG charts
- `references/ooxml-validation.md` — repairs, OOXML checks, and viewer QA

## HTML workflow

Write Markdown with `---` on its own line between slides, then run:

```bash
node <skill_dir>/scripts/md-to-slides.mjs <input.md> <output.html> [--theme=<name>] [--title="Tab Title"]
```

- Use `#` for the title slide and `##`/`###` headings thereafter; typically create 10–20 slides with 3–6 bullets each.
- Images from absolute local paths or URLs are embedded as base64; never leave external references. File and inline-base64 image payloads are validated and limited to 50 MiB decoded; SVG is acceptable only in HTML mode.
- Put ECharts option JSON in a fenced `echarts` block so the runtime renders it; do not paste it as plain text.
- Output includes keyboard/touch navigation, fullscreen (`F`), overview (`O`), and Home/End support.

## Themes and dependencies

Themes: `fintech` (default), `oldmoney`, `bloomberg`, `economist`, `saas`, `mist`, `twilight`, `parchment`, `azure`, `gravel`. Use `--theme=list` to inspect them or `--theme=none` for PptxGenJS defaults in PPTX mode.

Dependencies are pre-installed under `<hogagent_root>/node_modules/`: `pptxgenjs@4.0.1`, `jszip@3.10.1`, `saxes@6.0.0`, `marked`, and `highlight.js`.

The official HogAgent package includes these dependencies. Before using a source checkout or an independently copied Skill, install its declared runtime dependencies with `npm install --omit=dev --prefix '<skill_dir>'`. A `package.json` declaration alone does not install the modules.

## After changing the skill

Run:

```bash
npm run test:docs
npm run test:package-integrity -- --libreoffice
npm run test:native-charts -- --libreoffice
```

Add `--keynote` and/or `--powerpoint` wherever installed. These tests must keep documented examples, package/notes integrity, all native chart types, Keynote-safe rendering, and Keynote native-chart rejection covered.

## Execution safety

Native-PPT configuration and Markdown inputs are limited to 100 MiB and embedded images to 50 MiB. Output extensions are strict. PPTX packages are normalized and structurally validated in memory, while PPTX and HTML outputs replace the target atomically only after successful generation. Viewer validation subprocesses always receive an argument array, never a shell command, and have bounded timeouts.
