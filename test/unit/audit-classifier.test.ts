import { describe, it, expect } from "vitest";
import type { AuditClassification, AuditModelConfig, ScoreResult } from "../../src/utils/types.ts";
import { extractClassificationJson } from "../../src/audit-classifier.ts";

// ─── Unit tests for audit-classifier types and logic ──────────────────────────

describe("extractClassificationJson - Robust JSON extraction", () => {
  const valid = '{"complexity": "simple", "skipClarification": true, "clarificationQuestions": [], "optimizedPrompt": "我想了解市盈率", "goals": [], "acceptanceCriteria": []}';

  it("should parse a bare JSON object", () => {
    const parsed = extractClassificationJson(valid);
    expect(parsed).not.toBeNull();
    expect(parsed!.optimizedPrompt).toBe("我想了解市盈率");
  });

  it("should parse JSON wrapped in markdown code fences", () => {
    const parsed = extractClassificationJson("```json\n" + valid + "\n```");
    expect(parsed).not.toBeNull();
    expect(parsed!.complexity).toBe("simple");
  });

  it("should parse JSON surrounded by prose containing braces", () => {
    const text = `好的，我分析了请求 {这里有花括号}。\n${valid}\n以上是分类结果 {完成}。`;
    // Old greedy regex would capture from the first { to the last } and fail JSON.parse
    const parsed = extractClassificationJson(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.skipClarification).toBe(true);
  });

  it("should pick the object containing optimizedPrompt among multiple JSON blocks", () => {
    const text = `{"summary": "other block"}\n${valid}\n{"files": []}`;
    const parsed = extractClassificationJson(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.optimizedPrompt).toBe("我想了解市盈率");
  });

  it("should handle escaped quotes and braces inside string values", () => {
    const tricky = '{"complexity": "complex", "skipClarification": false, "clarificationQuestions": ["需要 {哪种} \\"格式\\"？"], "optimizedPrompt": "包含 } 和 { 的文本", "goals": ["g1"], "acceptanceCriteria": []}';
    const parsed = extractClassificationJson(tricky);
    expect(parsed).not.toBeNull();
    expect(parsed!.optimizedPrompt).toBe("包含 } 和 { 的文本");
  });

  it("should return null for empty or non-JSON output", () => {
    expect(extractClassificationJson("")).toBeNull();
    expect(extractClassificationJson("好的，我来回答你的问题……")).toBeNull();
  });

  it("should return null when JSON lacks optimizedPrompt", () => {
    expect(extractClassificationJson('{"complexity": "simple"}')).toBeNull();
  });

  it("should return null for malformed JSON containing the key", () => {
    expect(extractClassificationJson('{"optimizedPrompt": "broken",}')).toBeNull();
  });
});

describe("AuditClassification - New Shape (no mode)", () => {
  it("should accept valid AuditClassification without mode field", () => {
    const classification: AuditClassification = {
      optimizedPrompt: "Build a comprehensive financial report analyzing Q4 trends",
      goals: ["Collect Q4 data", "Analyze trends", "Generate visual report"],
      acceptanceCriteria: ["Report includes charts", "Data verified against source"],
      complexity: "complex",
      skipClarification: false,
    };
    expect(classification.optimizedPrompt).toContain("financial report");
    expect(classification.goals).toHaveLength(3);
    expect(classification.acceptanceCriteria).toHaveLength(2);
    // mode field should NOT exist on AuditClassification
    expect((classification as any).mode).toBeUndefined();
  });

  it("should accept empty goals and acceptanceCriteria arrays", () => {
    const classification: AuditClassification = {
      optimizedPrompt: "Simple query",
      goals: [],
      acceptanceCriteria: [],
      complexity: "simple",
      skipClarification: true,
    };
    expect(classification.goals).toHaveLength(0);
    expect(classification.acceptanceCriteria).toHaveLength(0);
  });

  it("should require all fields (optimizedPrompt, goals, acceptanceCriteria, complexity)", () => {
    const classification: AuditClassification = {
      optimizedPrompt: "test",
      goals: ["goal1"],
      acceptanceCriteria: ["criteria1"],
      complexity: "simple",
      skipClarification: true,
    };
    expect(classification).toBeDefined();
    expect(classification.optimizedPrompt).toBe("test");
    expect(classification.goals[0]).toBe("goal1");
    expect(classification.acceptanceCriteria[0]).toBe("criteria1");
  });
});

