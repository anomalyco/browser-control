import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { runPlaywrightOperation } from "../src/execute.ts"

describe("execute lifecycle", () => {
  it("bounds a Playwright operation that never settles", async () => {
    const error = await Effect.runPromise(runPlaywrightOperation({
      label: "Close test page",
      timeoutMs: 20,
      run: () => new Promise<void>(() => {}),
    }).pipe(Effect.flip))

    expect(error.message).toBe("Close test page timed out after 20ms")
  })
})
