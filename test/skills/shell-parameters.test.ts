import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createBashTool } from "../../src/tools/builtin-tools.ts";
import { prepareBashRuntime } from "../../src/tools/bash-sandbox.ts";
import { loadJsonParams as loadValuationParams } from "../../skills/company-valuation/scripts/params.mjs";
import { loadJsonParams as loadFinancialParams } from "../../skills/fin-calc/scripts/params.mjs";

function resultText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((item) => item.text).join("\n");
}

function quoteShellLiteral(value: string): string {
  if (process.platform === "win32") return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("built-in Skill shell parameters", () => {
  it("uses JSON parameter files without shell parsing or injection", async () => {
    const root = mkdtempSync(join(tmpdir(), "hogagent-skill 中文 shell-"));
    const workspace = join(root, "workspace");
    const systemDir = join(root, "system");
    const paramsDir = join(workspace, "params");
    const sentinel = join(workspace, "must-not-exist");
    mkdirSync(paramsDir, { recursive: true });

    try {
      const prepared = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: resolve("."),
        systemDir,
        sandboxMode: process.platform === "win32" ? "enabled" : "disabled",
      });
      if (!prepared.available) throw new Error(prepared.reason);
      if (process.platform === "win32") {
        expect(prepared.runtime.shells.map((shell) => basename(shell).toLowerCase())).not.toContain("cmd.exe");
      }

      const tool = createBashTool(prepared.runtime);
      const injection = process.platform === "win32"
        ? "$(New-Item must-not-exist)"
        : "$(touch must-not-exist)";
      const hostileText = `中文 O'Brien & | ${injection}`;
      const cases = [
        {
          script: "skills/fin-calc/scripts/call-api.mjs",
          method: "pv",
          params: { rate: 0.05, nper: 5, pmt: -1000, note: hostileText },
        },
        {
          script: "skills/company-valuation/scripts/relative.mjs",
          method: "pe",
          params: { marketCap: 300000, netIncome: 20000, industryPE: 18, note: hostileText },
        },
        {
          script: "skills/company-valuation/scripts/absolute.mjs",
          method: "black-scholes",
          params: { S: 100, K: 100, T: 1, r: 0.05, sigma: 0.3, note: hostileText },
        },
        {
          script: "skills/company-valuation/scripts/strategic.mjs",
          method: "nrr",
          params: { currentARR: 5000000, nrr: 1.25, note: hostileText },
        },
      ];

      for (const [index, testCase] of cases.entries()) {
        const skillName = testCase.script.includes("fin-calc") ? "fin-calc" : "company-valuation";
        const paramsFile = join(paramsDir, `tmp-${skillName}-${index}.json`);
        writeFileSync(paramsFile, `\uFEFF${JSON.stringify(testCase.params)}`, "utf8");
        const command = [
          ...(process.platform === "win32" ? ["&"] : []),
          quoteShellLiteral(process.execPath),
          quoteShellLiteral(resolve(testCase.script)),
          testCase.method,
          "--params-file",
          quoteShellLiteral(paramsFile),
        ].join(" ");
        expect(command).not.toContain("\n");

        const output = resultText(await tool.execute(`params-file-${index}`, { command }));
        expect(output).toContain(`"method": "${testCase.method}"`);
        expect(output).not.toMatch(/Invalid JSON|Cannot read params file|exit code/i);
      }
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("coerces safe flat named parameters without inline JSON", () => {
    const flatArgs = [
      "--keyword", "贵州 茅台", "--positive", "20", "--negative=-3", "--decimal", "0.25",
      "--scientific", "1e3", "--enabled", "true", "--disabled=false", "--code", "000001",
    ];
    const expected = {
      keyword: "贵州 茅台", positive: 20, negative: -3, decimal: 0.25,
      scientific: 1000, enabled: true, disabled: false, code: "000001",
    };
    expect(loadValuationParams(flatArgs)).toEqual(expected);
    expect(loadFinancialParams(flatArgs)).toEqual(expected);

    const cases = [
      ["skills/company-valuation/scripts/relative.mjs", "pe"],
      ["skills/fin-calc/scripts/call-api.mjs", "pv"],
    ];
    for (const [script, method] of cases) {
      const result = spawnSync(
        process.execPath,
        [
          resolve(script), method,
          ...(method === "pe"
            ? ["--marketCap", "300000", "--netIncome=20000", "--listed", "true", "--code", "000001"]
            : ["--rate", "0.05", "--nper=5", "--pmt", "-1000", "--listed", "false", "--code", "000001"]),
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`"method": "${method}"`);
    }
  });

  it("directs legacy malformed inline JSON to the portable file option", () => {
    for (const [script, method] of [
      ["skills/company-valuation/scripts/relative.mjs", "pe"],
      ["skills/fin-calc/scripts/call-api.mjs", "pv"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [resolve(script), method, "{keyword:贵州茅台,limit:20}"],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/flat named parameters.*tmp-\*\.json.*--params-file/i);
    }
  });
});
