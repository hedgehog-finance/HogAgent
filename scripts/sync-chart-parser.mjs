import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const source = new URL('../../frontend/web2/lib/markdown/briefingChartData.ts', import.meta.url);
const snapshot = new URL('./chart-data.js', import.meta.url);
// Standalone builds use the committed generated parser. Monorepo builds reject drift.
if (existsSync(source)) {
  const content = '// GENERATED from frontend/web2/lib/markdown/briefingChartData.ts. Do not edit.\n'
    + ts.transpileModule(readFileSync(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  if (process.argv.includes('--check')) {
    if (!existsSync(snapshot) || readFileSync(snapshot, 'utf8') !== content) {
      throw new Error('Shared chart parser is stale. Run npm run web:parser in the monorepo.');
    }
  } else {
    writeFileSync(snapshot, content);
  }
} else if (!existsSync(snapshot)) {
  throw new Error('Missing bundled chart parser. Restore scripts/chart-data.js from the checkout.');
}
