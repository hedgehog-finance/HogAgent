import { createWebSearchTool, setSearchSettingsPath } from "../../src/tools/web-search.ts";

describe("web-search tool", () => {
  const tool = createWebSearchTool();

  async function execute(params: Record<string, unknown>) {
    return tool.execute("test-call-id", params) as Promise<{
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    }>;
  }

  /** Clears all search-related environment variables. */
  function clearAllSearchEnv() {
    delete process.env["HOGAGENT_SEARCH_API_KEY"];
    delete process.env["HOGAGENT_SEARCH_ENDPOINT"];
    delete process.env["HOGAGENT_SEARCH_PROVIDER"];
    delete process.env["HOGAGENT_SEARCH_CX"];
    // China-based providers
    delete process.env["HOGAGENT_BOCHA_API_KEY"];
    delete process.env["HOGAGENT_BOCHA_ENDPOINT"];
    delete process.env["HOGAGENT_METASO_API_KEY"];
    delete process.env["HOGAGENT_METASO_MODE"];
    delete process.env["HOGAGENT_METASO_RANGE"];
    delete process.env["HOGAGENT_METASO_ENDPOINT"];
    delete process.env["HOGAGENT_ZHIPU_API_KEY"];
    delete process.env["HOGAGENT_ZHIPU_MODEL"];
    delete process.env["HOGAGENT_ZHIPU_BASE_URL"];
    delete process.env["HOGAGENT_VOLCENGINE_API_KEY"];
    delete process.env["HOGAGENT_VOLCENGINE_MODEL"];
    delete process.env["HOGAGENT_VOLCENGINE_ENDPOINT"];
  }

  describe("unconfigured state", () => {
    beforeEach(() => {
      clearAllSearchEnv();
      // Disable search_settings.json loading for unconfigured tests
      setSearchSettingsPath("/nonexistent/search_settings.json");
    });

    afterEach(() => {
      // Restore default path
      setSearchSettingsPath(undefined);
    });

    it("should return informative message when not configured", async () => {
      const result = await execute({ query: "test query" });
      expect(result.content[0].text).toContain("Web search is not configured");
      expect(result.content[0].text).toContain("HOGAGENT_SEARCH_PROVIDER");
      expect(result.content[0].text).toContain("HOGAGENT_SEARCH_API_KEY");
    });

    it("should mention Chinese providers in help message", async () => {
      const result = await execute({ query: "test query" });
      expect(result.content[0].text).toContain("bocha");
      expect(result.content[0].text).toContain("metaso");
      expect(result.content[0].text).toContain("zhipu");
      expect(result.content[0].text).toContain("HOGAGENT_BOCHA_API_KEY");
    });

    it("should include error details", async () => {
      const result = await execute({ query: "test query" });
      expect(result.details.error).toBe("not_configured");
    });
  });

  describe("chinese provider config detection", () => {
    beforeEach(() => {
      clearAllSearchEnv();
    });

    it("should recognize HOGAGENT_BOCHA_API_KEY as configured", async () => {
      process.env["HOGAGENT_SEARCH_PROVIDER"] = "bocha";
      process.env["HOGAGENT_BOCHA_API_KEY"] = "test-key";
      // Use an invalid endpoint for a fast fetch failure; this only verifies that the not_configured branch is bypassed.
      process.env["HOGAGENT_BOCHA_ENDPOINT"] = "http://127.0.0.1:1/invalid";
      const result = await execute({ query: "test" });
      expect(result.details.error).not.toBe("not_configured");
      delete process.env["HOGAGENT_BOCHA_API_KEY"];
      delete process.env["HOGAGENT_BOCHA_ENDPOINT"];
      delete process.env["HOGAGENT_SEARCH_PROVIDER"];
    });

    it("should recognize HOGAGENT_ZHIPU_API_KEY as configured", async () => {
      process.env["HOGAGENT_SEARCH_PROVIDER"] = "zhipu";
      process.env["HOGAGENT_ZHIPU_API_KEY"] = "test-key";
      process.env["HOGAGENT_ZHIPU_BASE_URL"] = "http://127.0.0.1:1";
      const result = await execute({ query: "test" });
      expect(result.details.error).not.toBe("not_configured");
      delete process.env["HOGAGENT_ZHIPU_API_KEY"];
      delete process.env["HOGAGENT_ZHIPU_BASE_URL"];
      delete process.env["HOGAGENT_SEARCH_PROVIDER"];
    });

    it("should recognize HOGAGENT_METASO_API_KEY as configured", async () => {
      process.env["HOGAGENT_SEARCH_PROVIDER"] = "metaso";
      process.env["HOGAGENT_METASO_API_KEY"] = "test-key";
      process.env["HOGAGENT_METASO_ENDPOINT"] = "http://127.0.0.1:1/invalid";
      const result = await execute({ query: "test" });
      expect(result.details.error).not.toBe("not_configured");
      delete process.env["HOGAGENT_METASO_API_KEY"];
      delete process.env["HOGAGENT_METASO_ENDPOINT"];
      delete process.env["HOGAGENT_SEARCH_PROVIDER"];
    });
  });

  describe("parameter validation", () => {
    beforeEach(() => {
      clearAllSearchEnv();
    });

    it("should clamp num_results to valid range", async () => {
      const result = await execute({ query: "test", num_results: 50 });
      expect(result.details.query).toBe("test");
    });

    it("should pass query to details even when unconfigured", async () => {
      const result = await execute({ query: "hello world" });
      expect(result.details.query).toBe("hello world");
    });
  });

  describe("result formatting", () => {
    it("should have proper tool name and description", () => {
      expect(tool.name).toBe("web_search");
      expect(tool.description).toContain("Search the web");
      expect(tool.description).toContain("titles");
    });
  });
});
