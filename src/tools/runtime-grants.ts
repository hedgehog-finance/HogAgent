import { gatewayProjectsDirectory } from "../gateway-project.ts";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { PythonEnvironment } from "./python-environment.ts";
import { normalizeEnvironment } from "../utils/environment.ts";

/** A composable file and environment capability; writable paths override read-only overlap. */
export interface RuntimeGrant {
  readOnlyPaths: string[];
  writablePaths: string[];
  environment: Record<string, string>;
}

export interface DefaultRuntimeGrantOptions {
  platform: NodeJS.Platform;
  workspaceDir: string;
  projectRoot: string;
  tempDir: string;
  shells: string[];
  baseEnvironment: NodeJS.ProcessEnv;
  pythonEnvironment?: PythonEnvironment;
  skillsConfig?: string;
}

const CLEARED_RUNTIME_ENVIRONMENT = new Set([
  "PYTHONHOME",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "PIP_REQUIRE_VIRTUALENV",
  "PYTHONNOUSERSITE",
  "_CE_CONDA",
  "_CE_M",
]);

const HOGAGENT_SECRET_ENVIRONMENT = /^HOGAGENT_.*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/;

const MAC_SYSTEM_RUNTIME_PATHS = [
  "/System",
  "/Library",
  "/usr/bin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/sbin",
  "/usr/share",
  "/bin",
  "/sbin",
  "/dev",
  "/opt/homebrew",
  "/opt/local",
  "/usr/local",
  // Keep public aliases alongside canonical /private targets. macOS sandbox
  // checks may observe the lexical path used by curl or c-ares before symlink
  // resolution.
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/nsswitch.conf",
  "/etc/protocols",
  "/etc/services",
  "/etc/ssl",
  "/etc/localtime",
  "/etc/paths",
  "/etc/paths.d",
  "/etc/resolver",
  "/var/db/timezone",
  "/var/db/dyld",
  "/var/run/resolv.conf",
  "/var/run/mDNSResponder",
  "/private/etc/hosts",
  "/private/etc/resolv.conf",
  "/private/etc/nsswitch.conf",
  "/private/etc/protocols",
  "/private/etc/services",
  "/private/etc/ssl",
  "/private/etc/localtime",
  "/private/etc/paths",
  "/private/etc/paths.d",
  "/private/etc/resolver",
  "/private/var/db/timezone",
  "/private/var/db/dyld",
  "/private/var/run/resolv.conf",
  "/private/var/run/mDNSResponder",
  "/Applications/LibreOffice.app",
  "/Applications/Keynote.app",
  "/Applications/Keynote Creator Studio.app",
  "/Applications/Microsoft PowerPoint.app",
];

const LINUX_SYSTEM_RUNTIME_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/usr/local",
  "/nix/store",
  "/snap",
  "/etc/ssl",
  "/etc/pki",
  "/etc/ca-certificates",
  "/etc/fonts",
  "/etc/alternatives",
  "/etc/ghostscript",
  "/etc/ImageMagick-6",
  "/etc/ImageMagick-7",
  "/etc/libreoffice",
  "/etc/xml",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/nsswitch.conf",
  "/etc/gai.conf",
  "/etc/ld.so.cache",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/mime.types",
  "/etc/magic",
  "/etc/magic.mime",
  "/etc/passwd",
  "/etc/group",
  "/run/systemd/resolve",
  "/run/current-system/sw",
  "/opt/libreoffice",
];

const MAC_BROWSER_RUNTIME_PATHS = [
  "/Applications/Google Chrome.app",
  "/Applications/Google Chrome Canary.app",
  "/Applications/Chromium.app",
  "/Applications/Microsoft Edge.app",
  "/Applications/Microsoft Edge Beta.app",
  "/Applications/Microsoft Edge Dev.app",
  "/Applications/Brave Browser.app",
  "/Applications/Firefox.app",
];

const LINUX_BROWSER_RUNTIME_PATHS = [
  "/opt/google/chrome",
  "/opt/microsoft/msedge",
  "/opt/brave.com",
  "/usr/lib/chromium",
  "/usr/lib/chromium-browser",
  "/usr/lib/firefox",
  "/snap/chromium",
];

const HOME_TOOL_PREFIXES = [
  ".asdf",
  ".bun",
  ".cargo",
  ".local",
  ".npm",
  ".nvm",
  ".pnpm",
  ".pyenv",
  ".volta",
  join("Library", "pnpm"),
];

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map((filePath) => resolve(filePath)))];
}

function absoluteEnvironmentPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value || value === "0" || !isAbsolute(value)) return undefined;
  return resolve(value);
}

function runtimeRootForPathEntry(entry: string, homeDir: string): string {
  const normalized = resolve(entry);
  const root = parse(normalized).root;
  const normalizedHome = resolve(homeDir);
  let current = normalized;
  while (current !== root) {
    if (["bin", "sbin"].includes(basename(current))) {
      const prefix = dirname(current);
      const homeRelative = relative(normalizedHome, prefix);
      const prefixIsInHome = homeRelative !== ""
        && !homeRelative.startsWith(`..${sep}`)
        && homeRelative !== ".."
        && !isAbsolute(homeRelative);
      const isKnownHomeToolPrefix = HOME_TOOL_PREFIXES.some(
        (allowed) => homeRelative === allowed || homeRelative.startsWith(`${allowed}${sep}`),
      );
      // Never widen a user-controlled PATH entry to all of HOME or an arbitrary
      // home project. Known per-user package-manager roots still carry sibling
      // libraries needed by their executables.
      return prefix !== root && resolve(prefix) !== normalizedHome
        && (!prefixIsInHome || isKnownHomeToolPrefix)
        ? prefix
        : normalized;
    }
    current = dirname(current);
  }
  return normalized;
}

function inheritedToolRoots(env: NodeJS.ProcessEnv): string[] {
  const homeDir = absoluteEnvironmentPath(env, "HOME") ?? homedir();
  return (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && isAbsolute(entry))
    .map((entry) => runtimeRootForPathEntry(entry, homeDir));
}

function customBrowserRuntimeRoots(env: NodeJS.ProcessEnv): string[] {
  const paths = ["PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH", "GOOGLE_CHROME_BIN"]
    .map((name) => absoluteEnvironmentPath(env, name))
    .filter((value): value is string => value !== undefined);
  return paths.map((filePath) => {
    const appMarker = filePath.indexOf(".app/");
    return appMarker >= 0 ? filePath.slice(0, appMarker + 4) : dirname(filePath);
  });
}

function createCoreRuntimeGrant(options: DefaultRuntimeGrantOptions): RuntimeGrant {
  const nodeDir = dirname(process.execPath);
  const homeDir = absoluteEnvironmentPath(options.baseEnvironment, "HOME") ?? homedir();
  const nodeRuntimeRoot = runtimeRootForPathEntry(nodeDir, homeDir);
  const tempDir = options.tempDir;
  const nullDevice = options.platform === "win32" ? "NUL" : "/dev/null";
  return {
    readOnlyPaths: [
      options.workspaceDir,
      options.projectRoot,
      process.execPath,
      nodeDir,
      nodeRuntimeRoot,
      ...options.shells,
      ...(options.skillsConfig ? [options.skillsConfig] : []),
    ],
    writablePaths: [options.workspaceDir, tempDir, ],
    environment: {
      PATH: [nodeDir, options.baseEnvironment.PATH ?? ""].filter(Boolean).join(delimiter),
      TMPDIR: tempDir,
      TEMP: tempDir,
      TMP: tempDir,
      XDG_CACHE_HOME: join(tempDir, "cache"),
      XDG_CONFIG_HOME: join(tempDir, "config"),
      XDG_DATA_HOME: join(tempDir, "data"),
      XDG_STATE_HOME: join(tempDir, "state"),
      XDG_RUNTIME_DIR: join(tempDir, "runtime"),
      NPM_CONFIG_CACHE: join(tempDir, "npm-cache"),
      COREPACK_HOME: join(tempDir, "corepack"),
      YARN_CACHE_FOLDER: join(tempDir, "yarn-cache"),
      MAGICK_TEMPORARY_PATH: tempDir,
      SQLITE_TMPDIR: tempDir,
      GNUPGHOME: join(tempDir, "gnupg"),
      GIT_CONFIG_GLOBAL: nullDevice,
      LESSHISTFILE: nullDevice,
      HISTFILE: nullDevice,
    },
  };
}

