/**
 * Normalize and validate OOXML emitted by PptxGenJS.
 *
 * PptxGenJS 4.0.1 emits package, notes-master, and chart parts that stricter
 * consumers reject or repair. Keep this module deterministic: it only repairs
 * known compatibility issues and fails closed when the resulting package is
 * internally inconsistent.
 */

import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import { SaxesParser } from "saxes";
import { posix as path } from "node:path";

const CHART_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/chart",
  "http://purl.oclc.org/ooxml/drawingml/chart",
]);
const CONTENT_TYPES_PART = "[Content_Types].xml";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const PRESENTATION_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://purl.oclc.org/ooxml/presentationml/main",
]);
const DRAWING_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
]);
const SLIDE_MASTER_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml";
const THEME_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.theme+xml";
const REQUIRED_OVERRIDE_TYPES = [
  [/^ppt\/presentation\.xml$/, "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],
  [/^ppt\/slides\/[^/]+\.xml$/, "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"],
  [/^ppt\/slideLayouts\/[^/]+\.xml$/, "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"],
  [/^ppt\/slideMasters\/[^/]+\.xml$/, SLIDE_MASTER_CONTENT_TYPE],
  [/^ppt\/notesMasters\/[^/]+\.xml$/, "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"],
  [/^ppt\/notesSlides\/[^/]+\.xml$/, "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"],
  [/^ppt\/charts\/[^/]+\.xml$/, "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"],
  [/^ppt\/theme\/[^/]+\.xml$/, THEME_CONTENT_TYPE],
];
const MEDIA_CONTENT_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["svg", "image/svg+xml"],
]);
const INTERNAL_REL_TARGET_PATTERNS = new Map([
  ["slide", /^ppt\/slides\/[^/]+\.xml$/],
  ["slideLayout", /^ppt\/slideLayouts\/[^/]+\.xml$/],
  ["slideMaster", /^ppt\/slideMasters\/[^/]+\.xml$/],
  ["notesSlide", /^ppt\/notesSlides\/[^/]+\.xml$/],
  ["notesMaster", /^ppt\/notesMasters\/[^/]+\.xml$/],
  ["theme", /^ppt\/theme\/[^/]+\.xml$/],
  ["chart", /^ppt\/charts\/[^/]+\.xml$/],
  ["package", /^ppt\/embeddings\/[^/]+\.xlsx$/i],
  ["image", /^ppt\/media\/[^/]+$/],
]);
const MINIMAL_TEXT_BODY = "<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>";
const VALID_PRESET_SHAPES = new Set(Object.values(new pptxgen().ShapeType));

// ECMA-376 Part 1, CT_Presentation. PowerPoint is sensitive to this sequence;
// PptxGenJS 4.0.1 emits notesMasterIdLst after sldIdLst.
const PRESENTATION_CHILD_ORDER = [
  "sldMasterIdLst",
  "notesMasterIdLst",
  "handoutMasterIdLst",
  "sldIdLst",
  "sldSz",
  "notesSz",
  "smartTags",
  "embeddedFontLst",
  "custShowLst",
  "photoAlbum",
  "custDataLst",
  "kinsoku",
  "defaultTextStyle",
  "modifyVerifier",
  "extLst",
];

const CHART_CHILD_ORDER = {
  lineChart: ["grouping", "varyColors", "ser", "dLbls", "dropLines", "hiLowLines", "upDownBars", "marker", "smooth", "axId", "extLst"],
  barChart: ["barDir", "grouping", "varyColors", "ser", "dLbls", "gapWidth", "overlap", "serLines", "axId", "extLst"],
  areaChart: ["grouping", "varyColors", "ser", "dLbls", "dropLines", "axId", "extLst"],
  scatterChart: ["scatterStyle", "varyColors", "ser", "dLbls", "axId", "extLst"],
  radarChart: ["radarStyle", "varyColors", "ser", "dLbls", "axId", "extLst"],
  pieChart: ["varyColors", "ser", "dLbls", "firstSliceAng", "extLst"],
  doughnutChart: ["varyColors", "ser", "dLbls", "firstSliceAng", "holeSize", "extLst"],
};

const SERIES_CHILD_ORDER = {
  lineChart: ["idx", "order", "tx", "spPr", "marker", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "smooth", "extLst"],
  barChart: ["idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "shape", "extLst"],
  areaChart: ["idx", "order", "tx", "spPr", "pictureOptions", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "extLst"],
  scatterChart: ["idx", "order", "tx", "spPr", "marker", "dPt", "dLbls", "trendline", "errBars", "xVal", "yVal", "smooth", "extLst"],
  radarChart: ["idx", "order", "tx", "spPr", "marker", "dPt", "dLbls", "cat", "val", "extLst"],
  pieChart: ["idx", "order", "tx", "spPr", "explosion", "dPt", "dLbls", "cat", "val", "extLst"],
  doughnutChart: ["idx", "order", "tx", "spPr", "explosion", "dPt", "dLbls", "cat", "val", "extLst"],
};

const FORBIDDEN_SERIES_CHILDREN = {
  lineChart: new Set(["invertIfNegative"]),
  areaChart: new Set(["invertIfNegative"]),
  radarChart: new Set(["invertIfNegative"]),
};

function localName(qname) {
  return qname.includes(":") ? qname.slice(qname.indexOf(":") + 1) : qname;
}

function getAttribute(xml, name) {
  const match = xml.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`));
  return match?.[2];
}

function setAttribute(xml, name, value) {
  const pattern = new RegExp(`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`);
  if (!pattern.test(xml)) throw new Error(`Cannot update missing ${name} attribute`);
  return xml.replace(pattern, `$1"${value}"`);
}

function parseXmlDocument(xml, partName) {
  const roots = [];
  const stack = [];
  let parseError;
  const parser = new SaxesParser({ xmlns: true });

  parser.on("error", (error) => {
    parseError ||= error;
  });
  parser.on("doctype", () => {
    parseError ||= new Error("DOCTYPE is not permitted in OOXML parts");
  });
  parser.on("opentag", (tag) => {
    const attributes = Object.values(tag.attributes).map((attribute) => ({
      name: attribute.name,
      local: attribute.local,
      uri: attribute.uri,
      value: attribute.value,
    }));
    const nonFiniteAttribute = attributes.find((attribute) => /^(?:NaN|[+-]?Infinity)$/i.test(attribute.value));
    if (nonFiniteAttribute) parseError ||= new Error(`non-finite OOXML attribute ${nonFiniteAttribute.name}="${nonFiniteAttribute.value}"`);
    const node = {
      name: tag.name,
      local: tag.local,
      uri: tag.uri,
      attributes,
      children: [],
    };
    if (stack.length) stack.at(-1).children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => stack.pop());

  try {
    parser.write(xml).close();
  } catch (error) {
    parseError ||= error;
  }
  if (parseError) throw new Error(`${partName}: invalid XML: ${parseError.message}`);
  if (roots.length !== 1) throw new Error(`${partName}: XML part must contain exactly one document element`);
  return roots[0];
}

function attributeValue(node, local, namespace = "") {
  return node.attributes.find((attribute) => attribute.local === local && attribute.uri === namespace)?.value;
}

function descendants(node, predicate, output = []) {
  if (predicate(node)) output.push(node);
  for (const child of node.children) descendants(child, predicate, output);
  return output;
}

function directChild(node, local, namespaces) {
  return node.children.find((child) => child.local === local && (!namespaces || namespaces.has(child.uri)));
}

function canonicalUnsignedInt(value, context) {
  if (!/^\d+$/.test(value || "")) throw new Error(`${context}: expected an unsigned integer, found ${value || "(missing)"}`);
  const numeric = BigInt(value);
  if (numeric > 4294967295n) throw new Error(`${context}: unsigned integer exceeds 32-bit OOXML range`);
  return numeric.toString();
}

function isValidRelationshipId(value) {
  // OPC Relationship/@Id is xsd:ID, whose lexical space is an XML NCName.
  return /^[_\p{L}][_\p{L}\p{N}\p{M}\p{Pc}.\-]*$/u.test(value || "");
}

function normalizePackagePartName(partName) {
  const withoutRootSlash = partName.startsWith("/") ? partName.slice(1) : partName;
  let decoded = withoutRootSlash;
  try {
    decoded = decodeURIComponent(withoutRootSlash);
  } catch {
    // Keep the encoded form so validation can still report the exact target.
  }
  const normalized = path.normalize(decoded);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Invalid package part name: ${partName}`);
  }
  if (normalized !== decoded) throw new Error(`Package part name is not canonical: ${partName}`);
  return normalized;
}

