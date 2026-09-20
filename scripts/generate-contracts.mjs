import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CONTRACT_FILES = ['agent-result.schema.json', 'artifact-manifest.schema.json', 'artifact-run-policy.schema.json', 'artifact-file-facts.ts'];

function writeOrCheck(target, content, check) {
  if (check) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content) {
      throw new Error(`Generated contract is stale: ${target}. Run npm run contracts:generate.`);
    }
  } else {
    writeFileSync(target, content, 'utf8');
  }
}

// Shared by the monorepo generator and the standalone checkout.
export function generateContracts(contractsDir, targets, check, snapshotDir) {
  const inputs = CONTRACT_FILES.map(name => readFileSync(join(contractsDir, name), 'utf8'));
  const names = ['AgentResultContract', 'ArtifactManifestContract', 'ArtifactRunPolicyContract'];
  const output = '// GENERATED from contracts/*.schema.json by contracts/generate-runtime.mjs. Do not edit.\n'
    + names.map((name, index) => `export const ${name} = ${JSON.stringify(JSON.parse(inputs[index]), null, 2)} as const;\n`).join('\n');
  for (const { projectDir, schemaPath } of targets) {
    writeOrCheck(join(projectDir, schemaPath), output, check);
    writeOrCheck(join(projectDir, 'src/artifacts/artifact-file-facts.ts'), '// GENERATED from contracts/artifact-file-facts.ts. Do not edit.\n' + inputs[3], check);
  }
  if (snapshotDir) {
    if (!check) mkdirSync(snapshotDir, { recursive: true });
    CONTRACT_FILES.forEach((name, index) => writeOrCheck(join(snapshotDir, name), inputs[index], check));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sharedGenerator = new URL('../../contracts/generate-runtime.mjs', import.meta.url);
  const check = process.argv.includes('--check');
  if (existsSync(sharedGenerator)) {
    const result = spawnSync(process.execPath, [fileURLToPath(sharedGenerator), ...(check ? ['--check'] : [])], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else {
    generateContracts(join(root, 'contracts'), [{ projectDir: root, schemaPath: 'src/protocol/generated-contracts.ts' }], check);
  }
}
