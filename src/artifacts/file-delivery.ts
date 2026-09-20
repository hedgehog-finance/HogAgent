import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import type { ArtifactRunState, HogAgentConfig, HogAgentContext } from "../utils/types.ts";
import { fingerprintFile, isFinalOutputFile, type FileOrigin } from "./artifact-file-facts.ts";
import { readArtifactOrigin, resolveArtifactFile, resolveManifestDeliveryFiles } from "./artifact-protocol.ts";
import { deliveryModeAllowsRole, effectiveDeliveryDecision, normalizeDeliveryPath, recoveryDeliveryDecision } from "./artifact-policy.ts";

export interface DeliveryFile { path: string; summary?: string }
export interface DeliveryReceipt {
  source: "explicit" | "automatic";
  origin?: FileOrigin;
  id: string; path: string; root: "session" | "project"; root_path: string; root_relative: string;
  session_id: string; run_id: string; size: number; fingerprint: string;
  description: string; mime_type: string; timestamp: string;
}
export interface DeliveryResult {
  protocol: "hogagent.file-delivery.v1";
  session_id: string; run_id: string; source: "explicit" | "automatic";
  already_delivered?: string[];
  requested_files: DeliveryFile[]; files: DeliveryReceipt[]; errors: string[]; skipCompress: true;
}

export function isDeliveryResult(value: unknown): value is DeliveryResult {
  if (!value || typeof value !== "object") return false;
  const result = value as DeliveryResult;
  return result.protocol === "hogagent.file-delivery.v1" && typeof result.session_id === "string"
    && typeof result.run_id === "string" && ["explicit", "automatic"].includes(result.source)
    && Array.isArray(result.requested_files) && result.requested_files.every(file => typeof file?.path === "string")
    && Array.isArray(result.errors) && Array.isArray(result.files) && result.files.every(file =>
      typeof file?.id === "string" && typeof file.path === "string" && typeof file.root_path === "string"
      && typeof file.root_relative === "string" && typeof file.fingerprint === "string"
      && file.session_id === result.session_id && file.run_id === result.run_id);
}

/** Only native tool results and our custom entries constitute delivery history. */
export function deliveryResultsFromEntries(entries: readonly unknown[]): DeliveryResult[] {
  return entries.flatMap(raw => {
    const entry = raw as { type?: string; customType?: string; data?: unknown; message?: { role?: string; toolName?: string; details?: unknown } };
    const value = entry.type === "custom" && entry.customType === "hogagent.file-delivery"
      ? entry.data : entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "deliver_files"
      ? entry.message.details : undefined;
    return isDeliveryResult(value) ? [value] : [];
  });
}

export function deliveryReceiptsFromEntries(entries: readonly unknown[], sessionId: string): DeliveryReceipt[] {
  const receipts = new Map<string, DeliveryReceipt>();
  for (const result of deliveryResultsFromEntries(entries)) {
    if (result.session_id === sessionId) for (const file of result.files) receipts.set(file.id, file);
  }
  return [...receipts.values()];
}

interface DeliveryRun {
  state: ArtifactRunState;
  config: HogAgentConfig;
  committed: Set<string>;
  recoveredReceipts: Map<string, string>;
  restored?: Promise<void>;
  completion?: Promise<void>;
  warned?: boolean;
}

export class FileDelivery {
  restricted = false;
  private activeRun?: DeliveryRun;
  private readonly context: HogAgentContext;
  constructor(context: HogAgentContext) { this.context = context; }

  private captureRun(): DeliveryRun {
    const config = this.context.getConfig();
    const state = config.artifactRunState;
    if (!state) throw new Error("Delivery requires the active artifact run");
    const run = this.activeRun?.state === state ? this.activeRun : {
      state, config: { ...config, artifactRunPolicy: config.artifactRunPolicy && structuredClone(config.artifactRunPolicy) },
      committed: new Set<string>(), recoveredReceipts: new Map<string, string>(),
    };
    this.assertActive(run);
    this.activeRun = run;
    return run;
  }

  private assertActive(run: DeliveryRun): void {
    const current = this.context.getConfig();
    if (current.artifactRunState !== run.state || current.sessionId !== run.state.sessionId
      || (current.manifestOwner ?? "hogagent") !== run.state.manifestOwner
      || current.workspaceDir !== run.config.workspaceDir || current.sessionTaskDir !== run.config.sessionTaskDir
      || current.projectDir !== run.config.projectDir
      || run.state.roots.join("\0") !== [current.sessionTaskDir, current.projectDir].filter(Boolean).join("\0")) {
      throw new Error("Delivery run identity changed");
    }
  }

