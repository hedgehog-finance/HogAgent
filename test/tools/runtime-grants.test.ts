import { delimiter, dirname, join, resolve } from "node:path";
import {
  applyRuntimeGrantEnvironment,
  createDefaultRuntimeGrant,
  mergeRuntimeGrants,
  type RuntimeGrant,
} from "../../src/tools/runtime-grants.ts";

describe("RuntimeGrant", () => {
  it("normalizes Windows environment names before filtering and overriding runtime values", () => {
    const base = { Path: "host", PythonHome: "host-python", pythonpath: "host-modules", Conda_Prefix: "conda", HogAgent_Llm_Api_Key: "secret", TEMP: "old" };
    const grant = { readOnlyPaths: [], writablePaths: [], environment: { PATH: "managed", Temp: "new" } };
    expect(applyRuntimeGrantEnvironment(base, grant, "win32")).toEqual({ PATH: "managed", TEMP: "new" });
    expect(applyRuntimeGrantEnvironment({ Path: "host" }, grant, "linux").Path).toBe("host");
  });

  it("merges paths and lets later environment values override earlier grants", () => {
    const first: RuntimeGrant = {
      readOnlyPaths: ["/runtime/a", "/runtime/a"],
      writablePaths: ["/workspace"],
      environment: { SHARED: "first", FIRST: "1" },
    };
    const second: RuntimeGrant = {
      readOnlyPaths: ["/runtime/b"],
      writablePaths: ["/workspace", "/cache"],
      environment: { SHARED: "second", SECOND: "2" },
    };

    expect(mergeRuntimeGrants(first, second)).toEqual({
      readOnlyPaths: [resolve("/runtime/a"), resolve("/runtime/b")],
      writablePaths: [resolve("/workspace"), resolve("/cache")],
      environment: { SHARED: "second", FIRST: "1", SECOND: "2" },
    });
  });

  it("composes Python, browser, system-tool, and writable-state defaults", () => {
    const root = resolve("/private/hogagent-runtime-grant-test");
    const workspaceDir = join(root, "workspace");
    const projectRoot = join(root, "install");
    const tempDir = join(workspaceDir, ".hogagent", "bash-tmp");
    const homeDir = join(root, "home");
    const toolRoot = join(root, "tools", "imagemagick");
    const customChrome = "/Applications/Custom Chromium.app/Contents/MacOS/Custom Chromium";
    const pythonRoot = join(root, "python-venv");
    const pythonBinDir = join(pythonRoot, "bin");
    const baseEnvironment: NodeJS.ProcessEnv = {
      HOME: homeDir,
      PATH: `${join(toolRoot, "bin", "override")}${delimiter}/usr/bin`,
      PUPPETEER_EXECUTABLE_PATH: customChrome,
      PYTHONHOME: "/host/python",
      PYTHONPATH: "/host/modules",
      CONDA_PREFIX: "/host/conda",
      HOGAGENT_LLM_API_KEY: "llm-secret",
      HOGAGENT_SEARCH_API_KEY: "search-secret",
      CIWEIAI_API_KEY: "skill-key",
    };

    const grant = createDefaultRuntimeGrant({
      platform: "darwin",
      workspaceDir,
      projectRoot,
      tempDir,
      shells: ["/bin/bash"],
      baseEnvironment,
      pythonEnvironment: {
        root: pythonRoot,
        binDir: pythonBinDir,
        python: join(pythonBinDir, "python"),
        readOnlyRuntimeRoots: [join(root, "base-python")],
      },
      skillsConfig: join(root, "system", "skills_config.json"),
    });

    expect(grant.readOnlyPaths).toEqual(expect.arrayContaining([
      workspaceDir,
      projectRoot,
      pythonRoot,
      join(root, "base-python"),
      toolRoot,
      join(homeDir, ".cache", "puppeteer"),
      join(homeDir, "Library", "Caches", "ms-playwright"),
      "/Applications/Google Chrome.app",
      "/Applications/Custom Chromium.app",
      "/Applications/LibreOffice.app",
      "/etc/resolv.conf",
      "/etc/ssl",
      "/var/run/resolv.conf",
      "/var/run/mDNSResponder",
      "/private/etc/resolv.conf",
      "/private/etc/ssl",
      "/private/var/run/resolv.conf",
      "/private/var/run/mDNSResponder",
    ]));
    expect(grant.writablePaths).toEqual(expect.arrayContaining([workspaceDir, tempDir, pythonRoot]));
    expect(grant.environment.PATH?.split(delimiter).slice(0, 2)).toEqual([pythonBinDir, dirname(process.execPath)]);
    expect(grant.environment).toMatchObject({
      VIRTUAL_ENV: pythonRoot,
      PLAYWRIGHT_BROWSERS_PATH: join(homeDir, "Library", "Caches", "ms-playwright"),
      PUPPETEER_CACHE_DIR: join(homeDir, ".cache", "puppeteer"),
      MAC_CHROMIUM_TMPDIR: tempDir,
      XDG_CONFIG_HOME: join(tempDir, "config"),
      NPM_CONFIG_CACHE: join(tempDir, "npm-cache"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      PYTHONPYCACHEPREFIX: join(tempDir, "python-cache"),
      MPLCONFIGDIR: join(tempDir, "matplotlib"),
    });

    const applied = applyRuntimeGrantEnvironment(baseEnvironment, grant);
    expect(applied.PYTHONHOME).toBeUndefined();
    expect(applied.PYTHONPATH).toBeUndefined();
    expect(applied.CONDA_PREFIX).toBeUndefined();
    expect(applied.HOGAGENT_LLM_API_KEY).toBeUndefined();
    expect(applied.HOGAGENT_SEARCH_API_KEY).toBeUndefined();
    expect(applied.CIWEIAI_API_KEY).toBe("skill-key");
    expect(applied.VIRTUAL_ENV).toBe(pythonRoot);
  });

  it("uses Linux runtime roots without granting the whole configuration tree", () => {
    const grant = createDefaultRuntimeGrant({
      platform: "linux",
      workspaceDir: "/work",
      projectRoot: "/srv/hogagent",
      tempDir: "/work/.hogagent/bash-tmp",
      shells: ["/bin/sh"],
      baseEnvironment: {
        HOME: "/home/agent",
        PATH: "/opt/media-tools/bin:/usr/bin",
      },
    });

    expect(grant.readOnlyPaths).toEqual(expect.arrayContaining([
      "/opt/media-tools",
      "/opt/google/chrome",
      "/opt/libreoffice",
      "/etc/ImageMagick-7",
      "/etc/ssl",
    ]));
    expect(grant.readOnlyPaths).not.toContain("/home/agent");
    expect(grant.readOnlyPaths).not.toContain("/etc");
    expect(grant.environment.MAC_CHROMIUM_TMPDIR).toBeUndefined();
  });

  it("does not promote a home bin directory into a whole-home grant", () => {
    const grant = createDefaultRuntimeGrant({
      platform: "darwin",
      workspaceDir: "/work",
      projectRoot: "/srv/hogagent",
      tempDir: "/work/.hogagent/bash-tmp",
      shells: ["/bin/sh"],
      baseEnvironment: {
        HOME: "/Users/agent",
        PATH: "/Users/agent/bin/override:/usr/bin",
      },
    });

    expect(grant.readOnlyPaths).toContain("/Users/agent/bin/override");
    expect(grant.readOnlyPaths).not.toContain("/Users/agent");
  });

  it("does not promote arbitrary home projects but keeps known user toolchains usable", () => {
    const grant = createDefaultRuntimeGrant({
      platform: "darwin",
      workspaceDir: "/work",
      projectRoot: "/srv/hogagent",
      tempDir: "/work/.hogagent/bash-tmp",
      shells: ["/bin/sh"],
      baseEnvironment: {
        HOME: "/Users/agent",
        PATH: [
          "/Users/agent/private-project/bin/override",
          "/Users/agent/.nvm/versions/node/v24/bin",
          "/usr/bin",
        ].join(delimiter),
      },
    });

    expect(grant.readOnlyPaths).toContain("/Users/agent/private-project/bin/override");
    expect(grant.readOnlyPaths).not.toContain("/Users/agent/private-project");
    expect(grant.readOnlyPaths).toContain("/Users/agent/.nvm/versions/node/v24");
  });
});
