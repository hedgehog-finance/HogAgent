import { readFileSync, writeFileSync } from "node:fs";
import { getVersion } from "../src/version.ts";

// Ship real version text so static HTML also works with an already-running WebUI server.
const version = getVersion();
if (version === "unknown") throw new Error("Cannot read the HogAgent package version");
const htmlPath = new URL("../src/web/public/index.html", import.meta.url);
const html = readFileSync(htmlPath, "utf8");
const versionLabel = /(<span class="app-version">(?:HogAgent )?v)[^<]*(<\/span>)/g;
if ([...html.matchAll(versionLabel)].length !== 2) {
  throw new Error("Expected sidebar and settings version labels in WebUI HTML");
}
const escapedVersion = version.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const updated = html.replace(versionLabel, (_match, prefix, suffix) => `${prefix}${escapedVersion}${suffix}`);
if (updated !== html) {
  if (process.argv.includes("--check")) {
    throw new Error("WebUI version is out of date. Run npm run web:version");
  }
  writeFileSync(htmlPath, updated, "utf8");
}
