# HogAgent Skill System Documentation

> 2026-09-07 布局更新：当前目录、提示词、凭据与恢复规则以 [统一工作空间](unified-workspace.md) 为准；下文旧路径及历史审计结论仅用于兼容/迁移背景，不再作为执行配置。

## What is a Skill?

A **Skill** is a self-contained capability package that provides context and instructions to the agent. Each skill is a directory containing a `SKILL.md` file that describes what the skill does, which tools it relies on, and how to use them.

Skills are the **knowledge layer** — they tell the agent _what it can do_ and _how to do it_. Tools are the **execution layer** — they actually perform the operations.

### Installation boundaries

Workspace installations use `.hogagent/skills/<name>/`. RPC Git installation and Web Git/ZIP installation share name validation: only letters, digits, underscores, hyphens and dots are accepted; `..` and trailing dots are rejected so a name cannot select the parent/current directory or a Windows trailing-dot alias. This also applies to Web management operations. RPC installation refuses disk changes during an active instruction snapshot.

Updates use unique hidden staging and backup names (`.<name>.tmp-<uuid>` / `.<name>.bak-<uuid>`); installed Skills named `<name>.tmp` or `<name>.bak` are not staging areas. ZIP uploads use unique hidden temporary files. ZIP extraction rejects links and special filesystem entries in addition to path traversal, accepting only regular files and directories. No legacy workspace-root Skill discovery is added.

RPC Git and Web Git/ZIP share `installSkillDirectory`: both first installs and updates populate a hidden candidate and require a regular `SKILL.md` with loader-compatible name/description frontmatter before publication. Version comparison is unchanged. A failed candidate is removed; failed replacement attempts restore the old directory. After successful publication, old-backup and upload-ZIP cleanup are best effort and logs retained paths without reporting the installed version as failed. This is local synchronous publication with rollback on an ordinary error, not a promise of crash recovery between every filesystem operation.

### Skill Dependencies

Node-based skills declare their dependencies in a per-skill `package.json`. All skill dependencies are also aggregated into HogAgent's root `package.json`, so a single `npm install` at the HogAgent root covers every built-in skill (skill scripts resolve modules via the upward `node_modules` search from the HogAgent tree). When packaging for distribution, `hedgehog-gateway/scripts/bundle-skills.sh` additionally runs `npm install --omit=dev` inside each skill directory so the shipped bundle is self-contained and does not depend on the packaging machine's local state.

Every `SKILL.md` whose directory contains a `package.json` must include a dependency reminder. The official package may describe modules as pre-installed, but source checkouts and independently copied Skills must run `npm install --omit=dev --prefix '<skill_dir>'` before first use. Declaring a module in `package.json` does not install it, and `ERR_MODULE_NOT_FOUND` should be treated as an incomplete dependency installation rather than a shell-quoting failure.

### Skill vs. Tool vs. Extension

| Concept | Location | Purpose | Naming |
|---------|----------|---------|--------|
| **Skill** | `skills/<name>/SKILL.md` | Contextual knowledge and usage instructions | kebab-case (`gen-chart`) |
| **Tool** | Registered in agent state | Executable function the LLM can call | snake_case (`math_calc`) |
| **Extension** | `extensions/<name>/index.js` | Runtime plugin with lifecycle hooks | kebab-case (`content-compressor`) |

---

## SKILL.md Format

Frontmatter accepts both LF and Windows CRLF line endings in the runtime loader and WebUI metadata display. The instruction body retains its original line endings.

Every skill **must** include a YAML frontmatter block with `name` and `description` fields. Skills without frontmatter are not loaded.

