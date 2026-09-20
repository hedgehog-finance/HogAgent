import { randomUUID } from "node:crypto";
import { assertArtifactOwner, artifactStatePath, fingerprintFile, isFinalOutputFile, readFileOrigin, sameFileFingerprint, writeFileOrigin, type ArtifactBaseline } from "./artifact-file-facts.ts";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { ArtifactRunState, DeliveryDecision, HogAgentConfig, HogAgentContext } from "../utils/types.ts";
import { isPathInside, realPath, realPathInside } from "../utils/path-safety.ts";
import { ArtifactManifestContract } from "../protocol/generated-contracts.ts";
import { resolveArtifactUpdateMode } from "./artifact-policy.ts";
import type { ArtifactUpdateMode } from "../utils/types.ts";

export type ArtifactRole = "intermediate" | "raw_data" | "regular" | "deliverable";
type ArtifactAccess = "none" | "delivery_event" | "project_api";

type Origin = import("./artifact-file-facts.ts").FileOrigin;

interface ArtifactEntry {
  path: string;
  root: "session" | "project";
  area: "task" | "publish" | "src" | "data";
  role: ArtifactRole;
  access: ArtifactAccess;
  state: "current" | "superseded";
  version: number;
  supersedes?: string;
  size: number;
  modified_at: string;
  sha256?: string;
  origin?: Origin;
}

interface Manifest {
  schema_version: "1.0";
  manifest_type: "session" | "project";
  revision: number;
  session_id?: string;
  run_id: string;
  task_id?: string;
  project_id?: string;
  producer: string;
  owner: "agent" | "gateway";
  generated_at: string;
  artifacts: ArtifactEntry[];
  changes: Array<{ path: string; operation: "created" | "modified_in_place" | "version_created" | "deleted"; role: ArtifactRole; access: ArtifactAccess; previous_path?: string }>;
  integrity: { status: "ok" | "warning"; warnings: string[] };
}

const PROTOCOL_DIR = ".hedgehog";
const manifestAjv = new Ajv2020({ strict: false, allErrors: true });
manifestAjv.addFormat("date-time", (value: string) => Number.isFinite(Date.parse(value)));
manifestAjv.addFormat("uri", (value: string) => {
  try { new URL(value); return true; } catch { return false; }
});
const validateManifest = manifestAjv.compile(ArtifactManifestContract) as ValidateFunction<Manifest>;

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function isManifest(value: unknown): value is Manifest {
  return validateManifest(value);
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return undefined; }
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(temp, path);
}


function updateRegistry<T>(rootDir: string, name: string, path: string, value: T): void {
  const registryPath = artifactStatePath(rootDir, name);
  const registry = readJson<Record<string, T>>(registryPath) ?? {};
  registry[normalize(relative(rootDir, path))] = value;
  atomicWrite(registryPath, registry);
}

export function startArtifactRun(config: HogAgentConfig, runId: string): ArtifactRunState {
  assertArtifactOwner(config.sessionTaskDir, config.manifestOwner === "gateway" ? "gateway" : "agent", config.sessionId);
  if (config.projectDir && config.manifestOwner !== "gateway") assertArtifactOwner(config.projectDir, "agent");
  const state: ArtifactRunState = {
    manifestOwner: config.manifestOwner ?? "hogagent",
    runId,
    createdPaths: new Set(),
    versionTargets: new Map(),
    sessionId: config.sessionId,
    roots: [config.sessionTaskDir, config.projectDir].filter((root): root is string => !!root),
    baselines: new Map(),
    reconcileStatus: "pending",
    currentChanges: new Map(),
  };
  config.artifactRunState = state;
  if (config.manifestOwner !== "gateway") {
    try {
      for (const root of state.roots) {
        const baseline: ArtifactBaseline = {};
        for (const path of managedFiles(root, root === config.projectDir ? "project" : "session")) baseline[path] = fingerprintFile(resolve(root, path));
        state.baselines.set(root, baseline);
      }
    } catch (error) { state.baselineError = String(error); }
  }
  return state;
}

function runState(config: HogAgentConfig): ArtifactRunState {
  return config.artifactRunState ?? startArtifactRun(config, `${config.sessionId}-${Date.now()}`);
}

