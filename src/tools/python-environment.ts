import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { isPathInside } from "../utils/path-safety.ts";
import { normalizeEnvironment } from "../utils/environment.ts";

const VENV_NAME = "python-venv";
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 60_000;

export interface PythonEnvironment {
  root: string;
  binDir: string;
  python: string;
  readOnlyRuntimeRoots: string[];
}

export type PythonEnvironmentResult =
  | { available: true; environment: PythonEnvironment }
  | { available: false; reason: string };

interface PythonEnvironmentOptions {
  systemDir: string;
  configuredInterpreter?: string;
  env?: NodeJS.ProcessEnv;
  lockWaitMs?: number;
}

interface TrustedPythonProbe {
  basePrefix: string;
  executable: string;
  stdlib: string;
  platstdlib: string;
  purelib: string;
  launchers: string[];
}

interface PythonCandidates {
  interpreters: string[];
  failures: string[];
}

function runFile(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      env: options.env,
      timeout: options.timeout ?? 120_000,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim();
        reject(new Error(detail || error.message));
        return;
      }
      resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkingInterpreter(candidate: string): Promise<string> {
  const script = "import os,sys;print(os.path.realpath(sys.executable))";
  const { stdout } = await runFile(candidate, ["-I", "-X", "utf8", "-S", "-c", script], { timeout: 30_000 });
  const executable = stdout.trim();
  if (!isAbsolute(executable) || !await isExecutable(executable)) {
    throw new Error("did not report an executable absolute sys.executable");
  }
  return realpath(executable);
}

async function findPythonInterpreters(configured: string | undefined, env: NodeJS.ProcessEnv): Promise<PythonCandidates> {
  const candidates: string[] = [];
  const failures: string[] = [];
  if (configured) {
    if (!isAbsolute(configured)) {
      failures.push("configured interpreter must be an absolute path");
    } else if (!await isExecutable(configured)) {
      failures.push(`configured interpreter is not executable: ${configured}`);
    } else {
      candidates.push(configured);
    }
  }

  const searchPath = env.PATH ?? "";
  for (const name of process.platform === "win32" ? ["python3.exe", "python.exe"] : ["python3", "python"]) {
    for (const directory of searchPath.split(delimiter)) {
      if (!directory) continue;
      const candidate = join(directory, name);
      if (await isExecutable(candidate)) candidates.push(candidate);
    }
  }

  const interpreters: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const interpreter = await resolveWorkingInterpreter(candidate);
      if (!interpreters.includes(interpreter)) interpreters.push(interpreter);
    } catch (error) {
      failures.push(`${candidate}: ${(error as Error).message}`);
    }
  }
  return { interpreters, failures };
}

