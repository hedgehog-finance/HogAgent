# HogAgent Troubleshooting

> 2026-09-07 布局更新：当前目录、提示词、凭据与恢复规则以 [统一工作空间](unified-workspace.md) 为准；下文旧路径及历史审计结论仅用于兼容/迁移背景，不再作为执行配置。

## Common Issues

### Session Recovery Refuses a Corrupt JSONL File

HogAgent creates new storage only when a session file is absent or empty. A missing header can be repaired only if the staged file passes the existing session parser. Corrupt entries, unsupported headers and unreadable history fail recovery instead of being replaced by a new empty session.

Keep the original `~/.hogagent/sessions/<user-namespace>/<session-id>.jsonl` and make a backup before manual repair. Use a new session ID to continue independent work; do not delete the historical file just to make resume succeed. Repairing arbitrary malformed entries requires inspecting the affected history and is not performed automatically.

### Long Task Final Summary Failed

Audit skips and exhausted retries still allow best-effort delivery. A final-summary provider failure is different: HogAgent reports the error and archives the existing progress as `tmp-orchestration-state.json`. Use the existing task Continue action (`[Continue Task]` dispatch) to restore it. Recovery starts at final audit when all groups were processed and follows existing retry rules. An ordinary message does not automatically restore this archive.

### MCP Operation Connection Changed

A persisted operation cannot send remote requests after its configured transport changes, or if it predates connection fingerprints. Start a new operation. Renaming or editing the saved record to force replay is unsupported. Exposure/timeout-only updates preserve connection identity, while revoked permissions still block responding.

### LLM API Key Not Configured

**Symptom:** Error message about missing API key when starting a conversation.

**Solution:**

```bash
# Option 1: Environment variable
export HOGAGENT_LLM_API_KEY="your-api-key-here"

# Option 2: Config file (recommended)
# Create ~/.hogagent/llm-settings.json
{
  "provider": "openai",
  "apiKey": "your-api-key-here",
  "baseUrl": "https://api.openai.com/v1"
}
```

---

### Web UI Cannot Connect

**Symptom:** Browser shows connection error when accessing `http://localhost:9108`.

**Solution:**

1. Confirm the service is running:
   ```bash
   node dist/bin/hogagent-web.js --port 9108
   ```

2. Check port usage:
   ```bash
   lsof -i :9108
   ```

3. Confirm `npm run build` has been executed:
   ```bash
   ls dist/bin/hogagent-web.js
   ```

4. Try a different port:
   ```bash
   node dist/bin/hogagent-web.js --port 9200
   ```

If the page displays a repeated authentication failure, confirm the browser is opening the same loopback host and port shown above and that no proxy is rewriting the WebSocket Origin. Restart the WebUI and reload the page; this issues a fresh token while preserving `~/.hogagent/web-jwt-secret.key`. The JWT itself is intentionally not logged or stored in browser local storage.

---

### Bash Tool Is Missing

**Symptom:** `bash` is absent from `builtin_tools` or the WebUI tool list.

Check startup logs for `Bash disabled`, `Bash running in degraded UNSANDBOXED mode`, or `Bash sandbox disabled by system configuration`. The last message means an operator deliberately disabled isolation and is not a missing dependency. Otherwise verify:

```bash
# macOS
test -x /usr/bin/sandbox-exec && echo sandbox-ok

# Linux
bwrap --version

# Python selected for the shared venv
python3 -m venv --help
```

On Windows, verify at least one command shell is available:

```powershell
Get-Command powershell.exe, bash.exe -ErrorAction SilentlyContinue
```

On Linux, install the distribution's `bubblewrap` package. If Python is installed at a nonstandard path, set `pythonPath` in `~/.hogagent/hogagent.json` (preferred) or an absolute `HOGAGENT_PYTHON`. HogAgent starts and validates each candidate rather than trusting its execute bit, then tries remaining `python3`/`python` entries. On macOS/Linux, `enabled` omits Bash after any sandbox or Python initialization failure, while `fallback` selects an explicitly marked unsandboxed shell. Windows ignores `sandboxMode`; Python initialization failure is reported but does not remove Windows PowerShell or verified Git Bash. `cmd.exe` is not a supported HogAgent shell.