```markdown
---
name: my-skill
description: >
    Brief description of what this skill does.
    Applicable: scenario A, scenario B.
    Triggers: keyword1, keyword2.
    Blocking: what this skill does NOT handle.
version: 1.0.0
---

# <Skill Display Name>

## Scripts
...
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique skill identifier (kebab-case) |
| `description` | Yes | Multi-line description with triggers, applicable scenarios, and blocking scenarios. Use YAML `>` folded syntax. |
| `version` | No | Semantic version of the skill |

> The system prompt only shows `name` and `description`. The full SKILL.md body is loaded on-demand when the LLM reads the file.

### `hog-memory` system prompt integration

An available skill whose frontmatter name is exactly `hog-memory` enables the
dedicated `memory_guidance` system-prompt segment even when the built-in Memory
Extension is disabled or has no Gateway MCP URL. The segment includes the
skill's description and workspace-derived
`<workspaceDir>/.hogagent/skills/hog-memory/SKILL.md` path, and directs the agent to read
and follow the skill before performing memory operations.

The built-in Memory Extension takes priority over the skill. If both are
available, only the `memory_extension` prompt section is emitted and
`hog-memory` is omitted from the model-visible `available_skills` catalog. The
`hog_memory_skill` section is a fallback used only when the extension is
unavailable; it does not assume the extension's `memory_save`/`memory_search`
schemas.

The fallback guidance mirrors the extension's tag and relevant-search rules.
Both persist only when the user request or standing workspace policy authorizes
it, never transient/sensitive content by default. The fallback uses `save` and `search` operations
without embedding CLI paths or command templates.
It also points to the CLI's `recall`, `update`, `delete`, and `list` operations.

Skill instructions are read completely across bounded pages, continuing to EOF if
truncated. `raw=true` only skips optional result compression and never bypasses read limits; there is no 500-line exemption from reading instructions. Bulk data
still uses bounded reads. Native tools and Skill/project scripts can implement
Gateway calls; product prompts prohibit LLM-improvised raw requests, not these
implementation paths. No new invocation gate is added.

Work attribution is an extension-only runtime behavior: `memory_save` forwards
the trusted current task `work_id` when Gateway supplied one and omits it
otherwise. The `hog-memory` fallback must not invent a Work ID when none is
available.

### Naming Conventions

- **Skill directory name**: `kebab-case` (e.g., `gen-chart`, `doc-convert`, `fin-calc`)
- **Tool names**: `snake_case` (e.g., `math_calc`, `web_search`, `deliver_files`)
- **Relationship**: A skill named `my-skill` typically provides a tool named `my_skill`

---

## Built-in Tools

HogAgent includes six always-registered Pi-style file tools plus a conditional, legacy-named Bash tool. They do not require a skill. On macOS/Linux, `hogagent.json.sandboxMode` selects strict isolation (`enabled`), isolation with a warning-marked bare-shell fallback (`fallback`), or the default direct shell (`disabled`). Windows does not support the sandbox, ignores the setting, and exposes a platform-marked `UNSANDBOXED` Windows PowerShell or verified Git Bash in every mode; `cmd.exe` is unsupported:

| Tool | Description |
|------|-------------|
| `read` | Read file contents (supports pagination, section extraction, raw mode) |
| `write` | Write content to a file |
| `edit` | Edit a file using search/replace blocks |
| `bash` | Execute commands using the selected platform shell; on macOS/Linux, `enabled` fails closed while `fallback` and `disabled` may run clearly marked `UNSANDBOXED` shells. Windows always runs `UNSANDBOXED` with Windows PowerShell or verified Git Bash. |
| `grep` | Search file contents using regex |
| `find` | Find files by name pattern |
| `ls` | List directory contents |

Additional tools: `math_calc`, `web_search`, `web_fetch`; explicitly enabled content compression may add `get_tool_details` and `query_tool_result`; other extensions may add `spawn_sub_agent`, `deliver_files`, `memory_save`, and `memory_search`.

Built-in Skills keep commands on one line and use one cross-platform parameter protocol. A top-level object containing only safe non-empty single-line strings, finite numbers, and booleans is passed as named arguments. Any object/array/`null`, multiline or quoting-sensitive value, or numeric/boolean-looking string that must retain string type goes in UTF-8 JSON created with the file tool. Agent-created parameter files use a unique `tmp-<skill-name>-<id>.json` basename, never the reserved `.hedgehog/` protocol directory, and are deleted after use. The CLI receives only the path through its documented file option; nested JSON and mixed payload sources are forbidden. macOS/Linux sandbox boundaries still apply, while Windows is explicitly `UNSANDBOXED`.

---

### doc-convert

**Description:** Convert between document formats (Markdown/HTML to PDF, PDF to Markdown, DOCX to HTML/Markdown). Supports optional LLM-based high-fidelity parsing.

**Scripts provided:**
- `md-to-pdf.mjs` — Convert Markdown to PDF
- `html-to-pdf.mjs` — Convert HTML to PDF
- `pdf-to-markdown.mjs` — Convert PDF to Markdown (unpdf or LLM)
- `docx-to-html.mjs` — Convert DOCX to HTML
- `html-to-markdown.mjs` — Convert HTML to Markdown
- `docx-to-markdown.mjs` — Convert DOCX to Markdown (chain or LLM)

**Requirements:** `md-to-pdf`, `convert-html-to-pdf`, `mammoth`, `turndown`, `turndown-plugin-gfm`, `unpdf` npm packages.

---

### gen-chart

**Description:** Generate charts and diagrams using Vega-Lite or Mermaid.

**Scripts provided:**
- `vega-chart.mjs` — Generate charts from Vega-Lite specifications (PNG output)
- `mermaid-chart.mjs` — Generate diagrams from Mermaid syntax (PNG output)

**References:**
- `references/vega-lite-examples.md` — Vega-Lite specification examples

**Requirements:** Vega 6, Vega-Lite 6, and `@mermaid-js/mermaid-cli`. Generated specifications use the Vega-Lite v6 schema when an explicit `$schema` is included.

**Headless text measurement:** `vega-chart.mjs` runs without node-canvas, so it installs a CJK-aware text-width estimator into `vega.textMetrics.width` (Vega's built-in 0.8em/char fallback underestimates full-width CJK glyphs and overlaps horizontal Chinese legend labels).

**Layout margins:** theme presets set `legend.offset: 16` / `title.offset: 14` so the legend stays clear of the x-axis labels/title and the chart title row; `echarts-config.mjs` reserves `grid.bottom: 56` when a bottom legend is shown.

---

### gen-ppt

Version 2.4.3 fixes HTML slide image resolution for Windows drive paths. Local images may use native absolute paths or paths relative to the Markdown input; use forward slashes in Markdown/HTML image attributes on Windows. Paths containing spaces and Chinese characters are supported.

**Description:** Generate presentations in two modes — defaults to native .pptx (editable in PowerPoint/Keynote/Google Slides) from JSON configuration; opt-in HTML web slides (.html, self-contained, plays in browser) from Markdown. Supports 9 layout types (title, section, content, two-column, image-text, chart, table, closing, blank), 10 financial color themes, charts (native types or pre-rendered image via `chart.type: "image"`), tables, images, and custom positioned elements (PPTX mode). Text fields support inline formatting: Markdown (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``) and HTML tags (`<strong>`, `<em>`, `<u>`, `<sub>`, `<sup>`, `<br>`, `<center>`). Images should be PNG/JPG — SVG paths are auto-substituted with a same-name .png when available. HTML mode supports standard Markdown syntax with keyboard/touch/button navigation and overview mode.

**Scripts provided:**
- `scripts/gen-ppt.mjs` — Convert JSON configuration to native PPTX file (default mode)
- `scripts/md-to-slides.mjs` — Convert Markdown to self-contained HTML slides (on-demand mode)

**References:**
- `references/json-schema.md` — Full JSON configuration specification (PPTX mode)
- `references/examples.md` — Complete example presentations (5 scenarios, PPTX mode)

**Usage:**
```bash
# Default: native PPTX
node scripts/gen-ppt.mjs <workspace>/tmp-gen-ppt-<id>.json <output.pptx> [--theme=<name>]

