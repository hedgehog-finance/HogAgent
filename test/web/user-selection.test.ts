import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("WebUI user selection", () => {
  it("normalizes a stale browser user before connecting without prompting for a workspace", () => {
    const source = readFileSync(resolve("src/web/public/app.js"), "utf8");
    const initialization = source.slice(
      source.indexOf("const userInitialization"),
      source.indexOf("// Initialize theme selector"),
    );

    expect(initialization).toContain("data.selectedUser");
    expect(initialization).toContain('localStorage.setItem("hogagent_user", selectedUser)');
    expect(source).toContain("void userInitialization.then(() => {");
    expect(source).toContain("restoreWebConnectionId();\n  connect();");
    expect(source).not.toContain("Enter workspace path:");
  });
});
