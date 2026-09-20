# Standalone release validation — 2026-09-20

Target: https://github.com/hedgehog-finance/HogAgent.git, version `1.2.4`.

## Verified locally

Validation used macOS with Node.js `22.23.1` and npm `10.9.8`. A clean standalone directory contained only the HogAgent release files, with no sibling `contracts/`, Gateway or Web2 checkout and no reused `node_modules`.

| Check | Result |
|---|---|
| `npm install` in the clean standalone directory | Passed |
| `npm run check` | Passed in both layouts |
| `npm run build` | Passed in both layouts; includes offline Markdown/chart preview assets |
| `npm test -- --run` | 92 test files passed; 867 tests passed and 21 conditional tests skipped (other platforms or explicit live-test credentials) |
| `npm run test:readme` | CLI help/version, interactive chat, RPC, Web UI assets/authenticated WebSocket and all six runnable RPC examples passed |
| Web UI browser regression | Passed across ten themes and five viewports |
| Browser preview regression | Markdown tables, formulas, chart parser and image access passed in two themes and three viewports |
| Actual model conversations | Interactive, RPC, WebSocket and basic-chat (normal/debug) passed using the configured Hedgehog `qwen3.8-flash` provider |
| Documentation links | Relative documentation links stay inside the standalone checkout; paths in code examples are illustrative |

The default README smoke test uses a loopback OpenAI-compatible model fixture, temporary settings and a workspace whose path contains spaces. It runs actual HogAgent subprocesses and exercises a real `math_calc` tool loop. The fixture checks transport, lifecycle and example code; it does not evaluate the quality of financial answers or generate every requested deliverable. Real-provider validation sends only short text prompts through HogAgent's normal entry points. It neither changes the user's configuration nor publishes credentials.

To repeat the checks:

```bash
npm install
npm run check
npm run build
npm test -- --run
npm run test:readme
```

Optional real-provider smoke test (uses your configured API quota):

```bash
npm run test:readme -- --live-config /absolute/path/to/llm-settings.json
```

GitHub Actions runs install/check/build/README smoke on Linux, macOS and Windows using the minimum supported Node.js `22.19.0`; the full regression suite runs on macOS. See the repository's Actions page for the results of a particular commit.

## Release fixes

- Bundle shared contract inputs and the generated chart parser, while keeping drift checks against canonical monorepo sources. Both layouts reuse the same contract generator.
- Document cloning, workspace paths, API-key prerequisites and shutdown in all three README translations.
- Start example subprocesses with the current Node.js executable; run TypeScript examples using native Node.js support. Remove misplaced trailing shebangs.
- Wait for complete agent turns, including tool execution, and issue `steer`/`follow_up` only during an active turn. Use current file tools and event fields in examples.
- Correct the package's compiled module entry point and remove documentation links that require sibling projects.
- Preserve LF text files on Windows checkout so generated contract checks do not mistake CRLF conversion for stale source.

The public snapshot contains source, vendored Pi, built-in Skills, tests, documentation and FinanceGym reports. Local editor state, dependencies, compiled output, user settings and credentials are excluded. Vendored Pi source is unchanged.

## Dependency status

The clean installation reported 15 npm advisories (3 moderate, 12 high) in the existing dependency tree. Dependency upgrades and their compatibility review were not part of this source-publication change. Re-run `npm audit` for the current advisory details; the count can change independently of this release.

The first cloud run exposed Windows CRLF conversion, a Homebrew framework Python symlink layout, and a download stream that could send newly appended bytes beyond Content-Length. Follow-up fixes preserve checkout line endings, validate the exact base interpreter link, and bound the download stream. These failures were addressed rather than skipped.
