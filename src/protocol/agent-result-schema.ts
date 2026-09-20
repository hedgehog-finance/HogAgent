import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { AgentResultContract } from "./generated-contracts.ts";
import type { DeliveryDecision } from "../utils/types.ts";

export interface LongTaskGroupResult {
  schema_version: "1.0";
  type: "long_task_group_result";
  summary: string;
  content: string;
  output_files: string[];
  notes_for_next_group: string;
}

export interface SubAgentTextResult {
  schema_version: "1.0";
  type: "sub_agent_result";
  summary: string;
  content: string;
  output_files: string[];
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(AgentResultContract);
const definitions = AgentResultContract.$defs;
const validateLongTaskGroup = ajv.compile(definitions.longTaskGroupResult) as ValidateFunction<LongTaskGroupResult>;
const validateSubAgent = ajv.compile(definitions.subAgentResult) as ValidateFunction<SubAgentTextResult>;

function getAgentResultValidator<T>(definition: string): ValidateFunction<T> {
  const validator = ajv.getSchema<T>(`${AgentResultContract.$id}#/$defs/${definition}`);
  if (!validator) throw new Error(`Missing agent result contract definition: ${definition}`);
  return validator;
}

const validateDeliveryDecision = getAgentResultValidator<DeliveryDecision>("deliveryDecision");

export function isDeliveryDecision(value: unknown): value is DeliveryDecision {
  return validateDeliveryDecision(value);
}

function findTrailingSchemaObject<T>(rawText: string, validate: (value: unknown) => value is T): { value: T; contentStart: number } | undefined {
  const trimmed = rawText.trimEnd();
  const withoutClosingFence = trimmed.endsWith("```") ? trimmed.slice(0, -3).trimEnd() : trimmed;
  let index = withoutClosingFence.lastIndexOf("{");
  while (index >= 0) {
    try {
      const parsed: unknown = JSON.parse(withoutClosingFence.slice(index));
      if (validate(parsed)) {
        const prefix = withoutClosingFence.slice(0, index).trimEnd();
        const marker = prefix.endsWith("```json") ? "```json" : prefix.endsWith("```") ? "```" : undefined;
        return { value: parsed, contentStart: marker ? prefix.length - marker.length : index };
      }
    } catch {
      // Try the previous opening brace.
    }
    if (index === 0) break;
    index = withoutClosingFence.lastIndexOf("{", index - 1);
  }
  return undefined;
}

export function parseLongTaskGroupResult(rawText: string): LongTaskGroupResult | undefined {
  return findTrailingSchemaObject(rawText, validateLongTaskGroup)?.value;
}

export function parseSubAgentResult(rawText: string): SubAgentTextResult | undefined {
  return findTrailingSchemaObject(rawText, validateSubAgent)?.value;
}

export function parseDeliveryDecision(rawText: string): DeliveryDecision | undefined {
  return findTrailingSchemaObject(rawText, validateDeliveryDecision)?.value;
}

export function stripDeliveryDecision(rawText: string): string {
  const found = findTrailingSchemaObject(rawText, validateDeliveryDecision);
  return found ? rawText.slice(0, found.contentStart).trimEnd() : rawText;
}

export function stripLongTaskGroupResult(rawText: string): string {
  const found = findTrailingSchemaObject(rawText, validateLongTaskGroup);
  return found ? rawText.slice(0, found.contentStart).trimEnd() : rawText;
}

/** A recognizable nonempty selection must never fall back to unrelated files. */
export function hasInvalidDeliverySelection(rawText: string): boolean {
  return !!findTrailingSchemaObject(rawText, (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return object.type === "delivery_decision" && object.mode === "selected_files"
      && Array.isArray(object.files) && object.files.length > 0 && !validateDeliveryDecision(value);
  });
}
