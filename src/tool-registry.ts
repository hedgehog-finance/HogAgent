import type { AgentHarness } from "./vendor/agent/harness/agent-harness.ts";
import type { AgentTool } from "./vendor/agent/types.ts";

export type AgentToolSource = "builtin" | "custom" | "extension" | "external_mcp";

export interface AgentToolRegistration {
  source: AgentToolSource;
  /** Tools with this flag are intentionally unavailable to isolated Sub-Agents. */
  topLevelOnly?: boolean;
}

interface RegisteredAgentTool {
  tool: AgentTool;
  registration: AgentToolRegistration;
}

const toolRegistrations = new WeakMap<object, AgentToolRegistration>();

function rememberRegistration(tool: AgentTool, registration: AgentToolRegistration): void {
  toolRegistrations.set(tool, { ...registration });
}

export function getAgentToolRegistration(tool: AgentTool): AgentToolRegistration | undefined {
  const registration = toolRegistrations.get(tool);
  return registration ? { ...registration } : undefined;
}

export function isTopLevelOnlyTool(tool: AgentTool): boolean {
  return getAgentToolRegistration(tool)?.topLevelOnly === true;
}

/**
 * Process-local source of truth for tools owned by HogAgent.
 *
 * AgentHarness intentionally snapshots its tool array. Keeping ownership here
 * lets session replacement and mode changes obtain a fresh view without
 * modifying the vendored harness implementation.
 */
export class AgentToolRegistry {
  private readonly entries = new Map<string, RegisteredAgentTool>();

  constructor(initial: Array<{ tool: AgentTool; registration: AgentToolRegistration }> = []) {
    for (const entry of initial) this.register(entry.tool, entry.registration);
  }

  register(tool: AgentTool, registration: AgentToolRegistration): void {
    if (!tool?.name) throw new Error("Tool name is required");
    if (this.entries.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    rememberRegistration(tool, registration);
    this.entries.set(tool.name, { tool, registration: { ...registration } });
  }

  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  get(name: string): AgentTool | undefined {
    return this.entries.get(name)?.tool;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  snapshotTopLevel(): AgentTool[] {
    return [...this.entries.values()].map((entry) => entry.tool);
  }

  snapshotSubAgent(): AgentTool[] {
    return [...this.entries.values()]
      .filter((entry) => entry.registration.topLevelOnly !== true)
      .map((entry) => entry.tool);
  }

  namesTopLevel(): string[] {
    return [...this.entries.keys()];
  }

  namesBySource(source: AgentToolSource): string[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.registration.source === source)
      .map(([name]) => name);
  }

  /** Register a related group in one Harness update, keeping existing scoped subsets. */
  async registerOnHarness(harness: AgentHarness, tools: readonly AgentTool[], registration: AgentToolRegistration): Promise<void> {
    await this.updateHarness(harness, () => {
      for (const tool of tools) this.register(tool, registration);
    }, true);
  }

  /** Remove a related group through the same transaction used for registration. */
  async unregisterFromHarness(harness: AgentHarness, names: readonly string[]): Promise<void> {
    if (!names.some(name => this.entries.has(name))) return;
    await this.updateHarness(harness, () => {
      for (const name of names) this.entries.delete(name);
    });
  }

  private async updateHarness(harness: AgentHarness, update: () => void, activateNewTools = false): Promise<void> {
    const previousEntries = new Map(this.entries);
    const previousTools = harness.getTools();
    const previousActiveNames = harness.getActiveTools().map(tool => tool.name);
    const hasPreviousHarness = (): boolean => {
      const tools = harness.getTools();
      return tools.length === previousTools.length && tools.every((tool, index) => tool === previousTools[index])
        && JSON.stringify(harness.getActiveTools().map(tool => tool.name)) === JSON.stringify(previousActiveNames);
    };
    try {
      update();
      await this.syncHarness(harness, activateNewTools);
    } catch (error) {
      this.entries.clear();
      for (const [name, entry] of previousEntries) this.entries.set(name, entry);
      // A failed session write leaves the Harness unchanged. Do not require a
      // second successful disk write merely to restore our in-memory registry.
      if (!hasPreviousHarness()) {
        try {
          await harness.setTools(previousTools, previousActiveNames);
        } catch (rollbackError) {
          // A subscriber can fail after setTools has already restored the state.
          if (!hasPreviousHarness()) throw new AggregateError([error, rollbackError], "Tool update failed and the Harness could not be restored; restart the process before continuing");
        }
      }
      throw error;
    }
  }

  /** Synchronize one Harness while preserving its currently active subset. */
  async syncHarness(harness: AgentHarness, activateNewTools = false): Promise<void> {
    const previousToolNames = harness.getTools().map((tool) => tool.name);
    const previousActiveNames = new Set(harness.getActiveTools().map((tool) => tool.name));
    // A newly registered extension tool should become active only when the
    // Harness previously had its complete tool set active. This keeps the
    // intentionally empty Quick-mode set (and any other scoped subset) empty.
    const wasCompleteSetActive = previousToolNames.every((name) => previousActiveNames.has(name));
    const tools = this.snapshotTopLevel();
    const validNames = new Set(tools.map((tool) => tool.name));
    const activeNames = [...previousActiveNames]
      .filter((name) => validNames.has(name));
    if (activateNewTools && wasCompleteSetActive) {
      for (const tool of tools) {
        if (!activeNames.includes(tool.name)) activeNames.push(tool.name);
      }
    }
    await harness.setTools(tools, activeNames);
  }
}
