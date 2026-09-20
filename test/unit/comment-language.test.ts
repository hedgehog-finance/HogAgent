import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss", ".html"]);
const SKIPPED_DIRECTORIES = new Set([
  join(PROJECT_ROOT, "node_modules"),
  join(PROJECT_ROOT, "dist"),
  join(PROJECT_ROOT, "src", "vendor"),
]);

interface CommentViolation {
  file: string;
  line: number;
  text: string;
}

function collectCodeFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name !== "node_modules"
        && !SKIPPED_DIRECTORIES.has(path)
        && !entry.name.startsWith(".")
      ) {
        files.push(...collectCodeFiles(path));
      }
      continue;
    }

    if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }

  return files;
}

function containsNonLatinLetter(text: string): boolean {
  return [...text].some((character) => /\p{Letter}/u.test(character) && !/\p{Script=Latin}/u.test(character));
}

function getScriptKind(file: string): ts.ScriptKind {
  switch (extname(file)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function findScriptCommentViolations(file: string, source: string): CommentViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, getScriptKind(file));
  const commentRanges = new Map<string, ts.CommentRange>();

  const addRanges = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      commentRanges.set(`${range.pos}:${range.end}`, range);
    }
  };

  const visit = (node: ts.Node): void => {
    addRanges(ts.getLeadingCommentRanges(source, node.pos));
    addRanges(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  };

  visit(sourceFile);

  return [...commentRanges.values()]
    .filter((range) => containsNonLatinLetter(source.slice(range.pos, range.end)))
    .map((range) => ({
      file: relative(PROJECT_ROOT, file),
      line: sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1,
      text: source.slice(range.pos, range.end).replace(/\s+/g, " ").slice(0, 160),
    }));
}

function findMarkupCommentViolations(file: string, source: string): CommentViolation[] {
  const commentPattern = extname(file) === ".html" ? /<!--[\s\S]*?-->/g : /\/\*[\s\S]*?\*\//g;
  const violations: CommentViolation[] = [];

  for (const match of source.matchAll(commentPattern)) {
    if (!containsNonLatinLetter(match[0])) continue;
    violations.push({
      file: relative(PROJECT_ROOT, file),
      line: source.slice(0, match.index).split("\n").length,
      text: match[0].replace(/\s+/g, " ").slice(0, 160),
    });
  }

  return violations;
}

describe("code comment language", () => {
  it("uses English comments throughout HogAgent code", () => {
    const violations = collectCodeFiles(PROJECT_ROOT).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [".css", ".scss", ".html"].includes(extname(file))
        ? findMarkupCommentViolations(file, source)
        : findScriptCommentViolations(file, source);
    });

    expect(violations).toEqual([]);
  });
});