function parseContentTypes(xml, partName = CONTENT_TYPES_PART) {
  const root = parseXmlDocument(xml, partName);
  if (root.local !== "Types" || root.uri !== CONTENT_TYPES_NS) {
    throw new Error(`${partName}: expected the OPC content-types document element`);
  }
  const defaults = [];
  const overrides = [];
  for (const child of root.children) {
    if (child.uri !== CONTENT_TYPES_NS) continue;
    if (child.local === "Default") {
      defaults.push({ extension: attributeValue(child, "Extension"), contentType: attributeValue(child, "ContentType") });
    } else if (child.local === "Override") {
      overrides.push({ partName: attributeValue(child, "PartName"), contentType: attributeValue(child, "ContentType") });
    }
  }
  return { defaults, overrides };
}

function normalizeContentTypesXml(xml, files) {
  parseContentTypes(xml);
  const preservedRequiredParts = new Set();
  let normalizedCount = 0;
  let normalized = xml.replace(/<(?:[A-Za-z_][\w.-]*:)?Override\b[^>]*\/?\s*>/g, (tag) => {
    const partName = getAttribute(tag, "PartName");
    const contentType = getAttribute(tag, "ContentType");
    if (!partName) return tag;
    const normalizedPart = normalizePackagePartName(partName);
    const expected = REQUIRED_OVERRIDE_TYPES.find(([pattern]) => pattern.test(normalizedPart))?.[1];
    if (!expected) return tag;
    if (!files.has(normalizedPart) || preservedRequiredParts.has(normalizedPart)) {
      normalizedCount += 1;
      return "";
    }
    preservedRequiredParts.add(normalizedPart);
    if (contentType !== expected) {
      normalizedCount += 1;
      return setAttribute(tag, "ContentType", expected);
    }
    return tag;
  });

  const rootPrefix = normalized.match(/<([A-Za-z_][\w.-]*:)?Types\b/)?.[1] || "";
  for (const partName of files) {
    const expected = REQUIRED_OVERRIDE_TYPES.find(([pattern]) => pattern.test(partName))?.[1];
    if (!expected || preservedRequiredParts.has(partName)) continue;
    const override = `<${rootPrefix}Override PartName="/${partName}" ContentType="${expected}"/>`;
    const closing = new RegExp(`<\\/${rootPrefix}Types\\s*>`);
    if (!closing.test(normalized)) throw new Error(`${CONTENT_TYPES_PART}: cannot append Override`);
    normalized = normalized.replace(closing, `${override}</${rootPrefix}Types>`);
    preservedRequiredParts.add(partName);
    normalizedCount += 1;
  }

  normalized = normalized.replace(/<(?:[A-Za-z_][\w.-]*:)?Default\b[^>]*\/?\s*>/g, (tag) => {
    const extension = getAttribute(tag, "Extension")?.toLowerCase();
    const expected = MEDIA_CONTENT_TYPES.get(extension);
    if (expected && getAttribute(tag, "ContentType") !== expected) {
      normalizedCount += 1;
      return setAttribute(tag, "ContentType", expected);
    }
    return tag;
  });
  return { xml: normalized, normalizedCount };
}

function validateContentTypesXml(xml, files) {
  if (!xml) throw new Error(`${CONTENT_TYPES_PART}: missing XML content`);
  const { defaults, overrides } = parseContentTypes(xml);
  const extensions = new Map();
  const parts = new Map();

  for (const entry of defaults) {
    if (!entry.extension || !entry.contentType) throw new Error(`${CONTENT_TYPES_PART}: Default is missing Extension or ContentType`);
    const extension = entry.extension.toLowerCase();
    if (extensions.has(extension)) throw new Error(`${CONTENT_TYPES_PART}: duplicate Default for .${extension}`);
    const expected = MEDIA_CONTENT_TYPES.get(extension);
    if (expected && entry.contentType !== expected) throw new Error(`${CONTENT_TYPES_PART}: .${extension} must use ${expected}`);
    extensions.set(extension, entry.contentType);
  }

  for (const entry of overrides) {
    if (!entry.partName || !entry.contentType) throw new Error(`${CONTENT_TYPES_PART}: Override is missing PartName or ContentType`);
    if (!entry.partName.startsWith("/")) throw new Error(`${CONTENT_TYPES_PART}: Override PartName must start with / (${entry.partName})`);
    const partName = normalizePackagePartName(entry.partName);
    if (parts.has(partName)) throw new Error(`${CONTENT_TYPES_PART}: duplicate Override for /${partName}`);
    if (!files.has(partName)) throw new Error(`${CONTENT_TYPES_PART}: Override targets missing part /${partName}`);
    parts.set(partName, entry.contentType);
  }

  for (const partName of files) {
    if (partName === CONTENT_TYPES_PART) continue;
    const basename = path.basename(partName).toLowerCase();
    const extension = basename === ".rels" ? "rels" : path.extname(partName).slice(1).toLowerCase();
    if (!parts.has(partName) && (!extension || !extensions.has(extension))) {
      throw new Error(`${CONTENT_TYPES_PART}: no content type is declared for /${partName}`);
    }
    const expectedMediaType = MEDIA_CONTENT_TYPES.get(extension);
    const effectiveContentType = parts.get(partName) || extensions.get(extension);
    if (expectedMediaType && effectiveContentType !== expectedMediaType) {
      throw new Error(`${CONTENT_TYPES_PART}: /${partName} must use ${expectedMediaType}, found ${effectiveContentType || "none"}`);
    }
  }

  for (const partName of files) {
    const expected = REQUIRED_OVERRIDE_TYPES.find(([pattern]) => pattern.test(partName))?.[1];
    if (!expected) continue;
    if (parts.get(partName) !== expected) {
      throw new Error(`${CONTENT_TYPES_PART}: /${partName} is missing its required Override (${expected})`);
    }
  }

  return { contentTypeDefaultCount: defaults.length, contentTypeOverrideCount: overrides.length };
}

