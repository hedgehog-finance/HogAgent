# PPTX Package and Native Chart Integrity

Use this reference when generating or troubleshooting `.pptx` output, including editable native charts.

## Invariants

For `targetViewer: "powerpoint"`, `gen-ppt.mjs` must preserve `bar`, `line`, `pie`, `doughnut`, `area`, `scatter`, and `radar` as native editable Office charts. For `targetViewer: "keynote"` or `"universal"`, the configuration must instead use PNG charts rendered from the same source data; the generator rejects PptxGenJS native chart slots because current Keynote imports them as blank even when their ChartML validates against ECMA-376.

The export pipeline in `scripts/pptx-ooxml.mjs` must:

1. Serialize with the pinned `pptxgenjs@4.0.1` runtime.
2. Remove required-part Overrides that target nonexistent package parts, preserve/add Overrides for real parts, and normalize known image MIME types (`image/jpeg`, `image/png`, `image/gif`, and `image/svg+xml`).
3. Reorder the direct children of `p:presentation` to the ECMA-376 `CT_Presentation` sequence, including placing `notesMasterIdLst` before `sldIdLst`.
4. Convert PptxGenJS's decimal-form `a:buSzPct` values such as `100000` to the element's required percentage lexical form such as `100%`; reject values outside 25%–400%.
5. Preserve the six PowerPoint-authored notes-master placeholder shapes (`hdr`, `dt`, `sldImg`, `body`, `ftr`, and `sldNum`). Per-slide notes inherit from them, so an empty or partial notes master is invalid for PowerPoint. If the notes master reuses a slide-master theme, clone an independent theme part, update its relationship, and add the corresponding content-type Override. Preserve all slide-level speaker-note content.
6. Convert slide-to-chart relationship targets from absolute `/ppt/charts/...` paths to relative `../charts/...` paths.
7. Enforce DrawingML child order for supported chart containers and data series.
8. Insert required `lineChart/grouping`, remove series nodes forbidden for that chart type, remove only PptxGenJS's extra orphan axis reference when two valid axes remain, and otherwise fail closed on incomplete axes.
9. Convert a one-level `multiLvlStrRef` category cache to `strRef` for cross-viewer compatibility while retaining genuinely multi-level categories.
10. Normalize documented friendly shape aliases to real DrawingML presets and reject unknown shape values before serialization; preserve valid chart intent such as rounded corners.
11. Add a minimal `p:txBody` to every textless `p:sp`, add `a:effectLst` to solid slide backgrounds, and reject invalid/non-finite table margins, column widths, and row heights before PptxGenJS can serialize invalid values.
12. Parse every XML part with a namespace-aware XML parser and validate ZIP CRCs, non-finite attributes, required package parts, embedded chart-workbook ZIPs, absolute Override part names, effective content types, presentation child order, bullet percentage lexical forms, relationship IDs/types/target modes/targets, source XML relationship references, one-to-one presentation IDs, reciprocal master/layout and notes links, unique drawing-object and chart-series IDs, required master/layout/slide/notes chains, notes themes, preset shapes, chart ordering, and reciprocal axis cross-references.
13. Abort generation on any validation failure. Never emit the unverified PptxGenJS buffer and never silently switch chart representations. Keynote/universal callers must explicitly supply PNG chart images; PowerPoint callers retain native charts.

Input validation must also reject empty/mismatched series, non-finite numbers, negative pie/doughnut values, incomplete scatter X/Y data, and undocumented native chart types before serialization.

## Commands

Generation already runs structural validation:

```bash
node <skill_dir>/scripts/gen-ppt.mjs <workspace>/tmp-gen-ppt-<id>.json <output.pptx> --target=powerpoint|keynote|universal
```

Run the validator independently when auditing an existing result:

```bash
node <skill_dir>/scripts/validate-pptx.mjs <output.pptx>
```

Add every available target viewer:

```bash
node <skill_dir>/scripts/validate-pptx.mjs <output.pptx> --libreoffice
# macOS, when the application is installed:
node <skill_dir>/scripts/validate-pptx.mjs <output.pptx> --keynote
node <skill_dir>/scripts/validate-pptx.mjs <output.pptx> --powerpoint
```

