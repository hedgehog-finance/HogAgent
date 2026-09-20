---
name: company-valuation
description: >
    Valuation engine: relative (PE/PE-TTM/PB/PS/PS-TTM/EV-EBITDA/EV-Revenue/PEG/ARR/P-Active-User/P-GMV/EV-FCF),
    absolute (DCF/DDM/rNPV/Black-Scholes), strategic (TAM-SAM-SOM/LTV-CAC/NRR).
    Triggers: valuation, intrinsic value, PE, PB, PS, DCF, DDM, PEG, EV/EBITDA, ARR, TAM, LTV/CAC, NRR, rNPV.
    Blocks: technical analysis, candlestick patterns, non-valuation financial calculations.
version: 3.0.5
---

# Company Valuation Engine

## Overview

**Pure calculation engine** — no external API calls. Financial data is queried by the caller (agent) via skills like `hedgehog-company-index-data` and passed as JSON params.

**23 valuation methods** (DCF includes 5 sub-methods):

| Category | Script | Count | Methods |
|----------|--------|-------|---------|
| Relative | `scripts/relative.mjs` | 12 | PE / PE-TTM / PB / PS / PS-TTM / EV-EBITDA / EV-Revenue / PEG / ARR / P-Active-User / P-GMV / EV-FCF |
| Absolute | `scripts/absolute.mjs` | 8 | DCF(5) / DDM / rNPV / Black-Scholes |
| Strategic | `scripts/strategic.mjs` | 3 | TAM-SAM-SOM / LTV-CAC / NRR |

## Invocation

Use the same CLI parameter rule on every Agent and operating system:

1. When every business value is a non-empty, single-line `string | finite number | boolean`, pass it as a named argument (`--key value` or `--key=value`). Names are case-sensitive and are not normalized.
2. When any value is an object, array, `null`, multiline text, a numeric/boolean-looking string that must remain a string, or contains difficult quoting, write the complete parameter object as UTF-8 JSON and pass `--params-file`.
3. Agent-created parameter files must have a unique basename matching `tmp-<skill-name>-<unique-id>.json`, must not use the reserved `.hedgehog/` directory, and must be removed after the call when no longer needed. UTF-8 BOM is accepted.
4. Do not inline nested JSON or combine flat arguments with a JSON/file payload. Create JSON with the Agent's file-writing capability, not `echo`, a shell heredoc, or PowerShell string assembly.

POSIX/Git Bash form: `node '<script>' <method> --key 'single-line value'` or `node '<script>' <method> --params-file '<workspace>/tmp-<skill-name>-<id>.json'`.

PowerShell form: `node "<script>" <method> --key "single-line value"` or `node "<script>" <method> --params-file "<workspace>\\tmp-<skill-name>-<id>.json"`.

On Windows, use PowerShell or a verified Git for Windows Bash; `cmd.exe` is unsupported. Keep each command on one physical line. HogAgent marks its Windows shell as `UNSANDBOXED`; other Agents apply their own native permissions and sandbox.

List methods with `node '<skill_dir>/scripts/<script>.mjs' --help`. For example, a flat call can use:

```bash
node '<skill_dir>/scripts/relative.mjs' pe --marketCap 1000000000 --netIncome 80000000
```

When a method needs an array or object, write its payload to a unique file such as `<workspace>/tmp-company-valuation-<id>.json`, call it with `--params-file`, then delete the file. The payload blocks below describe that file's contents. Legacy positional JSON and `--params` remain compatibility-only.

## Method Classification

### Relative Valuation

Compare with industry peers to determine value.

| Method | Formula | Best For |
|--------|---------|----------|
| PE | MktCap / NetIncome | Mature, stable earnings (consumer goods) |
| PE-TTM | MktCap / trailing-4Q net income | Mature profitable companies |
| PB | MktCap / Parent Equity | Financials, capital-intensive |
| PS | MktCap / Revenue | Loss-making high-growth (internet/SaaS) |
| PS-TTM | MktCap / trailing-4Q revenue | High-growth, pre-profit companies |
| EV/EBITDA | EV / EBITDA | Manufacturing, telecom, transport |
| EV/Revenue | EV / Revenue | Loss-making but fast-growing |
| PEG | PE / earnings growth rate | High-growth, measure if PE is justified |
| ARR Multiples | EV / ARR | SaaS (benchmark: Snowflake etc.) |
| P/Active-User | MktCap / active users | Social media, platform companies |
| P/GMV | MktCap / GMV | E-commerce platforms |
| EV/FCF | EV / Free Cash Flow | Semiconductor, high-cash-flow companies |

