import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureDir } from "../../src/index.ts";

describe("ensureDir (Bug 5 fix)", () => {
  let testBase: string;

  beforeEach(() => {
    testBase = join(tmpdir(), `hogagent-ensureDir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Clean up if exists from previous run
    if (existsSync(testBase)) rmSync(testBase, { recursive: true, force: true });
  });

  afterEach(() => {
    if (existsSync(testBase)) rmSync(testBase, { recursive: true, force: true });
  });

  it("should create a new directory", async () => {
    const target = join(testBase, "new-dir");
    expect(existsSync(target)).toBe(false);

    await ensureDir(target);

    expect(existsSync(target)).toBe(true);
  });

  it("should create nested directories", async () => {
    const target = join(testBase, "a", "b", "c");

    await ensureDir(target);

    expect(existsSync(target)).toBe(true);
  });

  it("should not throw when directory already exists (EEXIST tolerance)", async () => {
    const target = join(testBase, "existing-dir");
    mkdirSync(target, { recursive: true });
    expect(existsSync(target)).toBe(true);

    // Should not throw
    await expect(ensureDir(target)).resolves.toBeUndefined();
  });

  it("should handle concurrent calls without errors", async () => {
    const target = join(testBase, "concurrent-dir");

    // Fire multiple ensureDir calls concurrently
    const results = await Promise.allSettled([
      ensureDir(target),
      ensureDir(target),
      ensureDir(target),
      ensureDir(target),
      ensureDir(target),
    ]);

    // All should succeed
    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }

    expect(existsSync(target)).toBe(true);
  });

  it("should handle concurrent calls on nested paths", async () => {
    const target = join(testBase, "deep", "nested", "concurrent");

    const results = await Promise.allSettled([
      ensureDir(target),
      ensureDir(target),
      ensureDir(target),
    ]);

    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }

    expect(existsSync(target)).toBe(true);
  });
});