function parseVenvConfig(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    values.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return values;
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function verifyVenvLauncher(python: string, trustedInterpreter: string, launchers: string[]): Promise<void> {
  const launcherStat = await lstat(python);
  if (launcherStat.isSymbolicLink()) {
    if (await realpath(python) !== trustedInterpreter) {
      throw new Error("virtual environment Python does not point to the configured interpreter");
    }
    return;
  }
  if (launcherStat.isFile()) {
    const actual = await sha256(python);
    for (const launcher of launchers) {
      if (existsSync(launcher) && actual === await sha256(launcher)) return;
    }
  }
  throw new Error("virtual environment Python is not a trusted interpreter launcher (use a standard CPython installation)");
}

async function probeTrustedInterpreter(interpreter: string, root: string): Promise<TrustedPythonProbe> {
  const script = [
    "import json, os, sys, sysconfig, venv",
    "r=sys.argv[1]",
    "runtime=sysconfig.get_paths()",
    // The macOS framework default scheme ignores base/platbase for purelib.
    // A venv uses the platform prefix scheme even on those Python builds.
    "scheme='nt' if os.name=='nt' else 'posix_prefix'",
    "paths=sysconfig.get_paths(scheme,vars={'base':r,'platbase':r})",
    "launchers=[sys.executable]+([os.path.join(os.path.dirname(venv.__file__),'scripts','nt',n) for n in ('python.exe','venvlauncher.exe')] if os.name=='nt' else [])",
    "print(json.dumps({'basePrefix':sys.base_prefix,'executable':sys.executable,'stdlib':runtime.get('stdlib',''),'platstdlib':runtime.get('platstdlib',''),'purelib':paths.get('purelib',''),'launchers':launchers}))",
  ].join(";");
  const { stdout } = await runFile(interpreter, ["-I", "-X", "utf8", "-S", "-c", script, root], { timeout: 30_000 });
  return JSON.parse(stdout.trim()) as TrustedPythonProbe;
}

async function validatePip(root: string, binDir: string, purelib: string, trustedInterpreter: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const pipPackage = join(purelib, "pip");
  const pipInit = join(pipPackage, "__init__.py");
  const pipPackageStat = await lstat(pipPackage);
  const pipInitStat = await lstat(pipInit);
  if (pipPackageStat.isSymbolicLink() || !pipPackageStat.isDirectory()
    || pipInitStat.isSymbolicLink() || !pipInitStat.isFile()
    || !isPathInside(canonicalRoot, await realpath(pipPackage)) || !isPathInside(canonicalRoot, await realpath(pipInit))) {
    throw new Error("pip package is missing or escapes the virtual environment");
  }
  const entries = await readdir(purelib, { withFileTypes: true });
  if (!entries.some((entry) => entry.isDirectory() && /^pip-[^/]+\.dist-info$/i.test(entry.name))) {
    throw new Error("pip metadata is missing from the virtual environment");
  }

  if (process.platform !== "win32") {
    const pipCommand = join(binDir, "pip");
    const pipStat = await lstat(pipCommand);
    if (pipStat.isSymbolicLink() || !pipStat.isFile()) {
      throw new Error("pip command is missing or is not a regular file");
    }
    const firstLine = (await readFile(pipCommand, "utf8")).split(/\r?\n/, 1)[0] ?? "";
    const shebang = firstLine.startsWith("#!") ? firstLine.slice(2).trim() : "";
    const shebangInside = isPathInside(resolve(root), shebang) || isPathInside(canonicalRoot, shebang);
    if (!shebangInside || !await isExecutable(shebang) || await realpath(shebang) !== trustedInterpreter) {
      throw new Error("pip command points outside the virtual environment or to an untrusted interpreter");
    }
  }
}

async function probeEnvironment(root: string, trustedInterpreter: string): Promise<PythonEnvironment> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("the virtual environment root must be a real directory");
  }

  const binDir = join(root, process.platform === "win32" ? "Scripts" : "bin");
  const python = join(binDir, process.platform === "win32" ? "python.exe" : "python");
  if (!await isExecutable(python)) throw new Error("virtual environment Python is missing or not executable");

  const config = parseVenvConfig(await readFile(join(root, "pyvenv.cfg"), "utf8"));
  if (config.get("include-system-site-packages")?.toLowerCase() !== "false") {
    throw new Error("virtual environment must disable system site packages");
  }
  const configuredHome = config.get("home");
  let homeMatches = false;
  if (configuredHome && isAbsolute(configuredHome)) {
    homeMatches = isPathInside(await realpath(configuredHome), trustedInterpreter);
    // Framework installations may keep an interpreter symlink in the configured home.
    if (!homeMatches) {
      homeMatches = await realpath(join(configuredHome, basename(trustedInterpreter)))
        .then(executable => executable === trustedInterpreter, () => false);
    }
  }
  if (!homeMatches) {
    throw new Error("virtual environment base interpreter does not match the configured interpreter");
  }
  const configuredExecutable = config.get("executable");
  if (configuredExecutable && (!isAbsolute(configuredExecutable)
    || await realpath(configuredExecutable) !== trustedInterpreter)) {
    throw new Error("virtual environment executable does not match the configured interpreter");
  }

  // Never execute the shared, Bash-writable venv while validating it outside
  // the sandbox. Query only the trusted base interpreter in isolated mode.
  const probe = await probeTrustedInterpreter(trustedInterpreter, root);
  await verifyVenvLauncher(python, trustedInterpreter, probe.launchers);
  if (!isPathInside(root, probe.purelib)) {
    throw new Error("Python package installation path escapes the virtual environment");
  }
  await validatePip(root, binDir, probe.purelib, trustedInterpreter);

  const readOnlyRuntimeRoots = [probe.basePrefix, probe.executable, probe.stdlib, probe.platstdlib]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => resolve(value));

  return {
    root: resolve(root),
    binDir: resolve(binDir),
    python: resolve(python),
    readOnlyRuntimeRoots: [...new Set(readOnlyRuntimeRoots)],
  };
}