function validateNotesMasterXml(xml, partName) {
  const root = parseXmlDocument(xml, partName);
  if (root.local !== "notesMaster" || !PRESENTATION_NAMESPACES.has(root.uri)) throw new Error(`${partName}: invalid notesMaster document element`);
  if (!directChild(root, "clrMap", PRESENTATION_NAMESPACES)) throw new Error(`${partName}: missing p:clrMap`);
  if (!directChild(root, "notesStyle", PRESENTATION_NAMESPACES)) throw new Error(`${partName}: missing p:notesStyle`);
  const commonSlideData = directChild(root, "cSld", PRESENTATION_NAMESPACES);
  const shapeTree = commonSlideData && directChild(commonSlideData, "spTree", PRESENTATION_NAMESPACES);
  if (!shapeTree) throw new Error(`${partName}: missing p:cSld/p:spTree`);
  const firstChildren = shapeTree.children.slice(0, 2).map((child) => child.local);
  if (firstChildren[0] !== "nvGrpSpPr" || firstChildren[1] !== "grpSpPr") {
    throw new Error(`${partName}: notes master shape tree must start with nvGrpSpPr and grpSpPr`);
  }
  const placeholders = descendants(shapeTree, (node) => node.local === "ph" && PRESENTATION_NAMESPACES.has(node.uri));
  const expectedPlaceholderTypes = ["hdr", "dt", "sldImg", "body", "ftr", "sldNum"];
  if (placeholders.length !== expectedPlaceholderTypes.length) {
    throw new Error(`${partName}: notes master must retain exactly six PowerPoint placeholder shapes`);
  }
  for (const type of expectedPlaceholderTypes) {
    const count = placeholders.filter((placeholder) => attributeValue(placeholder, "type") === type).length;
    if (count !== 1) throw new Error(`${partName}: notes master must retain exactly one ${type} placeholder`);
  }
}

function validatePresetShapes(xml, partName) {
  const root = parseXmlDocument(xml, partName);
  for (const geometry of descendants(root, (node) => node.local === "prstGeom" && DRAWING_NAMESPACES.has(node.uri))) {
    const preset = attributeValue(geometry, "prst");
    if (preset && !VALID_PRESET_SHAPES.has(preset)) {
      throw new Error(`${partName}: unsupported DrawingML preset shape "${preset}"`);
    }
  }
}

function insertBeforeExtensionList(innerXml, insertion) {
  const extensionIndex = innerXml.search(/<p:extLst\b/);
  return extensionIndex < 0
    ? `${innerXml}${insertion}`
    : `${innerXml.slice(0, extensionIndex)}${insertion}${innerXml.slice(extensionIndex)}`;
}

function normalizeDrawingXml(xml) {
  let normalizedShapeCount = 0;
  let normalizedBackgroundCount = 0;
  let normalizedBulletSizeCount = 0;
  let normalized = xml.replace(/<p:sp\b([^>]*)>([\s\S]*?)<\/p:sp>/g, (whole, attributes, inner) => {
    if (/<p:txBody\b/.test(inner)) return whole;
    normalizedShapeCount += 1;
    return `<p:sp${attributes}>${insertBeforeExtensionList(inner, MINIMAL_TEXT_BODY)}</p:sp>`;
  });
  normalized = normalized.replace(/<p:bgPr\b([^>]*)>([\s\S]*?)<\/p:bgPr>/g, (whole, attributes, inner) => {
    if (!/<a:solidFill\b/.test(inner) || /<a:(?:effectLst|effectDag)\b/.test(inner)) return whole;
    normalizedBackgroundCount += 1;
    return `<p:bgPr${attributes}>${insertBeforeExtensionList(inner, "<a:effectLst/>")}</p:bgPr>`;
  });
  normalized = normalized.replace(/<a:buSzPct\b[^>]*\/?\s*>/g, (tag) => {
    const value = getAttribute(tag, "val");
    if (!/^\d+$/.test(value || "")) return tag;
    const thousandthsOfPercent = BigInt(value);
    if (thousandthsOfPercent % 1000n !== 0n) return tag;
    const percent = thousandthsOfPercent / 1000n;
    if (percent < 25n || percent > 400n) return tag;
    normalizedBulletSizeCount += 1;
    return setAttribute(tag, "val", `${percent}%`);
  });
  return { xml: normalized, normalizedShapeCount, normalizedBackgroundCount, normalizedBulletSizeCount };
}

function validateDrawingXml(xml, partName) {
  const root = parseXmlDocument(xml, partName);
  const drawingObjectIds = new Set();
  for (const nonVisualProperties of descendants(root, (node) => node.local === "cNvPr" && PRESENTATION_NAMESPACES.has(node.uri))) {
    const id = canonicalUnsignedInt(attributeValue(nonVisualProperties, "id"), `${partName}/p:cNvPr@id`);
    if (drawingObjectIds.has(id)) throw new Error(`${partName}: duplicate drawing object id ${id}`);
    drawingObjectIds.add(id);
  }
  for (const shapeTree of descendants(root, (node) => node.local === "spTree" && PRESENTATION_NAMESPACES.has(node.uri))) {
    const firstChildren = shapeTree.children.slice(0, 2).map((child) => child.local);
    if (firstChildren[0] !== "nvGrpSpPr" || firstChildren[1] !== "grpSpPr") {
      throw new Error(`${partName}: p:spTree must start with p:nvGrpSpPr and p:grpSpPr`);
    }
  }
  for (const shape of descendants(root, (node) => node.local === "sp" && PRESENTATION_NAMESPACES.has(node.uri))) {
    if (!directChild(shape, "txBody", PRESENTATION_NAMESPACES)) {
      throw new Error(`${partName}: p:sp is missing required p:txBody`);
    }
  }
  for (const background of descendants(root, (node) => node.local === "bgPr" && PRESENTATION_NAMESPACES.has(node.uri))) {
    const hasSolidFill = background.children.some((child) => child.local === "solidFill" && DRAWING_NAMESPACES.has(child.uri));
    const hasEffect = background.children.some((child) => ["effectLst", "effectDag"].includes(child.local) && DRAWING_NAMESPACES.has(child.uri));
    if (hasSolidFill && !hasEffect) throw new Error(`${partName}: solid p:bgPr is missing a:effectLst`);
  }
  for (const bulletSize of descendants(root, (node) => node.local === "buSzPct" && DRAWING_NAMESPACES.has(node.uri))) {
    const value = attributeValue(bulletSize, "val");
    const match = value?.match(/^(\d+)%$/);
    const percent = match ? BigInt(match[1]) : 0n;
    if (!match || percent < 25n || percent > 400n) {
      throw new Error(`${partName}: a:buSzPct@val must be an ECMA-376 percentage from 25% to 400%, found ${value || "(missing)"}`);
    }
  }
}

