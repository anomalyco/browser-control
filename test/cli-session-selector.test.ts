import { describe, expect, it } from "vitest"
import { resolveExplicitSessionSelector } from "../src/cli-session-selector.ts"

describe("resolveExplicitSessionSelector", () => {
  it("accepts positional, flag, and environment selectors in precedence order", () => {
    expect(resolveExplicitSessionSelector({ positional: "positional", flag: undefined, environment: "environment" })).toBe("positional")
    expect(resolveExplicitSessionSelector({ positional: undefined, flag: "flag", environment: "environment" })).toBe("flag")
    expect(resolveExplicitSessionSelector({ positional: undefined, flag: undefined, environment: "environment" })).toBe("environment")
    expect(resolveExplicitSessionSelector({ positional: undefined, flag: undefined, environment: undefined })).toBeUndefined()
  })

  it("rejects combining positional and flag selectors", () => {
    expect(() => resolveExplicitSessionSelector({
      positional: "positional",
      flag: "flag",
      environment: undefined,
    })).toThrow("Use either a positional session id or --session, not both")
  })
})
