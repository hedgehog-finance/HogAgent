/**
 * Mathematical Calculator Tool
 *
 * Safe mathematical expression evaluator using expr-eval library.
 * Supports arithmetic, exponents, parentheses, trigonometry, logarithms,
 * variables, conditionals, factorials, and more.
 * No eval() or Function() constructor used.
 *
 * Behavior notes:
 * - log(x) and ln(x) → natural logarithm (base e)
 * - log10(x) → common logarithm (base 10)
 * - log2(x) → binary logarithm (base 2)
 */

import { Type, type Static } from "@sinclair/typebox";
import { Parser } from "expr-eval";
import type { AgentTool, AgentToolResult } from "../vendor/agent/types.ts";

// ─── Schema ──────────────────────────────────────────────────────────────────

const MathCalcParams = Type.Object({
  expression: Type.String({ description: "Mathematical expression to evaluate" }),
  precision: Type.Optional(Type.Number({ description: "Decimal precision (default: 10, max: 15)" })),
});

type MathCalcInput = Static<typeof MathCalcParams>;

// ─── Custom Functions ────────────────────────────────────────────────────────

/** Extend expr-eval's built-in functions with additional math functions. */
const customFunctions: Record<string, (...args: number[]) => number> = {
  log10: Math.log10,
  log2: Math.log2,
  cbrt: Math.cbrt,
  hypot: Math.hypot,
  sign: Math.sign,
  trunc: Math.trunc,
};

// ─── Evaluate Expression ─────────────────────────────────────────────────────

function evaluate(expression: string): number {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Empty expression");
  }

  const parser = new Parser();

  // Register lowercase aliases for constants (expr-eval uses PI, E)
  parser.consts["pi"] = Math.PI;
  parser.consts["e"] = Math.E;

  // Register custom functions
  for (const [name, fn] of Object.entries(customFunctions)) {
    parser.functions[name] = fn;
  }

  const result = parser.evaluate(trimmed);

  if (typeof result !== "number") {
    throw new Error(`Expression did not evaluate to a number: got ${typeof result}`);
  }

  if (!isFinite(result)) {
    throw new Error("Result is not finite (overflow or invalid operation)");
  }

  return result;
}

// ─── Tool Factory ────────────────────────────────────────────────────────────

export function createMathCalcTool(): AgentTool {
  return {
    name: "math_calc",
    label: "Mathematical Calculator",
    description:
      "Evaluate mathematical expressions. Supports arithmetic, trig, logarithms, rounding, " +
      "factorial, conditionals, variables (pi, e). " +
      "Note: log(x) is natural log (base e); use log10(x) for base-10 log.",
    parameters: MathCalcParams,
    execute: async (
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      const params = rawParams as MathCalcInput;
      const { expression, precision: rawPrecision } = params;
      const precision = Math.min(Math.max(rawPrecision ?? 10, 0), 15);

      try {
        const result = evaluate(expression);
        const formatted = Number.isInteger(result)
          ? result.toString()
          : result.toFixed(precision).replace(/0+$/, "").replace(/\.$/, "");

        return {
          content: [{ type: "text", text: formatted }],
          details: { expression, result: formatted, precision },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { error: message, expression },
        };
      }
    },
  };
}