Viewer flags open the PPTX and export a non-empty PDF. A missing viewer is a failed requested check, not a skipped success. On macOS, Keynote discovery includes both `/Applications/Keynote.app` and `/Applications/Keynote Creator Studio.app`. Because a non-empty Keynote PDF can still contain blank chart regions, `--keynote` rejects PptxGenJS-authored decks that retain native charts and instructs the caller to use PNG. LibreOffice or Keynote success must not be presented as proof of Microsoft PowerPoint compatibility; PowerPoint-targeted delivery requires `--powerpoint`, or an explicit PowerPoint-unverified disclosure when that application is unavailable.

The generator and validator print the resolved artifact path, byte count, slide count, GenPPT version, target viewer, and SHA-256. Preserve this output in the task trace and compare the delivered file against it. Use a unique basename for every revision—include the version plus a task ID or timestamp—so browser suffixes such as `(1)` cannot make a failed older artifact look like the newly validated one. If Keynote is the stated target and is installed, generation with `--target=keynote`, zero native chart parts, and a successful `--keynote` line with the expected document name and slide count are release requirements; structural success alone is not a viewer test.

Run the bundled regression suite after any generator or dependency change:

```bash
cd <skill_dir>
npm run test:docs
npm run test:package-integrity -- --libreoffice
npm run test:native-charts -- --libreoffice
# Add installed macOS target viewers:
npm run test:package-integrity -- --libreoffice --keynote --powerpoint
npm run test:native-charts -- --libreoffice --keynote --powerpoint
```

## Release Checklist

- Parse every `json` code fence in `references/examples.md` and `references/json-schema.md`, then generate and structurally validate all complete examples.
- Generate a PowerPoint-targeted smoke-test deck containing all seven native chart types.
- Use explicit `xValues`/`yValues` for the scatter slide and confirm visible points, not only axes.
- Confirm `validate-pptx.mjs` reports all seven chart parts.
- Confirm ZIP and internal relationship validation pass.
- Confirm embedded native-chart workbooks are valid ZIP packages with content types, root relationships, and a workbook part.
- Confirm `[Content_Types].xml` has no ghost slide-master Overrides and uses `image/jpeg` for `.jpg`.
- Confirm `p:presentation` children follow `CT_Presentation` order and every `a:buSzPct@val` uses a 25%–400% percentage string.
- Confirm the notes master retains exactly one placeholder of each required type, speaker-note text remains present in notes slides, and the notes-master theme relationship targets an independent theme part.
- Confirm every `p:sp` contains `p:txBody` and every solid `p:bgPr` contains an effect list.
- Test documented shape aliases and rejection of an unknown preset.
- Run LibreOffice rendering when `soffice` is available.
- Confirm Keynote/universal generation rejects every native chart slot and names the offending location.
- Generate a chart-free or PNG-chart Keynote-safe deck and run the Keynote viewer test; separately confirm `--keynote` rejects a PptxGenJS native-chart deck instead of reporting a false pass.
- Run Keynote and PowerPoint tests on macOS when those target applications are installed.
- Confirm the generated and validated SHA-256 values match, the validator reports the expected slide count, and the delivered basename is unique to this revision.
- Inspect rendered pages and confirm every chart contains visible axes/marks/labels as applicable.
- Test an intentionally unnormalized PptxGenJS chart deck and confirm validation rejects it.
- Run the negative package fixtures for malformed/non-finite XML, invalid relationship IDs/target modes, missing or wrong-type `r:id`, prefixed Relationships, wrong relationship targets, corrupt embedded workbooks, invalid presentation order or bullet percentages, relative Override part names, wrong PNG MIME, duplicate slide/object/series IDs, orphan layouts, non-reciprocal notes, incompatible notes-master placeholders, missing text bodies/background effects, shared notes themes, missing chart axes, ghost masters, and invalid table dimensions.
- Confirm valid `roundedCorners` values survive normalization unchanged.
- Keep `pptxgenjs` pinned; do not change the version without repeating this checklist.

## Static Images

`type: "image"` is required for Keynote/universal chart delivery and remains valid when the user explicitly wants a static chart or requests a type without native support such as candlestick or heatmap. Use `gen-chart` to render the same source data as PNG, inspect the rendered slide, and disclose that the chart is no longer natively editable. PowerPoint-only mode keeps supported charts native. Do not switch silently or emit an unverified native PPTX.