# On-demand: HTML web slides
node scripts/md-to-slides.mjs <input.md> <output.html> [--theme=<name>] [--title="Title"]
```

**Requirements:** `pptxgenjs` (PPTX mode), `marked` + `highlight.js` (HTML mode) npm packages.

---

### fin-calc

**Description:** Professional financial calculator skill powered by the FinMaster library. Supports PV, FV, PMT, NPV, IRR, RATE, and remaining loan term calculations via `scripts/call-api.js`.

**Scripts provided:**
- `scripts/call-api.js` — Local FinMaster calculation script

**Usage:**

```bash
node scripts/call-api.js pv --rate 0.05 --nper 5 --pmt -1000
node scripts/call-api.js <method> --params-file <workspace>/tmp-fin-calc-<id>.json
```

**Supported methods:**

| Method | Required params | Description |
|--------|----------------|-------------|
| `pv` | rate, nper, pmt | Present value |
| `fv` | rate, nper, pmt | Future value |
| `pmt` | rate, nper, pv | Payment per period |
| `npv` | rate, cashFlows | Net present value |
| `irr` | cashFlows | Internal rate of return |
| `rate` | nper, pmt, pv | Interest rate per period |
| `remaining-loan-term` | startDateStr, loanTerm, loanTermUnit | Remaining loan months |

**Examples:**

```bash
# Present value: 5 years at 5%, receiving $1000/year
node scripts/call-api.js pv '{"rate":0.05,"nper":5,"pmt":-1000}'
# → { "method": "pv", "result": 4329.48 }

