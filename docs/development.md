# HogAgent Development Guide

## Build Commands

```bash
npm run build          # One-time build
npm run dev            # Watch mode
npm run check          # Type checking
```

`npm run build` compiles TypeScript and copies WebUI assets to `dist/src/web/public/`. The WebUI prefers this built asset directory; after frontend edits, rebuild and restart the idle WebUI server before reloading the browser. `npm run dev` watches TypeScript only. Mixing an old compiled server with current source assets can break protocol-dependent features such as delivery cards.

The asset step also bundles the installed Marked, DOMPurify, KaTeX (including fonts), and ECharts distributions and their license notices for lazy Markdown preview. It copies the generated `scripts/chart-data.js` parser and transpiles HogAgent's shared document parser into browser modules. Standalone builds need no sibling projects. In the monorepo, `npm run web:parser` refreshes the parser from `frontend/web2/lib/markdown/briefingChartData.ts`; build/check reject a stale snapshot.

`npm run contracts:generate` uses the shared monorepo generator when present, which updates both consumers and the standalone `contracts/` inputs. In a standalone checkout, it generates HogAgent validators from those bundled inputs using the same implementation. `npm run contracts:check` rejects stale generated files in either layout. Changes to shared schemas originate in the monorepo and must update both consumers; do not independently hand-edit snapshots. Preview rendering and image access checks are documented in [WebUI](web-ui.md#markdown-交付预览).

---

## Test Commands

### Standalone workspace instruction templates

Edit `src/standalone-agents-template.ts` and increment `STANDALONE_AGENTS_VERSION` (a numeric `major.minor.patch`) whenever its rules change. This is a HogAgent-owned template compiled with the runtime; do not import or generate it from Gateway files. Keep host-specific rules in the host and native protocol requirements in `SYSTEM.md`/`STANDALONE.md`. `src/workspace-instructions.ts` preserves all text outside the managed markers, skips same/newer versions, and rejects malformed sections rather than overwriting them. Never rename its markers without a migration.

Run `test/unit/workspace-instructions.test.ts`, `test/unit/user-workspace.test.ts` and `test/integration/standalone-build.test.ts` for preservation, upgrade, entry-point and standalone isolation coverage. After building, `npm run test:readme` exercises a fresh default CLI workspace, existing personal rules in an explicit workspace, and a Web UI startup that upgrades an older template.

Text files use LF via `.gitattributes`, including on Windows, so generated-source checks compare the same bytes on every platform. Keep this file when exporting HogAgent from the monorepo.

### FinanceGym research evaluation

The [FinanceGym test conditions](../FinanceGym/README.md) describe a 20-question financial deep-research evaluation using `qwen3.8-flash` in `standard` mode. The directory contains the [final report](../FinanceGym/REPORT.md), [20 original questions and their answer reports](../FinanceGym/QUESTIONS.md), and JSONL question and answer exports. All evaluation documents and reports are in English and omit machine-specific filesystem paths. The final report states the completion results and official scoring status on a 100-point scale.

### Basic Tests

```bash
npm test               # Watch mode
npm test -- --run      # Single run
npm run test:readme    # Built CLI, RPC, Web UI and basic-chat smoke (local model fixture)
```

### LLM Live Integration Tests

Requires a real API key. Specify provider and key via environment variables; tests auto-skip if not provided.

```bash
# Google Gemini
HOGAGENT_TEST_PROVIDER=google HOGAGENT_TEST_API_KEY=your-key npx vitest run test/integration/llm-live.test.ts

# OpenAI
HOGAGENT_TEST_PROVIDER=openai HOGAGENT_TEST_API_KEY=sk-xxx npx vitest run test/integration/llm-live.test.ts

# Anthropic
HOGAGENT_TEST_PROVIDER=anthropic HOGAGENT_TEST_API_KEY=sk-ant-xxx npx vitest run test/integration/llm-live.test.ts

# With custom model and Base URL
HOGAGENT_TEST_PROVIDER=openai HOGAGENT_TEST_API_KEY=sk-xxx \
  HOGAGENT_TEST_MODEL=gpt-4.1 \
  HOGAGENT_TEST_BASE_URL=https://api.openai.com/v1 \
  npx vitest run test/integration/llm-live.test.ts
```

**LLM Test Environment Variables:**

| Variable | Description | Required |
|----------|-------------|----------|
| `HOGAGENT_TEST_PROVIDER` | Provider: `openai` / `anthropic` / `google` / `deepseek` / `mistral` | Yes |
| `HOGAGENT_TEST_API_KEY` | API Key for the corresponding provider | Yes |
| `HOGAGENT_TEST_MODEL` | Custom model ID (defaults to provider's recommended model) | No |
| `HOGAGENT_TEST_BASE_URL` | Custom API URL | No |

---

## Code Standards

| Standard | Description |
|----------|-------------|
| **Module System** | ESM, all imports use `.ts` extension |
| **TypeScript** | Strict mode |
| **Naming Convention** | Functions/variables: camelCase; Types: PascalCase; Constants: SCREAMING_SNAKE_CASE |
| **Logging** | `createLogger(name)` factory, structured JSON |
| **Tool Parameters** | `@sinclair/typebox` for schema definitions |
| **Pi Source** | Code under `src/vendor/` must not be modified |

---

## Unified Audit Entry Architecture

The conversation mode is determined by the RPC `mode` parameter (**hard routing**), not by the audit model:

```
User Message (with mode parameter) → Hard Routing
              │
              ├─→ quick     │ Main Harness (no tools/skills)
              │
              ├─→ standard  │ Main Harness (filtered skills) execution
              │
              └─→ long_task │ Audit model optimizes prompt (only when audit LLM configured)
                            → Main Harness (all skills) plans steps
                            → Orchestrator grouped dispatch → Main Harness executes each group
                            → Temporary audit Harness checkpoint scoring (tools+skills)
                            → Temporary audit Harness final review (tools+skills)
```

**Audit model has no mode concept**: Its behavior is entirely determined by the calling phase context (system prompt + tool set + skills).

**Explicit audit LLM shutdown**: Setting the provider to an empty string or `'close'` via RPC explicitly disables the audit model (default: disabled).

**Degradation strategy**: When the audit LLM is not configured or explicitly disabled, `long_task` degrades to `standard`. An unusable audit key/quota during classification also degrades the turn. Mid-orchestration audit unavailability, timeout or turn-cap instead returns `skipped: true, passed: false` with a reason (`score: 0` is only a placeholder). Work continues without audit-driven redo; progress and the final reply must state that verification was skipped. When the **main** LLM returns a key/quota error during orchestration, the conversation fails fast instead of retrying. When it returns `stopReason: "aborted"`, orchestration stops immediately and emits `aborted` rather than `error`.

### Core Files

| File | Responsibility |
|------|----------------|
| `src/audit-classifier.ts` | Audit model direct call: prompt optimization (long_task), audit scoring |
| `src/long-task-orchestrator.ts` | Long Task hybrid dispatch state machine |
| `src/skills-filter.ts` | Skill filtering by mode |

---

## skills_config.json

`~/.hogagent/skills_config.json` stores all skill configurations (API Key + mode visibility):

```json
{
  "report-generator": {
    "api-key": "your-api-key"
  },
  "deep-analysis": {
    "isLongTaskSpecific": true
  },
  "data-fetcher": {
    "api-key": "your-api-key",
    "isLongTaskSpecific": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `api-key` | string | Skill-specific API key (`configure_skill` RPC accepts `apiKey` and stores this field) |
| `isLongTaskSpecific` | boolean | When `true`, only visible in Long Task mode; hidden in Standard mode |

Skill scripts read this file to obtain the API Key and authenticate via Bearer token when calling remote APIs:

```javascript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function getSkillApiKey(skillName) {
  const systemDir = process.env.HOGAGENT_USER_DIR || join(homedir(), ".hogagent");
  const configPath = join(systemDir, "skills_config.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config[skillName]?.["api-key"] || "";
  } catch { return ""; }
}

// When calling remote APIs:
const apiKey = getSkillApiKey("my-skill");
const response = await fetch(url, {
  headers: { "Authorization": `Bearer ${apiKey}` }
});
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@sinclair/typebox` | JSON Schema definitions for tool parameters |
| `ws` | WebSocket (Web UI) |
| `vitest` | Testing framework (dev) |

> Note: `pi-agent-core` and `pi-ai` are **vendored** (source in `src/vendor/`), not npm dependencies.

---

## Related Documentation

- [Architecture](./architecture.md)
- [Extension API](./extensions.md)
- [RPC Protocol](./orchestrator-integration.md)
