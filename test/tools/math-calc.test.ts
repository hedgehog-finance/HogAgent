import { createMathCalcTool } from "../../src/tools/math-calc.ts";

describe("math-calc tool", () => {
  const tool = createMathCalcTool();

  async function evaluate(expression: string, precision?: number) {
    const result = await tool.execute("test-call-id", { expression, precision }) as {
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    };
    return result.content[0].text;
  }

  describe("basic arithmetic", () => {
    it("should add numbers", async () => {
      expect(await evaluate("2 + 3")).toBe("5");
    });

    it("should subtract numbers", async () => {
      expect(await evaluate("10 - 4")).toBe("6");
    });

    it("should multiply numbers", async () => {
      expect(await evaluate("3 * 7")).toBe("21");
    });

    it("should divide numbers", async () => {
      expect(await evaluate("20 / 4")).toBe("5");
    });

    it("should compute modulo", async () => {
      expect(await evaluate("17 % 5")).toBe("2");
    });
  });

  describe("operator precedence", () => {
    it("should respect multiplication over addition", async () => {
      expect(await evaluate("2 + 3 * 4")).toBe("14");
    });

    it("should respect division over subtraction", async () => {
      expect(await evaluate("10 - 6 / 2")).toBe("7");
    });

    it("should handle mixed precedence", async () => {
      expect(await evaluate("2 + 3 * 4 - 1")).toBe("13");
    });
  });

  describe("parentheses", () => {
    it("should override precedence with parentheses", async () => {
      expect(await evaluate("(2 + 3) * 4")).toBe("20");
    });

    it("should handle nested parentheses", async () => {
      expect(await evaluate("((2 + 3) * (4 - 1))")).toBe("15");
    });
  });

  describe("exponents", () => {
    it("should compute power with ^", async () => {
      expect(await evaluate("2 ^ 10")).toBe("1024");
    });

    it("should handle right-associativity", async () => {
      // 2^3^2 = 2^(3^2) = 2^9 = 512
      expect(await evaluate("2 ^ 3 ^ 2")).toBe("512");
    });
  });

  describe("built-in functions", () => {
    it("should compute sqrt", async () => {
      expect(await evaluate("sqrt(16)")).toBe("4");
    });

    it("should compute abs", async () => {
      expect(await evaluate("abs(-5)")).toBe("5");
    });

    it("should compute ceil", async () => {
      expect(await evaluate("ceil(4.2)")).toBe("5");
    });

    it("should compute floor", async () => {
      expect(await evaluate("floor(4.9)")).toBe("4");
    });

    it("should compute round", async () => {
      expect(await evaluate("round(4.5)")).toBe("5");
    });

    it("should compute log (natural log, base e)", async () => {
      const result = await evaluate("log(e)");
      expect(parseFloat(result)).toBeCloseTo(1, 5);
    });

    it("should compute ln (natural log)", async () => {
      const result = await evaluate("ln(e)");
      expect(parseFloat(result)).toBeCloseTo(1, 5);
    });

    it("should compute log10 (common log, base 10)", async () => {
      expect(await evaluate("log10(100)")).toBe("2");
    });

    it("should compute log2 (binary log)", async () => {
      expect(await evaluate("log2(8)")).toBe("3");
    });

    it("should compute sin", async () => {
      const result = await evaluate("sin(0)");
      expect(parseFloat(result)).toBeCloseTo(0, 5);
    });

    it("should compute cos", async () => {
      const result = await evaluate("cos(0)");
      expect(parseFloat(result)).toBeCloseTo(1, 5);
    });

    it("should compute tan", async () => {
      const result = await evaluate("tan(0)");
      expect(parseFloat(result)).toBeCloseTo(0, 5);
    });

    it("should compute factorial", async () => {
      expect(await evaluate("5!")).toBe("120");
    });

    it("should compute cbrt", async () => {
      expect(await evaluate("cbrt(27)")).toBe("3");
    });
  });

  describe("constants", () => {
    it("should recognize pi (lowercase)", async () => {
      const result = await evaluate("pi", 10);
      expect(parseFloat(result)).toBeCloseTo(Math.PI, 8);
    });

    it("should recognize PI (uppercase)", async () => {
      const result = await evaluate("PI", 10);
      expect(parseFloat(result)).toBeCloseTo(Math.PI, 8);
    });

    it("should recognize e (lowercase)", async () => {
      const result = await evaluate("e", 10);
      expect(parseFloat(result)).toBeCloseTo(Math.E, 8);
    });

    it("should recognize E (uppercase)", async () => {
      const result = await evaluate("E", 10);
      expect(parseFloat(result)).toBeCloseTo(Math.E, 8);
    });
  });

  describe("conditional expressions", () => {
    it("should evaluate ternary expressions", async () => {
      expect(await evaluate("pi > 3 ? 1 : 0")).toBe("1");
    });

    it("should evaluate false condition", async () => {
      expect(await evaluate("2 > 5 ? 10 : 20")).toBe("20");
    });
  });

  describe("precision parameter", () => {
    it("should use specified precision", async () => {
      const result = await evaluate("1 / 3", 4);
      expect(result).toBe("0.3333");
    });

    it("should use default precision for integers", async () => {
      expect(await evaluate("6 * 7")).toBe("42");
    });

    it("should cap precision at 15", async () => {
      const result = await evaluate("1 / 7", 20);
      // precision capped at 15
      const parts = result.split(".");
      expect(parts[1]!.length).toBeLessThanOrEqual(15);
    });
  });

  describe("error cases", () => {
    it("should return error for division by zero", async () => {
      const result = await evaluate("1 / 0");
      expect(result).toContain("Error");
      expect(result).toContain("not finite");
    });

    it("should return error for invalid expression", async () => {
      const result = await evaluate("2 *** 3");
      expect(result).toContain("Error");
    });

    it("should return error for undefined variable/function", async () => {
      const result = await evaluate("unknown(5)");
      expect(result).toContain("Error");
    });

    it("should return error for empty expression", async () => {
      const result = await evaluate("");
      expect(result).toContain("Error");
    });
  });

  describe("negative and decimal numbers", () => {
    it("should handle negative numbers", async () => {
      expect(await evaluate("-5 + 3")).toBe("-2");
    });

    it("should handle decimal operations", async () => {
      expect(await evaluate("1.5 * 2.5")).toBe("3.75");
    });

    it("should handle negative exponents", async () => {
      const result = await evaluate("2 ^ -1", 4);
      expect(result).toBe("0.5");
    });

    it("should handle unary minus", async () => {
      expect(await evaluate("-(-5)")).toBe("5");
    });
  });

  describe("nested functions", () => {
    it("should compute sqrt(abs(-16))", async () => {
      expect(await evaluate("sqrt(abs(-16))")).toBe("4");
    });

    it("should compute floor(log(e^3))", async () => {
      const result = await evaluate("floor(log(e^3))");
      expect(parseInt(result)).toBe(3);
    });

    it("should compute abs(ceil(-4.2))", async () => {
      expect(await evaluate("abs(ceil(-4.2))")).toBe("4");
    });
  });

  describe("large numbers", () => {
    it("should handle large multiplication", async () => {
      expect(await evaluate("999999 * 999999")).toBe("999998000001");
    });

    it("should handle large factorials", async () => {
      expect(await evaluate("10!")).toBe("3628800");
    });
  });

  describe("tool metadata", () => {
    it("should have proper tool name and description", () => {
      expect(tool.name).toBe("math_calc");
      expect(tool.description).toContain("mathematical expressions");
    });
  });
});