On macOS/Linux, choose `sandboxMode: "disabled"` for a deliberate unconditional bypass, `"fallback"` to try isolation before bypassing it, or `"enabled"` when initialization failures must fail closed. Bare-shell paths give the selected shell and every subprocess the HogAgent process account's full filesystem permissions. Configure the mode in HogAgent WebUI **Settings → System**, Gateway **Agents → HogAgent → Runtime Settings → System Config**, or `~/.hogagent/hogagent.json`, then reconnect/restart HogAgent. Windows does not support the sandbox: every value is ignored for execution and the shell remains explicitly `UNSANDBOXED`.

Also keep `HOGAGENT_USER_DIR` outside the active workspace, HogAgent installation, and runtime roots; keep the installation/base interpreter outside the writable workspace. `skills_config.json` and `<workspace>/.hogagent/bash-tmp` must be real, non-linked entries. Unsafe sandbox overlap selects the mode's failure behavior (`enabled` omits Bash, `fallback` uses a bare shell). An invalid Bash temp directory omits Bash in every mode.

### Puppeteer or Playwright Browser Fails Inside Bash Sandbox

**Symptom:** Chromium reports `icudtl.dat not found in bundle`, or macOS reports that a Chrome framework was `blocked by sandbox`.

HogAgent's default RuntimeGrant allows the standard Puppeteer and Playwright downloaded-browser cache roots plus exact known browser application bundles as read-only runtime dependencies. On macOS it also sets `MAC_CHROMIUM_TMPDIR` to the workspace Bash temp directory because Chromium does not use ordinary `TMPDIR` for its native temporary files. The bundled `doc-convert` PDF paths use `chrome-headless-shell`, avoiding desktop Chrome's application/profile lifecycle. Restart HogAgent after upgrading so the Bash sandbox profile is rebuilt. For custom locations, set an absolute `PUPPETEER_CACHE_DIR`, `PLAYWRIGHT_BROWSERS_PATH`, `PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`, or `GOOGLE_CHROME_BIN` in the HogAgent process environment before startup. Keep browser profiles and generated PDF/image files inside the active workspace; arbitrary application directories are not exposed.

If another installed CLI reports a missing library, font, certificate, locale, or read-only package file, make sure an absolute PATH entry containing its `bin`/`sbin` segment is present in HogAgent's startup `PATH`, then restart. RuntimeGrant promotes that segment to its package prefix read-only outside the home directory and for known per-user package-manager roots. It does not widen `~/bin` or an arbitrary home project into a broader home grant. Mutable tool state must use the RuntimeGrant XDG/cache/temp paths below `<workspace>/.hogagent/bash-tmp`; a tool that insists on writing beside its executable remains unsupported rather than receiving a writable installation grant.

### DNS or HTTPS Fails Only Inside Bash Sandbox

The `enabled` sandbox restricts file access but intentionally retains host network access for Skill API calls. macOS explicitly allows network operations and Linux Bubblewrap uses the host network namespace. Its RuntimeGrant exposes only the exact resolver, mDNSResponder, NSS, and CA-certificate dependencies needed by native clients. On macOS it includes both `/etc`/`/var` lexical paths and `/private/etc`/`/private/var` canonical targets; omitting the lexical form can make `curl` report a CA-file error that higher-level tools misclassify as DNS failure. Check `node -e 'require("node:dns").lookup("example.com", console.log)'` separately from `curl -I https://example.com` to distinguish resolution from certificate loading. Host proxy, firewall, VPN, and DNS policies still apply.

### Shared Python Environment Is Damaged

**Symptom:** startup reports that `~/.hogagent/python-venv` is damaged and Bash is running in degraded `UNSANDBOXED` mode.

HogAgent does not delete an existing environment automatically. Preserve it for inspection, then restart so HogAgent can create and validate a new environment:

