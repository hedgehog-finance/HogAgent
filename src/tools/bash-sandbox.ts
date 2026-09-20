import { execFile } from "node:child_process";
import { constants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isPathInside } from "../utils/path-safety.ts";
import type { SandboxMode } from "../config.ts";
import {
  ensurePythonEnvironment,
  type PythonEnvironment,
  type PythonEnvironmentResult,
} from "./python-environment.ts";
import {
  applyRuntimeGrantEnvironment,
  createDefaultRuntimeGrant,
  type RuntimeGrant,
} from "./runtime-grants.ts";
import { getShellArguments, getShellCandidates } from "./shell-command.ts";
import { normalizeEnvironment } from "../utils/environment.ts";

export type BashSandboxBackend = "macos-sandbox-exec" | "linux-bubblewrap" | "bare-shell";

export interface BashSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface BashRuntime {
  backend: BashSandboxBackend;
  workspaceDir: string;
  pythonEnvironment?: PythonEnvironment;
  tempDir: string;
  shells: string[];
  /** True when an operator explicitly disabled file isolation in hogagent.json. */
  unrestrictedByConfiguration?: boolean;
  degradedReason?: string;
  /** True when the host platform has no supported file-sandbox backend. */
  unrestrictedByPlatform?: boolean;
  buildSpawn(shell: string, command: string): BashSpawnSpec;
}

export type BashRuntimeResult =
  | { available: true; runtime: BashRuntime }
  | { available: false; reason: string };

export interface BashRuntimeOptions {
  workspaceDir: string;
  projectRoot: string;
  systemDir: string;
  configuredPython?: string;
  /** Defaults to disabled. Fallback tries isolation before selecting a direct shell. */
  sandboxMode?: SandboxMode;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

interface MountEntry {
  path: string;
  directory: boolean;
}

interface LinuxMountEntry {
  source: string;
  target: string;
}

function runProbe(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: 15_000,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (!error) {
        resolvePromise();
        return;
      }
      const detail = String(stderr || stdout || error.message).trim();
      reject(new Error(detail || error.message));
    });
  });
}

async function preparePythonEnvironment(options: {
  systemDir: string;
  configuredInterpreter?: string;
  env: NodeJS.ProcessEnv;
}): Promise<PythonEnvironmentResult> {
  try {
    return await ensurePythonEnvironment(options);
  } catch (error) {
    return {
      available: false,
      reason: `Unable to initialize Python environment: ${(error as Error).message}`,
    };
  }
}

async function probePreparedRuntime(runtime: BashRuntime): Promise<void> {
  const shell = runtime.shells[0];
  if (!shell) throw new Error("no prepared shell is available");
  const spawn = runtime.buildSpawn(shell, "python -I -S -c 'import sys'");
  await runProbe(spawn.command, spawn.args, { cwd: spawn.cwd, env: spawn.env });
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (isAbsolute(name)) return await isExecutable(name) ? realpathSync(name) : null;
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (await isExecutable(candidate)) return realpathSync(candidate);
  }
  return null;
}

function windowsEnvironmentValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function shellLookupNames(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32") return [`/bin/${command}`, command];
  const systemRoot = windowsEnvironmentValue(env, "SystemRoot", "SYSTEMROOT", "windir", "WINDIR");
  if (command === "bash") {
    const programFiles = windowsEnvironmentValue(env, "ProgramFiles", "PROGRAMFILES");
    const programFilesX86 = windowsEnvironmentValue(env, "ProgramFiles(x86)", "PROGRAMFILES(X86)");
    const localAppData = windowsEnvironmentValue(env, "LOCALAPPDATA", "LocalAppData");
    return [
      ...(programFiles ? [join(programFiles, "Git", "bin", "bash.exe")] : []),
      ...(programFilesX86 ? [join(programFilesX86, "Git", "bin", "bash.exe")] : []),
      ...(localAppData ? [join(localAppData, "Programs", "Git", "bin", "bash.exe")] : []),
      "bash.exe",
      "bash",
    ];
  }
  if (command === "powershell.exe") {
    return [
      ...(systemRoot ? [join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")] : []),
      command,
    ];
  }
  return [command];
}

function isGitForWindowsBash(shell: string): boolean {
  const shellDir = dirname(shell);
  return [
    join(shellDir, "git.exe"),
    join(shellDir, "..", "cmd", "git.exe"),
    join(shellDir, "..", "..", "cmd", "git.exe"),
  ].some((candidate) => existsSync(candidate));
}

async function findShells(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string[]> {
  const shells: string[] = [];
  const seen = new Set<string>();
  for (const candidate of getShellCandidates(platform)) {
    for (const name of shellLookupNames(candidate.command, env, platform)) {
      const shell = await findExecutable(name, env);
      if (!shell) continue;
      if (platform === "win32" && candidate.command === "bash" && !isGitForWindowsBash(shell)) continue;
      const key = platform === "win32" ? shell.toLowerCase() : shell;
      if (!seen.has(key)) {
        seen.add(key);
        shells.push(shell);
      }
      break;
    }
  }
  return shells;
}

function createBareShellRuntime(
  workspaceDir: string,
  projectRoot: string,
  tempDir: string,
  shells: string[],
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  options: {
    reason?: string;
    pythonEnvironment?: PythonEnvironment;
    unrestrictedByConfiguration?: boolean;
    unrestrictedByPlatform?: boolean;
  },
): BashRuntime {
  const grant = createDefaultRuntimeGrant({
    platform,
    workspaceDir,
    projectRoot,
    tempDir,
    shells,
    baseEnvironment: baseEnv,
    pythonEnvironment: options.pythonEnvironment,
  });
  const env = applyRuntimeGrantEnvironment(baseEnv, grant, platform);
  return {
    backend: "bare-shell",
    workspaceDir,
    pythonEnvironment: options.pythonEnvironment,
    tempDir,
    shells,
    unrestrictedByConfiguration: options.unrestrictedByConfiguration,
    unrestrictedByPlatform: options.unrestrictedByPlatform,
    degradedReason: options.reason,
    buildSpawn(shell, command) {
      return {
        command: shell,
        args: getShellArguments(shell, command, platform),
        cwd: workspaceDir,
        env,
      };
    },
  };
}

function existingMounts(paths: string[], includeSymlinkLiterals = false): MountEntry[] {
  const seen = new Set<string>();
  const result: MountEntry[] = [];
  for (const input of paths) {
    const filePath = resolve(input);
    if (seen.has(filePath) || !existsSync(filePath)) continue;
    seen.add(filePath);
    const fileStat = lstatSync(filePath);
    if (fileStat.isSymbolicLink()) {
      if (includeSymlinkLiterals) result.push({ path: filePath, directory: false });
      continue;
    }
    result.push({ path: filePath, directory: fileStat.isDirectory() });
  }
  return result;
}

function canonicalMounts(paths: string[]): MountEntry[] {
  const seen = new Set<string>();
  const result: MountEntry[] = [];
  for (const input of paths) {
    const lexicalPath = resolve(input);
    if (!existsSync(lexicalPath)) continue;
    const filePath = realpathSync(lexicalPath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    result.push({ path: filePath, directory: statSync(filePath).isDirectory() });
  }
  return result;
}

function canonicalPath(filePath: string): string {
  let current = resolve(filePath);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...missing);
}

function validateSkillsConfig(systemDir: string): { path?: string; error?: string } {
  // Managed and standalone Skills share this one read-only credential file.
  const configPath = join(systemDir, "skills_config.json");
  if (!existsSync(configPath)) return {};
  const configStat = lstatSync(configPath);
  if (configStat.isSymbolicLink() || !configStat.isFile() || configStat.nlink !== 1) {
    return { error: "skills_config.json must be a regular file with no symbolic or hard links" };
  }
  const canonicalConfig = realpathSync(configPath);
  if (!isPathInside(canonicalPath(systemDir), canonicalConfig)) {
    return { error: "skills_config.json resolves outside the HogAgent config directory" };
  }
  return { path: configPath };
}

function linuxMounts(paths: string[]): LinuxMountEntry[] {
  const seenTargets = new Set<string>();
  const result: LinuxMountEntry[] = [];
  for (const input of paths) {
    const target = resolve(input);
    if (seenTargets.has(target) || !existsSync(target)) continue;
    seenTargets.add(target);
    result.push({ source: realpathSync(target), target });
  }
  return result;
}

function uniqueMounts(mounts: MountEntry[]): MountEntry[] {
  const seen = new Set<string>();
  return mounts.filter((mount) => {
    if (seen.has(mount.path)) return false;
    seen.add(mount.path);
    return true;
  });
}

function schemeString(value: string): string {
  return JSON.stringify(value);
}

function macDenyOutsideRule(operation: "file-read*" | "file-write*", mounts: MountEntry[]): string[] {
  if (mounts.length === 0) return [`(deny ${operation})`];
  const filters = mounts.map((mount) => `(${mount.directory ? "subpath" : "literal"} ${schemeString(mount.path)})`);
  return [
    `(deny ${operation}`,
    "  (require-not (require-any",
    ...filters.map((filter) => `    ${filter}`),
    "  )))",
  ];
}

function createMacRuntime(
  sandboxExec: string,
  workspaceDir: string,
  python: PythonEnvironment,
  tempDir: string,
  shells: string[],
  env: NodeJS.ProcessEnv,
  grant: RuntimeGrant,
): BashRuntime {
  const readPaths = grant.readOnlyPaths;
  // Keep both lexical and canonical forms. macOS resolves /var and /etc through
  // symlinks, and sandbox path checks may observe either form during traversal.
  // Read grants retain a literal rule for a final symlink plus a rule for its
  // already-validated canonical target. This is required for macOS resolver
  // aliases such as /etc/resolv.conf -> /private/var/run/resolv.conf. Writable
  // grants continue to reject symlinks.
  const readMounts = uniqueMounts([
    ...existingMounts(readPaths, true),
    ...canonicalMounts(readPaths),
  ]);
  // sandbox-exec needs metadata access to ancestor directories in order to
  // resolve an allowed path and getcwd(). Literal rules expose only those
  // directory entries, not sibling file contents.
  const ancestorMounts: MountEntry[] = [];
  const seenAncestors = new Set(readMounts.map((mount) => mount.path));
  for (const mount of readMounts) {
    for (const parent of pathParents(mount.path)) {
      if (seenAncestors.has(parent)) continue;
      seenAncestors.add(parent);
      ancestorMounts.push({ path: parent, directory: false });
    }
  }
  // tempDir was validated as a real directory inside workspaceDir before the
  // grant was composed, so canonicalizing both cannot widen the write roots.
  const writePaths = [...grant.writablePaths, "/dev/null", "/dev/tty"];
  const writeMounts = uniqueMounts([...existingMounts(writePaths), ...canonicalMounts(writePaths)]);
  const profile = [
    "(version 1)",
    "(allow default)",
    // Runtime isolation is intentionally file-system-only. Skills must retain
    // host DNS and outbound API access while their file reads/writes stay scoped.
    "(allow network*)",
    ...macDenyOutsideRule("file-read*", [{ path: "/", directory: false }, ...readMounts, ...ancestorMounts]),
    ...macDenyOutsideRule("file-write*", writeMounts),
  ].join("\n");

  return {
    backend: "macos-sandbox-exec",
    workspaceDir,
    pythonEnvironment: python,
    tempDir,
    shells,
    buildSpawn(shell, command) {
      return {
        command: sandboxExec,
        args: ["-p", profile, shell, "-c", command],
        cwd: workspaceDir,
        env,
      };
    },
  };
}

function pathParents(filePath: string): string[] {
  const parents: string[] = [];
  const root = parse(filePath).root;
  let current = dirname(filePath);
  while (current && current !== root) {
    parents.push(current);
    current = dirname(current);
  }
  return parents.reverse();
}

function createLinuxRuntime(
  bwrap: string,
  workspaceDir: string,
  python: PythonEnvironment,
  tempDir: string,
  shells: string[],
  env: NodeJS.ProcessEnv,
  grant: RuntimeGrant,
): BashRuntime {
  const writableMounts = linuxMounts(grant.writablePaths);
  const readMounts = linuxMounts(grant.readOnlyPaths)
    .filter((mount) => !writableMounts.some((writable) => isPathInside(writable.target, mount.target)));

  const mountTargets = [...readMounts, ...writableMounts].map((mount) => mount.target);
  const directories = [...new Set(mountTargets.flatMap(pathParents))]
    .sort((left, right) => left.length - right.length);
  const baseArgs = ["--die-with-parent", "--new-session", "--unshare-all", "--share-net"];
  for (const directory of directories) baseArgs.push("--dir", directory);
  for (const mount of readMounts) baseArgs.push("--ro-bind", mount.source, mount.target);
  for (const mount of writableMounts) baseArgs.push("--bind", mount.source, mount.target);
  baseArgs.push("--proc", "/proc", "--dev", "/dev", "--chdir", workspaceDir);

  return {
    backend: "linux-bubblewrap",
    workspaceDir,
    pythonEnvironment: python,
    tempDir,
    shells,
    buildSpawn(shell, command) {
      return {
        command: bwrap,
        args: [...baseArgs, "--", shell, "-c", command],
        cwd: workspaceDir,
        env,
      };
    },
  };
}

/** Prepare Bash according to the strict, fallback, or direct-shell sandbox policy. */
export async function prepareBashRuntime(options: BashRuntimeOptions): Promise<BashRuntimeResult> {
  const platform = options.platform ?? process.platform;
  const sandboxMode = options.sandboxMode ?? "disabled";
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return { available: false, reason: `Bash disabled: unsupported sandbox platform ${platform}` };
  }

  const workspaceDir = resolve(options.workspaceDir);
  const projectRoot = resolve(options.projectRoot);
  const systemDir = resolve(options.systemDir);
  const baseEnv = normalizeEnvironment(options.env ?? process.env, platform);

  const shells = await findShells(baseEnv, platform);
  if (shells.length === 0) {
    const expected = getShellCandidates(platform).map((candidate) => candidate.command).join(", ");
    return { available: false, reason: `Bash disabled: no supported command shell is available (${expected})` };
  }

  const tempDir = join(workspaceDir, ".hogagent", "bash-tmp");
  try {
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    const tempStat = lstatSync(tempDir);
    if (tempStat.isSymbolicLink() || !tempStat.isDirectory()
      || !isPathInside(canonicalPath(workspaceDir), realpathSync(tempDir))) {
      return { available: false, reason: "Bash disabled: the Bash temp directory escapes the workspace or is a symbolic link" };
    }
  } catch (error) {
    return { available: false, reason: `Bash disabled: unable to create a safe workspace temp directory: ${(error as Error).message}` };
  }

  if (platform === "win32") {
    const pythonResult = await preparePythonEnvironment({
      systemDir,
      configuredInterpreter: options.configuredPython,
      env: baseEnv,
    });
    const platformReason = "Windows does not support the HogAgent file sandbox; sandboxMode is ignored";
    return {
      available: true,
      runtime: createBareShellRuntime(workspaceDir, projectRoot, tempDir, shells, baseEnv, platform, {
        unrestrictedByPlatform: true,
        reason: pythonResult.available ? platformReason : `${platformReason}; ${pythonResult.reason}`,
        ...(pythonResult.available ? { pythonEnvironment: pythonResult.environment } : {}),
      }),
    };
  }

  if (sandboxMode === "disabled") {
    const pythonResult = await preparePythonEnvironment({
      systemDir,
      configuredInterpreter: options.configuredPython,
      env: baseEnv,
    });
    return {
      available: true,
      runtime: createBareShellRuntime(workspaceDir, projectRoot, tempDir, shells, baseEnv, platform, {
        unrestrictedByConfiguration: true,
        ...(pythonResult.available
          ? { pythonEnvironment: pythonResult.environment }
          : { reason: pythonResult.reason }),
      }),
    };
  }

  const fallbackAfterSandboxFailure = async (
    detail: string,
    preparedPython?: PythonEnvironment,
  ): Promise<BashRuntimeResult> => {
    if (sandboxMode === "enabled") {
      return { available: false, reason: `Bash disabled: ${detail}` };
    }
    const pythonResult: PythonEnvironmentResult = preparedPython
      ? { available: true, environment: preparedPython }
      : await preparePythonEnvironment({
        systemDir,
        configuredInterpreter: options.configuredPython,
        env: baseEnv,
      });
    const reason = pythonResult.available
      ? `Sandbox initialization failed: ${detail}`
      : `Sandbox initialization failed: ${detail}; ${pythonResult.reason}`;
    return {
      available: true,
      runtime: createBareShellRuntime(workspaceDir, projectRoot, tempDir, shells, baseEnv, platform, {
        reason,
        ...(pythonResult.available ? { pythonEnvironment: pythonResult.environment } : {}),
      }),
    };
  };

  const canonicalWorkspaceDir = canonicalPath(workspaceDir);
  const canonicalProjectRoot = canonicalPath(projectRoot);
  const canonicalSystemDir = canonicalPath(systemDir);
  if (isPathInside(workspaceDir, systemDir) || isPathInside(projectRoot, systemDir)
    || isPathInside(canonicalWorkspaceDir, canonicalSystemDir)
    || isPathInside(canonicalPath(projectRoot), canonicalSystemDir)) {
    return fallbackAfterSandboxFailure(
      "the HogAgent config directory is inside a Bash-readable root, so secrets cannot be isolated",
    );
  }
  if (isPathInside(canonicalWorkspaceDir, canonicalProjectRoot)) {
    return fallbackAfterSandboxFailure("the writable workspace contains the HogAgent installation root");
  }

  let skillsConfig: string | undefined;
  try {
    const config = validateSkillsConfig(systemDir);
    if (config.error) return fallbackAfterSandboxFailure(config.error);
    skillsConfig = config.path;
  } catch (error) {
    return fallbackAfterSandboxFailure(`unable to validate skills_config.json: ${(error as Error).message}`);
  }

  let sandboxCommand: string;
  if (platform === "darwin") {
    sandboxCommand = "/usr/bin/sandbox-exec";
    if (!await isExecutable(sandboxCommand)) {
      return fallbackAfterSandboxFailure("/usr/bin/sandbox-exec is unavailable");
    }
    try {
      await runProbe(sandboxCommand, ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
    } catch (error) {
      return fallbackAfterSandboxFailure(`sandbox-exec probe failed: ${(error as Error).message}`);
    }
  } else {
    const bwrap = await findExecutable("bwrap", baseEnv);
    if (!bwrap) return fallbackAfterSandboxFailure("Bubblewrap (bwrap) is unavailable");
    try {
      await runProbe(bwrap, ["--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--", "/bin/true"]);
    } catch (error) {
      return fallbackAfterSandboxFailure(`Bubblewrap probe failed: ${(error as Error).message}`);
    }
    sandboxCommand = bwrap;
  }

  const pythonResult = await preparePythonEnvironment({
    systemDir,
    configuredInterpreter: options.configuredPython,
    env: baseEnv,
  });
  if (!pythonResult.available) {
    if (sandboxMode === "enabled") {
      return { available: false, reason: `Bash disabled: ${pythonResult.reason}` };
    }
    return {
      available: true,
      runtime: createBareShellRuntime(workspaceDir, projectRoot, tempDir, shells, baseEnv, platform, {
        reason: `Sandbox initialization failed: ${pythonResult.reason}`,
      }),
    };
  }

  const immutableRuntimePaths = [
    projectRoot,
    process.execPath,
    ...shells,
    ...pythonResult.environment.readOnlyRuntimeRoots,
  ];
  if (immutableRuntimePaths.some((runtimePath) => isPathInside(canonicalWorkspaceDir, canonicalPath(runtimePath)))) {
    return fallbackAfterSandboxFailure(
      "the writable workspace contains the HogAgent, shell, Node, or base Python runtime",
      pythonResult.environment,
    );
  }

  const grant = createDefaultRuntimeGrant({
    platform,
    workspaceDir,
    projectRoot,
    tempDir,
    shells,
    baseEnvironment: baseEnv,
    pythonEnvironment: pythonResult.environment,
    skillsConfig,
  });
  const conflictingReadPath = grant.readOnlyPaths.find(
    (readPath) => isPathInside(canonicalPath(readPath), canonicalSystemDir),
  );
  if (conflictingReadPath) {
    return fallbackAfterSandboxFailure(
      `the HogAgent config directory overlaps runtime read-only root ${JSON.stringify(conflictingReadPath)}, so secrets cannot be isolated`,
      pythonResult.environment,
    );
  }

  const env = applyRuntimeGrantEnvironment(baseEnv, grant);
  let runtime: BashRuntime;
  try {
    runtime = platform === "darwin"
      ? createMacRuntime(
        sandboxCommand,
        workspaceDir,
        pythonResult.environment,
        tempDir,
        shells,
        env,
        grant,
      )
      : createLinuxRuntime(
        sandboxCommand,
        workspaceDir,
        pythonResult.environment,
        tempDir,
        shells,
        env,
        grant,
      );
    await probePreparedRuntime(runtime);
  } catch (error) {
    return fallbackAfterSandboxFailure(
      `prepared ${platform === "darwin" ? "sandbox-exec" : "Bubblewrap"} runtime probe failed: ${(error as Error).message}`,
      pythonResult.environment,
    );
  }

  return { available: true, runtime };
}
