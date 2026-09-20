# HogAgent Tool System

## Overview

HogAgent provides a runtime-selected tool set. The six Node-backed file tools are always registered. On macOS/Linux, the legacy-named `bash` tool is controlled by `hogagent.json.sandboxMode`: `enabled` requires a validated OS sandbox and shared Python environment, `fallback` prefers that runtime but uses a marked bare shell when isolation is unavailable, and the default `disabled` mode selects the unrestricted direct shell immediately. Windows does not support the sandbox and ignores this setting; the same tool always runs a platform-marked `UNSANDBOXED` Windows PowerShell or verified Git Bash. `cmd.exe` is not supported.

The `bash` tool accepts only the `{ command, timeout? }` shell-command form, and commands should stay on one line. Skill CLIs use one portable rule on every platform: pass safe non-empty top-level scalar values as named arguments; for objects, arrays, `null`, multiline text, difficult quoting, or scalar-looking strings whose type must be preserved, create UTF-8 JSON with the `write` tool in a writable task/project directory using a unique `tmp-<skill-name>-<id>.json` basename. Pass only the path through the Skill's documented file option, never combine payload sources, and delete the temporary file after use. Windows PowerShell 5 is a key reason nested JSON is never inlined.

| Category | Count | Description |
|----------|-------|-------------|
| **Pi-style Tools** | 6–7 | File operations and directory listing, plus conditional sandboxed shell execution |
| **Custom Tools** | 4 | Math calculation, web search, web fetch, file delivery |
| **Extension Tools** | Variable | Registered by enabled extensions; compression adds two tools only when enabled |

---

## Pi-style Built-in Tools

All Pi-style tools are defined in `src/tools/builtin-tools.ts` and created via the `createBuiltinTools(cwd)` factory function.

### `read` — Read File

Read file contents with support for chunking, section extraction, and raw mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path |
| `offset` | integer | No | Original file line number, 1-based; follow the returned next offset |
| `limit` | integer | No | Requested positive line count; still capped at 2000 lines / 50 KiB |
| `section` | string | No | Extract a bounded Markdown section; overrides offset/limit; oversized sections require line-range reads |
| `raw` | boolean | No | Skip optional result compression; no extra effect while off; never bypass read limits |

**Large files:** Every read is capped at 2000 lines or 50 KiB of numbered text, whichever comes first (header and short continuation hints are additional). Ordinary reads return the next original-file offset so all pages can be read without gaps. Truncated pages opt out of further compression. Oversized sections fail with guidance to locate and read original line ranges; a single oversized line requires Bash/script extraction. Skill instructions must be read completely across pages, including when raw=true.

### `write` — Write File

Write content to a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path |
| `content` | string | Yes | File content |
| `append` | boolean | No | Append mode (default: overwrite) |
| `artifact_role` | enum | No | Explicit Manifest role |
| `artifact_update_mode` | enum | No | Per-operation `in_place` or `new_version` choice when the run policy is unlocked |

### `edit` — Search-Replace Edit

Perform search-and-replace editing with exact text matching.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path |
| `old_text` | string | Yes | Text to find (exact match) |
| `new_text` | string | Yes | Replacement text |
| `artifact_update_mode` | enum | No | Per-operation `in_place` or `new_version` choice when the run policy is unlocked |

### `bash` — Execute Shell Command

Run shell commands with configurable timeout. `bash` is a conditional capability with three modes:

- `enabled`: probe the complete security runtime and every viable Python candidate, then execute a harmless command through the final generated profile/mount namespace; any initialization failure omits Bash.
- `fallback`: perform the same probes, but any sandbox dependency, boundary validation, final runtime probe, or Python/venv failure registers a warning-marked `UNSANDBOXED` bare shell.
- `disabled` (default): skip OS sandbox probing and register an operator-configured `UNSANDBOXED` direct shell; Python is still attempted but does not control Bash availability.