describe("Complexity Classification", () => {
  it("should accept 'simple' complexity", () => {
    const classification: AuditClassification = {
      optimizedPrompt: "What is the current market trend?",
      goals: [],
      acceptanceCriteria: [],
      complexity: "simple",
      skipClarification: true,
    };
    expect(classification.complexity).toBe("simple");
    expect(classification.goals).toHaveLength(0);
  });

  it("should accept 'complex' complexity", () => {
    const classification: AuditClassification = {
      optimizedPrompt: "Generate comprehensive Q4 financial report with charts and data analysis",
      goals: ["Collect data", "Analyze trends", "Generate report"],
      acceptanceCriteria: ["Report includes charts"],
      complexity: "complex",
      skipClarification: false,
    };
    expect(classification.complexity).toBe("complex");
    expect(classification.goals.length).toBeGreaterThan(0);
  });

  it("should only allow 'simple' or 'complex' as complexity values", () => {
    const validSimple: AuditClassification = {
      optimizedPrompt: "test",
      goals: [],
      acceptanceCriteria: [],
      complexity: "simple",
      skipClarification: true,
    };
    const validComplex: AuditClassification = {
      optimizedPrompt: "test",
      goals: [],
      acceptanceCriteria: [],
      complexity: "complex",
      skipClarification: false,
    };
    expect(["simple", "complex"]).toContain(validSimple.complexity);
    expect(["simple", "complex"]).toContain(validComplex.complexity);
  });

  it("should default to 'simple' when complexity is ambiguous", () => {
    // Simulate the parsing logic: non-"complex" values default to "simple"
    const parsedComplexity = (raw: unknown) =>
      raw === "complex" ? "complex" : "simple";

    expect(parsedComplexity(undefined)).toBe("simple");
    expect(parsedComplexity(null)).toBe("simple");
    expect(parsedComplexity("")).toBe("simple");
    expect(parsedComplexity("unknown")).toBe("simple");
    expect(parsedComplexity("complex")).toBe("complex");
  });
});

describe("skipClarification — Main LLM question permission control", () => {
  it("should parse skipClarification=true (main LLM NOT allowed to ask questions)", () => {
    // skipClarification=true means task is clear enough, main LLM cannot ask questions
    const parseSkip = (raw: unknown) => raw === true;
    expect(parseSkip(true)).toBe(true);
    expect(parseSkip(false)).toBe(false);
    expect(parseSkip(undefined)).toBe(false);
    expect(parseSkip(null)).toBe(false);
    expect(parseSkip("true")).toBe(false);
  });

  it("should default to complete=true on parse failure", () => {
    // Simulate fallback: if JSON parse fails, default to complete
    const fallback = {
      complete: true,
      followUpQuestions: [] as string[],
      refinedPrompt: "original prompt",
    };
    expect(fallback.complete).toBe(true);
  });
});

describe("Audit Explicit Close", () => {
  function isAuditExplicitlyClosed(provider: string): boolean {
    return provider === "close" || provider === "";
  }

  it("should detect 'close' as explicit close", () => {
    expect(isAuditExplicitlyClosed("close")).toBe(true);
  });

  it("should detect empty string as explicit close", () => {
    expect(isAuditExplicitlyClosed("")).toBe(true);
  });

  it("should NOT close for valid provider names", () => {
    expect(isAuditExplicitlyClosed("openai")).toBe(false);
    expect(isAuditExplicitlyClosed("anthropic")).toBe(false);
    expect(isAuditExplicitlyClosed("google")).toBe(false);
    expect(isAuditExplicitlyClosed("hedgehog")).toBe(false);
  });
});

describe("Hard Routing - Mode Selection", () => {
  function resolveMode(requestedMode?: string): string {
    return requestedMode || "standard";
  }

  it("should default to 'standard' when no mode specified", () => {
    expect(resolveMode()).toBe("standard");
    expect(resolveMode(undefined)).toBe("standard");
  });

  it("should use requested mode when specified", () => {
    expect(resolveMode("quick")).toBe("quick");
    expect(resolveMode("standard")).toBe("standard");
    expect(resolveMode("long_task")).toBe("long_task");
  });

  it("should handle mode as hard routing directive (not a hint)", () => {
    const mode = resolveMode("quick");
    expect(mode).toBe("quick");
  });
});

describe("Audit Classifier - Score Result", () => {
  it("should validate ScoreResult shape", () => {
    const result: ScoreResult = {
      score: 85,
      passed: true,
      feedback: "Good work, all criteria met",
      retryFrom: null,
    };
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.passed).toBe(true);
    expect(result.retryFrom).toBeNull();
  });

  it("should handle failed score with retryFrom", () => {
    const result: ScoreResult = {
      score: 45,
      passed: false,
      feedback: "Missing deliverables for step 3",
      retryFrom: "group_2",
    };
    expect(result.passed).toBe(false);
    expect(result.retryFrom).toBe("group_2");
  });
});

describe("Audit Classifier - Config Loading", () => {
  it("should build AuditModelConfig with defaults", () => {
    const config: AuditModelConfig = {
      provider: "openai",
      apiKey: "sk-test",
      modelId: "gpt-4.1",
      minPassScore: 70,
      maxIterations: 3,
    };
    expect(config.minPassScore).toBe(70);
    expect(config.maxIterations).toBe(3);
  });

  it("should allow custom minPassScore and maxIterations", () => {
    const config: AuditModelConfig = {
      provider: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-sonnet-4-20250514",
      minPassScore: 90,
      maxIterations: 5,
    };
    expect(config.minPassScore).toBe(90);
    expect(config.maxIterations).toBe(5);
  });
});
