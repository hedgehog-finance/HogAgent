/**
 * Directory creation utility with retry + EEXIST tolerance.
 * Safe for concurrent instances.
 */

import { mkdirSync } from "node:fs";

/** Ensure directory exists with retry + EEXIST tolerance (safe for concurrent instances). */
/** @internal — exported for testing */
export async function ensureDir(dirPath: string, retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      mkdirSync(dirPath, { recursive: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      if (i === retries - 1) throw err;
      // Wait and retry (async delay, non-blocking)
      await new Promise((resolve) => setTimeout(resolve, (i + 1) * 50));
    }
  }
}