# Future value: 60 months at 0.5%/month, saving $200/month
node scripts/call-api.js fv '{"rate":0.005,"nper":60,"pmt":-200}'
# → { "method": "fv", "result": 13954.01 }

# IRR: investment return calculation
node scripts/call-api.js irr '{"cashFlows":[-10000,3000,4000,5000,6000]}'
# → { "method": "irr", "result": 0.2489 }
```

**Notes:**
- All rate values use decimal form (0.05 = 5%)
- Cash outflows are negative, inflows are positive
- Requires the `finmaster` npm package (bundled in HogAgent root dependencies; no per-skill install needed)

---

### table-convert

**Description:** Convert spreadsheet files (.xlsx, .xls, .csv) to JSON arrays or Markdown tables.

**Scripts provided:**
- `scripts/convert.mjs` — Main converter script

**Usage:**
```bash
node scripts/convert.mjs <input> <output> [--format=json|markdown] [--sheet=<name|index>]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--format` | `json` | Output format: `json` or `markdown` |
| `--sheet` | first sheet | Sheet name, 0-based index, or `list` to print all sheet names |

**Examples:**

```bash
# CSV to JSON (default)
node scripts/convert.mjs data.csv output.json

# Excel to Markdown table
node scripts/convert.mjs report.xlsx output.md --format=markdown

# Convert specific sheet by name
node scripts/convert.mjs multi.xlsx output.json --sheet=Sales

# List all sheet names
node scripts/convert.mjs multi.xlsx dummy --sheet=list
```

**Requirements:** `xlsx` and `markdown-table` npm packages.

---

### tech-indicators

**Description:** Calculate 50+ technical analysis indicators and 35 candlestick patterns (75 total) locally from OHLCV JSON data. Based on fast-technical-indicators library, no network required.

**Scripts provided:**
- `scripts/calc.mjs` — Indicator calculation engine

**Usage:**
```bash
node scripts/calc.mjs <data.json> <output> [--indicators=sma,ema,rsi,...] [--params=<file.json>] [--format=json|markdown]
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--indicators` | `sma,ema,rsi,macd,bollingerbands` | Comma-separated indicator names, supports `all` for all 75 indicators |
| `--params` | none | JSON file path for custom parameter overrides |
| `--format` | `json` | Output format: `json` or `markdown` |
| `--list` | — | List all supported indicator names |

**Input format:** JSON array of OHLCV objects:
```json
[
  {"date": "2024-01-02", "open": 187.13, "high": 188.44, "low": 186.60, "close": 187.68, "volume": 41266200}
]
```

**Supported indicator categories:**
- **Trend:** SMA, EMA, WMA, WEMA, MACD, PSAR, SuperTrend, Aroon, IchimokuCloud, Trix, DPO, LinearRegression, MAEnvelope
- **Oscillators:** RSI, StochasticRSI, CCI, WilliamsR, ROC, PPO, KST, UltimateOscillator, PriceOscillator, Stochastic, KDJ
- **Channels:** BollingerBands, DonchianChannels, KeltnerChannels, ChandelierExit
- **Volume:** OBV, VWAP, ADL, MFI, ForceIndex
- **Volatility:** ATR, SD, VolatilityIndex
- **Candlestick patterns (35):** Doji, Hammer, SpinningTop, Marubozu, ShootingStar, BullishEngulfing, BearishEngulfing, MorningStar, EveningStar, ThreeWhiteSoldiers, ThreeBlackCrows, etc.

**Examples:**
```bash
# Default indicators (SMA, EMA, RSI, MACD, BollingerBands)
node scripts/calc.mjs ohlcv.json result.json