  private async restore(run: DeliveryRun): Promise<void> {
    run.restored ??= (async () => {
      const history = await this.context.readDeliveryHistory?.() ?? [];
      this.assertActive(run);
      for (const result of history) if (result.run_id === run.state.runId && result.session_id === run.state.sessionId) {
        for (const file of result.files) run.committed.add(file.id);
      }
    })().catch(error => { run.restored = undefined; throw error; });
    await run.restored;
    this.assertActive(run);
  }

  async restoreCompleted(decision: import("../utils/types.ts").DeliveryDecision | undefined, previousRunId?: string): Promise<void> {
    this.restricted = false;
    const run = this.captureRun();
    const state = run.state;
    // An automatic role decision is not permission to rediscover historical files on recovery.
    state.deliveryDecision = recoveryDeliveryDecision(decision);
    const history = await this.context.readDeliveryHistory?.() ?? [];
    this.assertActive(run);
    run.recoveredReceipts = new Map(history.filter(result => result.session_id === state.sessionId && result.run_id === previousRunId)
      .flatMap(result => result.files.map(file => [file.path, file.fingerprint] as const)));
    if (state.deliveryDecision !== decision) this.context.emitEvent({ type: "warning", session_id: state.sessionId,
      message: "恢复时没有可复用的明确文件清单；旧成果需明确选择后交付。" });
  }

  async prepare(files: DeliveryFile[], source: DeliveryResult["source"]): Promise<DeliveryResult> {
    return this.prepareForRun(this.captureRun(), files, source);
  }

