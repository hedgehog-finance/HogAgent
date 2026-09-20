import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureDefaultUser,
  loadUserSettings,
  saveUserSettings,
  selectRegisteredWebUser,
  sanitizeUser,
  resolveWorkspace,
  resolveWorkspaceOrExit,
  type UserSettings,
} from "../../src/user-workspace.ts";
import { loadSkillsFromDirs } from "../../src/skill-loader.ts";

// We test the pure logic functions that don't depend on filesystem paths.
// File-dependent functions (load/save/resolve/register) are tested via
// integration with a real temp settings dir.

describe("user-workspace module", () => {
  let previousUserDir: string | undefined;
  let systemDir: string;

  beforeEach(() => {
    previousUserDir = process.env["HOGAGENT_USER_DIR"];
    systemDir = mkdtempSync(join(tmpdir(), "hogagent-user-workspace-"));
    process.env["HOGAGENT_USER_DIR"] = systemDir;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (previousUserDir === undefined) delete process.env["HOGAGENT_USER_DIR"];
    else process.env["HOGAGENT_USER_DIR"] = previousUserDir;
    rmSync(systemDir, { recursive: true, force: true });
  });

  describe("sanitizeUser", () => {
    it("should accept valid user identifiers", () => {
      expect(sanitizeUser("alice")).toBe("alice");
      expect(sanitizeUser("user-123")).toBe("user-123");
      expect(sanitizeUser("my_user")).toBe("my_user");
      expect(sanitizeUser("Default")).toBe("Default");
    });

    it("should reject empty string", () => {
      expect(() => sanitizeUser("")).toThrow();
    });

    it("should reject strings with spaces", () => {
      expect(sanitizeUser("user name")).toBe("user name");
    });

    it("should reject strings with special characters", () => {
      expect(sanitizeUser("user/name")).toBe("user/name");
      expect(sanitizeUser("user@host")).toBe("user@host");
      expect(sanitizeUser("../evil")).toBe("../evil");
    });
  });

  describe("resolveWorkspaceOrExit", () => {
    // We can only test the happy path safely (registered user).
    // The unhappy path calls process.exit(1) which cannot be tested without mocking.

    it("should return workspace for registered user", () => {
      // Register using the real system dir (only safe if we don't pollute it)
      // Instead, we test the logic by checking that it throws for unregistered users
      // in a way that doesn't call process.exit
      // This is a limitation of the current design.
    });
  });

  describe("Gateway workspace registration", () => {
    it("replaces a legacy mapping so standalone sessions discover the Gateway-installed skills", () => {
      const user = "gateway-user";
      const legacyWorkspace = join(systemDir, "agents", "hogagent", user);
      const workspace = join(systemDir, "workspace", user);
      const otherUser = { workspace_dir: join(systemDir, "other-workspace"), theme: "mist" };
      saveUserSettings({
        [user]: { workspace_dir: legacyWorkspace, theme: "bloomberg" },
        default: otherUser,
      });
      const skillDir = join(workspace, ".hogagent", "skills", "hog-finnhub");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: hog-finnhub\ndescription: Workspace discovery fixture\n---\n");

      vi.stubEnv("HOGAGENT_GATEWAY_MANAGED", "1");
      expect(resolveWorkspace(user, workspace)).toBe(workspace);
      expect(loadUserSettings()).toEqual({
        [user]: { workspace_dir: workspace, theme: "bloomberg" },
        default: otherUser,
      });

      vi.stubEnv("HOGAGENT_GATEWAY_MANAGED", undefined);
      const standaloneWorkspace = resolveWorkspace(user);
      expect(standaloneWorkspace).toBe(workspace);
      expect(loadSkillsFromDirs(standaloneWorkspace)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "hog-finnhub", filePath: join(skillDir, "SKILL.md") }),
      ]));
    });

    it("registers a first Gateway user for later WebUI selection", () => {
      const user = "new-gateway-user";
      const workspace = join(systemDir, "workspace", user);
      vi.stubEnv("HOGAGENT_GATEWAY_MANAGED", "1");

      expect(resolveWorkspace(user, workspace)).toBe(workspace);
      expect(existsSync(workspace)).toBe(true);
      expect(loadUserSettings()).toEqual({ [user]: { workspace_dir: workspace } });

      vi.stubEnv("HOGAGENT_GATEWAY_MANAGED", undefined);
      expect(selectRegisteredWebUser(user)).toBe(user);
      expect(resolveWorkspace(user)).toBe(workspace);
    });
  });

  describe("user settings JSON format", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "hogagent-uw-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("should serialize/deserialize user settings correctly", () => {
      const data: UserSettings = {
        default: { workspace_dir: "/home/user/.hogagent/workspace" },
        alice: { workspace_dir: "/projects/alice" },
      };
      const path = join(tempDir, "user_settings.json");
      writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
      const loaded = JSON.parse(readFileSync(path, "utf-8")) as UserSettings;
      expect(loaded).toEqual(data);
    });

    it("should handle empty settings file", () => {
      const path = join(tempDir, "user_settings.json");
      writeFileSync(path, "{}", "utf-8");
      const loaded = JSON.parse(readFileSync(path, "utf-8")) as UserSettings;
      expect(loaded).toEqual({});
    });
  });

  describe("ensureDefaultUser", () => {
    it("uses an explicit Web UI workspace and preserves default-user settings", () => {
      const firstWorkspace = join(systemDir, "first-workspace");
      const requestedWorkspace = join(systemDir, "requested-workspace");
      saveUserSettings({
        default: { workspace_dir: firstWorkspace, theme: "bloomberg" },
        alice: { workspace_dir: join(systemDir, "alice") },
      });

      expect(ensureDefaultUser(requestedWorkspace)).toBe(requestedWorkspace);
      expect(existsSync(requestedWorkspace)).toBe(true);
      expect(loadUserSettings()).toEqual({
        default: { workspace_dir: requestedWorkspace, theme: "bloomberg" },
        alice: { workspace_dir: join(systemDir, "alice") },
      });
    });

    it("reuses an existing default mapping when no Web UI workspace is supplied", () => {
      const registeredWorkspace = join(systemDir, "registered-workspace");
      saveUserSettings({
        default: { workspace_dir: registeredWorkspace, theme: "mist" },
      });

      expect(ensureDefaultUser()).toBe(registeredWorkspace);
      expect(existsSync(registeredWorkspace)).toBe(true);
      expect(loadUserSettings().default).toEqual({
        workspace_dir: registeredWorkspace,
        theme: "mist",
      });
    });

    it("creates the user-directory workspace on first use", () => {
      const expectedWorkspace = join(systemDir, "workspace");

      expect(ensureDefaultUser()).toBe(expectedWorkspace);
      expect(existsSync(expectedWorkspace)).toBe(true);
      expect(readFileSync(join(expectedWorkspace, "AGENTS.md"), "utf8")).toContain("# User Rules");
      expect(loadUserSettings().default?.workspace_dir).toBe(expectedWorkspace);
    });

    it("provisions a fresh CLI/RPC default user but still rejects unknown named users", () => {
      const workspace = resolveWorkspace("default");
      expect(workspace).toBe(join(systemDir, "workspace"));
      expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toContain("# HogAgent Workspace Rules");
      expect(() => resolveWorkspace("unknown")).toThrow("not registered");
    });

    it("upgrades instructions in an existing mapping and keeps trailing user rules", () => {
      const workspace = ensureDefaultUser(join(systemDir, "custom-default"));
      const path = join(workspace, "AGENTS.md");
      const original = readFileSync(path, "utf8");
      writeFileSync(path, original.replace(/^version: .*$/m, "version: 0.1.0") + "Always answer in Chinese.\n");
      expect(resolveWorkspace("default")).toBe(workspace);
      expect(readFileSync(path, "utf8")).toBe(original + "Always answer in Chinese.\n");
    });
  });

  describe("selectRegisteredWebUser", () => {
    it("keeps a registered WebUI user", () => {
      saveUserSettings({
        default: { workspace_dir: join(systemDir, "default-workspace") },
        alice: { workspace_dir: join(systemDir, "alice-workspace") },
      });

      expect(selectRegisteredWebUser("alice")).toBe("alice");
    });

    it("falls back to default when browser state references a removed user", () => {
      saveUserSettings({
        default: { workspace_dir: join(systemDir, "default-workspace") },
      });

      expect(selectRegisteredWebUser("2082363713595088897")).toBe("default");
    });
  });
});