### Absolute Valuation

Forecast future earnings and discount to present value (intrinsic value).

| Method | Formula | Best For |
|--------|---------|----------|
| DCF | Discount future FCF + terminal value | Mature companies with stable cash flows |
| DDM | Discount future dividends | Mature, high-dividend blue chips |
| rNPV | Σ(NPV × success probability) | Biotech pipeline valuation |
| Black-Scholes | Option pricing model | High-uncertainty frontier tech |

### Strategic Valuation

For disruptive tech companies or special scenarios.

| Method | Formula | Best For |
|--------|---------|----------|
| TAM/SAM/SOM | SOM revenue × industry P/S | Pre-commercialization (autonomous driving, satellites) |
| LTV/CAC | Unit economics → FCF → DCF | Subscription businesses |
| NRR | Projected revenue × industry P/S | AI SaaS / AI Agent (customer expansion revenue) |

## Premium/Discount Factors

Adjust industry multiples based on company traits:

**Premium factors** (raise multiples):
- Market leadership / brand moat
- Core patents / high tech barriers
- High switching costs / strong stickiness
- Blue-chip customer endorsements

**Discount factors** (lower multiples):
- Single-customer revenue concentration
- Low R&D investment vs. peers
- Regulatory / policy risk

> Defaults: low factor 0.8 (−20%); high factor 1.1 (+10%) for pe/pe-ttm/pb/ps/ps-ttm, 1.2 (+20%) for arr/p-active-user/p-gmv/ev-fcf. Customizable via `*LowFactor` / `*HighFactor` params.

## Usage Recommendations

Use **two valuation models** for cross-validation (e.g. 1 relative + 1 absolute):

| Company Stage | Recommended Combo |
|---------------|-------------------|
| Mature & profitable | PE-TTM + DCF |
| Capital-intensive | PB + EV/EBITDA |
| High-growth, no profit | PS-TTM + EV/Revenue |
| SaaS / subscription | ARR + LTV/CAC |
| Biotech | rNPV + DCF |
| Frontier tech | TAM/SAM/SOM + Black-Scholes |
| Platform / social | P/Active-User + P/GMV |
| Semiconductor / AI infra | EV/FCF + PEG |

## Data Preparation

No API calls. Caller must query data via other skills and pass as params.

### Field Reference

| Source | Fields | Used By |
|--------|--------|---------|
| Daily basics | `total_mv`, `close`, `total_share` | All relative methods |
| Daily basics | `pe_ttm`, `pb`, `ps_ttm` | PE-TTM / PB / PS-TTM |
| Income stmt | `n_income_attr_p`, `total_revenue`, `ebit`, `ebitda` | PE / PS / EV-EBITDA |
| Balance sheet | `total_hldr_eqy_exc_min_int`, `st_borr`, `lt_borr`, `money_cap` | PB / EV |
| Cash flow stmt | `free_cashflow`, `n_cashflow_act` | EV/FCF / DCF |
| Industry daily | `pe`, `pb` (industry-level) | Industry benchmarks |
| Financial indicators | `roe`, `netprofit_yoy`, `grossprofit_margin` | Premium/discount judgment |

### TTM Calculation (PE-TTM / PS-TTM)

> **Important**: Quarterly/semi-annual/9-month/annual financial reports contain **year-to-date cumulative values** (not single-quarter). TTM calculation accounts for this.

Two modes:
1. **Direct**: pass pre-computed `ttmNetProfit` or `ttmRevenue`
2. **Auto**: pass `reports[]` (with `end_date` + financial field), script computes TTM automatically

