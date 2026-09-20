import { afterAll, vi } from 'vitest';

// Tests must never create runtime workspaces, logs, keys or native state in the
// developer's actual home, including tests run with loopback networking enabled.
const { runtimeHome } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return { runtimeHome: fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'hedgehog-test-home-')) };
});
process.env.HOGAGENT_USER_DIR = runtimeHome + '/.hogagent';
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => runtimeHome };
});
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => runtimeHome };
});
afterAll(async () => {
  const { rmSync } = await import('node:fs');
  rmSync(runtimeHome, { recursive: true, force: true });
});