async function rewriteRelocatedEnvironment(sourceRoot: string, targetRoot: string): Promise<void> {
  const candidates = [join(sourceRoot, "pyvenv.cfg")];
  const canonicalSourceRoot = await realpath(sourceRoot);
  const sourceRoots = [...new Set([sourceRoot, canonicalSourceRoot])];
  const binDir = join(sourceRoot, process.platform === "win32" ? "Scripts" : "bin");
  for (const entry of await readdir(binDir, { withFileTypes: true })) {
    if (entry.isFile()) candidates.push(join(binDir, entry.name));
  }

  for (const filePath of candidates) {
    const content = await readFile(filePath);
    if (content.includes(0)) continue;
    let rewritten = content.toString("utf8");
    for (const candidateRoot of sourceRoots) rewritten = rewritten.replaceAll(candidateRoot, targetRoot);
    if (rewritten !== content.toString("utf8")) await writeFile(filePath, rewritten, "utf8");
  }
}

async function acquireLock(lockPath: string, waitMs: number): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await writeFile(handle, `${process.pid}\n`, "utf8");
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for another HogAgent process to initialize Python");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
}

async function validateExistingEnvironment(
  target: string,
  trustedInterpreters: string[],
  previousFailures: string[] = [],
): Promise<PythonEnvironmentResult> {
  const failures = [...previousFailures];
  for (const interpreter of trustedInterpreters) {
    try {
      return { available: true, environment: await probeEnvironment(target, interpreter) };
    } catch (error) {
      failures.push(`${interpreter}: ${(error as Error).message}`);
    }
  }
  const detail = failures.length > 0 ? failures.join("; ") : "no working Python interpreter found";
  return {
    available: false,
    reason: `Python environment at ${target} is damaged or unusable: ${detail}. Remove it manually to recreate it.`,
  };
}

/** Ensure the shared Python environment exists and is internally consistent. */
export async function ensurePythonEnvironment(options: PythonEnvironmentOptions): Promise<PythonEnvironmentResult> {
  const systemDir = resolve(options.systemDir);
  const target = join(systemDir, VENV_NAME);
  const env = normalizeEnvironment(options.env ?? process.env);
  await mkdir(systemDir, { recursive: true, mode: 0o700 });

  const candidates = await findPythonInterpreters(options.configuredInterpreter, env);
  if (candidates.interpreters.length === 0) {
    const detail = candidates.failures.length > 0
      ? candidates.failures.join("; ")
      : "no executable python3 or python found on PATH";
    return { available: false, reason: `Unable to initialize Python environment: ${detail}` };
  }

  // Windows creates at the final path: pip.exe embeds an absolute interpreter
  // path and cannot be repaired by moving the directory and rewriting text files.
  // All Windows readers acquire the lock before inspecting that directory.
  if (process.platform !== "win32" && existsSync(target)) {
    return validateExistingEnvironment(target, candidates.interpreters, candidates.failures);
  }

  const lockPath = join(systemDir, `${VENV_NAME}.lock`);
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await acquireLock(lockPath, options.lockWaitMs ?? LOCK_WAIT_MS);
    if (existsSync(target)) {
      return validateExistingEnvironment(target, candidates.interpreters, candidates.failures);
    }

    const failures = [...candidates.failures];
    for (const interpreter of candidates.interpreters) {
      const temporary = process.platform === "win32" ? target : join(systemDir, `.${VENV_NAME}.tmp-${process.pid}-${randomUUID()}`);
      let created = false;
      try {
        await mkdir(temporary, { mode: 0o700 });
        created = true;
        await runFile(interpreter, ["-I", "-X", "utf8", "-m", "venv", temporary], { env, timeout: 180_000 });
        await probeEnvironment(temporary, interpreter);
        if (process.platform !== "win32") {
          await rewriteRelocatedEnvironment(temporary, target);
          try {
            await rename(temporary, target);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
            await rm(temporary, { recursive: true, force: true });
          }
        }
        return validateExistingEnvironment(target, candidates.interpreters, failures);
      } catch (error) {
        if (created) await rm(temporary, { recursive: true, force: true });
        failures.push(`${interpreter}: ${(error as Error).message}`);
      }
    }
    throw new Error(failures.join("; "));
  } catch (error) {
    return { available: false, reason: `Unable to initialize Python environment: ${(error as Error).message}` };
  } finally {
    await releaseLock?.();
  }
}
