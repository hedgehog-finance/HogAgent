import { Type, type Static } from "@sinclair/typebox";
import type { HogAgentContext, IExtension } from "../../utils/types.ts";
import type { AgentHarness } from "../../vendor/agent/harness/agent-harness.ts";
import { FileDelivery, isDeliveryResult } from "../../artifacts/file-delivery.ts";

const PARAMETERS = Type.Object({ files: Type.Array(Type.Object({ path: Type.String({ description: "Workspace-relative or managed absolute file path" }), summary: Type.Optional(Type.String()) })) });

/** Compatibility extension: registration and lifecycle only; Manifest remains the index. */
export class DeliveryManagerExtension implements IExtension {
  name = "delivery-manager";
  version = "1.0.0";
  private delivery?: FileDelivery;
  private context?: HogAgentContext;
  private unsubscribe?: () => void;

  setDeliveryRestricted(restricted: boolean): void { if (this.delivery) this.delivery.restricted = restricted; }
  isDeliveryRestricted(): boolean { return this.delivery?.restricted ?? false; }
  /** Compatibility hook. Prompt admission now captures the real file baseline. */
  setAutoDeliveryModifiedAfter(_timestampMs: number | null): void {}

  async initialize(context: HogAgentContext): Promise<void> {
    this.context = context;
    this.delivery = new FileDelivery(context);
    this.onHarnessReplaced(context.getHarness());
    await context.registerTool({
      name: "deliver_files", label: "Deliver Files",
      description: "Deliver existing managed files immediately when the current run permits. Paths are relative to workspaceDir (tasks/<session-id>/report.pdf). Final automatic delivery uses delivery_decision.",
      parameters: PARAMETERS,
      execute: async (_id: string, input: unknown) => {
        try {
          const details = await this.delivery!.prepare((input as Static<typeof PARAMETERS>).files, "explicit");
          const messages = [`Delivered ${details.files.length} file(s): ${details.files.map(file => file.path).join(", ")}`, ...(details.already_delivered?.length ? [`Already delivered ${details.already_delivered.length} unchanged file(s) in this run.`] : []), ...details.errors];
          return { content: [{ type: "text", text: messages.join("\n") }], details };
        } catch (error) { return { content: [{ type: "text", text: String(error) }], isError: true }; }
      },
    }, { source: "extension", topLevelOnly: true });
  }

  onHarnessReplaced(harness: AgentHarness): void {
    this.unsubscribe?.();
    this.unsubscribe = harness.subscribe(event => {
      if (event.type !== "message_end" || event.message.role !== "toolResult" || event.message.toolName !== "deliver_files") return;
      if (isDeliveryResult(event.message.details)) this.delivery?.publish(event.message.details);
    });
  }
  async restoreCompletedDelivery(decision: import("../../utils/types.ts").DeliveryDecision | undefined, previousRunId?: string): Promise<void> {
    await this.delivery?.restoreCompleted(decision, previousRunId);
  }
  async beforeAgentEnd(): Promise<void> {
    const sessionId = this.context?.getSessionId();
    try { await this.delivery?.complete(); }
    catch (error) { this.context?.emitEvent({ type: "warning", session_id: sessionId, message: `自动交付未完成：${String(error)}` }); throw error; }
  }
  async shutdown(): Promise<void> { this.unsubscribe?.(); this.delivery = undefined; }
}