# Custom indicators
node scripts/calc.mjs ohlcv.json result.json --indicators=rsi,macd,stochastic,atr

# Candlestick pattern detection
node scripts/calc.mjs ohlcv.json patterns.json --indicators=doji,hammer,bullishengulfing

# All 74 indicators
node scripts/calc.mjs ohlcv.json full.json --indicators=all

# Custom parameters
node scripts/calc.mjs ohlcv.json result.json --indicators=sma,rsi --params=custom_params.json

# Markdown output
node scripts/calc.mjs ohlcv.json result.md --indicators=sma,rsi,macd --format=markdown

# List all supported indicators
node scripts/calc.mjs --list
```

**Requirements:** `fast-technical-indicators` and `markdown-table` npm packages.

---

### company-valuation

**Description:** Valuation engine with 23 methods across 3 categories. Relative valuation (PE/PE-TTM/PB/PS/PS-TTM/EV-EBITDA/EV-Revenue/PEG/ARR/P-Active-User/P-GMV/EV-FCF), absolute valuation (DCF with 5 sub-methods / DDM / rNPV / Black-Scholes), and strategic valuation (TAM-SAM-SOM / LTV-CAC / NRR).

**Scripts provided:**
- `scripts/relative.mjs` — 12 relative valuation methods
- `scripts/absolute.mjs` — 8 absolute valuation methods (DCF includes 5 sub-methods)
- `scripts/strategic.mjs` — 3 strategic valuation methods

**Usage:**
```bash
node scripts/relative.mjs pe --marketCap 1000000000 --netIncome 80000000
node scripts/<script>.mjs <method> --params-file <workspace>/tmp-company-valuation-<id>.json
node scripts/<script>.mjs --help    # list available methods
```

**Method categories:**

| Category | Script | Methods |
|----------|--------|--------|
| Relative | `relative.mjs` | PE, PE-TTM, PB, PS, PS-TTM, EV-EBITDA, EV-Revenue, PEG, ARR, P-Active-User, P-GMV, EV-FCF |
| Absolute | `absolute.mjs` | DCF (5 variants), DDM, rNPV, Black-Scholes |
| Strategic | `strategic.mjs` | TAM-SAM-SOM, LTV-CAC, NRR |

**Notes:**
- Pure calculation engine — no external API calls
- Financial data is queried by the caller (agent) via skills like `hedgehog-company-index-data` and passed as JSON params
- DCF supports 5 sub-methods: FCFE-3Stage, FCFE-2Stage, FCFF-3Stage, FCFF-2Stage, Dividend-3Stage

---

### skill-creator

**Description:** Create or update focused HogAgent skills, organize optional scripts/references/assets, and validate the result against HogAgent's loading conventions.

**Scripts provided:**
- `scripts/init-skill.mjs` — Create a minimal skill scaffold without overwriting an existing directory
- `scripts/validate-skill.mjs` — Validate frontmatter, kebab-case naming, directory/name consistency, semantic version, unfinished scaffold markers, and local resource links

**Usage:**

```bash
# Create under the workspace scope by default
node <skill-creator-dir>/scripts/init-skill.mjs my-skill \
  --path <workspace>/.hogagent/skills \
  --resources scripts,references

# Add --examples only when placeholders are useful, then replace or delete them
node <skill-creator-dir>/scripts/init-skill.mjs my-skill \
  --path <workspace>/.hogagent/skills \
  --resources scripts,references,assets \
  --examples