function createPythonRuntimeGrant(options: DefaultRuntimeGrantOptions): RuntimeGrant {
  const python = options.pythonEnvironment;
  if (!python) return { readOnlyPaths: [], writablePaths: [], environment: {} };
  const tempDir = options.tempDir;
  const nodeDir = dirname(process.execPath);
  return {
    readOnlyPaths: [python.root, ...python.readOnlyRuntimeRoots],
    writablePaths: [python.root],
    environment: {
      PATH: [python.binDir, nodeDir, options.baseEnvironment.PATH ?? ""].filter(Boolean).join(delimiter),
      VIRTUAL_ENV: python.root,
      PIP_REQUIRE_VIRTUALENV: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONPYCACHEPREFIX: join(tempDir, "python-cache"),
      PIP_CACHE_DIR: join(tempDir, "pip-cache"),
      UV_CACHE_DIR: join(tempDir, "uv-cache"),
      MPLCONFIGDIR: join(tempDir, "matplotlib"),
      NUMBA_CACHE_DIR: join(tempDir, "numba-cache"),
      IPYTHONDIR: join(tempDir, "ipython"),
      JUPYTER_CONFIG_DIR: join(tempDir, "jupyter"),
    },
  };
}

function createBrowserRuntimeGrant(options: DefaultRuntimeGrantOptions): RuntimeGrant {
  const env = options.baseEnvironment;
  const homeDir = absoluteEnvironmentPath(env, "HOME") ?? homedir();
  const xdgCacheDir = absoluteEnvironmentPath(env, "XDG_CACHE_HOME") ?? join(homeDir, ".cache");
  const windowsCacheDir = absoluteEnvironmentPath(env, "LOCALAPPDATA") ?? homeDir;
  const playwright = absoluteEnvironmentPath(env, "PLAYWRIGHT_BROWSERS_PATH")
    ?? (options.platform === "darwin"
      ? join(homeDir, "Library", "Caches", "ms-playwright")
      : options.platform === "win32"
        ? join(windowsCacheDir, "ms-playwright")
        : join(xdgCacheDir, "ms-playwright"));
  const puppeteer = absoluteEnvironmentPath(env, "PUPPETEER_CACHE_DIR")
    ?? join(homeDir, ".cache", "puppeteer");
  const platformPaths = options.platform === "darwin"
    ? MAC_BROWSER_RUNTIME_PATHS
    : options.platform === "linux"
      ? LINUX_BROWSER_RUNTIME_PATHS
      : [];
  return {
    readOnlyPaths: [playwright, puppeteer, ...platformPaths, ...customBrowserRuntimeRoots(env)],
    writablePaths: [options.tempDir],
    environment: {
      PLAYWRIGHT_BROWSERS_PATH: playwright,
      PUPPETEER_CACHE_DIR: puppeteer,
      ...(options.platform === "darwin" ? { MAC_CHROMIUM_TMPDIR: options.tempDir } : {}),
    },
  };
}

function createSystemRuntimeGrant(options: DefaultRuntimeGrantOptions): RuntimeGrant {
  const platformPaths = options.platform === "darwin"
    ? MAC_SYSTEM_RUNTIME_PATHS
    : options.platform === "linux"
      ? LINUX_SYSTEM_RUNTIME_PATHS
      : [];
  return {
    readOnlyPaths: [...platformPaths, ...inheritedToolRoots(options.baseEnvironment)],
    writablePaths: [options.tempDir],
    environment: {},
  };
}

/** Merge grants deterministically; later environment values override earlier ones. */
export function mergeRuntimeGrants(...grants: RuntimeGrant[]): RuntimeGrant {
  return {
    readOnlyPaths: uniquePaths(grants.flatMap((grant) => grant.readOnlyPaths)),
    writablePaths: uniquePaths(grants.flatMap((grant) => grant.writablePaths)),
    environment: Object.assign({}, ...grants.map((grant) => grant.environment)) as Record<string, string>,
  };
}

/** Build the default capability set shared by macOS sandbox-exec and Linux Bubblewrap. */
export function createDefaultRuntimeGrant(options: DefaultRuntimeGrantOptions): RuntimeGrant {
  options = { ...options, baseEnvironment: normalizeEnvironment(options.baseEnvironment, options.platform) };
  return mergeRuntimeGrants(
    createCoreRuntimeGrant(options),
    createSystemRuntimeGrant(options),
    createPythonRuntimeGrant(options),
    createBrowserRuntimeGrant(options),
  );
}

/** Apply a grant without inheriting host Python/Conda activation into the child. */
export function applyRuntimeGrantEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  grant: RuntimeGrant,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = normalizeEnvironment(baseEnvironment, platform);
  for (const name of Object.keys(environment)) {
    if (CLEARED_RUNTIME_ENVIRONMENT.has(name) || name.startsWith("CONDA_")
      || HOGAGENT_SECRET_ENVIRONMENT.test(name)) {
      delete environment[name];
    }
  }
  return Object.assign(environment, normalizeEnvironment(grant.environment, platform));
}