- **macOS**: commands run under `/usr/bin/sandbox-exec` with a generated deny-outside-whitelist policy.
- **Linux**: commands run in a Bubblewrap mount namespace. Debian service packages depend on `bubblewrap`; other package formats probe `bwrap` at runtime.
- **Windows**: no sufficiently strong file sandbox is currently available. Every `sandboxMode` value registers a platform-marked `UNSANDBOXED` command shell, preferring system Windows PowerShell and then verified Git for Windows Bash. `cmd.exe` is deliberately unsupported.

On POSIX systems, HogAgent prefers `/bin/bash` and falls back to `/bin/sh`. On Windows it uses shell-specific invocation arguments (`-Command` or `-c`), resolves system PowerShell before `PATH` fallbacks, and accepts `bash.exe` only when an adjacent Git for Windows installation can be verified. Windows shells can access any path allowed to the HogAgent process account regardless of `sandboxMode`. Unsupported platforms or the absence of every platform shell candidate omit the tool.

### Bash file boundary

In normal sandboxed mode, the boundary is enforced by the operating system around the complete shell process tree; HogAgent does not try to parse command strings. Shell expansion, redirection, absolute paths, `..`, symlinks, Node/Python file APIs, and subprocesses therefore receive the same policy.

- Writable: the active workspace, `<workspace>/.hogagent/bash-tmp`, and the shared `~/.hogagent/python-venv`.
- Read-only: the HogAgent installation/skills; current Node, shell, Python, browser, and inherited `PATH` tool runtimes; common package-manager roots; required OS libraries/certificates/fonts/network resolver and document-renderer files; and exactly `~/.hogagent/skills_config.json` when that config is a regular, unlinked file.
- Hidden: other home-directory content and other `~/.hogagent` configuration, including `web-jwt-secret.key`.

Absolute paths inside the workspace and normalized `..` paths that remain inside are valid. Any final target outside the allowed roots is rejected by the kernel sandbox. This new boundary intentionally applies only to `bash`; the existing `read`, `write`, `edit`, `grep`, `find`, and `ls` path semantics are unchanged.

The two sandbox backends consume one composable `RuntimeGrant`: Python, browser, system-tool, read-only, writable, and child-environment rules are assembled once instead of being duplicated in platform profiles. An inherited absolute `PATH` entry containing a `bin`/`sbin` segment grants that segment's package prefix read-only outside HOME and for known per-user package-manager roots, which covers Homebrew, MacPorts, Nix, bundled native-tool directories, and standard user toolchains. `~/bin` and arbitrary home projects are not promoted to broader roots. Known system package roots, exact installed Office/browser application bundles, DNS resolver dependencies, and CA certificate roots are also accepted. On macOS, both public `/etc`/`/var` aliases and their `/private` canonical targets are present because native clients may be sandbox-checked before symlink resolution. HogAgent does not expose all of `/Applications`, `/opt`, `/etc`, or the user's home directory.

The `enabled` sandbox is a file-system boundary, not a network boundary. macOS explicitly allows network operations, while Linux Bubblewrap shares the host network namespace. Skill subprocesses therefore retain DNS and outbound HTTP/HTTPS API access subject to the host's proxy, firewall, and routing policy. In both Gateway-managed and standalone mode, `skills_config.json` remains read-only and readable and ordinary Skill-specific API environment variables are preserved; HogAgent-owned secret-shaped environment variables remain filtered from Bash by design.

Downloaded browser runtimes are code dependencies rather than user data. HogAgent mounts the standard Puppeteer cache (`~/.cache/puppeteer`) and the platform Playwright cache (`~/Library/Caches/ms-playwright` on macOS, `${XDG_CACHE_HOME:-~/.cache}/ms-playwright` on Linux) read-only. Absolute `PUPPETEER_CACHE_DIR` and `PLAYWRIGHT_BROWSERS_PATH` overrides are honored; absolute `PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`, and `GOOGLE_CHROME_BIN` targets receive a narrowly scoped read-only grant. On macOS, `MAC_CHROMIUM_TMPDIR` redirects Chromium's native temporary files into `<workspace>/.hogagent/bash-tmp`; ordinary `TMPDIR` alone does not control this Chromium path. Chromium profiles, downloads, PDF output, and other mutable browser state must stay in the writable workspace/temp directory.

