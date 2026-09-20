import { describe, expect, it } from "vitest";
import { resolveSandboxMode } from "../../src/config.ts";

describe("sandbox mode compatibility", () => {
  it("defaults to disabled and maps the legacy boolean without overriding an explicit mode", () => {
    expect(resolveSandboxMode({})).toBe("disabled");
    expect(resolveSandboxMode({ sandboxEnabled: false })).toBe("disabled");
    expect(resolveSandboxMode({ sandboxEnabled: true })).toBe("fallback");
    expect(resolveSandboxMode({ sandboxMode: "enabled", sandboxEnabled: false })).toBe("enabled");
    expect(resolveSandboxMode({ sandboxMode: "invalid" as never })).toBe("enabled");
  });
});