TTM rules (all based on cumulative values, subtraction removes overlap):
- `end_date` ends with `1231` → Annual: TTM = annual value
- `end_date` ends with `0331` → Q1: TTM = Q1_cum + (lastYear_annual − lastYear_Q1_cum) → this year Q1 + last year Q2-Q4
- `end_date` ends with `0630` → H1: TTM = H1_cum + (lastYear_annual − lastYear_H1_cum) → this year H1 + last year H2
- `end_date` ends with `0930` → Q3: TTM = Q3_cum + (lastYear_annual − lastYear_Q3_cum) → this year Q1-Q3 + last year Q4

---

## API Reference

### Relative Valuation (`relative.mjs`)

#### Common Optional Params (shared across methods)

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| totalShare | number | — | Total shares outstanding (for price range calc) |
| currentPrice | number | — | Current stock price (for rating) |
| *LowFactor | number | 0.8 | Discount factor |
| *HighFactor | number | 1.1 or 1.2 | Premium factor (1.2 for arr/p-active-user/p-gmv/ev-fcf) |

#### 1. pe — Static P/E

```json
{"marketCap":300000,"netIncome":20000,"industryPE":18,"totalShare":50000}
```

| Param | Type | Req | Desc |
|-------|------|-----|------|
| marketCap | number | either | Total market cap |
| netIncome | number | either | Net income |
| price | number | either | Stock price (with eps) |
| eps | number | either | Earnings per share |
| pe | number | opt | Direct PE value |
| industryPE | number | opt | Industry PE multiple |

#### 2. pe-ttm — Trailing P/E (TTM)

```jsonc
// Direct mode
{"marketCap":300000,"ttmNetProfit":30000,"totalShare":50000,"industryPE":15}
// Auto mode (reports array)
{"marketCap":300000,"reports":[{"end_date":"20250331","n_income_attr_p":8000},{"end_date":"20241231","n_income_attr_p":25000},{"end_date":"20240331","n_income_attr_p":7000}],"totalShare":50000,"industryPE":15}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| marketCap | number | yes | — | Total market cap |
| ttmNetProfit | number | either | — | Pre-computed TTM net profit |
| reports | array | either | — | Reports array (end_date + n_income_attr_p) |
| reportField | string | opt | n_income_attr_p | Field name in reports |
| industryPE | number | opt | — | Industry PE multiple |

#### 3. pb — Price/Book

```json
{"marketCap":300000,"equityToParent":200000,"totalShare":50000,"industryPB":1.5}
```

| Param | Type | Req | Desc |
|-------|------|-----|------|
| marketCap | number | yes | Total market cap |
| equityToParent | number | yes | Equity attributable to parent |
| industryPB | number | opt | Industry PB multiple |

#### 4. ps — Static P/S

```json
{"marketCap":300000,"revenue":50000,"industryPS":8,"totalShare":50000}
```

| Param | Type | Req | Desc |
|-------|------|-----|------|
| marketCap | number | yes | Total market cap |
| revenue | number | yes | Revenue |
| industryPS | number | opt | Industry PS multiple |

#### 5. ps-ttm — Trailing P/S (TTM)

```json
{"marketCap":300000,"ttmRevenue":120000,"totalShare":50000,"peerPS":2.5}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| marketCap | number | yes | — | Total market cap |
| ttmRevenue | number | either | — | Pre-computed TTM revenue |
| reports | array | either | — | Reports array (end_date + total_revenue) |
| reportField | string | opt | total_revenue | Field name in reports |
| peerPS | number | opt | — | Peer avg PS-TTM |
| industryPS | number | opt | — | Industry PS |

#### 6. ev-ebitda

```json
{"marketCap":300000,"totalDebt":50000,"cash":30000,"ebitda":40000}
```

| Param | Type | Req | Desc |
|-------|------|-----|------|
| marketCap | number | yes | Market cap |
| totalDebt | number | yes | Total debt |
| cash | number | yes | Cash |
| ebitda | number | yes | EBITDA |

#### 7. ev-revenue

```json
{"marketCap":300000,"totalDebt":50000,"cash":30000,"revenue":100000}
```

Same as ev-ebitda but with `revenue` instead of `ebitda`.

#### 8. peg — PEG Ratio

