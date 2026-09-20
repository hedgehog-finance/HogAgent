import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import ts from "typescript";

// Keep the compiled server and its client on the same build of the delivery protocol.
const source = new URL("../src/web/public/", import.meta.url);
const destination = new URL("../dist/src/web/public/", import.meta.url);
rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });

const preview = new URL("preview-vendor/", destination);
mkdirSync(preview, { recursive: true });
for (const [from, to] of [
  ["marked/lib/marked.esm.js", "marked.js"],
  ["dompurify/dist/purify.es.mjs", "purify.js"],
  ["katex/dist", "katex"],
  ["echarts/dist/echarts.esm.min.js", "echarts.js"],
  ["marked/LICENSE.md", "marked-LICENSE.md"],
  ["dompurify/LICENSE", "dompurify-LICENSE.txt"],
  ["dompurify/LICENSE-MPL", "dompurify-LICENSE-MPL.txt"],
  ["katex/LICENSE", "katex-LICENSE.txt"],
  ["echarts/LICENSE", "echarts-LICENSE.txt"],
  ["echarts/NOTICE", "echarts-NOTICE.txt"],
  ["echarts/licenses", "echarts-licenses"],
]) cpSync(new URL(`../node_modules/${from}`, import.meta.url), new URL(to, preview), { recursive: true });
// The generated snapshot keeps standalone builds independent of the Web2 checkout.
cpSync(new URL('./chart-data.js', import.meta.url), new URL('chart-data.js', preview));
for (const [from, to] of [
  ["../src/web/markdown-document.ts", "markdown-document.js"],
]) {
  const source = readFileSync(new URL(from, import.meta.url), "utf8");
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  writeFileSync(new URL(to, preview), result.outputText);
}