node <skill-creator-dir>/scripts/validate-skill.mjs <workspace>/.hogagent/skills/my-skill
```

The skill defaults to workspace scope unless the user requests a bundled system skill. It does not generate Codex-specific `agents/openai.yaml` because HogAgent does not consume that metadata.

When an authored skill requires an API key, its `SKILL.md` must include an `API configuration` section covering the exact `skills_config.json` entry and fields, supported configuration entry point, endpoint/permissions, any environment fallback and precedence, missing-key behavior, and authentication scheme. Use only placeholders; never store a real key in skill files, examples, tests, logs, or artifacts.

---

## Skill Installation

### Via RPC Command

```json
{"type": "install_skill", "name": "hedgehog-stock-research"}
```

This registers the skill for the current session. The orchestrator is responsible for placing skill files in the appropriate directory.

### Manual File Copy

Copy the skill directory to either scope:

```bash
# Project scope (bundled with HogAgent)
cp -r my-skill/ <project_root>/skills/my-skill/

# Workspace scope (project-specific, overrides project scope by name)
cp -r my-skill/ <workspace>/.hogagent/skills/my-skill/
```

### Project vs Workspace Scope

| Scope | Directory | Use Case |
|-------|-----------|----------|
| Project | `<project_root>/skills/` | Built-in skills bundled with HogAgent |
| Workspace | `<workspace>/.hogagent/skills/` | Project-specific skills |

**Override rule:** Workspace skills override project skills with the same name.

---

## Skill Discovery and Loading

### Discovery Process

On startup (and on `reload_config`), HogAgent scans:

1. `<project_root>/skills/` — Project skills (bundled with HogAgent)
2. `<workspace>/.hogagent/skills/` — Workspace skills

Each subdirectory is treated as a skill. The directory name is the skill name.

### Two-Level Priority

```
Workspace skills  >  Project skills
```

If both `<project_root>/skills/web-search/` and `<workspace>/.hogagent/skills/web-search/` exist, the **workspace** version takes precedence.

### Auto-Discovery on Startup

Skills are automatically discovered during `createHogAgent()` initialization and reported in the `ready` event's `capabilities.installed_skills` array.

### Reporting

```json
{
  "type": "ready",
  "capabilities": {
    "installed_skills": ["gen-chart", "gen-ppt", "doc-convert", "fin-calc", "hedgehog-stock-research"]
  }
}
```

---

## How to Write a Custom Skill

### Step 1: Create the Directory

```bash
node <skill-creator-dir>/scripts/init-skill.mjs my-custom-skill \
  --path <workspace>/.hogagent/skills
```

Use `<project_root>/skills` only when intentionally authoring a bundled system skill. Manual directory creation is also supported.

### Step 2: Write SKILL.md

```markdown
---
name: my-custom-skill
description: >
    Portfolio risk analysis for stock holdings.
    Applicable: risk metrics, portfolio performance, benchmark comparison.
    Triggers: portfolio analyze, risk analysis, holdings.
    Blocking: individual stock analysis, backtesting.
version: 1.0.0
---

# My Custom Skill

## Scripts
...
```

If the skill calls an authenticated API, add an `API configuration` section. At minimum, document the on-disk `"api-key"` field, the skill name used as the config entry, how the key is configured, any endpoint and environment fallback, and what happens when configuration is missing. Never place a real credential in the skill.

### Step 3: Validate

```bash
node <skill-creator-dir>/scripts/validate-skill.mjs <workspace>/.hogagent/skills/my-custom-skill
```

### Step 4: Reload and Verify

Restart HogAgent or send `reload_config`:
```json
{"type": "reload_config"}
```

Check the capabilities:
```json
{"type": "get_state"}
```

The skill should appear in `available_skills`.

---

## Skill + Tool Relationship

A skill provides **context** (instructions, examples, documentation) while a tool provides **function** (executable code).

```
┌─────────────────────────────────────────────────┐
│                    SKILL                          │
│  SKILL.md                                        │
│  - What the tool does                            │
│  - How to use it                                 │
│  - Parameter descriptions                        │
│  - Usage examples                                │
│  - Constraints and notes                         │
└────────────────────────┬────────────────────────┘
                         │ references
                         ▼