Generic temporary state is redirected below `<workspace>/.hogagent/bash-tmp`, including XDG cache/config/data/state/runtime roots, Node package-manager caches, ImageMagick/SQLite temporary files, and GnuPG state. Python adds pip/uv, bytecode, Matplotlib, Numba, IPython, and Jupyter caches there. Git's global config path uses `/dev/null` on POSIX and `NUL` on Windows, so repository/system config remains usable without probing the hidden user-level Git config. This lets common conversion, charting, packaging, network, archive, and document-rendering commands operate without granting write access to their installed runtimes.

These boundary guarantees do **not** apply when the Bash tool description reports `UNSANDBOXED`. Both `disabled` and `fallback` direct modes run the selected shell with the workspace as CWD, retain the normal process `PATH` with HogAgent's Node directory first, clear inherited Python/Conda activation and HogAgent-owned secret variables, and use the workspace Bash temp directory. Windows execution is always in one of these direct modes. The RuntimeGrant still supplies consistent Python/browser/tool paths and redirected child state, but it is no longer an access-control boundary: the command can read or modify any path allowed to the HogAgent process account, so environment filtering alone is not a security boundary in these modes.

If `HOGAGENT_USER_DIR` is placed inside the workspace, installation, or a runtime-readable root, secret files would overlap the Bash policy. A workspace containing the HogAgent installation/base runtime or a linked `skills_config.json` is likewise unsafe for isolation. These validations disable Bash in `enabled` and activate the bare shell in `fallback`; `disabled` does not claim an isolation boundary. A linked or escaping `.hogagent/bash-tmp` prevents Bash in every mode because the child-process state directory itself is invalid.

### Shared Python environment

Before selecting the normal Bash runtime, HogAgent creates or validates `python-venv` under its configuration directory (`~/.hogagent` by default). It tries the configured absolute interpreter first, then executable `python3`/`python` on `PATH` (`python3.exe`/`python.exe` on Windows). Each candidate must actually start in isolated mode with UTF-8 output; wrappers are resolved through their reported `sys.executable`. If venv creation or full validation fails, the next candidate is tried. Creation uses a cross-process lock. On POSIX, it builds in a sibling temporary directory, rewrites relocated script paths (including macOS `/var` canonicalization), validates the launcher and pip paths, and atomically renames the environment into place. Windows creates at the final path under the lock because `pip.exe` contains an absolute interpreter path; concurrent readers acquire the same lock before inspecting it. Validation accepts a launcher matching the trusted base interpreter or that installation's standard CPython venv launcher template. Nonstandard launchers fail with an explicit error. Validation runs only the selected base interpreter with isolated-site flags; it never executes or imports code from the shared Bash-writable venv outside the sandbox. Existing damaged or interrupted environments are not deleted automatically.

Windows environment names are normalized before PATH composition, Python/Conda cleanup and secret filtering, so `Path`/`PATH` cannot select different runtimes. PowerShell commands set console input/output and native pipeline encoding to UTF-8; stdout and stderr are decoded as streams to preserve multibyte characters split across chunks. This does not change PowerShell 5 file-redirection defaults: write parameter files as UTF-8 with the file tool. A quoted executable path in PowerShell requires the `&` call operator. Access-denied execution errors are returned without retrying another shell or elevating privileges.

