import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { createBashTool, createBuiltinTools } from "../../src/tools/builtin-tools.ts";
import { prepareBashRuntime, type BashRuntime } from "../../src/tools/bash-sandbox.ts";

function findPython(): string | undefined {
  if (process.env.HOGAGENT_PYTHON && existsSync(process.env.HOGAGENT_PYTHON)) {
    return process.env.HOGAGENT_PYTHON;
  }
  for (const name of ["python3", "python"]) {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function resultText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((item) => item.text).join("\n");
}

describe("Bash sandbox", () => {
  it("omits Bash when no supported shell or strict sandbox backend exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "hogagent-no-bash-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    try {
      const result = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: resolve("."),
        systemDir: join(root, "system"),
        platform: "win32",
        sandboxMode: "enabled",
      });
      expect(result.available).toBe(false);
      expect(result.available ? "" : result.reason).toContain("no supported command shell");
      expect(createBuiltinTools(workspace).map((tool) => tool.name)).not.toContain("bash");

      const missingBwrap = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: resolve("."),
        systemDir: join(root, "linux-system"),
        platform: "linux",
        sandboxMode: "enabled",
        env: { ...process.env, PATH: "" },
      });
      expect(missingBwrap.available).toBe(false);
      expect(missingBwrap.available ? "" : missingBwrap.reason).toContain("bwrap");

      const unsafeConfigLocation = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: resolve("."),
        systemDir: join(workspace, ".hogagent"),
        platform: "linux",
        sandboxMode: "enabled",
        env: { ...process.env, PATH: "" },
      });
      expect(unsafeConfigLocation.available).toBe(false);
      expect(unsafeConfigLocation.available ? "" : unsafeConfigLocation.reason).toContain("secrets cannot be isolated");

      const linkedSystem = join(root, "linked-system");
      mkdirSync(linkedSystem);
      writeFileSync(join(root, "linked-secret"), "secret", "utf8");
      symlinkSync(join(root, "linked-secret"), join(linkedSystem, "skills_config.json"));
      const unsafeSkillsConfig = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: resolve("."),
        systemDir: linkedSystem,
        platform: "linux",
        sandboxMode: "enabled",
        env: { ...process.env, PATH: "" },
      });
      expect(unsafeSkillsConfig.available).toBe(false);
      expect(unsafeSkillsConfig.available ? "" : unsafeSkillsConfig.reason).toContain("skills_config.json");

      const realWorkspace = join(root, "real-workspace");
      const linkedWorkspace = join(root, "workspace-link");
      mkdirSync(realWorkspace);
      mkdirSync(join(realWorkspace, "system"));
      symlinkSync(realWorkspace, linkedWorkspace);
      const canonicalOverlap = await prepareBashRuntime({
        workspaceDir: linkedWorkspace,
        projectRoot: resolve("."),
        systemDir: join(realWorkspace, "system"),
        platform: "linux",
        sandboxMode: "enabled",
        env: { ...process.env, PATH: "" },
      });
      expect(canonicalOverlap.available).toBe(false);
      expect(canonicalOverlap.available ? "" : canonicalOverlap.reason).toContain("secrets cannot be isolated");

      const nestedInstall = join(workspace, "hogagent-install");
      mkdirSync(nestedInstall);
      const writableInstall = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: nestedInstall,
        systemDir: join(root, "isolated-system"),
        platform: "linux",
        sandboxMode: "enabled",
        env: { ...process.env, PATH: "" },
      });
      expect(writableInstall.available).toBe(false);
      expect(writableInstall.available ? "" : writableInstall.reason).toContain("installation root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores sandboxMode and uses an explicit Windows bare shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "hogagent-windows-shell-"));
    const workspace = join(root, "workspace");
    const windowsRoot = join(root, "windows");
    const foreignBashDir = join(root, "foreign-bash");
    const foreignBash = join(foreignBashDir, "bash.exe");
    const adjacentGit = join(foreignBashDir, "git.exe");
    const powershell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    mkdirSync(workspace);
    mkdirSync(foreignBashDir);
    mkdirSync(dirname(powershell), { recursive: true });
    writeFileSync(foreignBash, "#!/bin/sh\nexit 0\n", "utf8");
    writeFileSync(powershell, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(foreignBash, 0o755);
    chmodSync(powershell, 0o755);

    const options = {
      workspaceDir: workspace,
      projectRoot: resolve("."),
      systemDir: join(root, "system"),
      platform: "win32" as const,
      env: {
        Path: foreignBashDir,
        SystemRoot: windowsRoot,
        LOCALAPPDATA: join(root, "local-app-data"),
      },
    };

    try {
      const runtimes = await Promise.all(
        (["enabled", "fallback", "disabled"] as const).map((sandboxMode) =>
          prepareBashRuntime({ ...options, sandboxMode })),
      );
      for (const result of runtimes) {
        if (!result.available) throw new Error(result.reason);
        expect(result.runtime.backend).toBe("bare-shell");
        expect(result.runtime.unrestrictedByPlatform).toBe(true);
        expect(result.runtime.unrestrictedByConfiguration).toBeUndefined();
        expect(result.runtime.degradedReason).toContain("sandboxMode is ignored");
        expect(result.runtime.shells).not.toContain(foreignBash);
        expect(result.runtime.shells.map((shell) => basename(shell))).toEqual(["powershell.exe"]);
        const tools = createBuiltinTools(workspace, undefined, result.runtime);
        expect(tools.map((tool) => tool.name)).toContain("bash");
        expect(tools.find((tool) => tool.name === "bash")?.description).toContain("sandboxMode has no effect");
      }

      const runtimeResult = runtimes[0];
      if (!runtimeResult.available) throw new Error(runtimeResult.reason);
      const powershellSpawn = runtimeResult.runtime.buildSpawn(powershell, "node script.js");
      expect(powershellSpawn.env.GIT_CONFIG_GLOBAL).toBe("NUL");
      expect(powershellSpawn.env.PLAYWRIGHT_BROWSERS_PATH).toBe(join(root, "local-app-data", "ms-playwright"));
      expect(powershellSpawn.args).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false); node script.js",
      ]);
      writeFileSync(adjacentGit, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(adjacentGit, 0o755);
      const withVerifiedGitBash = await prepareBashRuntime({ ...options, sandboxMode: "enabled" });
      if (!withVerifiedGitBash.available) throw new Error(withVerifiedGitBash.reason);
      expect(withVerifiedGitBash.runtime.shells.map((shell) => basename(shell)))
        .toEqual(["powershell.exe", "bash.exe"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["", "1"])("enforces workspace boundaries and shared Skill config access (managed=%s)", async managed => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const interpreter = findPython();
    if (!interpreter) return;
    vi.stubEnv("HOGAGENT_GATEWAY_MANAGED", managed);

    const root = mkdtempSync(join(tmpdir(), "hogagent-bash-sandbox-"));
    const workspace = join(root, "workspace");
    const systemDir = join(root, "system");
    const outside = join(root, "outside.txt");
    const secret = join(systemDir, "web-jwt-secret.key");
    const skillsConfig = join(systemDir, "skills_config.json");
    const fakeHome = join(root, "home");
    const puppeteerCache = join(fakeHome, ".cache", "puppeteer");
    const playwrightCache = process.platform === "darwin"
      ? join(fakeHome, "Library", "Caches", "ms-playwright")
      : join(fakeHome, ".cache", "ms-playwright");
    const puppeteerRuntime = join(puppeteerCache, "chrome", "runtime.dat");
    const playwrightRuntime = join(playwrightCache, "chromium", "runtime.dat");
    const commonToolRoot = join(root, "common-tool");
    const commonToolRuntime = join(commonToolRoot, "share", "runtime.dat");
    mkdirSync(workspace);
    mkdirSync(systemDir);
    mkdirSync(dirname(puppeteerRuntime), { recursive: true });
    mkdirSync(dirname(playwrightRuntime), { recursive: true });
    const commonToolBin = join(commonToolRoot, "bin", "override");
    mkdirSync(commonToolBin, { recursive: true });
    mkdirSync(dirname(commonToolRuntime), { recursive: true });
    writeFileSync(outside, "outside-secret", "utf8");
    writeFileSync(secret, "jwt-secret", "utf8");
    writeFileSync(skillsConfig, "{}", "utf8");
    writeFileSync(puppeteerRuntime, "puppeteer-runtime", "utf8");
    writeFileSync(playwrightRuntime, "playwright-runtime", "utf8");
    writeFileSync(commonToolRuntime, "common-tool-runtime", "utf8");
    symlinkSync(outside, join(workspace, "outside-link"));

    try {
      const prepared = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: resolve("."),
        systemDir,
        configuredPython: interpreter,
        sandboxMode: "enabled",
        env: {
          ...process.env,
          HOME: fakeHome,
          XDG_CACHE_HOME: join(fakeHome, ".cache"),
          PATH: `${commonToolBin}${delimiter}${process.env.PATH ?? ""}`,
        },
      });
      if (!prepared.available) throw new Error(prepared.reason);
      expect(prepared.available).toBe(true);
      if (!prepared.available) return;
      const runtime: BashRuntime = prepared.runtime;
      if (!runtime.pythonEnvironment) throw new Error("expected sandboxed runtime with Python environment");
      const spawnSpec = runtime.buildSpawn(runtime.shells[0]!, "true");
      if (runtime.backend === "macos-sandbox-exec") {
        expect(spawnSpec.args[1]).toContain("(allow network*)");
      } else if (runtime.backend === "linux-bubblewrap") {
        expect(spawnSpec.args).toContain("--share-net");
      }
      expect(spawnSpec.env.PUPPETEER_CACHE_DIR).toBe(puppeteerCache);
      expect(spawnSpec.env.PLAYWRIGHT_BROWSERS_PATH).toBe(playwrightCache);
      if (process.platform === "darwin") expect(spawnSpec.env.MAC_CHROMIUM_TMPDIR).toBe(runtime.tempDir);
      expect(spawnSpec.env.XDG_CONFIG_HOME).toBe(join(runtime.tempDir, "config"));
      expect(spawnSpec.env.NPM_CONFIG_CACHE).toBe(join(runtime.tempDir, "npm-cache"));
      expect(spawnSpec.env.PYTHONPYCACHEPREFIX).toBe(join(runtime.tempDir, "python-cache"));
      const tool = createBashTool(runtime);

      const insidePath = join(workspace, "inside.txt");
      const inside = resultText(await tool.execute("inside", {
        command: `printf safe > ${JSON.stringify(insidePath)} && cat ${JSON.stringify(insidePath)}`,
      }));
      expect(inside).toContain("safe");

      for (const command of [
        `cat ${JSON.stringify(outside)}`,
        `cat ../outside.txt`,
        "cat outside-link",
        `printf bad > ${JSON.stringify(outside)}`,
        `printf bad > ${JSON.stringify(skillsConfig)}`,
        `node -e 'require("fs").readFileSync(process.argv[1])' ${JSON.stringify(secret)}`,
        `python -c 'import pathlib,sys;pathlib.Path(sys.argv[1]).read_text()' ${JSON.stringify(secret)}`,
      ]) {
        const denied = resultText(await tool.execute("denied", { command }));
        expect(denied).toMatch(/denied|not permitted|operation not permitted|exit code/i);
      }
      const configRead = resultText(await tool.execute("config", { command: `cat ${JSON.stringify(skillsConfig)}` }));
      expect(configRead).toContain("{}");
      const browserRuntimeRead = resultText(await tool.execute("browser-runtime", {
        command: `cat ${JSON.stringify(puppeteerRuntime)} ${JSON.stringify(playwrightRuntime)}`,
      }));
      expect(browserRuntimeRead).toContain("puppeteer-runtime");
      expect(browserRuntimeRead).toContain("playwright-runtime");
      const browserRuntimeWrite = resultText(await tool.execute("browser-runtime-read-only", {
        command: `printf bad > ${JSON.stringify(puppeteerRuntime)}`,
      }));
      expect(browserRuntimeWrite).toMatch(/denied|not permitted|operation not permitted|exit code/i);
      const commonToolRead = resultText(await tool.execute("common-tool-runtime", {
        command: `cat ${JSON.stringify(commonToolRuntime)}`,
      }));
      expect(commonToolRead).toContain("common-tool-runtime");
      const dnsLookup = resultText(await tool.execute("dns-lookup", {
        command: "node -e 'require(\"node:dns\").lookup(\"localhost\",(error,address)=>{if(error)throw error;console.log(address)})'",
      }));
      expect(dnsLookup).not.toMatch(/denied|not permitted|operation not permitted|exit code/i);
      if (process.platform === "darwin") {
        const resolverFiles = resultText(await tool.execute("resolver-files", {
          command: "test -r /etc/resolv.conf && test -r /etc/ssl/cert.pem",
        }));
        expect(resolverFiles).not.toMatch(/denied|not permitted|operation not permitted|exit code/i);
      }
      const commonToolWrite = resultText(await tool.execute("common-tool-read-only", {
        command: `printf bad > ${JSON.stringify(commonToolRuntime)}`,
      }));
      expect(commonToolWrite).toMatch(/denied|not permitted|operation not permitted|exit code/i);
      const venvWrite = join(runtime.pythonEnvironment.root, "sandbox-write.txt");
      const pythonWrite = resultText(await tool.execute("python", {
        command: `python -c 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text("ok")' ${JSON.stringify(venvWrite)} && cat ${JSON.stringify(venvWrite)}`,
      }));
      expect(pythonWrite).toContain("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }, 300_000);

  it("rejects a workspace temp directory that is a symlink", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const root = mkdtempSync(join(tmpdir(), "hogagent-bash-temp-link-"));
    const workspace = join(root, "workspace");
    const outsideTemp = join(root, "outside-temp");
    mkdirSync(join(workspace, ".hogagent"), { recursive: true });
    mkdirSync(outsideTemp);
    symlinkSync(outsideTemp, join(workspace, ".hogagent", "bash-tmp"));
    try {
      const result = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: resolve("."),
        systemDir: join(root, "system"),
        sandboxMode: "enabled",
      });
      if (!result.available && /unavailable|probe failed/i.test(result.reason)) return;
      expect(result.available).toBe(false);
      expect(result.available ? "" : result.reason).toContain("temp directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to a clearly marked bare shell when sandbox initialization fails", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const root = mkdtempSync(join(tmpdir(), "hogagent-bare-shell-"));
    const workspace = join(root, "workspace");
    const systemDir = join(root, "system");
    const brokenPython = join(root, "broken-python");
    mkdirSync(workspace);
    writeFileSync(brokenPython, "#!/bin/sh\nexit 71\n", "utf8");
    chmodSync(brokenPython, 0o755);
    try {
      const strict = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: resolve("."),
        systemDir,
        configuredPython: brokenPython,
        sandboxMode: "enabled",
        env: { ...process.env, PATH: "" },
      });
      if (!strict.available && /unavailable|probe failed/i.test(strict.reason)
        && !strict.reason.includes(brokenPython)) return;
      expect(strict.available).toBe(false);
      expect(strict.available ? "" : strict.reason).toContain(brokenPython);

      const prepared = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: resolve("."),
        systemDir,
        configuredPython: brokenPython,
        sandboxMode: "fallback",
        env: { ...process.env, PATH: "" },
      });
      if (!prepared.available && /unavailable|probe failed/i.test(prepared.reason)) return;
      if (!prepared.available) throw new Error(prepared.reason);
      expect(prepared.runtime.backend).toBe("bare-shell");
      expect(prepared.runtime.pythonEnvironment).toBeUndefined();
      expect(prepared.runtime.degradedReason).toContain(brokenPython);

      const tool = createBashTool(prepared.runtime);
      const output = resultText(await tool.execute("node", {
        command: "node -e 'console.log(JSON.stringify([1,2,3]))'",
      }));
      expect(output).toContain("[1,2,3]");
      expect(tool.description).toContain("UNSANDBOXED");

      const missingBackendFallback = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: resolve("."),
        systemDir,
        configuredPython: brokenPython,
        sandboxMode: "fallback",
        platform: "linux",
        env: { ...process.env, PATH: "" },
      });
      expect(missingBackendFallback.available).toBe(true);
      if (missingBackendFallback.available) {
        expect(missingBackendFallback.runtime.backend).toBe("bare-shell");
        expect(missingBackendFallback.runtime.degradedReason).toContain("bwrap");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("runs with unrestricted file access when the sandbox is explicitly disabled", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const root = mkdtempSync(join(tmpdir(), "hogagent-sandbox-disabled-"));
    const workspace = join(root, "workspace");
    const nestedInstall = join(workspace, "hogagent-install");
    const systemDir = join(workspace, "system");
    const outside = join(root, "outside.txt");
    const brokenPython = join(root, "broken-python");
    mkdirSync(nestedInstall, { recursive: true });
    writeFileSync(systemDir, "not-a-directory", "utf8");
    writeFileSync(outside, "outside-before", "utf8");
    writeFileSync(brokenPython, "#!/bin/sh\nexit 71\n", "utf8");
    chmodSync(brokenPython, 0o755);

    try {
      const prepared = await prepareBashRuntime({
        workspaceDir: workspace,
        projectRoot: nestedInstall,
        systemDir,
        configuredPython: brokenPython,
        sandboxMode: "disabled",
        env: { ...process.env, PATH: "" },
      });
      if (!prepared.available) throw new Error(prepared.reason);
      expect(prepared.runtime.backend).toBe("bare-shell");
      expect(prepared.runtime.unrestrictedByConfiguration).toBe(true);
      expect(prepared.runtime.pythonEnvironment).toBeUndefined();
      expect(prepared.runtime.degradedReason).toContain("Unable to initialize Python environment");

      const tool = createBashTool(prepared.runtime);
      const output = resultText(await tool.execute("unrestricted", {
        command: `printf outside-after > ${JSON.stringify(outside)} && /bin/cat ${JSON.stringify(outside)}`,
      }));
      expect(output).toContain("outside-after");
      expect(tool.description).toContain("operator-configured UNSANDBOXED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
