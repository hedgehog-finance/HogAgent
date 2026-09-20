---
name: table-convert
description: >
    Convert spreadsheets (.xlsx, .xls, .csv) to JSON or Markdown table.
    Triggers: Excel, CSV, spreadsheet, table convert, xlsx, xls.
    Blocking: PDF/Word export, database import, chart generation from raw data.
version: 1.1.2
---

# TableConvert — Spreadsheet to JSON / Markdown

Convert .xlsx, .xls, .csv files to structured JSON arrays or Markdown tables.

## Scripts

### convert.mjs — Main converter
```bash
node ./scripts/convert.mjs <input> <output> [--format=json|markdown] [--sheet=<name|index>]
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--format` | `json` | Output format: `json` or `markdown` |
| `--sheet` | first sheet | Sheet name, 0-based index, or `list` to print all sheet names. Numeric values are treated as index first; if out of range, they fall back to exact sheet-name match (e.g. a sheet named `2024`). |

## Workflow

1. **Identify** the input spreadsheet file (.xlsx, .xls, or .csv)
2. **Run**: `node <this_skill_dir>/scripts/convert.mjs <input> <output> [options]`
3. Output is written to the specified `<output>` path (use session task dir)

## Examples

```bash
# CSV to JSON (default format)
node ./scripts/convert.mjs data.csv output.json

# Excel to Markdown table
node ./scripts/convert.mjs report.xlsx output.md --format=markdown

# Convert a specific sheet by name
node ./scripts/convert.mjs multi.xlsx output.json --sheet=Sales

# Convert by sheet index (0-based)
node ./scripts/convert.mjs multi.xlsx output.json --sheet=1

# List all sheet names
node ./scripts/convert.mjs multi.xlsx --sheet=list
```

> Resolve `./scripts/*` to absolute paths using this SKILL.md's directory (shown in system prompt `available_skills`).
> Use absolute paths for input/output files. Write output to session task dir.

## Dependencies
Pre-installed in `<hogagent_root>/node_modules/`: `xlsx`, `markdown-table`

The official HogAgent package includes these dependencies. Before using a source checkout or an independently copied Skill, install its declared runtime dependencies with `npm install --omit=dev --prefix '<skill_dir>'`. A `package.json` declaration alone does not install the modules.

## Execution safety

Inputs are limited to 100 MiB. Unknown, duplicate, empty, or conflicting options fail before conversion; list mode is exclusive. Converted files replace the target atomically only after serialization completes.