The normal Bash environment puts the venv first in `PATH`, sets `VIRTUAL_ENV`, `PIP_REQUIRE_VIRTUALENV=1`, and `PYTHONNOUSERSITE=1`, clears `PYTHONHOME`, `PYTHONPATH`, Conda activation variables, and HogAgent-owned secret variables such as `HOGAGENT_LLM_API_KEY`, then applies the shared RuntimeGrant temporary/cache environment. Explicit skill credentials with different names (for example `CIWEIAI_API_KEY`) remain available. A Python failure disables Bash in `enabled`, activates the bare-shell path in `fallback`, and is recorded without affecting direct-shell availability in `disabled`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Single-line shell command; use named arguments for safe flat scalars and a unique UTF-8 `tmp-*.json` file for complex Skill parameters; never inline nested JSON |
| `timeout` | number | No | Timeout in milliseconds (default: 30000) |

### `grep` — Regex Search

Search file contents using regular expressions. Implemented with Node.js file APIs, so it does not require system `grep`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Regex pattern |
| `path` | string | No | Directory path to search |
| `include` | string | No | File glob filter (e.g., `*.ts`) |

### `find` — Find Files

Find files by glob pattern. Implemented with Node.js file APIs, so it does not require system `find`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Glob pattern (e.g., `*.json`) |
| `path` | string | No | Directory to search |

### `ls` — List Directory

List directory contents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | No | Directory path (default: current directory) |

---

## Custom Tools

### `math_calc` — Math Calculation

Evaluate mathematical expressions using the `expr-eval` library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `expression` | string | Yes | Mathematical expression |
| `precision` | number | No | Decimal precision |

**Supported functions:** `log`, `ln`, `log10`, `log2`, `sin`, `cos`, `tan`, `sqrt`, `abs`, `ceil`, `floor`, `round`, `min`, `max`, `random`, and more.

### `web_search` — Web Search

Search the web using one of 11 supported providers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `num_results` | number | No | Number of results |
| `language` | string | No | Language (default: `zh-CN`) |

**Supported Providers (11):**

| Provider | Value | API Key Variable |
|----------|-------|-----------------|
| Brave Search | `brave` | `HOGAGENT_SEARCH_API_KEY` |
| You.com | `you` | `HOGAGENT_SEARCH_API_KEY` |
| Tavily | `tavily` | `HOGAGENT_SEARCH_API_KEY` |
| SerpAPI | `serpapi` | `HOGAGENT_SEARCH_API_KEY` |
| Bing | `bing` | `HOGAGENT_SEARCH_API_KEY` |
| Google | `google` | `HOGAGENT_SEARCH_API_KEY` + `_CX` |
| Custom | `custom` | `HOGAGENT_SEARCH_API_KEY` + `_ENDPOINT` |
| Bocha AI | `bocha` | `HOGAGENT_BOCHA_API_KEY` |
| Metaso AI | `metaso` | `HOGAGENT_METASO_API_KEY` |
| Zhipu AI | `zhipu` | `HOGAGENT_ZHIPU_API_KEY` |
| Volcengine | `volcengine` | `HOGAGENT_VOLCENGINE_API_KEY` |

> **Recommendation:** For pure search scenarios, prefer Bocha AI (cleanest structured data) or Metaso AI (supports deep research mode). For broadest Chinese domain coverage, choose Volcengine.

### `web_fetch` — Fetch Web Page

Fetch a web page and convert its content to Markdown.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Web page URL |
| `max_length` | number | No | Maximum content length |

### `deliver_files` — Batch File Delivery

Deliver existing files to the user (supports binary files, multiple files per call).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | array | Yes | Array of `{ path, summary? }` objects |

`deliver_files` emits the existing `delivery` event for real managed files and remains available for compatibility or an explicit immediate download. It is not the normal final-output registration path: final delivery is selected by `delivery_decision` after Manifest reconciliation. Locked `none/deliverables/raw_data/selected_files` policies filter the tool; files outside the current Session/Project artifact roots, intermediate artifacts and `.hedgehog/` are always rejected. The complete nonempty requested list, including failed items, bounds finalization. Successes are structured receipts in tool-result details; publication follows Harness persistence. Automatic delivery is not another explicit selection.