```json
{"pe":20,"earningsGrowthRate":0.25,"targetPEG":1.0,"netIncome":20000,"totalShare":50000}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| pe | number | either | — | PE value |
| marketCap + netIncome | number | either | — | Or derive PE from these |
| earningsGrowthRate | number | yes | — | Growth rate (decimal, e.g. 0.25 = 25%) |
| targetPEG | number | opt | 1.0 | Target PEG |
| netIncome | number | opt | — | For valuation calc |

#### 9. arr — ARR Multiples

```json
{"marketCap":500000,"totalDebt":50000,"cash":30000,"arr":60000,"industryARRMultiple":12}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| marketCap | number | yes | — | Market cap |
| totalDebt | number | opt | 0 | Total debt |
| cash | number | opt | 0 | Cash |
| arr | number | yes | — | Annual recurring revenue |
| industryARRMultiple | number | opt | — | Industry avg ARR multiple (8-20x) |

#### 10. p-active-user — Per-User Value (MAU/DAU)

```json
{"marketCap":500000,"activeUsers":80000000,"userType":"MAU","industryValuePerUser":0.01}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| marketCap | number | yes | — | Market cap |
| activeUsers | number | yes | — | Active user count |
| userType | string | opt | MAU | `"MAU"` or `"DAU"` |
| industryValuePerUser | number | opt | — | Industry per-user value |

#### 11. p-gmv

```json
{"marketCap":800000,"gmv":2000000,"industryPGmv":0.5}
```

| Param | Type | Req | Desc |
|-------|------|-----|------|
| marketCap | number | yes | Market cap |
| gmv | number | yes | Gross merchandise value |
| industryPGmv | number | opt | Industry P/GMV multiple |

#### 12. ev-fcf — EV/Free Cash Flow

```json
{"marketCap":500000,"totalDebt":50000,"cash":30000,"freeCashFlow":40000,"industryEvFcf":15}
```

| Param | Type | Req | Desc |
|-------|------|-----|------|
| marketCap | number | yes | Market cap |
| totalDebt | number | opt | Total debt (default 0) |
| cash | number | opt | Cash (default 0) |
| freeCashFlow | number | yes | Free cash flow |
| industryEvFcf | number | opt | Industry avg EV/FCF multiple |

---

### Absolute Valuation (`absolute.mjs`)

#### DCF Methods (migrated from dcf-valuation, fully preserved)

##### dcf — Basic DCF (10-year growth-driven projection)

```json
{"firstFreeCashFlow":50,"growthRates":[0.15,0.05],"terminalFcfMultiple":20,"discountRate":0.10}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| firstFreeCashFlow | number | yes | — | First-year FCF |
| growthRates | array | opt | [0.05] | Growth rate array (phased) |
| terminalFcfMultiple | number | opt | 15 | Terminal FCF multiple |
| discountRate | number | opt | 0.10 | Discount rate |
| decimals | number | opt | 2 | Decimal places |

##### dcf-per-share — Intrinsic Value Per Share

```json
{"firstFreeCashFlow":50,"growthRates":[0.15,0.05],"discountRate":0.10,"sharesOutstanding":10,"netDebt":200,"currentPrice":80}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| firstFreeCashFlow | number | yes | — | First-year FCF |
| sharesOutstanding | number | either | — | Total shares (`totalShares` is accepted as an alias) |
| netDebt | number | opt | 0 | Net debt (or totalDebt + cash) |
| totalDebt | number | opt | 0 | Total debt |
| cash | number | opt | 0 | Cash |
| currentPrice | number | opt | — | Current stock price |
| marginOfSafety | number | opt | 0.20 | Safety margin |

##### wacc — Weighted Average Cost of Capital (CAPM)

```json
{"riskFreeRate":0.025,"beta":1.2,"equityRiskPremium":0.06,"costOfDebt":0.035,"taxRate":0.15}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| riskFreeRate | number | opt | 0.03 | Risk-free rate |
| beta | number | opt | 1.0 | Beta coefficient |
| equityRiskPremium | number | opt | 0.055 | Equity risk premium |
| costOfDebt | number | opt | 0.04 | Cost of debt |
| taxRate | number | opt | 0.25 | Tax rate |
| marketCap | number | opt | — | For weight calc |
| totalDebt | number | opt | — | For weight calc |
| equityWeight | number | opt | 0.7 | Equity weight |
| debtWeight | number | opt | 0.3 | Debt weight |

