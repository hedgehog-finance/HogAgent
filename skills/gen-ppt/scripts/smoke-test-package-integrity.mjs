#!/usr/bin/env node
/** Regression test for package content types, notes masters, and preset shapes. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import { normalizeAndValidatePptx, validatePptxPackage } from "./pptx-ooxml.mjs";
import { parseViewerArgs } from "./cli-args.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
let parsedArgs;
try {
  parsedArgs = parseViewerArgs(process.argv.slice(2), { requireFile: false });
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
if (parsedArgs.help) {
  console.log("Usage: smoke-test-package-integrity.mjs [--libreoffice] [--keynote] [--powerpoint]");
  process.exit(0);
}
const viewerFlags = Object.keys(parsedArgs.options).map((name) => `--${name}`);
const workDir = mkdtempSync(join(tmpdir(), "gen-ppt-package-integrity-"));
const keynoteRequested = viewerFlags.includes("--keynote");
const positiveViewerFlags = viewerFlags.filter((flag) => flag !== "--keynote");

function run(command, args, expectSuccess = true) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, timeout: 300_000 });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (expectSuccess && (result.error || result.status !== 0)) throw new Error(output.trim() || result.error?.message || `${command} failed`);
  if (!expectSuccess && !result.error && result.status === 0) throw new Error(`Expected failure but command succeeded: ${command} ${args.join(" ")}`);
  return output;
}

async function mutatePackage(buffer, mutate) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  await mutate(zip);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function expectFailure(label, operation, expected) {
  try {
    await operation();
  } catch (error) {
    if (!String(error.message).includes(expected)) throw new Error(`${label} failed for the wrong reason: ${error.message}`);
    return;
  }
  throw new Error(`${label} unexpectedly passed`);
}

try {
  const configPath = join(workDir, "package-integrity.json");
  const outputPath = join(workDir, "package-integrity.pptx");
  writeFileSync(configPath, JSON.stringify({
    title: "Package integrity smoke test",
    slides: [
      { layout: "title", title: "Valid OOXML package", notes: "PACKAGE_INTEGRITY_NOTE" },
      { layout: "blank", elements: [
        { type: "shape", shape: "oval", x: 1, y: 1, w: 2, h: 1, options: { fill: { color: "4472C4" } } },
        { type: "shape", shape: "roundedRectangle", x: 4, y: 1, w: 2, h: 1, options: { fill: { color: "70AD47" } } },
        { type: "shape", shape: "arrow", x: 7, y: 1, w: 2, h: 1, options: { fill: { color: "ED7D31" } } },
      ] },
      { layout: "blank", elements: [
        { type: "chart", x: 0.8, y: 0.8, w: 7, h: 4.8, content: {
          type: "bar",
          data: [
            { name: "Series 1", labels: ["A", "B", "C"], values: [1, 3, 2] },
            { name: "Series 2", labels: ["A", "B", "C"], values: [2, 1, 4] },
          ],
        } },
        { type: "image", x: 8.5, y: 1, w: 1, h: 1, content: {
          data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        } },
      ] },
      { layout: "content", title: "Schema-valid bullets", bullets: ["First point", "Second point"] },
      { layout: "closing", title: "Validated" },
    ],
  }, null, 2));

  const generationOutput = run(process.execPath, [join(scriptDir, "gen-ppt.mjs"), configPath, outputPath]);
  if (!/\b\d+ OOXML fixes\b/.test(generationOutput) || generationOutput.includes("NaN OOXML fixes")) {
    throw new Error(`Generation reported an invalid OOXML repair count: ${generationOutput.trim()}`);
  }
  if (!/GenPPT \d+\.\d+\.\d+/.test(generationOutput) || !/SHA-256 [a-f0-9]{64}/.test(generationOutput)) {
    throw new Error(`Generation did not report an auditable version and fingerprint: ${generationOutput.trim()}`);
  }
  const invalidBase64Path = join(workDir, "tmp-gen-ppt-invalid-base64.json");
  writeFileSync(invalidBase64Path, JSON.stringify({
    slides: [{ layout: "blank", elements: [{
      type: "image", x: 1, y: 1, w: 1, h: 1, content: { data: "not-valid-base64!" },
    }] }],
  }));
  const invalidBase64Failure = run(
    process.execPath,
    [join(scriptDir, "gen-ppt.mjs"), invalidBase64Path, join(workDir, "invalid-base64.pptx")],
    false,
  );
  if (!invalidBase64Failure.includes("valid base64 encoding")) {
    throw new Error(`Invalid base64 failed for the wrong reason: ${invalidBase64Failure.trim()}`);
  }
  const validationOutput = run(process.execPath, [join(scriptDir, "validate-pptx.mjs"), outputPath, ...positiveViewerFlags]);
  if (!/Artifact verified: .*; \d+ bytes; SHA-256 [a-f0-9]{64}/.test(validationOutput) || !/5 slides/.test(validationOutput)) {
    throw new Error(`Validation did not report the exact artifact fingerprint and slide count: ${validationOutput.trim()}`);
  }
  if (keynoteRequested) {
    const nativeChartFailure = run(process.execPath, [join(scriptDir, "validate-pptx.mjs"), outputPath, "--keynote"], false);
    if (!nativeChartFailure.includes("PptxGenJS deck contains 1 native chart")) {
      throw new Error(`Keynote native-chart guard failed for the wrong reason: ${nativeChartFailure.trim()}`);
    }

    const keynoteConfigPath = join(workDir, "keynote-safe.json");
    const keynoteOutputPath = join(workDir, "keynote-safe.pptx");
    writeFileSync(keynoteConfigPath, JSON.stringify({
      targetViewer: "keynote",
      slides: [
        { layout: "title", title: "Keynote-safe PPTX", subtitle: "Native charts are replaced with PNG before generation" },
        { layout: "content", title: "Viewer validation", bullets: ["Text and shapes remain editable", "Chart images remain visible"] },
      ],
    }));
    run(process.execPath, [join(scriptDir, "gen-ppt.mjs"), keynoteConfigPath, keynoteOutputPath, "--target=keynote"]);
    const keynoteValidation = run(process.execPath, [join(scriptDir, "validate-pptx.mjs"), keynoteOutputPath, "--keynote"]);
    if (!keynoteValidation.includes("Keynote open/render test passed")) {
      throw new Error(`Keynote-safe deck did not pass viewer validation: ${keynoteValidation.trim()}`);
    }
  }

  const zip = await JSZip.loadAsync(readFileSync(outputPath), { checkCRC32: true });
  const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const masters = files.filter((name) => /^ppt\/slideMasters\/[^/]+\.xml$/.test(name));
  const contentTypes = await zip.file("[Content_Types].xml").async("string");
  const masterOverrides = [...contentTypes.matchAll(/<Override\b[^>]*PartName="\/(ppt\/slideMasters\/[^\"]+\.xml)"[^>]*>/g)].map((match) => match[1]);
  if (masterOverrides.length !== masters.length || masterOverrides.some((name) => !masters.includes(name))) {
    throw new Error(`Content type slide-master declarations do not match package parts: ${masterOverrides.join(", ")}`);
  }
  if (contentTypes.includes('ContentType="image/jpg"')) throw new Error("Non-standard image/jpg MIME type survived normalization");
  const chartXml = await zip.file("ppt/charts/chart1.xml").async("string");
  if (!/<c:roundedCorners\b[^>]*val="1"/.test(chartXml)) throw new Error("Valid chart rounded-corner intent was not preserved");

  const notesMaster = await zip.file("ppt/notesMasters/notesMaster1.xml").async("string");
  const notesMasterPlaceholderTypes = [...notesMaster.matchAll(/<p:ph\b[^>]*\btype="([^"]+)"/g)].map((match) => match[1]);
  for (const type of ["hdr", "dt", "sldImg", "body", "ftr", "sldNum"]) {
    if (notesMasterPlaceholderTypes.filter((candidate) => candidate === type).length !== 1) {
      throw new Error(`Notes master did not retain exactly one ${type} placeholder`);
    }
  }
  if (notesMasterPlaceholderTypes.length !== 6) throw new Error("Notes master did not retain exactly six placeholder shapes");
  const notesMasterRels = await zip.file("ppt/notesMasters/_rels/notesMaster1.xml.rels").async("string");
  const notesThemeTarget = notesMasterRels.match(/Type="[^"]*\/theme"[^>]*Target="([^"]+)"/)?.[1];
  if (!notesThemeTarget || notesThemeTarget === "../theme/theme1.xml") throw new Error("Notes master did not receive an independent theme");
  if (!zip.file(`ppt/${notesThemeTarget.replace(/^\.\.\//, "")}`)) throw new Error(`Independent notes theme is missing: ${notesThemeTarget}`);
  const notesSlides = files.filter((name) => /^ppt\/notesSlides\/[^/]+\.xml$/.test(name));
  const notesText = (await Promise.all(notesSlides.map((name) => zip.file(name).async("string")))).join("");
  if (!notesText.includes("PACKAGE_INTEGRITY_NOTE")) throw new Error("Speaker note content was lost during notes-master normalization");

  const emptyNotesMaster = await mutatePackage(readFileSync(outputPath), async (badZip) => {
    const part = "ppt/notesMasters/notesMaster1.xml";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g, (shape) => /<p:ph\b/.test(shape) ? "" : shape));
  });
  await expectFailure("Empty notes master", () => validatePptxPackage(emptyNotesMaster), "notes master must retain exactly six PowerPoint placeholder shapes");

  const partialNotesMaster = await mutatePackage(readFileSync(outputPath), async (badZip) => {
    const part = "ppt/notesMasters/notesMaster1.xml";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/<p:sp\b[^>]*>[\s\S]*?<p:ph\b[^>]*type="hdr"[\s\S]*?<\/p:sp>/, ""));
  });
  await expectFailure("Partial notes master", () => validatePptxPackage(partialNotesMaster), "notes master must retain exactly six PowerPoint placeholder shapes");

  const drawingXml = (await Promise.all(files
    .filter((name) => /^ppt\/(?:slides|slideLayouts|slideMasters|notesMasters|notesSlides)\/[^/]+\.xml$/.test(name))
    .map((name) => zip.file(name).async("string")))).join("");
  if (!/<a:buSzPct\b[^>]*val="100%"/.test(drawingXml)) throw new Error("Schema-valid bullet percentage was not emitted");
  if (/<a:buSzPct\b[^>]*val="100000"/.test(drawingXml)) throw new Error("PptxGenJS decimal bullet percentage survived normalization");
  for (const shape of drawingXml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)) {
    if (!/<p:txBody\b/.test(shape[1])) throw new Error("A p:sp without p:txBody survived normalization");
  }
  for (const background of drawingXml.matchAll(/<p:bgPr\b[^>]*>([\s\S]*?)<\/p:bgPr>/g)) {
    if (/<a:solidFill\b/.test(background[1]) && !/<a:(?:effectLst|effectDag)\b/.test(background[1])) {
      throw new Error("A solid p:bgPr without a:effectLst survived normalization");
    }
  }
  for (const expected of ["ellipse", "roundRect", "rightArrow"]) {
    if (!drawingXml.includes(`prst="${expected}"`)) throw new Error(`Expected normalized shape ${expected} was not emitted`);
  }
  for (const invalid of ["oval", "roundedRectangle", "arrow"]) {
    if (drawingXml.includes(`prst="${invalid}"`)) throw new Error(`Invalid DrawingML shape ${invalid} survived normalization`);
  }

  const badShapePath = join(workDir, "bad-shape.json");
  writeFileSync(badShapePath, JSON.stringify({ slides: [{ layout: "blank", elements: [{ type: "shape", shape: "notARealShape" }] }] }));
  const badShapeFailure = run(process.execPath, [join(scriptDir, "gen-ppt.mjs"), badShapePath, join(workDir, "bad-shape.pptx")], false);
  if (!badShapeFailure.includes("Unsupported shape")) throw new Error(`Invalid shape failed for the wrong reason: ${badShapeFailure.trim()}`);

  const badMarginPath = join(workDir, "bad-margin.json");
  writeFileSync(badMarginPath, JSON.stringify({ slides: [{ layout: "blank", elements: [{
    type: "table", x: 1, y: 1, w: 6, h: 3,
    content: { headers: ["A"], rows: [["B"]], options: { margin: { top: 1 } } },
  }] }] }));
  const badMarginFailure = run(process.execPath, [join(scriptDir, "gen-ppt.mjs"), badMarginPath, join(workDir, "bad-margin.pptx")], false);
  if (!badMarginFailure.includes("table.options.margin")) throw new Error(`Invalid table margin failed for the wrong reason: ${badMarginFailure.trim()}`);

  const badRowHeightPath = join(workDir, "bad-row-height.json");
  writeFileSync(badRowHeightPath, JSON.stringify({ slides: [{ layout: "blank", elements: [{
    type: "table", x: 1, y: 1, w: 6, h: 3,
    content: { headers: ["A"], rows: [["B"]], options: { rowH: ["bad"] } },
  }] }] }));
  const badRowHeightFailure = run(process.execPath, [join(scriptDir, "gen-ppt.mjs"), badRowHeightPath, join(workDir, "bad-row-height.pptx")], false);
  if (!badRowHeightFailure.includes("table.options.rowH")) throw new Error(`Invalid table row height failed for the wrong reason: ${badRowHeightFailure.trim()}`);

  const validBuffer = readFileSync(outputPath);
  const invalidXml = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/slides/slide1.xml";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/<a:t>([^<]*)<\/a:t>/, "<a:t>$1 & invalid</a:t>"));
  });
  await expectFailure("Non-well-formed XML", () => validatePptxPackage(invalidXml), "invalid XML");

  const missingRelationship = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/slides/slide3.xml";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/(<c:chart\b[^>]*r:id=")[^"]+/, "$1rId9999"));
  });
  await expectFailure("Missing r:id", () => validatePptxPackage(missingRelationship), "references missing relationship rId9999");

  const invalidRelationshipId = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/slides/_rels/slide3.xml.rels";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/(<Relationship\b[^>]*\bId=")[^"]+/, "$1bad id"));
  });
  await expectFailure("Invalid relationship Id", () => validatePptxPackage(invalidRelationshipId), "invalid relationship Id bad id");

  const invalidRelationshipTargetMode = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/slides/_rels/slide3.xml.rels";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/<Relationship\b[^>]*\/>/, (tag) => tag.replace(/\/>$/, ' TargetMode="Bogus"/>')));
  });
  await expectFailure("Invalid relationship TargetMode", () => validatePptxPackage(invalidRelationshipTargetMode), "invalid TargetMode Bogus");

  const wrongRelationshipKind = await mutatePackage(validBuffer, async (badZip) => {
    const slidePart = "ppt/slides/slide3.xml";
    const relPart = "ppt/slides/_rels/slide3.xml.rels";
    const slideXml = await badZip.file(slidePart).async("string");
    const relXml = await badZip.file(relPart).async("string");
    const imageRelationshipId = relXml.match(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Type="[^"]*\/image"/)?.[1];
    if (!imageRelationshipId) throw new Error("Test fixture is missing an image relationship");
    badZip.file(slidePart, slideXml.replace(/(<c:chart\b[^>]*r:id=")[^"]+/, `$1${imageRelationshipId}`));
  });
  await expectFailure("Wrong relationship kind", () => validatePptxPackage(wrongRelationshipKind), "must reference chart, found image");

  const invalidEmbeddedWorkbook = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx";
    if (!badZip.file(part)) throw new Error("Test fixture is missing an embedded chart workbook");
    badZip.file(part, Buffer.from("not an OPC package"));
  });
  await expectFailure("Invalid embedded workbook", () => validatePptxPackage(invalidEmbeddedWorkbook), "invalid embedded workbook package");

  const chartTargetsImage = await mutatePackage(validBuffer, async (badZip) => {
    const relPart = "ppt/slides/_rels/slide3.xml.rels";
    const relXml = await badZip.file(relPart).async("string");
    const imageTarget = relXml.match(/<Relationship\b[^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"/)?.[1];
    if (!imageTarget) throw new Error("Test fixture is missing an image target");
    badZip.file(relPart, relXml.replace(/(<Relationship\b[^>]*Type="[^"]*\/chart"[^>]*Target=")[^"]+/, `$1${imageTarget}`));
  });
  await expectFailure("Chart relationship target type", () => validatePptxPackage(chartTargetsImage), "has chart type but targets ppt/media/");

  const prefixedRelationship = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/slides/_rels/slide1.xml.rels";
    const xml = await badZip.file(part).async("string");
    const prefixed = xml
      .replace(/<Relationships\s+xmlns="([^"]+)"/, '<rel:Relationships xmlns:rel="$1"')
      .replace(/<Relationship\b/g, "<rel:Relationship")
      .replace(/<\/Relationships>/g, "</rel:Relationships>")
      .replace(/Target="[^"]+"/, 'Target="../missing/slideLayout999.xml"');
    badZip.file(part, prefixed);
  });
  await expectFailure("Prefixed Relationship", () => validatePptxPackage(prefixedRelationship), "targets missing part");

  const wrongPngMime = await mutatePackage(validBuffer, async (badZip) => {
    const part = "[Content_Types].xml";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/<Default\b[^>]*Extension="png"[^>]*\/>/, (tag) => tag.replace(/ContentType="[^"]+"/, 'ContentType="text/plain"')));
  });
  await expectFailure("Wrong PNG MIME", () => validatePptxPackage(wrongPngMime), ".png must use image/png");

  const relativeOverridePartName = await mutatePackage(validBuffer, async (badZip) => {
    const part = "[Content_Types].xml";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/(<Override\b[^>]*PartName=")\//, "$1"));
  });
  await expectFailure("Relative Override PartName", () => validatePptxPackage(relativeOverridePartName), "Override PartName must start with /");

  const missingTextBody = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/slides/slide2.xml";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/(<p:sp\b[^>]*>[\s\S]*?)<p:txBody>[\s\S]*?<\/p:txBody>/, "$1"));
  });
  await expectFailure("Missing p:txBody", () => validatePptxPackage(missingTextBody), "missing required p:txBody");

  const missingBackgroundEffect = await mutatePackage(validBuffer, async (badZip) => {
    let changed = false;
    for (const part of Object.keys(badZip.files).filter((name) => /^ppt\/(?:slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(name))) {
      const xml = await badZip.file(part).async("string");
      const mutated = xml.replace(/(<p:bgPr\b[^>]*>[\s\S]*?<a:solidFill\b[\s\S]*?<\/a:solidFill>)\s*<a:effectLst\s*\/>/, "$1");
      if (mutated !== xml) {
        badZip.file(part, mutated);
        changed = true;
        break;
      }
    }
    if (!changed) throw new Error("Test fixture contains no normalized solid background");
  });
  await expectFailure("Missing background effect", () => validatePptxPackage(missingBackgroundEffect), "missing a:effectLst");

  const sharedNotesTheme = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/notesMasters/_rels/notesMaster1.xml.rels";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/Target="\.\.\/theme\/theme\d+\.xml"/, 'Target="../theme/theme1.xml"'));
  });
  await expectFailure("Shared notes theme", () => validatePptxPackage(sharedNotesTheme), "must not reuse a slide-master theme");

  const mismatchedNotesSlide = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/notesSlides/_rels/notesSlide1.xml.rels";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/(Type="[^"]*\/slide"[^>]*Target=")\.\.\/slides\/slide1\.xml/, "$1../slides/slide2.xml"));
  });
  await expectFailure("Mismatched notes slide", () => validatePptxPackage(mismatchedNotesSlide), "but is owned by ppt/slides/slide1.xml");

  const orphanSlideLayout = await mutatePackage(validBuffer, async (badZip) => {
    const masterPart = "ppt/slideMasters/slideMaster1.xml";
    const relPart = "ppt/slideMasters/_rels/slideMaster1.xml.rels";
    const masterXml = await badZip.file(masterPart).async("string");
    const relXml = await badZip.file(relPart).async("string");
    const relationshipTag = relXml.match(/<Relationship\b(?=[^>]*Type="[^"]*\/slideLayout")(?=[^>]*Target="\.\.\/slideLayouts\/slideLayout1\.xml")[^>]*\/>/)?.[0];
    const relationshipId = relationshipTag?.match(/\bId="([^"]+)"/)?.[1];
    if (!relationshipTag || !relationshipId) throw new Error("Test fixture is missing the slideLayout1 relationship");
    badZip.file(relPart, relXml.replace(relationshipTag, ""));
    badZip.file(masterPart, masterXml.replace(new RegExp(`<p:sldLayoutId\\b(?=[^>]*r:id="${relationshipId}")[^>]*/>`), ""));
  });
  await expectFailure("Orphan slide layout", () => validatePptxPackage(orphanSlideLayout), "slide layout is not referenced by a slide master");

  const duplicateSlideReference = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/presentation.xml";
    const xml = await badZip.file(part).async("string");
    const slideRelationshipIds = [...xml.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((match) => match[1]);
    if (slideRelationshipIds.length < 2) throw new Error("Test fixture needs at least two slides");
    badZip.file(part, xml.replace(`r:id="${slideRelationshipIds[1]}"`, `r:id="${slideRelationshipIds[0]}"`));
  });
  await expectFailure("Duplicate slide reference", () => validatePptxPackage(duplicateSlideReference), "duplicate sldId relationship reference");

  const invalidPresentationOrder = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/presentation.xml";
    const xml = await badZip.file(part).async("string");
    const notesMasterList = xml.match(/<p:notesMasterIdLst\b[\s\S]*?<\/p:notesMasterIdLst>/)?.[0];
    if (!notesMasterList) throw new Error("Test fixture is missing notesMasterIdLst");
    badZip.file(part, xml.replace(notesMasterList, "").replace(/<\/p:sldIdLst>/, `</p:sldIdLst>${notesMasterList}`));
  });
  await expectFailure("Presentation child order", () => validatePptxPackage(invalidPresentationOrder), "presentation child notesMasterIdLst is out of OOXML schema order");

  const duplicateSlideNumericId = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/presentation.xml";
    const xml = await badZip.file(part).async("string");
    const slideIds = [...xml.matchAll(/<p:sldId\b[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
    let occurrence = 0;
    badZip.file(part, xml.replace(/<p:sldId\b[^>]*>/g, (tag) => {
      occurrence += 1;
      return occurrence === 2 ? tag.replace(/\sid="[^"]+"/, ` id="${slideIds[0]}"`) : tag;
    }));
  });
  await expectFailure("Duplicate slide numeric id", () => validatePptxPackage(duplicateSlideNumericId), "duplicate sldId id");

  const duplicateDrawingObjectId = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/slides/slide2.xml";
    const xml = await badZip.file(part).async("string");
    const objectIds = [...xml.matchAll(/<p:cNvPr\b[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
    let occurrence = 0;
    badZip.file(part, xml.replace(/<p:cNvPr\b[^>]*>/g, (tag) => {
      occurrence += 1;
      return occurrence === 2 ? tag.replace(/\sid="[^"]+"/, ` id="${objectIds[0]}"`) : tag;
    }));
  });
  await expectFailure("Duplicate drawing object id", () => validatePptxPackage(duplicateDrawingObjectId), "duplicate drawing object id");

  const invalidDrawingObjectId = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/slides/slide2.xml";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/(<p:cNvPr\b[^>]*\bid=")[^"]+/, "$1not-a-number"));
  });
  await expectFailure("Invalid drawing object id", () => validatePptxPackage(invalidDrawingObjectId), "expected an unsigned integer");

  const invalidBulletPercentage = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/slides/slide4.xml";
    const xml = await badZip.file(part).async("string");
    if (!/<a:buSzPct\b[^>]*val="100%"/.test(xml)) throw new Error("Test fixture is missing a bullet percentage");
    badZip.file(part, xml.replace(/(<a:buSzPct\b[^>]*\bval=")100%/, "$1100000"));
  });
  await expectFailure("Bullet percentage lexical form", () => validatePptxPackage(invalidBulletPercentage), "a:buSzPct@val must be an ECMA-376 percentage");

  const duplicateChartSeriesIndex = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/charts/chart1.xml";
    const xml = await badZip.file(part).async("string");
    let occurrence = 0;
    badZip.file(part, xml.replace(/<c:idx\b[^>]*val="[^"]+"\s*\/>/g, (tag) => {
      occurrence += 1;
      return occurrence === 2 ? tag.replace(/val="[^"]+"/, 'val="0"') : tag;
    }));
  });
  await expectFailure("Duplicate chart series index", () => validatePptxPackage(duplicateChartSeriesIndex), "duplicate series idx 0");

  const nonFiniteAttribute = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/slides/slide2.xml";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/\bx="[^"]+"/, 'x="NaN"'));
  });
  await expectFailure("Non-finite OOXML attribute", () => validatePptxPackage(nonFiniteAttribute), "non-finite OOXML attribute x=\"NaN\"");

  const missingAxes = await mutatePackage(validBuffer, async (badZip) => {
    const part = "ppt/charts/chart1.xml";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/<c:(?:catAx|dateAx|valAx|serAx)>[\s\S]*?<\/c:(?:catAx|dateAx|valAx|serAx)>/g, ""));
  });
  await expectFailure("Missing chart axes", () => validatePptxPackage(missingAxes), "orphan axis id");
  await expectFailure("Axis normalization fail-closed", () => normalizeAndValidatePptx(missingAxes), "orphan axis id");

  const ghostMaster = await mutatePackage(validBuffer, async (badZip) => {
    const part = "[Content_Types].xml";
    const xml = await badZip.file(part).async("string");
    badZip.file(part, xml.replace(/<\/Types>/, '<Override PartName="/ppt/slideMasters/slideMaster999.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/></Types>'));
  });
  await expectFailure("Ghost slide master", () => validatePptxPackage(ghostMaster), "Override targets missing part /ppt/slideMasters/slideMaster999.xml");

  console.log(`Package integrity smoke test passed${viewerFlags.length ? ` (${viewerFlags.join(", ")})` : ""}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
