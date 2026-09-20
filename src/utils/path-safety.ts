import path, { posix, win32 } from "node:path";
import { lstatSync, realpathSync } from "node:fs";

type PathApi = typeof posix;

function isWindowsPathLike(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

function pathApiFor(...paths: string[]): PathApi {
  if (paths.some(isWindowsPathLike)) return win32;
  return path;
}

function normalizeInput(value: string, api: PathApi): string {
  if (api === win32 || api.isAbsolute(value)) return value;
  return value.replace(/\\/g, "/");
}

export function isPathAbsolute(filePath: string, basePath?: string): boolean {
  const api = pathApiFor(filePath, basePath ?? "");
  return api.isAbsolute(normalizeInput(filePath, api));
}

export function normalizePath(filePath: string, basePath?: string): string {
  const api = pathApiFor(filePath, basePath ?? "");
  return api.normalize(normalizeInput(filePath, api));
}

export function joinPath(basePath: string, ...segments: string[]): string {
  const api = pathApiFor(basePath, ...segments);
  return api.join(basePath, ...segments.map((segment) => normalizeInput(segment, api)));
}

export function basenamePath(filePath: string): string {
  const api = pathApiFor(filePath);
  return (api === win32 || filePath.includes("\\")) ? win32.basename(filePath) : api.basename(filePath);
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const api = pathApiFor(parentPath, childPath);
  const parent = api.resolve(normalizeInput(parentPath, api));
  const child = api.resolve(normalizeInput(childPath, api));
  const rel = api.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !api.isAbsolute(rel));
}

export function relativePathIfInside(parentPath: string, childPath: string): string | null {
  if (!isPathInside(parentPath, childPath)) return null;
  const api = pathApiFor(parentPath, childPath);
  return api.relative(api.resolve(normalizeInput(parentPath, api)), api.resolve(normalizeInput(childPath, api)));
}

export function realPath(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

/** Resolve parent and child through symlinks before applying containment. */
export function realPathInside(parentPath: string, childPath: string): string | null {
  const canonicalParent = realPath(parentPath);
  const canonicalChild = realPath(childPath);
  if (!canonicalParent || !canonicalChild || !isPathInside(canonicalParent, canonicalChild)) return null;
  return canonicalChild;
}

/** Resolve an existing canonical direct child, rejecting symlink aliases. */
export function realPathDirectChild(parentPath: string, childPath: string): string | null {
  try {
    if (lstatSync(childPath).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const canonicalParent = realPath(parentPath);
  const canonicalChild = realPath(childPath);
  if (!canonicalParent || !canonicalChild) return null;
  const api = pathApiFor(canonicalParent, canonicalChild);
  return api.dirname(canonicalChild) === canonicalParent ? canonicalChild : null;
}
