/**
 * Session Storage & Repair
 *
 * Handles JSONL session storage creation, opening, and auto-repair
 * for missing headers and broken parent chains.
 */

import { JsonlSessionStorage } from "./vendor/agent/harness/session/jsonl-storage.ts";
import type { NodeExecutionEnv } from "./vendor/agent/harness/env/nodejs.ts";
import type { ExecutionEnv } from "./vendor/agent/harness/types.ts";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "./utils/logger.ts";
import { emitEvent } from "./rpc.ts";

const log = createLogger("core");

/**
 * Open or create a JSONL session storage with auto-repair for missing headers.
 *
 * Handles the case where a session file exists but is missing the required
 * session header line (e.g., due to a crash or bug during initial creation).
 * In that case, the header is prepended to the existing content and the file
 * is re-opened.
 */
export async function openOrCreateSessionStorage(
  env: NodeExecutionEnv,
  sessionFilePath: string,
  workspaceDir: string,
  sessionId: string,
): Promise<JsonlSessionStorage> {
  // Identity/CWD errors are not parser errors and must never enter header repair.
  if (existsSync(sessionFilePath)) {
    const first = readFileSync(sessionFilePath, 'utf8').split('\n').find(line => line.trim());
    if (first) {
      let header: { type?: string; id?: string; cwd?: string } | undefined;
      try { header = JSON.parse(first); } catch { /* The parser below reports malformed history. */ }
      if (header?.type === 'session') {
        const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
        if (header.id !== sessionId || !header.cwd || canonical(header.cwd) !== canonical(workspaceDir)) {
          throw new Error('Session identity/workspace mismatch: history is read-only; create a new session');
        }
        return JsonlSessionStorage.open(env, sessionFilePath);
      }
    }
    if (process.env.HOGAGENT_GATEWAY_MANAGED === '1') throw new Error('Native history lacks valid identity/CWD metadata; create a new session');
  }
  // Standalone missing-header repair remains available; managed history fails closed.
  try {
    return await JsonlSessionStorage.open(env, sessionFilePath);
  } catch {
    // open() failed — check if file exists with content but no valid header
  }

  // 2. File exists? Try to repair by prepending a session header
  if (existsSync(sessionFilePath)) {
    const repairPath = `${sessionFilePath}.${randomUUID()}.repair`;
    try {
      const content = readFileSync(sessionFilePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      if (lines.length > 0) {
        // Validate a staged repair with Pi's parser before replacing any history.
        // An invalid entry (including a truncated crash write) is not a missing
        // header and must never fall through to create(), which truncates the file.
        const header = JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: workspaceDir,
        });
        writeFileSync(repairPath, header + "\n" + content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
        await JsonlSessionStorage.open(env, repairPath);
        renameSync(repairPath, sessionFilePath);
        log.warn("Session missing header repaired", { sessionFilePath, entryCount: lines.length });

        // Retry open after repair
        return await JsonlSessionStorage.open(env, sessionFilePath);
      }
    } catch (repairErr) {
      log.error("Session recovery failed; refusing to recreate existing history", { error: String(repairErr) });
      throw repairErr;
    } finally {
      rmSync(repairPath, { force: true });
    }
  }

  // 3. File doesn't exist (or is empty) — create new with header
  const storage = await JsonlSessionStorage.create(env, sessionFilePath, {
    cwd: workspaceDir,
    sessionId,
  });

  // 4. Verify header was actually written (guards against silent writeFile failures)
  try {
    const content = readFileSync(sessionFilePath, "utf-8");
    const firstLine = content.split("\n")[0]?.trim();
    if (!firstLine) {
      log.warn("Session header verification failed: file is empty after create, retrying", { sessionFilePath });
      return await JsonlSessionStorage.create(env, sessionFilePath, {
        cwd: workspaceDir,
        sessionId,
      });
    }
  } catch (verifyErr) {
    log.warn("Session header verification failed", { sessionFilePath, error: String(verifyErr) });
  }

  return storage;
}

/**
 * Validate and repair session tree parent chain integrity.
 *
 * If the JSONL file has entries whose parentId references a missing entry
 * (e.g., due to a crash during append or a partial write), getPathToRoot
 * will throw "Entry ... not found". Repair by appending a leaf entry that
 * resets the tree pointer to the last entry with a complete chain to root.
 */
export async function repairSessionTree(
  storage: JsonlSessionStorage,
  sessionId: string,
): Promise<void> {
  try {
    const leafId = await storage.getLeafId();
    if (leafId !== null) {
      await storage.getPathToRoot(leafId);
    }
  } catch (chainErr) {
    log.warn("Session parent chain broken, attempting repair", {
      sessionId,
      error: String(chainErr),
    });
    const allEntries = await storage.getEntries();
    // Strategy: find the LAST entry whose parent chain reaches root (parentId=null).
    let lastRootedId: string | null = null;
    for (let i = allEntries.length - 1; i >= 0; i--) {
      const candidate = allEntries[i]!;
      if (candidate.type === "leaf") continue;
      let reachesRoot = false;
      let pid = candidate.parentId;
      const visited = new Set<string>();
      while (true) {
        if (pid === null) { reachesRoot = true; break; }
        if (visited.has(pid)) break;
        visited.add(pid);
        const parent = await storage.getEntry(pid);
        if (!parent) break;
        pid = parent.parentId;
      }
      if (reachesRoot) {
        lastRootedId = candidate.id;
        break;
      }
    }
    if (lastRootedId) {
      await storage.setLeafId(lastRootedId);
      log.info("Session parent chain repaired", { sessionId, newLeaf: lastRootedId });
      emitEvent({
        type: "warning",
        message: `Session history partially recovered (some early messages may be missing due to file corruption)`,
        session_id: sessionId,
      });
    } else {
      await storage.setLeafId(null);
      log.warn("Session has no entries with valid root chain, reset to empty", { sessionId });
      emitEvent({
        type: "warning",
        message: `Session history could not be recovered, starting with a clean conversation`,
        session_id: sessionId,
      });
    }
  }
}
