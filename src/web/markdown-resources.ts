import { marked } from "marked";
import { JSDOM } from "jsdom";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { realPathInside } from "../utils/path-safety.ts";
import { chartImageUrl, extractMarkdownChartSection } from "./markdown-document.ts";

export const MAX_MARKDOWN_PREVIEW_BYTES = 2 * 1024 * 1024;

/** A document receipt grants only its referenced images within the same managed root. */
export function resolveMarkdownImage(documentPath: string, root: string, resource: string): string | null {
  if (!/\.(md|markdown)$/i.test(documentPath)) return null;
  if (statSync(documentPath).size > MAX_MARKDOWN_PREVIEW_BYTES) return null;
  const bytes = readFileSync(documentPath);
  if (bytes.length > MAX_MARKDOWN_PREVIEW_BYTES) return null;
  const markdown = bytes.toString("utf8");
  const references = new Set<string>();
  marked.walkTokens(marked.lexer(markdown), token => {
    if (token.type === "image") references.add(token.href);
    if (token.type === "html") {
      for (const image of JSDOM.fragment(token.text).querySelectorAll("img[src]")) references.add(image.getAttribute("src")!);
    }
  });
  for (const chart of extractMarkdownChartSection(markdown).charts) {
    const url = chartImageUrl(chart.json);
    if (url) references.add(url);
  }
  if (!references.has(resource) || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(resource)) return null;
  let path: string;
  try { path = decodeURIComponent(resource).replace(/\\/g, "/"); } catch { return null; }
  if (path.split("/").includes(".hedgehog")) return null;
  const resolved = realPathInside(root, isAbsolute(path) ? path : resolve(dirname(documentPath), path));
  if (!resolved || relative(root, resolved).split(/[\\/]/).includes(".hedgehog")) return null;
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(resolved) ? resolved : null;
}