export function recordArtifactWrite(config: HogAgentConfig, path: string, sourcePath?: string): void {
  const state = runState(config);
  const target = normalize(resolve(path));
  state.createdPaths.add(target);
  if (sourcePath) {
    const source = normalize(resolve(sourcePath));
    if (source !== target) state.versionTargets.set(source, target);
  }
}

export function recordArtifactOrigin(rootDir: string, filePath: string, origin: Origin): void {
  writeFileOrigin(rootDir, filePath, origin);
}

export function readArtifactOrigin(rootDir: string, path: string, facts: ReturnType<typeof fingerprintFile>): Origin | undefined {
  const value = readJson<unknown>(artifactStatePath(rootDir, "artifact-manifest.json"));
  const previous = isManifest(value) ? value.artifacts.find(artifact => artifact.path === path) : undefined;
  return readFileOrigin(rootDir, path, facts, previous);
}

export function recordArtifactRole(rootDir: string, filePath: string, role: ArtifactRole): void {
  updateRegistry(rootDir, "artifact-overrides.json", filePath, { role });
}

export function validateArtifactRole(config: HogAgentConfig, path: string, role: ArtifactRole): string | undefined {
  if (config.manifestOwner === "gateway" && config.projectDir) return "artifact_role is controlled by the Gateway project policy; use the project artifact API";
  if (![config.sessionTaskDir, config.projectDir].some(root => root && isPathInside(root, path)) || normalize(path).split("/").includes(PROTOCOL_DIR)) return "artifact_role requires a managed business file";
  const type = config.projectDir && isPathInside(config.projectDir, path) ? "project" : "session";
  const root = type === "project" ? config.projectDir! : config.sessionTaskDir;
  const protectedRole = classify(type, normalize(relative(root, path))).role;
  if ((protectedRole === "intermediate" || protectedRole === "raw_data") && role !== protectedRole) return `Cannot reclassify protected ${protectedRole} file`;
  if (existsSync(path) && roleForExisting(path, config) === "raw_data" && role !== "raw_data") return "Cannot reclassify raw data";
  return undefined;
}

export function recordArtifactRoleForConfig(config: HogAgentConfig, filePath: string, role: ArtifactRole): void {
  const error = validateArtifactRole(config, filePath, role);
  if (error) throw new Error(error);
  const root = config.projectDir && isPathInside(config.projectDir, filePath)
    ? config.projectDir
    : isPathInside(config.sessionTaskDir, filePath) ? config.sessionTaskDir : undefined;
  if (root) recordArtifactRole(root, filePath, role);
}

function classify(type: "session" | "project", path: string, override?: { role?: ArtifactRole }): { area: ArtifactEntry["area"]; role: ArtifactRole; access: ArtifactAccess } {
  const normalized = normalize(path);
  const name = basename(normalized);
  if (type === "project") {
    if (normalized.startsWith("publish/") || normalized.startsWith("artifacts/")) return { area: "publish", role: override?.role ?? "deliverable", access: "project_api" };
    if (normalized.startsWith("data/")) return { area: "data", role: override?.role ?? "raw_data", access: "project_api" };
    return { area: "src", role: override?.role ?? "regular", access: "project_api" };
  }
  if (["log.txt", "mode.json", "plan.json", "orchestration-state.json", "tmp-orchestration-state.json", "sub-agent-usage.json", "audit-usage.json", "sub-agent-list.txt"].includes(name)
    || ["sub-output-", "temp-", "tmp-", "draft-", "log-"].some((prefix) => name.startsWith(prefix))) {
    return { area: "task", role: "intermediate", access: "none" };
  }
  if (name.startsWith("data-")) return { area: "task", role: override?.role ?? "raw_data", access: "none" };
  if (name.startsWith("final-output")) return { area: "task", role: override?.role ?? "deliverable", access: "delivery_event" };
  return { area: "task", role: override?.role ?? "regular", access: "none" };
}

function managedFiles(rootDir: string, type: "session" | "project"): string[] {
  const starts = type === "project" ? ["publish", "src", "data"].map((part) => join(rootDir, part)) : [rootDir];
  const result: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === PROTOCOL_DIR || entry.name === ".DS_Store" || entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) result.push(normalize(relative(rootDir, fullPath)));
    }
  };
  for (const start of starts) walk(start);
  return result.sort();
}

