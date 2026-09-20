import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getProjectRoot } from './config.ts';

export interface InstructionSnapshot {
  readonly system: string;
  readonly workspace: string;
  readonly supplement: string;
  readonly processInstructions: readonly string[];
}

const executions = new Map<string, Readonly<InstructionSnapshot>>();

function optionalFile(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export function readInstructionSnapshot(workspace: string): Readonly<InstructionSnapshot> {
  const managed = process.env.HOGAGENT_GATEWAY_MANAGED === '1';
  const system = readFileSync(join(getProjectRoot(), 'SYSTEM.md'), 'utf8');
  const root = optionalFile(join(workspace, 'AGENTS.md'));
  if (managed && !root?.trim()) throw new Error('Required workspace AGENTS.md is missing or empty; reconnect Gateway to repair it');
  if (!system.trim()) throw new Error('Required SYSTEM.md is empty');
  return Object.freeze({
    system: managed ? system : system + '\n\n' + readFileSync(join(getProjectRoot(), 'STANDALONE.md'), 'utf8'),
    workspace: root ?? optionalFile(join(getProjectRoot(), 'AGENTS.md')) ?? '',
    supplement: optionalFile(join(workspace, '.hogagent', 'hogagent.md')) ?? '',
    processInstructions: Object.freeze(parseGatewayProcessInstructions()),
  });
}

/** Called once around the outer prompt, never on internal agent_end/compaction events. */
export function beginInstructionSnapshot(workspace: string): void {
  const key = resolve(workspace);
  if (executions.has(key)) throw new Error('A prompt already owns the workspace instruction snapshot');
  executions.set(key, readInstructionSnapshot(workspace));
}

export function endInstructionSnapshot(workspace: string): void { executions.delete(resolve(workspace)); }

/** Sub-agents and rebuilt Harnesses inherit the active top-level snapshot. */
export function getInstructionSnapshot(workspace: string): Readonly<InstructionSnapshot> {
  return executions.get(resolve(workspace)) ?? readInstructionSnapshot(workspace);
}

export function hasInstructionSnapshot(workspace: string): boolean { return executions.has(resolve(workspace)); }

export function parseGatewayProcessInstructions(raw = process.env.HOGAGENT_GATEWAY_PROCESS_INSTRUCTIONS): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean)
      : [];
  } catch { return []; }
}

/** Common immutable layers, reused by main, child, audit and stateless calls. */
export function buildInstructionPrompt(workspace: string): string {
  const rules = getInstructionSnapshot(workspace);
  let prompt = rules.system;
  if (rules.workspace) prompt += '\n\n<workspace_instructions>\n' + rules.workspace + '\n</workspace_instructions>';
  if (rules.supplement) prompt += '\n\n<hogagent_instructions>\n' + rules.supplement + '\n</hogagent_instructions>';
  if (rules.processInstructions.length) {
    const json = JSON.stringify(rules.processInstructions).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
    prompt += `\n\n<gateway_process_instructions>\n${json}\n</gateway_process_instructions>`;
  }
  return prompt;
}
