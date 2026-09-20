import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getVersion } from "../../src/version.ts";

it("uses the HogAgent package version shared by the CLI and WebUI", () => {
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  expect(getVersion()).toBe(manifest.version);
  expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
  // Old servers serve this file directly, without any version interpolation.
  const html = readFileSync(resolve("src/web/public/index.html"), "utf8");
  expect(html).toContain(`<span class="app-version">v${manifest.version}</span>`);
  expect(html).toContain(`<span class="app-version">HogAgent v${manifest.version}</span>`);
  expect(html).not.toContain("__HOGAGENT_VERSION__");
});