##### sensitivity — Sensitivity Analysis Matrix

```json
{"firstFreeCashFlow":50,"growthRates":[0.12,0.05],"discountRate":0.10,"terminalFcfMultiple":15,"sharesOutstanding":10,"netDebt":200}
```

Output uses the Vega-Lite v6 chart contract. The command returns `method: "sensitivity"` plus the top-level `sensitivity` and `inputs` objects.

- `sensitivity.chartData` — flattened `{ discountRate, terminalMultiple, value }` rows
- `sensitivity.vegaLiteSpec` — complete Vega-Lite v6 specification with inline `data.values`; write this object to a JSON file and pass it directly to `gen-chart`
- `sensitivity.metric` / `sensitivity.baseCase` — chart metric and base-case coordinates
- `inputs` — normalized calculation inputs

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| firstFreeCashFlow | number | yes | — | First-year FCF |
| growthRates | array | opt | [0.05] | Growth rates |
| discountRate | number | opt | 0.10 | Base discount rate |
| terminalFcfMultiple | number | opt | 15 | Base terminal multiple |
| discountRateRange | number | opt | 0.03 | DR variation range |
| terminalMultipleRange | number | opt | 5 | TM variation range |
| sharesOutstanding | number | opt | — | For per-share output |
| netDebt | number | opt | 0 | Net debt |

**Vega-Lite heatmap** — `sensitivity.vegaLiteSpec` is returned in this directly renderable form:
```json
{"$schema":"https://vega.github.io/schema/vega-lite/v6.json","data":{"values":[{"discountRate":"8.00%","terminalMultiple":12,"value":18.5}]},"mark":"rect","encoding":{"x":{"field":"terminalMultiple","type":"ordinal"},"y":{"field":"discountRate","type":"ordinal"},"color":{"field":"value","type":"quantitative"}}}
```

##### fcf-series — Custom FCF Sequence

```json
{"fcfSeries":[50,58,67,75,82,88,93,97,100,103],"discountRate":0.09,"terminalFcfMultiple":18}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| fcfSeries | array | yes | — | FCF array (yearly values) |
| discountRate | number | opt | 0.10 | Discount rate |
| terminalFcfMultiple | number | opt | 15 | Terminal multiple |
| sharesOutstanding | number | opt | — | For per-share calc |
| netDebt | number | opt | 0 | Net debt |

#### DDM — Dividend Discount Model

```jsonc
// Single-stage (Gordon Growth)
{"dividend":2,"growthRate":0.05,"discountRate":0.10}
// Two-stage
{"dividend":2,"growthRate":0.03,"discountRate":0.10,"highGrowthRate":0.15,"highGrowthYears":5}
// Three-stage
{"dividend":2,"growthRate":0.03,"discountRate":0.10,"highGrowthRate":0.15,"highGrowthYears":5,"transitionYears":3}
```

| Param | Type | Req | Desc |
|-------|------|-----|------|
| dividend | number | yes | Current dividend D0 |
| growthRate | number | yes | Perpetual growth rate |
| discountRate | number | yes | Required return rate |
| highGrowthRate | number | opt | High-growth rate (enables 2/3-stage) |
| highGrowthYears | number | opt | High-growth years |
| transitionYears | number | opt | Transition years (enables 3-stage) |

#### rnpv — Risk-Adjusted NPV

```json
{"pipeline":[{"name":"DrugA","cashFlows":[500,1000,2000],"discountRate":0.10,"probability":0.6,"initialCost":200},{"name":"DrugB","cashFlows":[300,800,1500],"discountRate":0.10,"probability":0.3,"initialCost":150}]}
```

| Param | Type | Req | Desc |
|-------|------|-----|------|
| pipeline | array | yes | Pipeline array |
| .name | string | opt | Pipeline name |
| .cashFlows | array | yes | Yearly cash flows |
| .discountRate | number | opt | Discount rate (default 0.10) |
| .probability | number | yes | Success probability (0-1) |
| .initialCost | number | opt | Initial cost (default 0) |

#### black-scholes — Option Pricing

```json
{"S":100,"K":100,"T":1,"r":0.05,"sigma":0.3}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| S | number | yes | — | Underlying asset price |
| K | number | yes | — | Strike price |
| T | number | yes | — | Time to expiry (years) |
| r | number | yes | — | Risk-free rate |
| sigma | number | yes | — | Volatility |
| q | number | opt | 0 | Dividend yield |

