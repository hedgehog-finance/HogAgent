import { AsyncLocalStorage } from 'node:async_hooks';

export type InstructionScope = 'main' | 'planning' | 'long_task_group' | 'classification' | 'audit' | 'sub_agent' | 'isolated';

// A Harness is reused across long_task phases. Scope belongs to the invocation,
// not to the workspace snapshot shared by concurrently running child agents.
const scopes = new AsyncLocalStorage<InstructionScope>();

export function getInstructionScope(): InstructionScope { return scopes.getStore() ?? 'main'; }
export function withInstructionScope<T>(scope: InstructionScope, run: () => T): T { return scopes.run(scope, run); }

export function formatInstructionScope(scope: InstructionScope, tools: readonly string[]): string {
  const role: Record<InstructionScope, string> = {
    main: 'Top-level conversation completion. Follow the current run response schema and delivery policy.',
    planning: 'Internal planning only. Read relevant instructions if read is available; do not execute business tasks. Return the requested plan JSON array, or an explicitly allowed clarification.',
    long_task_group: 'Internal execution group. Return long_task_group_result, or an explicitly allowed clarification. Defer conversation delivery until top-level completion.',
    classification: 'Internal intent classification only. Do not execute the task or add output requirements. Return the requested classification JSON.',
    audit: 'Internal read-only verification. Evaluate the requested task and evidence; do not execute or repair it. Submit the score through submit_score. Do not penalize internal responses for omitting a conversation delivery envelope.',
    sub_agent: 'Child execution. Return sub_agent_result to the parent; no conversation delivery authority.',
    isolated: 'Isolated stateless request. Return only the requested response/schema; no conversation or child execution state is available.',
  };
  return `\n\n<invocation_scope name="${scope}">\n${role[scope]}\n` +
    'This scope selects which inherited response-format rules apply; all inherited access, Skill and run policy constraints still apply. Enclosing conversation metadata does not change this invocation scope.\n' +
    (scope === 'main' ? '' : 'Do not append delivery_decision or other conversation-only formatting to this internal response.\n') +
    `Available tools for this invocation: ${tools.length ? tools.join(', ') : 'none'}. Never claim or invoke unavailable capabilities.\n</invocation_scope>`;
}
