import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { TabActivity } from "../src/tab-activity.ts"
import type { ConnectedTarget } from "../src/relay-types.ts"

describe("tab activity", () => {
  it("focus lasts only through the last overlapping execute and can be reacquired", async () => {
    const calls: Array<[number, boolean]> = []
    const activity = new TabActivity((id, enabled) => Effect.sync(() => { calls.push([id, enabled]) }))
    await Effect.runPromise(Effect.gen(function* () {
      yield* activity.focus(1, "a")
      yield* activity.focus(1, "a")
      yield* activity.focus(1, "b")
      yield* activity.finish("a")
      expect(calls).toEqual([[1, true]])
      yield* activity.finish("b")
      yield* activity.focus(1, "a")
      yield* activity.finish("a")
    }))
    expect(calls).toEqual([[1, true], [1, false], [1, true], [1, false]])
  })

  it("only idle user tabs become detach candidates at 15 minutes", async () => {
    const activity = new TabActivity(() => Effect.void)
    const targets: ConnectedTarget[] = ["user", "relay", "user"].map((owner, index) => ({
      tabId: index, sessionId: String(index), owner: owner === "relay" ? "relay" : "user",
      targetInfo: { targetId: String(index), type: "page", title: "", url: "about:blank", attached: true, canAccessOpener: false },
    }))
    for (const target of targets) activity.touch(target.tabId, 0)
    expect(activity.idleUserTargets(targets, 899_999, 900_000)).toEqual([])
    await Effect.runPromise(activity.focus(2, "running"))
    expect(activity.idleUserTargets(targets, 900_000, 900_000).map((target) => target.tabId)).toEqual([0])
    activity.touch(0, 900_000)
    expect(activity.idleUserTargets(targets, 900_001, 900_000)).toEqual([])
    activity.forget(2)
    expect(activity.idleUserTargets(targets, 900_001, 900_000)).toEqual([])
  })
})
