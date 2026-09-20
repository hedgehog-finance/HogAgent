---
name: fin-calc
description: >
    Financial calculator: PV, FV, PMT, NPV, IRR, RATE, loan term. Loan, investment, annuity, cash flow, interest rate.
    Triggers: financial calc, PV, NPV, IRR, loan, mortgage, annuity, present/future value.
    Blocking: stock prediction, portfolio optimization, tax.
version: 1.0.4
---

# FinCalc — Financial Calculator

PV, FV, PMT, NPV, IRR, RATE, remaining loan term. Rates in decimal form (0.05 = 5%). Cash outflows negative, inflows positive.

## Usage

Use the same CLI parameter rule on every Agent and operating system:

1. When every business value is a non-empty, single-line `string | finite number | boolean`, pass it as a named argument (`--key value` or `--key=value`). Names are case-sensitive and are not normalized.
2. When any value is an object, array, `null`, multiline text, a numeric/boolean-looking string that must remain a string, or contains difficult quoting, write the complete parameter object as UTF-8 JSON and pass `--params-file`.
3. Agent-created parameter files must have a unique basename matching `tmp-<skill-name>-<unique-id>.json`, must not use the reserved `.hedgehog/` directory, and must be removed after the call when no longer needed. UTF-8 BOM is accepted.
4. Do not inline nested JSON or combine flat arguments with a JSON/file payload. Create JSON with the Agent's file-writing capability, not `echo`, a shell heredoc, or PowerShell string assembly.

POSIX/Git Bash form: `node '<script>' <method> --key 'single-line value'` or `node '<script>' <method> --params-file '<workspace>/tmp-<skill-name>-<id>.json'`.

PowerShell form: `node "<script>" <method> --key "single-line value"` or `node "<script>" <method> --params-file "<workspace>\\tmp-<skill-name>-<id>.json"`.

On Windows, use PowerShell or a verified Git for Windows Bash; `cmd.exe` is unsupported. Keep each command on one physical line. HogAgent marks its Windows shell as `UNSANDBOXED`; other Agents apply their own native permissions and sandbox.

For flat methods, call named parameters directly:

```bash
node '<skill_dir>/scripts/call-api.mjs' pv --rate 0.05 --nper 5 --pmt -1000
```

For `npv`, `irr`, or another payload containing an array/object, write UTF-8 JSON to `<workspace>/tmp-fin-calc-<id>.json`, use `--params-file`, then delete the file. Legacy positional JSON and `--params` remain compatibility-only.

## Methods

| Method | Params | Description |
|--------|--------|-------------|
| `pv` | rate, nper, pmt | Present Value |
| `fv` | rate, nper, pmt | Future Value |
| `pmt` | rate, nper, pv | Payment per Period |
| `npv` | rate, cashFlows | Net Present Value |
| `irr` | cashFlows | Internal Rate of Return |
| `rate` | nper, pmt, pv | Interest Rate per Period |
| `remaining-loan-term` | startDateStr, loanTerm, loanTermUnit | Remaining Loan Months |

## Examples

Write one of these payloads to the parameter file, then use the corresponding method in the command above:

```jsonc
// pv
{"rate":0.05,"nper":5,"pmt":-1000}
// npv
{"rate":0.1,"cashFlows":[3000,4000,5000]}
// remaining-loan-term
{"startDateStr":"01 2020","loanTerm":30,"loanTermUnit":"Years"}
```

> Resolve `<skill_dir>/scripts/*` to absolute paths using this SKILL.md's directory (shown in system prompt `available_skills`).
> Output is JSON to stdout; redirect to session task dir if needed.

## Dependencies
`finmaster` in `<hogagent_root>/node_modules/`

The official HogAgent package includes this dependency. Before using a source checkout or an independently copied Skill, install its declared runtime dependencies with `npm install --omit=dev --prefix '<skill_dir>'`. A `package.json` declaration alone does not install the module.

## Execution safety

Parameter files are limited to 10 MiB and invalid, non-object, mixed, empty, multiline, or duplicate inputs fail before calculation. Numeric inputs and every cash-flow item must be finite JSON numbers rather than numeric strings; cash-flow arrays are bounded at 100,000 items. The CLI performs local calculations only, starts no subprocess, makes no network request, and writes JSON only to stdout.