┌─────────────────────────────────────────────────┐
│                    TOOL                           │
│  Registered via AgentTool interface              │
│  - name: "my_tool"                               │
│  - parameters: TypeBox schema                    │
│  - execute(): actual implementation              │
└─────────────────────────────────────────────────┘
```

The skill's `SKILL.md` content is injected into the LLM's context so it understands _when_ and _how_ to use the associated tool. Without the skill, the LLM only sees the tool's JSON schema and brief description.

---

## Hot-Reload via reload_config

The Skill inventory can be refreshed without restarting the process:

```json
{"type": "reload_config"}
```

**What happens:**
1. Skills are re-discovered from the existing system/workspace discovery sources.
2. The shared Skill inventory and the existing `skillsConfig` object are refreshed in place for future prompts and session rebuilds; the active Harness receives the current mode's newly filtered skills (Quick remains empty).
3. A `config_reloaded` event is emitted.

The WebUI saves Skill configuration first, then broadcasts this same existing command only to its managed child processes. A stale child's write failure is isolated so the remaining managed sessions still receive the refresh. Gateway retains the same request-correlated FIFO command and acknowledgement boundary. The RPC installation paths use the same refresh operation. `reload_config` does not reload unrelated model, sandbox or extension settings; those retain their dedicated settings/restart paths.

This allows:
- Adding new skills at runtime
- Updating existing skill instructions
- Removing skills (delete directory, then reload)

---

## skills_config.json

`~/.hogagent/skills_config.json` 存储所有技能配置（API Key + 模式可见性）。多个技能的配置存储在同一个文件中。Gateway 登录、续期、Key 更新和切换用户通过 [HogAgent 配置 API](configuration-api.md)，由 HogAgent 自动同步已配置及已安装的 hedgehog-* Skill 的 api-key；托管与独立 HogAgent 必须读取同一份持久化 Key。同步只更新 Key，保留模式标志和其他字段，新安装 Skill 在连接/热加载时补齐。托管模式与独立模式的 Bash 沙箱均允许只读访问这一份共享文件，仍拒绝链接文件和写入；其他 HogAgent 凭据文件保持不可读。

### 格式

```json
{
  "hedgehog-stock-research": {
    "api-key": "your-api-key"
  },
  "hedgehog-macro-industry": {
    "isLongTaskSpecific": true
  },
  "data-fetcher": {
    "api-key": "your-api-key",
    "isLongTaskSpecific": true
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `api-key` | string | — | 技能专属 API 密钥；`configure_skill` RPC 的输入字段名仍为 `apiKey` |
| `isLongTaskSpecific` | boolean | `false` | `true` 时仅 Long Task 模式可见，Standard 模式隐藏 |

WebUI/API writes require a JSON boolean for `isLongTaskSpecific`. Legacy persisted strings `"true"` and `"false"` are converted only in memory when read; invalid values are ignored with a warning, and no automatic migration rewrites the configuration file.

### 模式过滤

mode 由 RPC `prompt` 命令的 `mode` 参数指定：

| Mode | Filter Rule |
|------|-------------|
| `quick` | No skills loaded (always empty) |
| `standard` | Skills with `isLongTaskSpecific: true` are **excluded** |
| `long_task` | All skills loaded (no filtering) |

未列出的技能默认 `isLongTaskSpecific: false`，在 `standard` 和 `long_task` 模式下均可用。

### 技能脚本读取 API Key

需要 API Key 的技能必须在自己的 `SKILL.md` 中写明配置入口、字段、服务端点/权限、环境变量回退优先级、缺失配置时行为和认证方式。若服务并非 Bearer 认证，应按实际协议说明，不能假设所有远程 API 都使用 Bearer。

`configure_skill` RPC 使用 camelCase 输入并写入标准的连字符字段：

```json
{"type": "configure_skill", "name": "my-skill", "apiKey": "your-api-key"}
```

技能脚本读取 `$HOGAGENT_USER_DIR/skills_config.json`（设置该变量时）或默认的 `~/.hogagent/skills_config.json` 中自己的条目：

```javascript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SKILL_NAME = "my-skill";

function getSkillApiKey() {
  const systemDir = process.env.HOGAGENT_USER_DIR || join(homedir(), ".hogagent");
  const configPath = join(systemDir, "skills_config.json");
  const envApiKey = process.env.MY_SKILL_API_KEY || "";
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config[SKILL_NAME]?.["api-key"] || envApiKey;
  } catch { return envApiKey; }
}

const apiKey = getSkillApiKey();
if (!apiKey) throw new Error("my-skill API key is not configured");
const response = await fetch(url, {
  headers: { "Authorization": `Bearer ${apiKey}` }
});
```

不得读取其他技能的配置条目，不得静默复用主 LLM Key，也不得输出或记录密钥。Gateway 只会为有意采用 `hedgehog-*` 命名的技能自动播种 `"api-key"`；不应仅为了取得凭据而使用此前缀。

---

## Tool Naming Convention

| Type | Convention | Example |
|------|-----------|---------|
| Skill directory | kebab-case | `hedgehog-stock-research` |
| Tool name | snake_case | `stock_research` |
| Extension name | kebab-case | `content-compressor` |
| Extension-provided tool | snake_case | `query_tool_result` |

**Rationale:**
- kebab-case for filesystem directories (Unix convention)
- snake_case for tool identifiers (LLM function calling convention)

---

## External MCP Client

HogAgent independently loads external MCP server configurations from:

- `~/.hogagent/mcp-servers.json` (system level)
- `<workspace>/.hogagent/mcp-servers.json` (workspace level)

The files use a strict versioned schema, capability allowlists and environment-variable credential references. When at least one effective server is enabled, HogAgent exposes allowlisted Tools, Resources and Prompts to the top-level Agent in Standard/Long modes through meta-tools, with an optional small direct-tool subset; an unconfigured installation, Quick mode and Sub-Agents do not receive these tools. HogAgent also exposes its own configuration/probe/reload RPC commands to its WebUI. The Client has no Gateway dependency or automatic service discovery. See [External MCP Client](./external-mcp.md).

### MCP vs Native Tools

| Aspect | Native Tool | MCP Server Tool |
|--------|-------------|-----------------|
| Location | In-process | External service |
| Language | TypeScript/JavaScript | Any (Go, Python, etc.) |
| Latency | Low (in-process) | Higher (network) |
| Isolation | Shares process | Full isolation |
| Deployment | Bundled with agent | Independent service |

### When to Use MCP

- Tool requires heavy dependencies (Python ML libraries, etc.)
- Tool needs to be shared across multiple agents
- Tool needs independent scaling
- Tool wraps an existing service

---

## Best Practices for Skill Design

### 1. One Skill, One Concern

Each skill should focus on a single domain or capability. Don't combine unrelated functionality.

```
✓ hedgehog-stock-research     — Stock analysis
✓ hedgehog-macro-industry     — Macro/industry data
✗ hedgehog-everything         — Too broad
```

### 2. Clear, Actionable Descriptions

The LLM reads the skill description to decide when to use it. Be specific:

```markdown
✓ "Search for real-time stock prices, historical data, and financial metrics for A-share listed companies."
✗ "Does stock stuff."
```

### 3. Provide Realistic Examples

Include examples that match real usage patterns. Show both simple and complex cases.

### 4. Document Requirements

Clearly state environment variables, API keys, or other dependencies.

### 5. Match Tool Capabilities

The SKILL.md should accurately reflect what the tool can do. Don't promise functionality the tool doesn't implement.

### 6. Use Consistent Parameter Naming

Follow existing conventions:
- `query` for search inputs
- `limit` for result counts
- `type` or `filter` for narrowing
- `format` for output format preferences

### 7. Keep Skills Focused and Short

The description is always available for discovery, while the full SKILL.md is loaded on demand. Keep the entrypoint as short as the task permits and move substantial conditional detail into linked references.

---

## Cross-References

- [Architecture Overview](./architecture.md) — Two-level directory system, design principles
- [Extension APIs](./extensions.md) — How tools are registered by extensions
- [RPC Protocol](./orchestrator-integration.md) — `install_skill`, `reload_config` commands