/** Split an element's inner XML into direct child element strings. */
function directChildren(innerXml) {
  const children = [];
  const tags = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>/g;
  let depth = 0;
  let start = -1;
  let qname = "";
  let match;

  while ((match = tags.exec(innerXml))) {
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<![CDATA[")) continue;
    if (token.startsWith("<!")) continue;

    const closing = /^<\//.test(token);
    const selfClosing = /\/\s*>$/.test(token);
    if (!closing) {
      const nameMatch = token.match(/^<\s*([^\s/>]+)/);
      if (!nameMatch) continue;
      if (depth === 0) {
        start = match.index;
        qname = nameMatch[1];
      }
      if (selfClosing) {
        if (depth === 0) {
          children.push({ qname, name: localName(qname), xml: innerXml.slice(start, tags.lastIndex) });
          start = -1;
          qname = "";
        }
      } else {
        depth += 1;
      }
    } else {
      depth -= 1;
      if (depth < 0) throw new Error("Malformed XML: unexpected closing tag");
      if (depth === 0 && start >= 0) {
        children.push({ qname, name: localName(qname), xml: innerXml.slice(start, tags.lastIndex) });
        start = -1;
        qname = "";
      }
    }
  }

  if (depth !== 0) throw new Error("Malformed XML: unclosed element");
  return children;
}

function reorderChildren(innerXml, order, forbidden = new Set()) {
  const rank = new Map(order.map((name, index) => [name, index]));
  return directChildren(innerXml)
    .filter((child) => !forbidden.has(child.name))
    .map((child, index) => ({ ...child, index }))
    .sort((a, b) => {
      const ar = rank.has(a.name) ? rank.get(a.name) : order.length - 1;
      const br = rank.has(b.name) ? rank.get(b.name) : order.length - 1;
      return ar - br || a.index - b.index;
    })
    .map((child) => child.xml)
    .join("");
}

function normalizePresentationXml(xml) {
  let normalizedCount = 0;
  const normalized = xml.replace(
    /<((?:[A-Za-z_][\w.-]*:)?presentation)\b([^>]*)>([\s\S]*?)<\/\1>/,
    (whole, qname, attributes, inner) => {
      const ordered = reorderChildren(inner, PRESENTATION_CHILD_ORDER);
      if (ordered === inner) return whole;
      normalizedCount += 1;
      return `<${qname}${attributes}>${ordered}</${qname}>`;
    },
  );
  return { xml: normalized, normalizedCount };
}

function transformBlocks(xml, localTag, transform) {
  const pattern = new RegExp(`<c:${localTag}([^>]*)>([\\s\\S]*?)<\\/c:${localTag}>`, "g");
  return xml.replace(pattern, (whole, attrs, inner) => `<c:${localTag}${attrs}>${transform(inner, whole)}</c:${localTag}>`);
}

function normalizeSingleLevelCategories(xml) {
  return xml.replace(/<c:multiLvlStrRef>([\s\S]*?)<\/c:multiLvlStrRef>/g, (whole, inner) => {
    const levels = [...inner.matchAll(/<c:lvl>([\s\S]*?)<\/c:lvl>/g)];
    if (levels.length !== 1) return whole;
    const formula = inner.match(/<c:f>[\s\S]*?<\/c:f>/)?.[0] || "";
    const pointCount = inner.match(/<c:ptCount\b[^>]*\/>/)?.[0] || "";
    const points = [...levels[0][1].matchAll(/<c:pt\b[\s\S]*?<\/c:pt>/g)].map((match) => match[0]).join("");
    return `<c:strRef>${formula}<c:strCache>${pointCount}${points}</c:strCache></c:strRef>`;
  });
}

function definedAxisIds(xml) {
  const ids = new Set();
  const axes = /<c:(?:catAx|dateAx|valAx|serAx)>[\s\S]*?<\/c:(?:catAx|dateAx|valAx|serAx)>/g;
  for (const match of xml.matchAll(axes)) {
    const id = match[0].match(/<c:axId\b[^>]*\bval="([^"]+)"/)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

function normalizeChartXml(xml) {
  const axisIds = definedAxisIds(xml);
  let normalized = xml;
  normalized = normalizeSingleLevelCategories(normalized);

  for (const [chartType, chartOrder] of Object.entries(CHART_CHILD_ORDER)) {
    normalized = transformBlocks(normalized, chartType, (chartInner) => {
      let inner = chartInner;
      if (chartType === "lineChart" && !/<c:grouping\b/.test(inner)) {
        inner = '<c:grouping val="standard"/>' + inner;
      }

      inner = transformBlocks(inner, "ser", (seriesInner) => reorderChildren(
        seriesInner,
        SERIES_CHILD_ORDER[chartType],
        FORBIDDEN_SERIES_CHILDREN[chartType] || new Set(),
      ));

      const children = directChildren(inner);
      const axisChildren = children.filter((child) => child.name === "axId");
      const validAxisChildren = axisChildren.filter((child) => {
        const id = getAttribute(child.xml, "val");
        return id && axisIds.has(id);
      });
      const requiresTwoAxes = ["lineChart", "barChart", "areaChart", "scatterChart", "radarChart"].includes(chartType);
      const repairableChildren = requiresTwoAxes && validAxisChildren.length === 2
        ? children.filter((child) => child.name !== "axId" || validAxisChildren.includes(child))
        : children;
      return reorderChildren(repairableChildren.map((child) => child.xml).join(""), chartOrder);
    });
  }

  return normalized;
}

function normalizeChartRelationshipTargets(xml) {
  return xml.replace(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*\/?\s*>/g, (tag) => {
    const type = getAttribute(tag, "Type");
    const target = getAttribute(tag, "Target");
    if (type?.endsWith("/chart") && target?.startsWith("/ppt/charts/")) {
      return setAttribute(tag, "Target", target.replace(/^\/ppt\/charts\//, "../charts/"));
    }
    return tag;
  });
}

function assertWellFormedXml(xml, partName) {
  return parseXmlDocument(xml, partName);
}

function relationshipSourcePart(relPart) {
  if (relPart === "_rels/.rels") return "";
  const marker = "/_rels/";
  const index = relPart.lastIndexOf(marker);
  if (index < 0 || !relPart.endsWith(".rels")) return null;
  return path.join(relPart.slice(0, index), relPart.slice(index + marker.length, -".rels".length));
}

function relationshipPartForSource(sourcePart) {
  if (!sourcePart) return "_rels/.rels";
  return path.join(path.dirname(sourcePart), "_rels", `${path.basename(sourcePart)}.rels`);
}

function parseRelationships(xml, partName = "relationship part") {
  const root = parseXmlDocument(xml, partName);
  if (root.local !== "Relationships" || root.uri !== PACKAGE_REL_NS) {
    throw new Error(`${partName}: expected the OPC Relationships document element`);
  }
  const relationships = [];
  for (const child of root.children) {
    if (child.local !== "Relationship" || child.uri !== PACKAGE_REL_NS) continue;
    relationships.push({
      id: attributeValue(child, "Id"),
      type: attributeValue(child, "Type"),
      target: attributeValue(child, "Target"),
      targetMode: attributeValue(child, "TargetMode"),
    });
  }
  return relationships;
}

function relationshipKind(relationship) {
  return relationship.type?.slice(relationship.type.lastIndexOf("/") + 1);
}

function relationshipReferenceExpectation(node, attribute) {
  if (CHART_NAMESPACES.has(node.uri) && node.local === "chart" && attribute.local === "id") {
    return { kinds: ["chart"], internal: true };
  }
  if (CHART_NAMESPACES.has(node.uri) && node.local === "externalData" && attribute.local === "id") {
    return { kinds: ["package"], internal: true };
  }
  if (DRAWING_NAMESPACES.has(node.uri) && node.local === "blip" && ["embed", "link"].includes(attribute.local)) {
    return { kinds: ["image"], internal: attribute.local === "embed" };
  }
  if (DRAWING_NAMESPACES.has(node.uri) && ["hlinkClick", "hlinkHover"].includes(node.local) && attribute.local === "id") {
    return { kinds: ["hyperlink", "slide"], internal: false };
  }
  if (PRESENTATION_NAMESPACES.has(node.uri) && attribute.local === "id") {
    const kindByElement = new Map([
      ["sldId", "slide"],
      ["sldMasterId", "slideMaster"],
      ["sldLayoutId", "slideLayout"],
      ["notesMasterId", "notesMaster"],
      ["oleObj", "oleObject"],
    ]);
    const kind = kindByElement.get(node.local);
    if (kind) return { kinds: [kind], internal: true };
  }
  return null;
}

function relationshipsOfKind(relationshipsBySource, sourcePart, kind) {
  return [...(relationshipsBySource.get(sourcePart)?.values() || [])].filter((relationship) => relationshipKind(relationship) === kind);
}

function assertExactRelationshipReferences(root, relationshipsBySource, sourcePart, elementLocal, relationshipType) {
  const relationships = relationshipsOfKind(relationshipsBySource, sourcePart, relationshipType)
    .filter((relationship) => relationship.targetMode !== "External");
  const declaredIds = relationships.map((relationship) => relationship.id);
  const referencedIds = descendants(root, (node) => node.local === elementLocal && PRESENTATION_NAMESPACES.has(node.uri))
    .map((node) => node.attributes.find((attribute) => attribute.local === "id" && OFFICE_REL_NAMESPACES.has(attribute.uri))?.value)
    .filter(Boolean);
  if (new Set(referencedIds).size !== referencedIds.length) {
    throw new Error(`${sourcePart}: duplicate ${elementLocal} relationship reference`);
  }
  if (referencedIds.length !== declaredIds.length || declaredIds.some((id) => !referencedIds.includes(id))) {
    throw new Error(`${sourcePart}: ${elementLocal} references do not match declared ${relationshipType} relationships`);
  }
}

function assertUniqueElementIds(root, partName, elementLocal) {
  const ids = descendants(root, (node) => node.local === elementLocal && PRESENTATION_NAMESPACES.has(node.uri))
    .map((node) => canonicalUnsignedInt(attributeValue(node, "id"), `${partName}/${elementLocal}@id`));
  if (new Set(ids).size !== ids.length) throw new Error(`${partName}: duplicate ${elementLocal} id`);
}

function assertRelationshipTargets(relationshipsBySource, sourcePart, kind, expectedTargets, options = {}) {
  const relationships = relationshipsOfKind(relationshipsBySource, sourcePart, kind)
    .filter((relationship) => relationship.targetMode !== "External");
  const targets = relationships.map((relationship) => resolveRelationshipTarget(sourcePart, relationship.target));
  if (options.exactlyOne && targets.length !== 1) {
    throw new Error(`${sourcePart || "package"}: expected exactly one ${kind} relationship, found ${targets.length}`);
  }
  if (options.targetPattern && targets.some((target) => !options.targetPattern.test(target))) {
    throw new Error(`${sourcePart || "package"}: ${kind} relationship targets an invalid part`);
  }
  for (const expected of expectedTargets) {
    if (!targets.includes(expected)) throw new Error(`${sourcePart || "package"}: missing ${kind} relationship to ${expected}`);
  }
  if (options.exactTargets) {
    if (targets.length !== expectedTargets.length || new Set(targets).size !== targets.length) {
      throw new Error(`${sourcePart || "package"}: ${kind} relationship targets do not form a one-to-one part mapping`);
    }
    for (const target of targets) {
      if (!expectedTargets.includes(target)) throw new Error(`${sourcePart || "package"}: unexpected ${kind} relationship to ${target}`);
    }
  }
  return targets;
}

function resolveRelationshipTarget(sourcePart, target) {
  const cleanTarget = target.startsWith("/") ? target.slice(1) : target;
  const resolved = sourcePart
    ? path.normalize(path.join(path.dirname(sourcePart), cleanTarget))
    : path.normalize(cleanTarget);
  try {
    return decodeURIComponent(resolved);
  } catch {
    return resolved;
  }
}

function replaceRelationshipTarget(xml, relationshipId, newTarget) {
  let replaced = false;
  const normalized = xml.replace(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*\/?\s*>/g, (tag) => {
    if (getAttribute(tag, "Id") !== relationshipId) return tag;
    replaced = true;
    return setAttribute(tag, "Target", newTarget);
  });
  if (!replaced) throw new Error(`Cannot update missing relationship ${relationshipId}`);
  return normalized;
}

function nextThemePart(files) {
  let index = 1;
  while (files.has(`ppt/theme/theme${index}.xml`)) index += 1;
  return `ppt/theme/theme${index}.xml`;
}

async function normalizeNotesMasterThemes(zip, files) {
  const claimedThemeTargets = new Set();
  const themeOwnerParts = [
    "ppt/presentation.xml",
    ...[...files].filter((name) => /^ppt\/slideMasters\/[^/]+\.xml$/.test(name)),
  ];
  for (const ownerPart of themeOwnerParts) {
    const relPart = relationshipPartForSource(ownerPart);
    const entry = zip.file(relPart);
    if (!entry) continue;
    const xml = await entry.async("string");
    for (const relationship of parseRelationships(xml, relPart)) {
      if (relationshipKind(relationship) === "theme" && relationship.targetMode !== "External" && relationship.target) {
        claimedThemeTargets.add(resolveRelationshipTarget(ownerPart, relationship.target));
      }
    }
  }

  let normalizedCount = 0;
  const notesMasters = [...files].filter((name) => /^ppt\/notesMasters\/[^/]+\.xml$/.test(name)).sort();
  for (const notesMasterPart of notesMasters) {
    const relPart = relationshipPartForSource(notesMasterPart);
    const entry = zip.file(relPart);
    if (!entry) continue;
    const originalXml = await entry.async("string");
    const themeRelationships = parseRelationships(originalXml, relPart)
      .filter((relationship) => relationshipKind(relationship) === "theme" && relationship.targetMode !== "External");
    if (themeRelationships.length !== 1 || !themeRelationships[0].target) continue;
    const relationship = themeRelationships[0];
    const currentThemePart = resolveRelationshipTarget(notesMasterPart, relationship.target);
    if (!claimedThemeTargets.has(currentThemePart)) {
      claimedThemeTargets.add(currentThemePart);
      continue;
    }
    const currentThemeEntry = zip.file(currentThemePart);
    if (!currentThemeEntry) continue;
    const newThemePart = nextThemePart(files);
    zip.file(newThemePart, await currentThemeEntry.async("nodebuffer"));
    files.add(newThemePart);
    const newTarget = path.relative(path.dirname(notesMasterPart), newThemePart);
    zip.file(relPart, replaceRelationshipTarget(originalXml, relationship.id, newTarget));
    claimedThemeTargets.add(newThemePart);
    normalizedCount += 1;
  }
  return normalizedCount;
}

function assertOrderedNodeChildren(node, order, context, childLabel = "chart child") {
  const rank = new Map(order.map((name, index) => [name, index]));
  let previous = -1;
  for (const child of node.children) {
    if (!rank.has(child.local)) continue;
    const current = rank.get(child.local);
    if (current < previous) throw new Error(`${context}: ${childLabel} ${child.local} is out of OOXML schema order`);
    previous = current;
  }
}

function validateChartXml(xml, partName) {
  const root = parseXmlDocument(xml, partName);
  if (root.local !== "chartSpace" || !CHART_NAMESPACES.has(root.uri)) throw new Error(`${partName}: invalid chartSpace document element`);
  const axisDefinitions = new Map();
  const axes = descendants(root, (node) => ["catAx", "dateAx", "valAx", "serAx"].includes(node.local) && CHART_NAMESPACES.has(node.uri));
  for (const axis of axes) {
    const axisId = canonicalUnsignedInt(attributeValue(directChild(axis, "axId", CHART_NAMESPACES) || { attributes: [] }, "val"), `${partName}/axis/c:axId@val`);
    const crossAxisId = canonicalUnsignedInt(attributeValue(directChild(axis, "crossAx", CHART_NAMESPACES) || { attributes: [] }, "val"), `${partName}/axis/c:crossAx@val`);
    if (axisDefinitions.has(axisId)) throw new Error(`${partName}: duplicate axis definition ${axisId}`);
    axisDefinitions.set(axisId, crossAxisId);
  }
  for (const [axisId, crossAxisId] of axisDefinitions) {
    if (axisDefinitions.get(crossAxisId) !== axisId) {
      throw new Error(`${partName}: axes ${axisId} and ${crossAxisId} do not cross-reference each other`);
    }
  }

  for (const [chartType, chartOrder] of Object.entries(CHART_CHILD_ORDER)) {
    const charts = descendants(root, (node) => node.local === chartType && CHART_NAMESPACES.has(node.uri));
    for (const chart of charts) {
      if (chartType === "lineChart" && !directChild(chart, "grouping", CHART_NAMESPACES)) {
        throw new Error(`${partName}: lineChart is missing required grouping`);
      }
      assertOrderedNodeChildren(chart, chartOrder, `${partName}/${chartType}`);
      const chartAxisIds = chart.children
        .filter((child) => child.local === "axId" && CHART_NAMESPACES.has(child.uri))
        .map((child) => canonicalUnsignedInt(attributeValue(child, "val"), `${partName}/${chartType}/c:axId@val`));
      if (["lineChart", "barChart", "areaChart", "scatterChart", "radarChart"].includes(chartType)
          && (chartAxisIds.length !== 2 || new Set(chartAxisIds).size !== 2)) {
        throw new Error(`${partName}/${chartType}: expected exactly two unique axis references`);
      }
      for (const axisId of chartAxisIds) {
        if (!axisDefinitions.has(axisId)) throw new Error(`${partName}/${chartType}: orphan axis id ${axisId}`);
      }
      const seriesNodes = chart.children.filter((child) => child.local === "ser" && CHART_NAMESPACES.has(child.uri));
      const seriesIndexes = new Set();
      const seriesOrders = new Set();
      for (const series of seriesNodes) {
        const index = canonicalUnsignedInt(attributeValue(directChild(series, "idx", CHART_NAMESPACES) || { attributes: [] }, "val"), `${partName}/${chartType}/ser/c:idx@val`);
        const order = canonicalUnsignedInt(attributeValue(directChild(series, "order", CHART_NAMESPACES) || { attributes: [] }, "val"), `${partName}/${chartType}/ser/c:order@val`);
        if (seriesIndexes.has(index)) throw new Error(`${partName}/${chartType}: duplicate series idx ${index}`);
        if (seriesOrders.has(order)) throw new Error(`${partName}/${chartType}: duplicate series order ${order}`);
        seriesIndexes.add(index);
        seriesOrders.add(order);
        assertOrderedNodeChildren(series, SERIES_CHILD_ORDER[chartType], `${partName}/${chartType}/ser`);
        for (const forbidden of FORBIDDEN_SERIES_CHILDREN[chartType] || []) {
          if (directChild(series, forbidden, CHART_NAMESPACES)) throw new Error(`${partName}/${chartType}/ser: forbidden c:${forbidden}`);
        }
      }
    }
  }
}

export async function validatePptxPackage(input) {
  const zip = await JSZip.loadAsync(input, { checkCRC32: true });
  const files = new Set(Object.keys(zip.files).filter((name) => !zip.files[name].dir));
  for (const required of ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"]) {
    if (!files.has(required)) throw new Error(`PPTX package is missing required part: ${required}`);
  }

  const xmlParts = [...files].filter((name) => name.endsWith(".xml") || name.endsWith(".rels"));
  const xmlByPart = new Map();
  const xmlRootByPart = new Map();
  for (const partName of xmlParts) {
    const xml = await zip.file(partName).async("string");
    const root = assertWellFormedXml(xml, partName);
    xmlByPart.set(partName, xml);
    xmlRootByPart.set(partName, root);
  }

  const embeddedWorkbookParts = [...files].filter((name) => /^ppt\/embeddings\/[^/]+\.xlsx$/i.test(name));
  for (const workbookPart of embeddedWorkbookParts) {
    let workbookZip;
    try {
      workbookZip = await JSZip.loadAsync(await zip.file(workbookPart).async("nodebuffer"), { checkCRC32: true });
    } catch (error) {
      throw new Error(`${workbookPart}: invalid embedded workbook package: ${error.message}`);
    }
    const workbookFiles = new Set(Object.keys(workbookZip.files).filter((name) => !workbookZip.files[name].dir));
    for (const required of [CONTENT_TYPES_PART, "_rels/.rels", "xl/workbook.xml"]) {
      if (!workbookFiles.has(required)) throw new Error(`${workbookPart}: embedded workbook is missing required part ${required}`);
    }
  }

  let relationshipCount = 0;
  const relationshipsBySource = new Map();
  for (const [relPart, xml] of xmlByPart) {
    if (!relPart.endsWith(".rels")) continue;
    const sourcePart = relationshipSourcePart(relPart);
    if (sourcePart === null) continue;
    if (sourcePart && !files.has(sourcePart)) throw new Error(`${relPart}: relationship source part is missing: ${sourcePart}`);
    const relationshipIds = new Map();
    for (const relationship of parseRelationships(xml, relPart)) {
      relationshipCount += 1;
      if (!relationship.id) throw new Error(`${relPart}: relationship is missing Id`);
      if (!isValidRelationshipId(relationship.id)) throw new Error(`${relPart}: invalid relationship Id ${relationship.id}`);
      if (relationshipIds.has(relationship.id)) throw new Error(`${relPart}: duplicate relationship Id ${relationship.id}`);
      if (!relationship.type) throw new Error(`${relPart}: relationship ${relationship.id} is missing Type`);
      if (!relationship.target) throw new Error(`${relPart}: relationship ${relationship.id} is missing Target`);
      if (relationship.targetMode && !["Internal", "External"].includes(relationship.targetMode)) {
        throw new Error(`${relPart}: relationship ${relationship.id} has invalid TargetMode ${relationship.targetMode}`);
      }
      relationshipIds.set(relationship.id, relationship);
      if (relationship.targetMode !== "External") {
        if (relationshipKind(relationship) === "chart" && relationship.target.startsWith("/")) {
          throw new Error(`${relPart}: chart relationship target must be relative: ${relationship.target}`);
        }
        const targetPart = resolveRelationshipTarget(sourcePart, relationship.target);
        normalizePackagePartName(targetPart);
        if (!files.has(targetPart)) throw new Error(`${relPart}: relationship ${relationship.id} targets missing part ${targetPart}`);
        const targetPattern = INTERNAL_REL_TARGET_PATTERNS.get(relationshipKind(relationship));
        if (targetPattern && !targetPattern.test(targetPart)) {
          throw new Error(`${relPart}: ${relationship.id} has ${relationshipKind(relationship)} type but targets ${targetPart}`);
        }
      }
    }
    relationshipsBySource.set(sourcePart, relationshipIds);
  }

  for (const [sourcePart, root] of xmlRootByPart) {
    if (sourcePart.endsWith(".rels") || sourcePart === CONTENT_TYPES_PART) continue;
    const relationships = relationshipsBySource.get(sourcePart);
    for (const node of descendants(root, () => true)) {
      for (const attribute of node.attributes) {
        if (!OFFICE_REL_NAMESPACES.has(attribute.uri) || !["id", "embed", "link"].includes(attribute.local)) continue;
        if (!attribute.value || !relationships?.has(attribute.value)) {
          throw new Error(`${sourcePart}: ${attribute.name} references missing relationship ${attribute.value || "(empty)"}`);
        }
        const relationship = relationships.get(attribute.value);
        const expectation = relationshipReferenceExpectation(node, attribute);
        if (expectation && !expectation.kinds.includes(relationshipKind(relationship))) {
          throw new Error(`${sourcePart}: ${node.name}/${attribute.name} must reference ${expectation.kinds.join(" or ")}, found ${relationshipKind(relationship)}`);
        }
        if (expectation?.internal && relationship.targetMode === "External") {
          throw new Error(`${sourcePart}: ${node.name}/${attribute.name} must use an internal relationship`);
        }
      }
    }
  }

  const slideParts = [...files].filter((name) => /^ppt\/slides\/[^/]+\.xml$/.test(name));
  const slideLayoutParts = [...files].filter((name) => /^ppt\/slideLayouts\/[^/]+\.xml$/.test(name));
  const slideMasterParts = [...files].filter((name) => /^ppt\/slideMasters\/[^/]+\.xml$/.test(name));
  const notesMasterParts = [...files].filter((name) => /^ppt\/notesMasters\/[^/]+\.xml$/.test(name));
  const notesSlideParts = [...files].filter((name) => /^ppt\/notesSlides\/[^/]+\.xml$/.test(name));

  assertRelationshipTargets(relationshipsBySource, "", "officeDocument", ["ppt/presentation.xml"], { exactlyOne: true });
  assertRelationshipTargets(relationshipsBySource, "ppt/presentation.xml", "slide", slideParts, { exactTargets: true });
  assertRelationshipTargets(relationshipsBySource, "ppt/presentation.xml", "slideMaster", slideMasterParts, { exactTargets: true });
  assertRelationshipTargets(relationshipsBySource, "ppt/presentation.xml", "notesMaster", notesMasterParts, { exactTargets: true });
  const presentationRoot = xmlRootByPart.get("ppt/presentation.xml");
  if (presentationRoot.local !== "presentation" || !PRESENTATION_NAMESPACES.has(presentationRoot.uri)) {
    throw new Error("ppt/presentation.xml: invalid presentation document element");
  }
  assertOrderedNodeChildren(presentationRoot, PRESENTATION_CHILD_ORDER, "ppt/presentation.xml", "presentation child");
  assertUniqueElementIds(presentationRoot, "ppt/presentation.xml", "sldId");
  assertUniqueElementIds(presentationRoot, "ppt/presentation.xml", "sldMasterId");
  assertExactRelationshipReferences(presentationRoot, relationshipsBySource, "ppt/presentation.xml", "sldId", "slide");
  assertExactRelationshipReferences(presentationRoot, relationshipsBySource, "ppt/presentation.xml", "sldMasterId", "slideMaster");
  assertExactRelationshipReferences(presentationRoot, relationshipsBySource, "ppt/presentation.xml", "notesMasterId", "notesMaster");
  for (const slidePart of slideParts) assertRelationshipTargets(relationshipsBySource, slidePart, "slideLayout", [], { exactlyOne: true, targetPattern: /^ppt\/slideLayouts\/[^/]+\.xml$/ });
  const layoutMasterTargets = new Map();
  for (const layoutPart of slideLayoutParts) {
    const [masterPart] = assertRelationshipTargets(relationshipsBySource, layoutPart, "slideMaster", [], { exactlyOne: true, targetPattern: /^ppt\/slideMasters\/[^/]+\.xml$/ });
    layoutMasterTargets.set(layoutPart, masterPart);
  }
  const layoutOwners = new Map();
  for (const masterPart of slideMasterParts) {
    assertRelationshipTargets(relationshipsBySource, masterPart, "theme", [], { exactlyOne: true, targetPattern: /^ppt\/theme\/[^/]+\.xml$/ });
    assertUniqueElementIds(xmlRootByPart.get(masterPart), masterPart, "sldLayoutId");
    assertExactRelationshipReferences(xmlRootByPart.get(masterPart), relationshipsBySource, masterPart, "sldLayoutId", "slideLayout");
    for (const layoutPart of assertRelationshipTargets(relationshipsBySource, masterPart, "slideLayout", [])) {
      if (layoutOwners.has(layoutPart)) throw new Error(`${layoutPart}: slide layout is referenced by multiple slide masters`);
      layoutOwners.set(layoutPart, masterPart);
    }
  }
  for (const layoutPart of slideLayoutParts) {
    const ownerMaster = layoutOwners.get(layoutPart);
    if (!ownerMaster) throw new Error(`${layoutPart}: slide layout is not referenced by a slide master`);
    const backReference = layoutMasterTargets.get(layoutPart);
    if (backReference !== ownerMaster) {
      throw new Error(`${layoutPart}: slide layout points to ${backReference}, but is owned by ${ownerMaster}`);
    }
  }
  for (const notesMasterPart of notesMasterParts) assertRelationshipTargets(relationshipsBySource, notesMasterPart, "theme", [], { exactlyOne: true, targetPattern: /^ppt\/theme\/[^/]+\.xml$/ });
  for (const notesSlidePart of notesSlideParts) {
    assertRelationshipTargets(relationshipsBySource, notesSlidePart, "notesMaster", [], { exactlyOne: true, targetPattern: /^ppt\/notesMasters\/[^/]+\.xml$/ });
    assertRelationshipTargets(relationshipsBySource, notesSlidePart, "slide", [], { exactlyOne: true, targetPattern: /^ppt\/slides\/[^/]+\.xml$/ });
  }
  const notesSlideOwners = new Map();
  for (const slidePart of slideParts) {
    const notesRelationships = relationshipsOfKind(relationshipsBySource, slidePart, "notesSlide")
      .filter((relationship) => relationship.targetMode !== "External");
    if (notesRelationships.length > 1) throw new Error(`${slidePart}: a slide may reference at most one notes slide`);
    for (const relationship of notesRelationships) {
      const notesSlidePart = resolveRelationshipTarget(slidePart, relationship.target);
      if (notesSlideOwners.has(notesSlidePart)) throw new Error(`${notesSlidePart}: notes slide is referenced by multiple slides`);
      notesSlideOwners.set(notesSlidePart, slidePart);
    }
  }
  for (const notesSlidePart of notesSlideParts) {
    const ownerSlide = notesSlideOwners.get(notesSlidePart);
    if (!ownerSlide) throw new Error(`${notesSlidePart}: notes slide is not referenced by a slide`);
    const [backReference] = assertRelationshipTargets(relationshipsBySource, notesSlidePart, "slide", [], { exactlyOne: true });
    if (backReference !== ownerSlide) throw new Error(`${notesSlidePart}: notes slide points to ${backReference}, but is owned by ${ownerSlide}`);
  }

  const slideThemeTargets = new Set(slideMasterParts.flatMap((masterPart) =>
    relationshipsOfKind(relationshipsBySource, masterPart, "theme")
      .filter((relationship) => relationship.targetMode !== "External")
      .map((relationship) => resolveRelationshipTarget(masterPart, relationship.target))));
  for (const notesMasterPart of notesMasterParts) {
    const notesTheme = relationshipsOfKind(relationshipsBySource, notesMasterPart, "theme")
      .filter((relationship) => relationship.targetMode !== "External")
      .map((relationship) => resolveRelationshipTarget(notesMasterPart, relationship.target))[0];
    if (notesTheme && slideThemeTargets.has(notesTheme)) {
      throw new Error(`${notesMasterPart}: notes master must not reuse a slide-master theme part (${notesTheme})`);
    }
  }

  const chartParts = [...files].filter((name) => /^ppt\/charts\/[^/]+\.xml$/.test(name));
  for (const chartPart of chartParts) validateChartXml(xmlByPart.get(chartPart), chartPart);

  const contentTypes = validateContentTypesXml(xmlByPart.get(CONTENT_TYPES_PART), files);
  for (const notesMasterPart of notesMasterParts) validateNotesMasterXml(xmlByPart.get(notesMasterPart), notesMasterPart);

  const drawingParts = [...files].filter((name) => /^ppt\/(?:slides|slideLayouts|slideMasters|notesMasters|notesSlides)\/[^/]+\.xml$/.test(name));
  for (const drawingPart of drawingParts) {
    validatePresetShapes(xmlByPart.get(drawingPart), drawingPart);
    validateDrawingXml(xmlByPart.get(drawingPart), drawingPart);
  }

  const slideMasterCount = slideMasterParts.length;
  const slideLayoutCount = slideLayoutParts.length;
  const notesSlideCount = notesSlideParts.length;
  const appPropertiesXml = xmlByPart.get("docProps/app.xml") || "";
  const generatedByPptxGenJS = /<(?:[A-Za-z_][\w.-]*:)?Company>\s*PptxGenJS\s*<\/(?:[A-Za-z_][\w.-]*:)?Company>/i.test(appPropertiesXml);

  return {
    partCount: files.size,
    xmlPartCount: xmlParts.length,
    relationshipCount,
    chartCount: chartParts.length,
    slideCount: slideParts.length,
    slideMasterCount,
    slideLayoutCount,
    notesMasterCount: notesMasterParts.length,
    notesSlideCount,
    embeddedWorkbookCount: embeddedWorkbookParts.length,
    generatedByPptxGenJS,
    ...contentTypes,
  };
}

export async function normalizeAndValidatePptx(input) {
  const zip = await JSZip.loadAsync(input, { checkCRC32: true });
  const files = new Set(Object.keys(zip.files).filter((name) => !zip.files[name].dir));
  let normalizedChartCount = 0;
  let normalizedRelationshipCount = 0;
  let normalizedContentTypeCount = 0;
  let normalizedNotesThemeCount = 0;
  let normalizedShapeCount = 0;
  let normalizedBackgroundCount = 0;
  let normalizedPresentationCount = 0;
  let normalizedBulletSizeCount = 0;

  normalizedNotesThemeCount = await normalizeNotesMasterThemes(zip, files);

  const contentTypesEntry = zip.file(CONTENT_TYPES_PART);
  if (!contentTypesEntry) throw new Error(`PPTX package is missing required part: ${CONTENT_TYPES_PART}`);
  const originalContentTypes = await contentTypesEntry.async("string");
  const normalizedContentTypes = normalizeContentTypesXml(originalContentTypes, files);
  normalizedContentTypeCount = normalizedContentTypes.normalizedCount;
  zip.file(CONTENT_TYPES_PART, normalizedContentTypes.xml);

  for (const [partName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (partName === "ppt/presentation.xml") {
      const original = await entry.async("string");
      const presentation = normalizePresentationXml(original);
      normalizedPresentationCount += presentation.normalizedCount;
      if (presentation.xml !== original) zip.file(partName, presentation.xml);
    } else if (/^ppt\/charts\/[^/]+\.xml$/.test(partName)) {
      const original = await entry.async("string");
      const normalized = normalizeChartXml(original);
      if (normalized !== original) normalizedChartCount += 1;
      zip.file(partName, normalized);
    } else if (/^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(partName)) {
      const original = await entry.async("string");
      const normalized = normalizeChartRelationshipTargets(original);
      if (normalized !== original) normalizedRelationshipCount += 1;
      zip.file(partName, normalized);
    } else if (/^ppt\/(?:slides|slideLayouts|slideMasters|notesMasters|notesSlides)\/[^/]+\.xml$/.test(partName)) {
      const original = await entry.async("string");
      const drawing = normalizeDrawingXml(original);
      normalizedShapeCount += drawing.normalizedShapeCount;
      normalizedBackgroundCount += drawing.normalizedBackgroundCount;
      normalizedBulletSizeCount += drawing.normalizedBulletSizeCount;
      if (drawing.xml !== original) zip.file(partName, drawing.xml);
    }
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const validation = await validatePptxPackage(buffer);
  return {
    buffer,
    report: {
      ...validation,
      normalizedChartCount,
      normalizedRelationshipCount,
      normalizedContentTypeCount,
      normalizedNotesThemeCount,
      normalizedShapeCount,
      normalizedBackgroundCount,
      normalizedPresentationCount,
      normalizedBulletSizeCount,
    },
  };
}