```bash
mv ~/.hogagent/python-venv ~/.hogagent/python-venv.broken
```

If creation still fails, run the candidate interpreter's `-I -m venv` manually to diagnose missing `venv`/`ensurepip` support. HogAgent normally continues to the next working interpreter automatically. Existing environments must still match one discovered base interpreter; HogAgent validates launcher identity and pip metadata without importing writable venv code outside the sandbox. Packages are shared across workspaces, so reinstall required packages after recreation.

---

### RPC Communication Issues

**Symptom:** Orchestrator receives no events or malformed JSON.

**Solution:**

```bash
# Enable debug mode for detailed logging
node dist/bin/hogagent.js --mode rpc --debug 2>debug.log

# Check debug output
cat debug.log
```

**Common causes:**
- Malformed JSONL input (ensure one JSON object per line, no trailing commas)
- Process stdout is buffered (ensure orchestrator reads line-by-line)
- Session ID conflicts (use unique UUIDs for each session)

---

### Session Persistence Issues

**Symptom:** Sessions not loading or switching correctly.

**Solution:**

1. Verify session files exist:
   ```bash
   ls -la ~/.hogagent/sessions/<user-namespace>/
   ```

2. Check session file integrity:
   ```bash
   # Session files are JSONL format, one event per line
   cat ~/.hogagent/sessions/<user-namespace>/<session-id>.jsonl | head -5
   ```

3. Verify workspace path is correct:
   ```bash
   node dist/bin/hogagent.js --mode rpc --workspace /path/to/workspace
   ```

---

### Extension Not Loading

**Symptom:** Extension tools are not available in the tool list.

**Solution:**

1. Check extension is enabled in `~/.hogagent/hogagent.json`:
   ```json
   {
     "extensions": [
       { "name": "my-extension", "enabled": true }
     ]
   }
   ```

2. Verify extension file exists:
   - System-level: `~/.hogagent/extensions/<name>/index.js`
   - Workspace-level: `<workspace>/extensions/<name>/index.js`

3. Check extension implements `IExtension` interface correctly

---

### Context Window Overflow

**Symptom:** Error about context window exceeded during long conversations.

**Solution:**

1. Enable auto-compaction (default is enabled):
   ```json
   // ~/.hogagent/llm-settings.json
   {
     "compaction": {
       "autoCompactThreshold": 0.75
     }
   }
   ```

2. Send the next prompt and allow the pre-prompt capacity check to compact the session. User chat input remains disabled during compaction; backend commands can wait in the FIFO.

3. When the session is idle and writable, use the WebUI action or `{"type":"compact"}` to compact manually. Manual requests are rejected while a turn, queue, or Long Task is active. If compression fails or exceeds five minutes, start a new session.

---

### Search Not Working

**Symptom:** `web_search` tool returns empty results or errors.

**Solution:**

1. Verify search provider is configured:
   ```bash
   export HOGAGENT_SEARCH_PROVIDER=bocha
   export HOGAGENT_BOCHA_API_KEY=your-key
   ```

2. Or configure via `~/.hogagent/search_settings.json`:
   ```json
   {
     "active_provider": "bocha",
     "providers": {
       "bocha": { "api_key": "your-key" }
     }
   }
   ```

3. Test with a simple query via RPC:
   ```json
   {"type": "prompt", "text": "Search for latest AI news"}
   ```

---

### Build Errors

**Symptom:** `npm run build` fails with TypeScript errors.

**Solution:**

```bash
# Clean and rebuild
rm -rf dist/
npm run build

# Check TypeScript separately
npm run check

# If dependency issues
npm install --legacy-peer-deps
```

---

## Debug Mode

Enable verbose logging for any HogAgent process:

```bash
# RPC mode with debug
node dist/bin/hogagent.js --mode rpc --debug 2>debug.log

# Web UI mode with debug
DEBUG=* node dist/bin/hogagent-web.js --port 9108
```

---

## Related Documentation

- [Deployment](./deployment.md)
- [Configuration](./configuration.md)
- [RPC Protocol](./orchestrator-integration.md)
