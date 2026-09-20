import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { ensurePythonEnvironment } from "../../src/tools/python-environment.ts";

function findPython(): string | undefined {
  const configured = process.env.HOGAGENT_PYTHON;
  if (configured && existsSync(configured)) return configured;
  for (const name of process.platform === "win32" ? ["python3.exe", "python.exe"] : ["python3", "python"]) {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function findWorkingPython(): string | undefined {
  const candidates = [process.env.HOGAGENT_PYTHON, findPython()].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-I", "-X", "utf8", "-S", "-c", "import os,sys;print(os.path.realpath(sys.executable))"], {
      encoding: "utf8",
    });
    const executable = result.status === 0 ? result.stdout.trim() : "";
    if (executable && existsSync(executable)) return executable;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, process.platform === "win32" ? "python.exe" : "python");
    if (!existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["-I", "-S", "-c", "import os,sys;print(os.path.realpath(sys.executable))"], {
      encoding: "utf8",
    });
    const executable = result.status === 0 ? result.stdout.trim() : "";
    if (executable && existsSync(executable)) return executable;
  }
  return undefined;
}

describe("shared Python environment", () => {
  it.skipIf(process.platform !== "win32")("discovers python.exe via Path and keeps pip.exe usable in a Unicode final directory", async () => {
    const interpreter = findWorkingPython();
    expect(interpreter, "native Windows CI requires standard CPython").toBeTruthy();
    const systemDir = mkdtempSync(join(tmpdir(), "hogagent 中文 Python "));
    try {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
      env.Path = dirname(interpreter!);
      const results = await Promise.all([
        ensurePythonEnvironment({ systemDir, env }),
        ensurePythonEnvironment({ systemDir, env }),
      ]);
      for (const result of results) {
        if (!result.available) throw new Error(result.reason);
        for (const [command, args] of [
          [result.environment.python, ["-I", "-X", "utf8", "-m", "pip", "--version"]],
          [join(result.environment.binDir, "pip.exe"), ["--version"]],
        ] as const) {
          const execution = spawnSync(command, [...args], { encoding: "utf8", windowsHide: true });
          expect(execution.status, execution.stderr).toBe(0);
          expect(execution.stdout).toContain("pip ");
        }
      }
      expect(readdirSync(systemDir)).toEqual(["python-venv"]);
      // Launcher tampering must be rejected without running or removing it.
      const python = join(systemDir, "python-venv", "Scripts", "python.exe");
      writeFileSync(python, "not an executable");
      const damaged = await ensurePythonEnvironment({ systemDir, env });
      expect(damaged.available ? "" : damaged.reason).toContain("damaged");
      expect(readFileSync(python, "utf8")).toBe("not an executable");
    } finally {
      rmSync(systemDir, { recursive: true, force: true });
    }
  }, 240_000);

  it("creates under a lock, validates pip, and is reused by concurrent callers", async () => {
    const interpreter = findPython();
    if (!interpreter) return;
    const systemDir = mkdtempSync(join(tmpdir(), "hogagent-python-env-"));
    try {
      const [first, second] = await Promise.all([
        ensurePythonEnvironment({ systemDir, configuredInterpreter: interpreter }),
        ensurePythonEnvironment({ systemDir, configuredInterpreter: interpreter }),
      ]);
      if (!first.available) throw new Error(first.reason);
      if (!second.available) throw new Error(second.reason);
      expect(first.available).toBe(true);
      expect(second.available).toBe(true);
      if (first.available && second.available) {
        expect(first.environment.root).toBe(join(systemDir, "python-venv"));
        expect(second.environment.root).toBe(first.environment.root);
        expect(existsSync(first.environment.python)).toBe(true);

        const pipCommand = join(first.environment.binDir, process.platform === "win32" ? "pip.exe" : "pip");
        if (process.platform !== "win32") {
          expect(readFileSync(pipCommand, "utf8").split(/\r?\n/, 1)[0]).toContain(first.environment.root);
        }

        if (process.platform !== "win32") {
          const canonicalInterpreter = realpathSync(first.environment.python);
          const aliasHome = join(systemDir, "framework-bin");
          mkdirSync(aliasHome);
          symlinkSync(canonicalInterpreter, join(aliasHome, basename(canonicalInterpreter)));
          const venvConfig = join(first.environment.root, "pyvenv.cfg");
          writeFileSync(venvConfig, readFileSync(venvConfig, "utf8").replace(/^home = .*$/m, `home = ${aliasHome}`));
          expect((await ensurePythonEnvironment({ systemDir, configuredInterpreter: interpreter })).available).toBe(true);

          const versionDir = readdirSync(join(first.environment.root, "lib"))
            .find((entry) => entry.startsWith("python"));
          if (versionDir) {
            const marker = join(systemDir, "sitecustomize-ran");
            writeFileSync(
              join(first.environment.root, "lib", versionDir, "site-packages", "sitecustomize.py"),
              `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("unsafe")\n`,
              "utf8",
            );
            const reused = await ensurePythonEnvironment({ systemDir, configuredInterpreter: interpreter });
            expect(reused.available).toBe(true);
            expect(existsSync(marker)).toBe(false);
          }

          const marker = join(systemDir, "replacement-ran");
          rmSync(first.environment.python);
          writeFileSync(first.environment.python, `#!/bin/sh\nprintf unsafe > ${JSON.stringify(marker)}\n`, "utf8");
          chmodSync(first.environment.python, 0o755);
          const replaced = await ensurePythonEnvironment({ systemDir, configuredInterpreter: interpreter });
          expect(replaced.available).toBe(false);
          expect(replaced.available ? "" : replaced.reason).toContain("damaged");
          expect(existsSync(marker)).toBe(false);
        }
      }
      expect(existsSync(join(systemDir, "python-venv.lock"))).toBe(false);
    } finally {
      rmSync(systemDir, { recursive: true, force: true });
    }
  }, 240_000);

  it("fails closed without deleting an existing damaged environment", async () => {
    const systemDir = mkdtempSync(join(tmpdir(), "hogagent-python-broken-"));
    const root = join(systemDir, "python-venv");
    mkdirSync(root);
    writeFileSync(join(root, "keep.txt"), "do not delete", "utf8");
    try {
      const result = await ensurePythonEnvironment({ systemDir });
      expect(result.available).toBe(false);
      expect(result.available ? "" : result.reason).toContain("damaged");
      expect(existsSync(join(root, "keep.txt"))).toBe(true);
    } finally {
      rmSync(systemDir, { recursive: true, force: true });
    }
  });

  it("rejects a configured interpreter that is not absolute", async () => {
    const systemDir = mkdtempSync(join(tmpdir(), "hogagent-python-config-"));
    try {
      const result = await ensurePythonEnvironment({
        systemDir,
        configuredInterpreter: "python3",
        env: { PATH: "" },
      });
      expect(result.available).toBe(false);
      expect(result.available ? "" : result.reason).toContain("absolute path");
    } finally {
      rmSync(systemDir, { recursive: true, force: true });
    }
  });

  it("skips a launchable-looking Python and creates the venv with the next working candidate", async () => {
    if (process.platform === "win32") return;
    const workingPython = findWorkingPython();
    if (!workingPython) return;
    const root = mkdtempSync(join(tmpdir(), "hogagent-python-fallback-"));
    const binDir = join(root, "bin");
    const systemDir = join(root, "system");
    mkdirSync(binDir);
    const brokenPython = join(binDir, "python3");
    writeFileSync(brokenPython, "#!/bin/sh\nexit 71\n", "utf8");
    chmodSync(brokenPython, 0o755);
    symlinkSync(resolve(workingPython), join(binDir, "python"));
    try {
      const result = await ensurePythonEnvironment({
        systemDir,
        env: { PATH: binDir },
      });
      if (!result.available) throw new Error(result.reason);
      expect(result.available).toBe(true);
      expect(existsSync(result.environment.python)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
