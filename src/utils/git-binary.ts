/**
 * Git executable resolution utilities.
 *
 * GUI environments launched by Electron or launchd often inherit a minimal PATH,
 * usually only /usr/bin:/bin:/usr/sbin:/sbin, so execFileSync("git") can throw
 * spawnSync git ENOENT.
 *
 * This module probes common installation paths before current PATH directories,
 * caches the absolute git path, and builds an environment with a complete PATH
 * for git subprocesses.
 */

import { constants, accessSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir, platform } from "node:os";

let cachedGitPath: string | null = null;

/**
 * Clears the cached git path.
 * Callers use this after a subprocess reports ENOENT, such as when git is
 * uninstalled during a long-running process, so the next lookup probes again.
 */
export function clearGitBinaryCache(): void {
  cachedGitPath = null;
}

/** Common git installation paths ordered from highest to lowest priority. */
function candidatePaths(): string[] {
  const home = homedir();
  const os = platform();
  if (os === "win32") {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
    return [
      join(pf, "Git", "cmd", "git.exe"),
      join(pf86, "Git", "cmd", "git.exe"),
      join(local, "Programs", "Git", "cmd", "git.exe"),
      join(home, "scoop", "shims", "git.exe"),
    ];
  }
  if (os === "darwin") {
    return [
      "/opt/homebrew/bin/git",
      "/usr/local/bin/git",
      "/usr/bin/git",
      "/opt/local/bin/git",
      join(home, ".local", "bin", "git"),
    ];
  }
  return [
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/snap/bin/git",
    "/opt/local/bin/git",
    join(home, ".local", "bin", "git"),
  ];
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves and caches the absolute path to the git executable.
 * Throws an actionable error when git is unavailable instead of exposing a raw ENOENT message.
 */
export function resolveGitBinary(): string {
  if (cachedGitPath) return cachedGitPath;

  // 1. Probe common installation paths.
  for (const p of candidatePaths()) {
    if (isExecutable(p)) {
      cachedGitPath = p;
      return p;
    }
  }

  // 2. Probe each current PATH directory, including git.exe and git.cmd shims on Windows.
  const names = platform() === "win32" ? ["git.exe", "git.cmd"] : ["git"];
  const pathDirs = (process.env["PATH"] || "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of names) {
      const p = join(dir, name);
      if (isExecutable(p)) {
        cachedGitPath = p;
        return p;
      }
    }
  }

  throw new Error(
    "未找到 git 可执行文件，无法执行 Git 安装。请先安装 git（macOS: xcode-select --install）后重试。",
  );
}

/**
 * Builds the git subprocess environment by inheriting the current environment
 * and prepending the git directory plus common system directories to PATH.
 * This keeps dependencies such as ssh and askpass available in minimal environments.
 */
export function getGitEnv(): NodeJS.ProcessEnv {
  const gitDir = dirname(resolveGitBinary());
  const extraDirs = platform() === "win32"
    ? []
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/opt/homebrew/bin"];
  // Windows environment keys are case-insensitive and may use Path or path, so replace the original key instead of adding PATH.
  // This avoids multiple PATH variants in the subprocess environment with an indeterminate effective value.
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const current = env[pathKey] || "";
  const merged = [gitDir, ...extraDirs, ...current.split(delimiter).filter(Boolean)];
  env[pathKey] = [...new Set(merged)].join(delimiter);
  return env;
}
