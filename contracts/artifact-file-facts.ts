// Shared file facts used by the existing Manifest implementations. No directory discovery.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface FileOrigin {
  type: 'web_fetch' | 'web_search' | 'api' | 'upload' | 'database' | 'other';
  tool?: string;
  fetched_at?: string;
  locator?: string;
  title?: string;
  content_type?: string;
  data_range?: string;
}

export interface FileFingerprint {
  size: number;
  modified_at: string;
  ctimeMs: number;
  dev: number;
  ino: number;
  sha256?: string;
}
export type ArtifactBaseline = Record<string, FileFingerprint>;
export const ARTIFACT_HASH_LIMIT_BYTES = 50 * 1024 * 1024;

export function fingerprintFile(path: string): FileFingerprint {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Not a regular artifact: ${path}`);
  const sha256 = before.size <= ARTIFACT_HASH_LIMIT_BYTES
    ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined;
  const after = lstatSync(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    || before.dev !== after.dev || before.ino !== after.ino || !after.isFile()) {
    throw new Error(`Artifact changed while reading: ${path}`);
  }
  return { size: after.size, modified_at: after.mtime.toISOString(), ctimeMs: after.ctimeMs,
    dev: after.dev, ino: after.ino, ...(sha256 ? { sha256 } : {}) };
}

export function sameFileFingerprint(before: FileFingerprint | undefined, after: FileFingerprint): boolean {
  return !!before && before.size === after.size && before.modified_at === after.modified_at
    && before.ctimeMs === after.ctimeMs && before.dev === after.dev && before.ino === after.ino
    && before.sha256 === after.sha256;
}

export function isFinalOutputFile(path: string): boolean {
  return /^final-output-.+\.[^.]+$/.test(path.replace(/\\/g, '/').split('/').pop() ?? '');
}

export function sanitizeFileOrigin(value: unknown): FileOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!['web_fetch', 'web_search', 'api', 'upload', 'database', 'other'].includes(String(input.type))) return undefined;
  const origin: FileOrigin = { type: input.type as FileOrigin['type'] };
  for (const [key, limit] of [['tool', 100], ['title', 500], ['content_type', 200], ['data_range', 500]] as const) {
    if (typeof input[key] === 'string') origin[key] = input[key].slice(0, limit);
    if (key === 'title' && /^https?:\/\//.test(origin.title ?? '')) {
      try { const url = new URL(origin.title!); origin.title = `${url.protocol}//${url.host}${url.pathname}`; } catch { delete origin.title; }
    }
  }
  if (typeof input.fetched_at === 'string' && Number.isFinite(Date.parse(input.fetched_at))) {
    origin.fetched_at = new Date(input.fetched_at).toISOString();
  }
  if (typeof input.locator === 'string') {
    try {
      const url = new URL(input.locator);
      if (url.protocol === 'http:' || url.protocol === 'https:') origin.locator = `${url.protocol}//${url.host}${url.pathname}`;
    } catch { /* Never retain non-URL query payloads. */ }
  }
  return origin;
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

/** Reject links in internal state as well as escapes through the target file. */
export function artifactStatePath(root: string, ...parts: string[]): string {
  const canonicalRoot = realpathSync(root);
  let path = canonicalRoot;
  for (const part of ['.hedgehog', ...parts]) {
    if (!part || part === '.' || part === '..' || /[\\/]/.test(part)) throw new Error('Invalid artifact state path');
    path = join(path, part);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Artifact state must not contain symbolic links');
  }
  return path;
}

function originNoteName(path: string, sha256: string): string {
  return `${createHash('sha256').update(path).digest('hex')}.${sha256}.json`;
}

export function writeFileOrigin(root: string, file: string, origin: FileOrigin): void {
  const canonicalRoot = realpathSync(root);
  const canonicalFile = realpathSync(file);
  const path = relative(canonicalRoot, canonicalFile).replace(/\\/g, '/');
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path) || path.split('/').includes('.hedgehog')) {
    throw new Error('Origin file is outside its artifact root');
  }
  const facts = fingerprintFile(canonicalFile);
  if (!facts.sha256) throw new Error('Origin content exceeds the supported fingerprint size');
  const target = artifactStatePath(canonicalRoot, 'artifact-origins', originNoteName(path, facts.sha256));
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ schema_version: '1.0', path, sha256: facts.sha256, origin: sanitizeFileOrigin(origin) }) + '\n', { flag: 'wx' });
  renameSync(temp, target);
}

/** Read notes only for an already discovered file. Old tables remain compatibility input. */
export function readFileOrigin(root: string, path: string, facts: Pick<FileFingerprint, 'size' | 'modified_at' | 'sha256'>,
  previous?: { size: number; modified_at: string; sha256?: string; origin?: FileOrigin }): FileOrigin | undefined {
  try {
    if (facts.sha256) {
      const note = readJson(artifactStatePath(root, 'artifact-origins', originNoteName(path, facts.sha256))) as Record<string, unknown> | undefined;
      if (note?.schema_version === '1.0' && note.path === path && note.sha256 === facts.sha256) {
        const origin = sanitizeFileOrigin(note.origin);
        if (origin) return origin;
      }
    }
    // Once indexed, keep only the previous entry's still-valid origin. Re-reading
    // an old table after invalidation would resurrect stale provenance next run.
    if (previous) {
      const unchanged = previous.size === facts.size && previous.modified_at === facts.modified_at
        && (!previous.sha256 || previous.sha256 === facts.sha256);
      return unchanged ? sanitizeFileOrigin(previous.origin) : undefined;
    }
    const registry = readJson(artifactStatePath(root, 'artifact-origins.json')) as Record<string, unknown> | undefined;
    return sanitizeFileOrigin(registry?.[path]);
  } catch { return undefined; }
}

/** Validate ownership at admission, before any business file writes or model calls. */
export function assertArtifactOwner(root: string, owner: 'agent' | 'gateway', sessionId?: string): void {
  if (!existsSync(root)) return;
  const path = artifactStatePath(root, 'artifact-manifest.json');
  if (!existsSync(path)) return;
  const manifest = readJson(path) as { owner?: string; session_id?: string } | undefined;
  if (!manifest || manifest.owner !== owner || (sessionId && manifest.session_id && manifest.session_id !== sessionId)) {
    throw new Error('Artifact Manifest owner or Session identity conflicts with this run; use its owning runtime or a separate Session directory');
  }
}

/** A producer may validate its output before requesting data, without discovering artifacts. */
export function assertArtifactOutput(root: string, output: string): void {
  const canonicalRoot = realpathSync(root);
  const target = resolve(output);
  let parent = target;
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  const canonicalTarget = resolve(realpathSync(parent), relative(parent, target));
  const path = relative(canonicalRoot, canonicalTarget);
  if (isAbsolute(path) || path === '..' || path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
    || path.replace(/\\/g, '/').split('/').includes('.hedgehog')) throw new Error('Output must be inside the business artifact root');
}
