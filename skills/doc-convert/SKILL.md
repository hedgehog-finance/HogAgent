---
name: doc-convert
description: >
    Convert between document formats: Markdown/HTML to PDF, PDF to Markdown, DOCX to HTML/Markdown.
    Applicable: document conversion, format transformation, report export, content extraction.
    Triggers: convert document, PDF to markdown, docx to markdown, docx to html, html to markdown, markdown to pdf, html to pdf.
    Blocking: password-protected documents, scanned PDF OCR, interactive PDF forms.
version: 2.1.2
---

# DocConvert — Multi-Format Document Conversion

Convert between Markdown, HTML, PDF, and DOCX.

## Conversion Matrix

| Input | Output | Script | Engine |
|-------|--------|--------|--------|
| Markdown | PDF | md-to-pdf.mjs | md-to-pdf |
| HTML | PDF | html-to-pdf.mjs | puppeteer (ECharts-aware) |
| PDF | Markdown | pdf-to-markdown.mjs | unpdf (LLM-switchable) |
| DOCX | HTML | docx-to-html.mjs | mammoth |
| HTML | Markdown | html-to-markdown.mjs | turndown |
| DOCX | Markdown | docx-to-markdown.mjs | mammoth→turndown (LLM-switchable) |

## Script Usage

### md-to-pdf.mjs — Markdown to PDF
```bash
node ./scripts/md-to-pdf.mjs <input.md> <output.pdf> [--css "custom.css"]
```

### html-to-pdf.mjs — HTML to PDF
```bash
node ./scripts/html-to-pdf.mjs <input.html> <output.pdf> [--timeout 15000]
```
Renders HTML with Puppeteer's `chrome-headless-shell`. Auto-detects and waits for ECharts charts to finish rendering before PDF capture.
- `--timeout`: max ms to wait for ECharts render (default 10000)
- Chromium sandboxing remains enabled on Windows and non-root POSIX runs. Only a POSIX process already running as root receives Puppeteer's required `--no-sandbox` fallback.

### pdf-to-markdown.mjs — PDF to Markdown
```bash
node ./scripts/pdf-to-markdown.mjs <input.pdf> <output.md>
```
Defaults to local unpdf; LLM path preferred when configured (higher fidelity: tables/layout/formulas).

### docx-to-html.mjs — DOCX to HTML
```bash
node ./scripts/docx-to-html.mjs <input.docx> <output.html>
```

### html-to-markdown.mjs — HTML to Markdown
```bash
node ./scripts/html-to-markdown.mjs <input.html> <output.md>
```

### docx-to-markdown.mjs — DOCX to Markdown
```bash
node ./scripts/docx-to-markdown.mjs <input.docx> <output.md>
```
Defaults to chain (DOCX→HTML→MD); LLM path preferred when configured.

## Workflow

1. Write input file to session task directory
2. Run: `node <this_skill_dir>/scripts/<script>.mjs <input_file> <output_file>`

> Resolve `./scripts/*` to absolute paths from SKILL.md directory (see `available_skills`).
> Use absolute paths for I/O; output written to session task directory.

## LLM Parsing Config (Optional)

PDF→MD and DOCX→MD support an LLM parsing path for higher fidelity (tables, complex layouts, formulas).
When unconfigured, the default local engine is used.

Config file: `~/.hogagent/skills_config.json`

```json
{
  "doc-convert": {
    "api-key": "your-api-key",
    "endpoint": "https://your-provider/api/paas/v4/files/parser/sync",
    "toolType": "prime-sync"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `api-key` | Yes | File parsing service API key |
| `endpoint` | Yes | Parsing service endpoint URL (vendor-agnostic) |
| `toolType` | No | Parser tool type, default `prime-sync` |

The managed HogAgent spelling is `api-key`; portable Skill installations may use the `apiKey` alias. The loader accepts both without changing precedence for the canonical field.

Environment variables (fallback when not set in config file):
- `DOC_CONVERT_API_KEY`
- `DOC_CONVERT_ENDPOINT`
- `DOC_CONVERT_TOOL_TYPE`

> LLM path uses a generic file-parsing protocol; the endpoint URL determines the actual provider.

## Conversion Quality

| Path | Tables | Layout | Use Case |
|------|--------|--------|----------|
| Local engine | Basic | Basic | Standard documents, no external deps |
| LLM path | High-fidelity | Layout-aware | Complex tables, formulas, multi-column |

## Dependencies

Pre-installed in `<hogagent_root>/node_modules/`:

- `md-to-pdf`, `puppeteer` — PDF generation through `chrome-headless-shell` (Puppeteer also powers ECharts-aware HTML→PDF)
- `mammoth` — DOCX parsing
- `turndown`, `turndown-plugin-gfm` — HTML→MD (with GFM table support)
- `unpdf` — PDF→MD (based on pdf.js)

The official HogAgent package includes these dependencies. Before using a source checkout or an independently copied Skill, install its declared runtime dependencies with `npm install --omit=dev --prefix '<skill_dir>'`. A `package.json` declaration alone does not install the modules.

## Execution safety

Document inputs are limited to 100 MiB, custom CSS to 5 MiB, embedded local images to 50 MiB, parser responses to 50 MiB, and generated PDFs to 250 MiB. Parser calls time out after 60 seconds, reject redirects, and require HTTPS except for loopback endpoints. Outputs use the documented extension and replace the target only after a complete temporary result passes validation.
