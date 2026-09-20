import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const skillsRoot = resolve("skills");
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function collectNodeScripts(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "__pycache__"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectNodeScripts(path));
    else if ([".js", ".mjs", ".mts"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function writeParams(skill: string, value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), `tmp-${skill}-audit-`));
  tempDirs.push(directory);
  const path = join(directory, `tmp-${skill}-params.json`);
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

describe("bundled Skill script audit", () => {
  it.each(["absolute", "relative"])("embeds %s local image paths when delivering HTML slides", (pathType) => {
    const directory = mkdtempSync(join(tmpdir(), "hogagent 图表 "));
    tempDirs.push(directory);
    const image = join(directory, "研究 图.svg");
    const input = join(directory, "slides.md");
    const output = join(directory, "slides.html");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
    writeFileSync(image, svg);
    const imageSource = pathType === "absolute" ? image.replaceAll('\\', '/') : "研究 图.svg";
    writeFileSync(input, `# 研究报告\n\n<img src="${imageSource}" alt="图表">`);
    const result = spawnSync(process.execPath, [resolve("skills/gen-ppt/scripts/md-to-slides.mjs"), input, output], { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toContain(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  });

  it("passes syntax checking and never opts into shell process execution", () => {
    for (const path of collectNodeScripts(skillsRoot)) {
      const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", timeout: 30_000 });
      expect(checked.status, `${path}\n${checked.stderr || checked.stdout}`).toBe(0);
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/\bshell\s*[:=]\s*true\b|\bexecSync\s*\(|\bchild_process\.exec\s*\(/);
    }
  });

  it("contains no duplicate static object keys", () => {
    const issues: string[] = [];
    for (const path of collectNodeScripts(skillsRoot)) {
      const source = readFileSync(path, "utf8");
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const visit = (node: ts.Node) => {
        if (ts.isObjectLiteralExpression(node)) {
          const seen = new Set<string>();
          for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)
              && !ts.isGetAccessorDeclaration(property) && !ts.isSetAccessorDeclaration(property)) continue;
            const name = property.name;
            const key = ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
              ? name.text
              : undefined;
            if (!key) continue;
            if (seen.has(key)) {
              const location = file.getLineAndCharacterOfPosition(property.getStart(file));
              issues.push(`${path}:${location.line + 1}: duplicate object key ${key}`);
            }
            seen.add(key);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(issues).toEqual([]);
  });

  it("computes TTM from numeric dates but rejects numeric-string financial values", () => {
    const script = resolve("skills/company-valuation/scripts/relative.mjs");
    const valid = writeParams("company-valuation", {
      marketCap: 1000,
      reports: [
        { end_date: 20240930, n_income_attr_p: 90 },
        { end_date: 20231231, n_income_attr_p: 100 },
        { end_date: 20230930, n_income_attr_p: 70 },
      ],
    });
    const output = execFileSync(process.execPath, [script, "pe-ttm", "--params-file", valid], { encoding: "utf8" });
    expect(JSON.parse(output).ttmNetProfit).toBe(120);

    const invalid = writeParams("company-valuation", {
      marketCap: 1000,
      reports: [{ end_date: "20241231", n_income_attr_p: "100" }],
    });
    const rejected = spawnSync(process.execPath, [script, "pe-ttm", "--params-file", invalid], { encoding: "utf8" });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("必须是有限数字");
  });

  it("keeps TAM P/S revenue separate from P/E profit and validates finance arrays", () => {
    const strategic = resolve("skills/company-valuation/scripts/strategic.mjs");
    const output = execFileSync(process.execPath, [strategic, "tam-sam-som", "--tam", "1000", "--marketShare", "0.05", "--industryPS", "8"], { encoding: "utf8" });
    expect(JSON.parse(output).estimatedValue).toBe(120);

    const finCalc = resolve("skills/fin-calc/scripts/call-api.mjs");
    const invalid = writeParams("fin-calc", { rate: 0.1, cashFlows: [100, "200"] });
    const rejected = spawnSync(process.execPath, [finCalc, "npv", "--params-file", invalid], { encoding: "utf8" });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("cashFlows[1]");
  });

  it("accepts the documented totalShares alias for per-share DCF", () => {
    const script = resolve("skills/company-valuation/scripts/absolute.mjs");
    const output = execFileSync(process.execPath, [
      script, "dcf-per-share", "--firstFreeCashFlow", "50", "--growthRate", "0.05",
      "--totalShares", "10", "--netDebt", "20",
    ], { encoding: "utf8" });
    expect(JSON.parse(output).equity.sharesOutstanding).toBe(10);
  });
});