Output: callPrice, putPrice, d1, d2, Greeks (delta, gamma, vega, theta, rho).

---

### Strategic Valuation (`strategic.mjs`)

#### tam-sam-som — Market Sizing → Valuation

```json
{"tam":1000,"serviceableRatio":0.3,"marketShare":0.05,"industryPS":8}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| tam | number | yes | — | Total addressable market |
| serviceableRatio | number | opt | 0.3 | SAM/TAM ratio |
| marketShare | number | yes | — | Target market share |
| targetNetMargin | number | required with P/E | — | Target net margin used to derive SOM net profit |
| industryPS | number | either | — | Industry P/S multiple |
| industryPE | number | either | — | Industry P/E multiple |

Logic: SAM = TAM × ratio → SOM revenue = SAM × share. P/S valuation uses SOM revenue directly; P/E valuation requires `targetNetMargin` and uses SOM revenue × margin as net profit.

#### ltv-cac — Unit Economics → DCF

```json
{"arpu":100,"grossMargin":0.7,"churnRate":0.05,"cac":200,"currentUsers":10000,"userGrowthRate":0.3,"discountRate":0.10}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| arpu | number | yes | — | Avg revenue per user |
| grossMargin | number | opt | 1 | Gross margin |
| churnRate | number | either | — | Churn rate (e.g. 0.05 = 5%) |
| retentionPeriod | number | either | — | Retention period (months) |
| cac | number | yes | — | Customer acquisition cost |
| currentUsers | number | opt | — | Current users (enables DCF) |
| userGrowthRate | number | opt | 0 | User growth rate |
| discountRate | number | opt | 0.10 | Discount rate |
| projectionYears | number | opt | 5 | Projection years |
| terminalGrowthRate | number | opt | 0.03 | Terminal growth rate |

Logic: LTV = ARPU × margin × (1/churnRate) → yearly FCF projection → DCF discount. LTV/CAC > 3 = excellent.

#### nrr — Net Revenue Retention ★ AI SaaS

```json
{"currentARR":5000000,"nrr":1.25,"userGrowthRate":0.3,"projectionYears":3,"industryPS":10}
```

| Param | Type | Req | Default | Desc |
|-------|------|-----|---------|------|
| currentARR | number | yes | — | Current annual recurring revenue |
| nrr | number | yes | — | Net revenue retention (e.g. 1.25 = 125%) |
| userGrowthRate | number | opt | 0 | Subscriber growth rate |
| projectionYears | number | opt | 3 | Projection years |
| industryPS | number | opt | — | Industry P/S multiple |
| currentUsers | number | opt | — | Current users (ARR validation) |
| arpu | number | opt | — | ARPU (ARR validation) |

Top AI SaaS companies: NRR typically 120%-130%. Logic: projected_revenue = currentARR × (1+growthRate) × NRR (multi-year) → Valuation = final_year_revenue × P/S.

---

## File Structure

```
company-valuation/
├── SKILL.md
└── scripts/
    ├── relative.mjs      # Relative valuation (12 methods)
    ├── absolute.mjs      # Absolute valuation (DCF 5 + DDM + rNPV + Black-Scholes)
    └── strategic.mjs     # Strategic valuation (TAM/SAM/SOM + LTV/CAC + NRR)
```

## Dependencies

- `discounted-cash-flow` (DCF methods)
- Node.js >= 18 (ESM)

The official HogAgent package includes this dependency. Before using a source checkout or an independently copied Skill, install its declared runtime dependencies with `npm install --omit=dev --prefix '<skill_dir>'`. A `package.json` declaration alone does not install the module.

## Execution safety

Parameter files are limited to 10 MiB and invalid, non-object, mixed, empty, multiline, or duplicate inputs fail before calculation. Numeric inputs must be finite JSON numbers rather than numeric strings. TTM reports, growth/FCF arrays, rNPV pipelines, sensitivity grids, and option domains are size- and type-checked before calculation. These scripts perform local calculations only: they do not start subprocesses or make network requests, and they write results only to stdout.
