import { extractProjectDirFromText } from "../../src/handlers/types.ts";

afterEach(() => vi.unstubAllGlobals());

describe("standalone prompt project paths", () => {
  it.each([String.raw`C:\Users\中文 姓名\projects\demo`, "D:/研究/projects/demo", String.raw`\\server\share\projects\demo`])("accepts absolute Windows path %s", (path) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(extractProjectDirFromText(`[Project directory: ${path}]`)).toBe(path);
  });
  it("accepts the plain projects marker with Windows separators", () => {
    expect(extractProjectDirFromText(String.raw`projectDir: C:\Users\test\projects\demo`)).toBe(String.raw`C:\Users\test\projects\demo`);
  });
  it.each(["C:projects/demo", "projects/demo", "/projects/demo", String.raw`\projects\demo`, String.raw`C:\projects\..\secret`])("rejects relative or traversing Windows path %s", (path) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(extractProjectDirFromText(`[Project directory: ${path}]`)).toBeUndefined();
  });
  it("retains absolute POSIX paths", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    expect(extractProjectDirFromText("[Project directory: /home/中文 用户/projects/demo]")).toBe("/home/中文 用户/projects/demo");
  });
});