function parseVersion(path: string): { version: number; supersedes?: string } {
  const extension = extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  const match = stem.match(/-v(\d+)$/i);
  if (!match) return { version: 1 };
  const version = Number.parseInt(match[1]!, 10);
  if (version <= 1) return { version };
  const baseStem = stem.slice(0, match.index);
  return {
    version,
    supersedes: version === 2
      ? `${baseStem}${extension}`
      : `${baseStem}-v${version - 1}${extension}`,
  };
}


function reconcileRoot(
  context: HogAgentContext,
  rootDir: string,
  type: "session" | "project",
  owner: Manifest["owner"],
): void {
  if (!existsSync(rootDir)) return;
  const config = context.getConfig();
  const tracking = context.getLlmTracking();
  const currentPath = artifactStatePath(rootDir, "artifact-manifest.json");
  const previousValue = readJson<unknown>(currentPath);
  const previous = isManifest(previousValue)
    && previousValue.manifest_type === type
    && (!previousValue.session_id || previousValue.session_id === context.getSessionId())
    && (!config.projectId || !previousValue.project_id || previousValue.project_id === config.projectId)
    ? previousValue
    : undefined;
  const previousByPath = new Map((previous?.artifacts ?? []).map((artifact) => [artifact.path, artifact]));
  const overrides = readJson<Record<string, { role?: ArtifactRole }>>(join(rootDir, PROTOCOL_DIR, "artifact-overrides.json")) ?? {};
  const warnings: string[] = [];
  const fingerprints: ArtifactBaseline = {};
  const artifacts = managedFiles(rootDir, type).map((path): ArtifactEntry => {
    const file = resolve(rootDir, path);
    const stat = statSync(file);
    const facts = fingerprintFile(file);
    fingerprints[path] = facts;
    const defaults = classify(type, path, overrides[path]);
    const before = previousByPath.get(path);
    const version = parseVersion(path);
    const supersededBefore = version.supersedes ? previousByPath.get(version.supersedes) : undefined;
    const origin = readFileOrigin(rootDir, path, facts, before);
    const sourceRole: ArtifactRole | undefined = origin && ["web_fetch", "web_search", "api", "upload", "database"].includes(origin.type)
      ? "raw_data"
      : undefined;
    // Re-classify legacy entries from facts. Older manifests could promote a
    // one-time delivered regular/raw file to deliverable; that delivery history
    // must not become a permanent role.
    const supersededDefaults = supersededBefore ? classify(type, supersededBefore.path, overrides[supersededBefore.path]) : undefined;
    const supersededOrigin = supersededBefore
      ? supersededBefore.origin
      : undefined;
    const supersededSourceRole: ArtifactRole | undefined = supersededOrigin
      && ["web_fetch", "web_search", "api", "upload", "database"].includes(supersededOrigin.type)
      ? "raw_data"
      : undefined;
    const inheritedVersionRole = supersededBefore
      ? overrides[supersededBefore.path]?.role ?? supersededSourceRole ?? supersededDefaults?.role
      : undefined;
    const protectedRole = classify(type, path).role;
    const role = protectedRole === "intermediate" || protectedRole === "raw_data" ? protectedRole
      : sourceRole ?? (before?.role === "raw_data" ? "raw_data" : undefined) ?? overrides[path]?.role ?? inheritedVersionRole ?? defaults.role;
    const entry: ArtifactEntry = {
      path,
      root: type,
      area: defaults.area,
      role,
      access: type === "session" ? (role === "deliverable" ? "delivery_event" : "none") : defaults.access,
      state: "current",
      version: version.version,
      ...(version.supersedes ? { supersedes: version.supersedes } : {}),
      size: stat.size,
      modified_at: stat.mtime.toISOString(),
    };
    const sha256 = facts.sha256;
    if (sha256) entry.sha256 = sha256;
    if (origin) entry.origin = origin;
    const baseline = config.artifactRunState?.baselines.get(rootDir);
    const auditedBefore = baseline ? baseline[path] : before;
    if (auditedBefore && (auditedBefore.size !== facts.size || auditedBefore.modified_at !== facts.modified_at || auditedBefore.sha256 !== facts.sha256
      || (baseline && !sameFileFingerprint(baseline[path], facts)))) {
      if (before?.role === "raw_data" || entry.role === "raw_data") warnings.push(`Raw data was modified in place: ${path}`);
      else if (entry.role !== "intermediate") {
        if (config.artifactRunPolicy?.mutation.locked && config.artifactRunPolicy.mutation.mode === "new_version") warnings.push(`Existing artifact was modified in place despite new_version mode: ${path}`);
      }
    }
    return entry;
  });
  const currentByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  for (const artifact of artifacts) {
    let previousPath = artifact.supersedes;
    const visited = new Set<string>();
    while (previousPath && !visited.has(previousPath)) {
      visited.add(previousPath);
      const previousVersion = currentByPath.get(previousPath);
      if (!previousVersion) break;
      previousVersion.state = "superseded";
      previousPath = previousVersion.supersedes;
    }
  }
  const changes: Manifest["changes"] = [];
  for (const artifact of artifacts) {
    const before = previousByPath.get(artifact.path);
    if (!before) changes.push({ path: artifact.path, operation: artifact.version > 1 ? "version_created" : "created", role: artifact.role, access: artifact.access, ...(artifact.supersedes ? { previous_path: artifact.supersedes } : {}) });
    else if (before.size !== artifact.size || before.modified_at !== artifact.modified_at || before.sha256 !== artifact.sha256) changes.push({ path: artifact.path, operation: "modified_in_place", role: artifact.role, access: artifact.access });
  }
  for (const before of previous?.artifacts ?? []) {
    if (!currentByPath.has(before.path)) changes.push({ path: before.path, operation: "deleted", role: before.role, access: before.access });
  }
  const baseline = config.artifactRunState?.baselines.get(rootDir);
  if (baseline) config.artifactRunState!.currentChanges.set(rootDir,
    new Set(Object.entries(fingerprints).filter(([path, facts]) => !sameFileFingerprint(baseline[path], facts)).map(([path]) => path)));
  if (previous?.task_id && tracking.taskId && previous.task_id === tracking.taskId) {
    const keys = new Set(changes.map((change) => `${change.operation}:${change.path}`));
    for (const change of previous.changes) if (!keys.has(`${change.operation}:${change.path}`)) changes.unshift(change);
    for (const warning of previous.integrity.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }
  const runId = config.artifactRunState?.runId ?? randomUUID();
  const manifest: Manifest = {
    schema_version: "1.0",
    manifest_type: type,
    revision: (previous?.revision ?? 0) + 1,
    session_id: context.getSessionId(),
    run_id: runId,
    ...(tracking.taskId ? { task_id: tracking.taskId } : {}),
    ...(config.projectId ? { project_id: config.projectId } : {}),
    producer: "hogagent",
    owner,
    generated_at: new Date().toISOString(),
    artifacts,
    changes,
    integrity: { status: warnings.length ? "warning" : "ok", warnings },
  };
  if (!isManifest(manifest)) throw new Error("Generated artifact Manifest failed protocol validation");
  atomicWrite(currentPath, manifest);
  atomicWrite(artifactStatePath(rootDir, "manifests", `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), manifest);
}

export function reconcileHogAgentManifests(context: HogAgentContext): void {
  const config = context.getConfig();
  if (config.artifactRunState && config.artifactRunState.manifestOwner !== (config.manifestOwner ?? "hogagent")) throw new Error("Artifact run owner changed before finalization");
  // Gateway-owned runs are reconciled once by Gateway at the final agent_end.
  // Writing here as well duplicates scans, hashes, snapshots and revisions.
  if (config.manifestOwner === "gateway") return;
  const state = config.artifactRunState;
  if (state?.reconcileStatus === "success") return;
  if (state && (state.sessionId !== config.sessionId || state.roots.join("\0") !== [config.sessionTaskDir, config.projectDir].filter(Boolean).join("\0"))) {
    state.reconcileStatus = "failed";
    throw new Error("Artifact run identity changed before finalization");
  }
  try {
    reconcileRoot(context, config.sessionTaskDir, "session", "agent");
    if (config.projectDir) reconcileRoot(context, config.projectDir, "project", "agent");
    if (state) state.reconcileStatus = state.baselineError ? "failed" : "success";
  } catch (error) { if (state) state.reconcileStatus = "failed"; throw error; }
}

export function roleForExisting(
  path: string,
  config: Pick<HogAgentConfig, "projectDir" | "sessionTaskDir" | "manifestOwner">,
): ArtifactRole | undefined {
  const canonicalProject = config.projectDir ? realPathInside(config.projectDir, path) : null;
  const canonicalSession = realPathInside(config.sessionTaskDir, path);
  const root = canonicalProject && config.projectDir ? config.projectDir : canonicalSession ? config.sessionTaskDir : undefined;
  const canonicalPath = canonicalProject ?? canonicalSession;
  const canonicalRoot = root ? realPath(root) : null;
  if (!root || !canonicalPath || !canonicalRoot) return undefined;
  if (config.manifestOwner === "gateway" && root === config.projectDir) {
    const rel = normalize(relative(canonicalRoot, canonicalPath));
    if (root === config.projectDir && !/^(artifacts|dashboard|src|data)\//.test(rel)) return undefined;
    return classify(root === config.projectDir ? "project" : "session", rel).role;
  }
  const manifestValue = readJson<unknown>(join(root, PROTOCOL_DIR, "artifact-manifest.json"));
  const manifest = isManifest(manifestValue) ? manifestValue : undefined;
  const rel = normalize(relative(canonicalRoot, canonicalPath));
  if (root === config.projectDir && !/^(publish|artifacts|dashboard|src|data)\//.test(rel)) return undefined;
  const defaults = classify(root === config.projectDir ? "project" : "session", rel).role;
  if (defaults === "intermediate" || defaults === "raw_data") return defaults;
  const origin = readFileOrigin(root, rel, fingerprintFile(canonicalPath), manifest?.artifacts.find(entry => entry.path === rel));
  if (origin && origin.type !== "other") return "raw_data";
  if (manifest?.artifacts.some(entry => entry.path === rel && entry.role === "raw_data")) return "raw_data";
  const override = readJson<Record<string, { role?: ArtifactRole }>>(join(root, PROTOCOL_DIR, "artifact-overrides.json"))?.[rel]?.role;
  if (override && ["intermediate", "raw_data", "regular", "deliverable"].includes(override)) return override;
  return manifest?.artifacts.find((artifact) => artifact.path === rel)?.role
    ?? classify(root === config.projectDir ? "project" : "session", rel).role;
}

export interface ResolvedArtifactFile {
  absolutePath: string;
  rootRelative: string;
  workspaceRelative?: string;
  role: ArtifactRole;
  root: "session" | "project";
}

export function resolveArtifactFile(
  path: string,
  config: Pick<HogAgentConfig, "workspaceDir" | "sessionTaskDir" | "projectDir" | "manifestOwner">,
): ResolvedArtifactFile | undefined {
  const normalizedInput = normalize(path);
  const candidates = resolve(path) === path
    ? [resolve(path)]
    : /^(publish|artifacts|dashboard|src|data)\//.test(normalizedInput) && config.projectDir
      // The public selected_files protocol uses Manifest-root-relative Project
      // paths. Prefer that authority over a coincidental workspace file with the
      // same lexical path.
      ? [resolve(config.projectDir, path), resolve(config.sessionTaskDir, path), resolve(config.workspaceDir, path)]
      // Bare Session paths are likewise rooted at sessionTaskDir. Workspace-
      // relative declarations such as tasks/<session>/... remain the fallback
      // used by group/sub-agent output_files.
      : [resolve(config.sessionTaskDir, path), resolve(config.workspaceDir, path), ...(config.projectDir ? [resolve(config.projectDir, path)] : [])];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const canonicalProject = config.projectDir ? realPathInside(config.projectDir, candidate) : null;
    const canonicalSession = realPathInside(config.sessionTaskDir, candidate);
    const canonicalCandidate = canonicalProject ?? canonicalSession;
    if (!canonicalCandidate) continue;
    let stat;
    try { stat = lstatSync(canonicalCandidate); } catch { continue; }
    if (!stat.isFile()) continue;
    const root = canonicalProject && config.projectDir
      ? config.projectDir
      : canonicalSession ? config.sessionTaskDir : undefined;
    if (!root) continue;
    const canonicalRoot = realPath(root);
    if (!canonicalRoot) continue;
    const rootRelative = normalize(relative(canonicalRoot, canonicalCandidate));
    if (rootRelative.split('/').includes(PROTOCOL_DIR)) continue;
    const role = roleForExisting(canonicalCandidate, config);
    if (!role) continue;
    const canonicalWorkspace = realPath(config.workspaceDir);
    const workspaceCandidate = realPathInside(config.workspaceDir, canonicalCandidate);
    return {
      absolutePath: canonicalCandidate,
      rootRelative,
      workspaceRelative: canonicalWorkspace && workspaceCandidate
        ? normalize(relative(canonicalWorkspace, workspaceCandidate))
        : undefined,
      role,
      root: root === config.projectDir ? "project" : "session",
    };
  }
  return undefined;
}

export function resolveManifestDeliveryFiles(
  context: HogAgentContext,
  decision: DeliveryDecision,
): Array<{ path: string; summary?: string }> {
  const config = context.getConfig();
  const roots: Array<{ root: string; manifest: Manifest }> = [];
  for (const root of [config.sessionTaskDir, config.projectDir]) {
    if (!root) continue;
    const value = readJson<unknown>(join(root, PROTOCOL_DIR, "artifact-manifest.json"));
    if (isManifest(value)) roots.push({ root, manifest: value });
  }
  if (decision.mode === "none") return [];
  if (decision.mode === "deliverables" || decision.mode === "raw_data") {
    const role: ArtifactRole = decision.mode === "deliverables" ? "deliverable" : "raw_data";
    return roots.flatMap(({ root, manifest }) => {
      const changed = config.artifactRunState?.currentChanges.get(root) ?? new Set<string>();
      return manifest.artifacts
        .filter((artifact) => changed.has(artifact.path) && ((artifact.role === role && artifact.state === "current")
          || (role === "deliverable" && root === config.sessionTaskDir && !config.projectDir
            && artifact.role !== "raw_data" && artifact.role !== "intermediate" && isFinalOutputFile(artifact.path))))
        .map((artifact) => ({ path: resolve(root, artifact.path), summary: basename(artifact.path) }));
    });
  }

  const result: Array<{ path: string; summary?: string }> = [];
  for (const selected of decision.files ?? []) {
    const resolved = resolveArtifactFile(selected.path, config);
    if (!resolved || resolved.role === "intermediate") continue;
    const manifest = roots.find((entry) => entry.root === (resolved.root === "project" ? config.projectDir : config.sessionTaskDir))?.manifest;
    if (!manifest?.artifacts.some((artifact) => artifact.path === resolved.rootRelative && artifact.role !== "intermediate")) continue;
    result.push({ path: resolved.absolutePath, summary: selected.summary });
  }
  return result;
}

function nextVersionPath(path: string): string {
  const extension = extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  const match = stem.match(/-v(\d+)$/i);
  const base = match ? stem.slice(0, match.index) : stem;
  let version = match ? Number.parseInt(match[1]!, 10) + 1 : 2;
  let candidate = `${base}-v${version}${extension}`;
  while (existsSync(candidate)) candidate = `${base}-v${++version}${extension}`;
  return candidate;
}

export function prepareArtifactMutation(
  path: string,
  config: HogAgentConfig,
  requestedMode?: ArtifactUpdateMode,
): { ok: true; path: string; versioned: boolean; effectiveMode?: ArtifactUpdateMode; forced?: boolean } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, path, versioned: false };
  let stat;
  try { stat = lstatSync(path); } catch { return { ok: true, path, versioned: false }; }
  if (!stat.isFile()) return { ok: true, path, versioned: false };
  const role = roleForExisting(path, config);
  if (!role) return { ok: true, path, versioned: false };
  const state = runState(config);
  const sourceKey = normalize(resolve(path));
  if (role === "raw_data") {
    return { ok: false, error: `Raw data is immutable: ${path}. Re-fetch to a new raw_data file or create a derived regular/deliverable file.` };
  }
  // Non-raw files first created in this run may still be written incrementally.
  if (state.createdPaths.has(sourceKey)) return { ok: true, path, versioned: false };
  const resolved = resolveArtifactUpdateMode(config, role, requestedMode);
  if (resolved.mode === "in_place") return { ok: true, path, versioned: false, effectiveMode: resolved.mode, ...(resolved.forced ? { forced: true } : {}) };
  const existingTarget = state.versionTargets.get(sourceKey);
  if (existingTarget) {
    return { ok: true, path: existingTarget, versioned: true, effectiveMode: resolved.mode, ...(resolved.forced ? { forced: true } : {}) };
  }
  const versionPath = nextVersionPath(path);
  // Reserve synchronously before the file-system write awaits. Parallel tool
  // calls in the same run then converge on one version target; a failed first
  // write leaves a reusable empty reservation rather than consuming a version.
  state.versionTargets.set(sourceKey, versionPath);
  return { ok: true, path: versionPath, versioned: true, effectiveMode: resolved.mode, ...(resolved.forced ? { forced: true } : {}) };
}