  private async prepareForRun(run: DeliveryRun, files: DeliveryFile[], source: DeliveryResult["source"]): Promise<DeliveryResult> {
    await this.restore(run);
    const { config, state } = run;
    if (config.manifestOwner === "gateway" && config.projectDir) throw new Error("Development files use project/resource delivery APIs");
    if (this.restricted) throw new Error("Delivery is deferred until orchestration finishes; return output_files and continue the task.");
    const result: DeliveryResult = { protocol: "hogagent.file-delivery.v1", session_id: state.sessionId, run_id: state.runId,
      source, requested_files: files, files: [], errors: [], skipCompress: true };
    if (!files.length) result.errors.push("No files specified. Provide a non-empty array of file objects.");
    if (source === "explicit" && files.length) state.explicitFiles = [...new Map([...(state.explicitFiles ?? []), ...files].map(file => [file.path, file])).values()];
    const ids = new Set<string>();
    for (const file of files) {
      try {
        if (file.path.replace(/\\/g, "/").split("/").some(part => part === ".." || part === ".hedgehog")) throw new Error("invalid internal or traversal path");
        // Tool paths are workspace-relative; final decisions are business-root-relative.
        const candidate = source === "explicit" && !isAbsolute(file.path) ? resolve(config.workspaceDir, file.path) : file.path;
        const resolved = resolveArtifactFile(candidate, config);
        if (!resolved) throw new Error("file is missing or outside the current Session/Project artifact roots");
        if (resolved.role === "intermediate") throw new Error("intermediate artifacts cannot be delivered");
        const policy = config.artifactRunPolicy?.delivery;
        if (policy?.locked) {
          const allowed = policy.mode === "selected_files"
            ? policy.files.some(selected => [resolved.rootRelative, resolved.workspaceRelative].includes(normalizeDeliveryPath(selected)))
            : deliveryModeAllowsRole(policy.mode, resolved.role) || (policy.mode === "deliverables" && source === "automatic"
              && !state.explicitFiles?.length && effectiveDeliveryDecision(config).mode === "deliverables"
              && !config.projectDir && resolved.root === "session" && resolved.role === "regular"
              && state.currentChanges.get(config.sessionTaskDir)?.has(resolved.rootRelative) === true && isFinalOutputFile(resolved.rootRelative));
          if (!allowed) throw new Error(`blocked by locked delivery mode ${policy.mode}`);
        }
        if (!resolved.workspaceRelative) throw new Error("file must be within workspaceDir for download delivery");
        const facts = fingerprintFile(resolved.absolutePath);
        const fingerprint = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
        const id = createHash("sha256").update(JSON.stringify([state.sessionId, state.runId, resolved.absolutePath, fingerprint])).digest("hex");
        if (ids.has(id)) continue;
        ids.add(id);
        if (run.committed.has(id)) { (result.already_delivered ??= []).push(id); continue; }
        result.files.push({ source, origin: readArtifactOrigin(resolved.root === "project" ? config.projectDir! : config.sessionTaskDir, resolved.rootRelative, facts), id, session_id: state.sessionId, run_id: state.runId, path: resolved.workspaceRelative,
          root: resolved.root, root_path: resolved.root === "project" ? config.projectDir! : config.sessionTaskDir,
          root_relative: resolved.rootRelative, size: facts.size, fingerprint, description: file.summary || basename(resolved.absolutePath),
          mime_type: mimeType(resolved.absolutePath), timestamp: new Date().toISOString() });
      } catch (error) { result.errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return result;
  }

  /** Publish only after the containing tool message or custom entry is durable. */
  publish(result: DeliveryResult): void {
    const run = this.activeRun;
    if (!run || result.session_id !== run.state.sessionId || result.run_id !== run.state.runId) return;
    this.assertActive(run);
    const fresh = result.files.filter(file => !run.committed.has(file.id));
    // The whole result is already durable, even if a transport throws halfway.
    for (const file of fresh) run.committed.add(file.id);
    if (result.source === "explicit") this.context.emitEvent({ type: "delivery", session_id: result.session_id,
      run_id: result.run_id, files: [], requested_files: result.requested_files, delivery_intent: "selected_files" });
    for (const file of fresh) {
      this.context.emitEvent({ type: "delivery", ...file, delivery_intent: result.source === "explicit" ? "selected_files" : undefined });
    }
  }

  async complete(): Promise<void> {
    const config = this.context.getConfig();
    if (config.artifactRunState && config.artifactRunState.manifestOwner !== (config.manifestOwner ?? "hogagent")) throw new Error("Artifact run owner changed before delivery");
    if (this.restricted || config.manifestOwner === "gateway") return;
    const run = this.captureRun();
    run.completion ??= this.completeRun(run).catch(error => { run.completion = undefined; throw error; });
    return run.completion;
  }

  private async completeRun(run: DeliveryRun): Promise<void> {
    const { config, state } = run;
    const decision = effectiveDeliveryDecision(config);
    if (state && !state.invalidDeliverySelection && (!state.deliveryDecision
      || (state.deliveryDecision.mode === "selected_files" && !state.deliveryDecision.files?.length))
      && !run.warned) {
      run.warned = true;
      this.context.emitEvent({ type: "warning", session_id: state.sessionId, message: "未收到有效的非空文件选择，按本轮交付策略处理。" });
    }
    if (decision.mode === "none") return;
    if (state?.invalidDeliverySelection) throw new Error("Invalid nonempty delivery selection; automatic expansion is disabled");
    if (!state || state.reconcileStatus !== "success") throw new Error("Automatic delivery unavailable: no successful reconciliation for this run");
    const files = decision.mode === "selected_files" ? decision.files ?? []
      : state.explicitFiles?.length ? state.explicitFiles.map(file => ({ ...file, path: isAbsolute(file.path) ? file.path : resolve(config.workspaceDir, file.path) })) : resolveManifestDeliveryFiles(this.context, decision);
    if (!files.length) {
      this.context.emitEvent({ type: "warning", session_id: state.sessionId, message: "要求交付文件，但本轮未找到可交付成果（包括新增或改写的 final-output 文件）。" });
      return;
    }
    const persist = this.context.captureDeliveryWriter?.();
    if (!persist) throw new Error("Delivery persistence is unavailable");
    for (let offset = 0; offset < files.length; offset += 50) {
      this.assertActive(run);
      const result = await this.prepareForRun(run, files.slice(offset, offset + 50), "automatic");
      result.files = result.files.filter(file => !run.committed.has(file.id) && run.recoveredReceipts.get(file.path) !== file.fingerprint);
      if (!result.files.length && !result.errors.length) continue;
      await persist(result);
      this.assertActive(run);
      this.publish(result);
      if (result.errors.length) this.context.emitEvent({ type: "warning", session_id: state.sessionId, message: result.errors.join("; ") });
    }
  }
}

function mimeType(path: string): string {
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
    pdf: "application/pdf", json: "application/json", csv: "text/csv", md: "text/markdown", html: "text/html", htm: "text/html", txt: "text/plain" };
  return types[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