The `write` tool accepts optional `artifact_role` (`intermediate`, `raw_data`, `regular`, or `deliverable`). For existing regular/deliverable files, a locked run policy wins; otherwise `write/edit` may choose a mode for that operation and omission uses the contextual default. Raw data cannot be overwritten.

---

## Extension-Registered Tools

These tools are registered at runtime by extensions:

| Tool | Extension | Description |
|------|-----------|-------------|
| `get_tool_details` | content-compressor (opt-in) | Retrieve cached tool-result text by page |
| `query_tool_result` | content-compressor (opt-in) | Filter, sort and aggregate cached structured data |
| `spawn_sub_agent` | sub-agent | Spawn isolated sub-agent |
| `deliver_files` | delivery-manager | Batch deliver files |
| `memory_save` | memory | Save persistent memory; forwards the current trusted `work_id` when available so Gateway records `source_work_id`, otherwise omits it |
| `memory_search` | memory | Search persistent memory |

---

## Content Compression

Content compression is off by default. Disabling takes effect at the next idle RPC boundary after the current top-level task finishes: both retrieval tools and their model-visible definitions are removed, the hook is detached, and cached Entry IDs expire. Enabling always requires a process restart. Threshold changes apply only to an already active compressor. Both save_settings and Gateway reload_config await the same extension configuration application; failures are reported rather than acknowledged as applied.

When explicitly enabled, the `content-compressor` extension intercepts tool results via the `tool_result` hook. Results **below** the token threshold (default 5000, configurable) pass
through untouched. Above it, one of three strategies applies (line-number prefixes
like `123│` and the `File: ... (N lines total)` header are stripped before analysis
so both `read` output and raw API payloads are detected correctly):

| Content | Strategy |
|---------|----------|
| **Markdown** (has `#` headings) | Return a **Table of Contents**: heading level, text, start line, and section length. Progressive depth `###` → `##` → `#` (clamped to the shallowest heading level present) until it fits the threshold. For `read`, gated on a markdown file extension (`.md`/`.markdown`/`.mdx`) so `#`-comment source files (Python/shell/YAML/…) are not mistaken for markdown. |
| **Structured JSON** | Keep the full object/array **structure**, sampling every long array in place as `[...first N, { "__omitted__": K }, ...last M]`. Progressive ladder `50/5` → `20/2` → `5/1` → `1/1` → `1/0`. Array-free objects that still overflow fall back to the text preview. |
| **Other text** | Head (70%) + tail (30%) preview with a middle-omitted marker. |

While compression is active, each compressed result carries an **Entry ID**. Only use a currently available retrieval tool for an ID actually returned by a result. Retrieve the cached content with
`get_tool_details(entry_id, ...)`, query structured data with
`query_tool_result(entry_id, query=...)`, or (for files) expand a slice with
`read(path, offset=/limit=/section=)`.

---

Cached retrieval uses its own 1-based line numbers, which may differ from file line numbers because cached results can include headers. `get_tool_details.lines` / `offset` and `query_tool_result.limit` accept positive integers; invalid ranges and offsets beyond the cache return explicit errors. Continue from the last returned cache line plus one. Error results (`isError` or `details.error`) are never compressed, so read-limit recovery instructions remain visible.

## Tool Parameter Schema

All tool parameters are defined using [`@sinclair/typebox`](https://github.com/sinclairzx81/typebox) for JSON Schema compliance:

```typescript
import { Type } from "@sinclair/typebox";

const parameters = Type.Object({
  path: Type.String({ description: "File path" }),
  content: Type.String({ description: "File content" }),
  append: Type.Optional(Type.Boolean({ description: "Append mode" })),
});
```

---

## Related Documentation

- [Extension API](./extensions.md)
- [Skill System](./skills.md)
- [RPC Protocol](./orchestrator-integration.md)

Gateway ordinary Sessions honor write.artifact_role via the existing overrides registry; Development rejects such overrides before mutation. Saved web_fetch data carries content-bound origin notes in either mode. See [Artifact Manifest](artifact-manifest.md) for partial failures, current-run fallback and provenance.
