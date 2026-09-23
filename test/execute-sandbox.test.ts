import { EventEmitter } from "node:events"
import { PNG } from "pngjs"
import { Effect, Fiber, Latch } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defaultPageReplacedWarning, ExecuteSandbox, type RequestHandoff } from "../src/execute.ts"
import { awaitHandoffAction } from "../src/handoff.ts"

const { connectOverCDP } = vi.hoisted(() => ({ connectOverCDP: vi.fn<() => Promise<unknown>>() }))

vi.mock("playwright-core", () => ({
  chromium: { connectOverCDP },
  selectors: { register: vi.fn(async () => {}) },
}))

class FakePage extends EventEmitter {
  title = async () => "Fixture"
  closed = false
  readonly screenshot = vi.fn(async () => PNG.sync.write(new PNG({ width: 2, height: 2 })))
  readonly frame = { url: () => this.url() }
  readonly evaluate = vi.fn(async (): Promise<unknown> => {
    if (this.closed) throw new Error("Target page has been closed")
    return true
  })
  readonly waitForEvent = vi.fn(async () => {})
  readonly close = vi.fn(async () => {
    this.closed = true
    this.emit("close")
  })

  constructor(readonly targetId: string, private readonly owner: FakeContext, readonly href = "https://example.test/page") {
    super()
  }

  context() { return this.owner }
  url() { return this.href }
  isClosed() { return this.closed }
  mainFrame() { return this.frame }
}

class FakeContext extends EventEmitter {
  readonly targets: FakePage[] = []
  readonly newPage = vi.fn(async () => this.addPage(`created-${this.targets.length}`))
  readonly newCDPSession = vi.fn(async (page: FakePage) => ({
    send: async () => ({ targetInfo: { targetId: page.targetId } }),
    detach: async () => {},
  }))

  pages() { return this.targets.filter((page) => !page.closed) }

  addPage(targetId: string, href?: string) {
    const page = new FakePage(targetId, this, href)
    this.targets.push(page)
    this.emit("page", page)
    return page
  }
}

function connect(context: FakeContext) {
  const browser = {
    contexts: () => [context],
    isConnected: () => true,
    close: vi.fn(async () => {}),
  }
  // The transport boundary supplies only the Playwright surface these tests use.
  connectOverCDP.mockResolvedValue(browser)
  return browser
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ExecuteSandbox", () => {
  it("model-checks bounded recovery traces against document-local crash evidence", async () => {
    // Exhaustive within this bound, not random sampling. The reference model
    // tracks evidence, not the sandbox's connection/retry implementation.
    const events = ["crash", "main-navigation", "child-navigation", "foreign-crash"] as const
    type Event = typeof events[number]
    const traces: Event[][] = [[]]
    for (let i = 0; i < traces.length; i++) {
      const trace = traces[i]
      if (!trace || trace.length === 4) continue
      for (const event of events) traces.push([...trace, event])
    }
    let checked = 0
    for (const owner of ["relay", "user"] as const) {
      for (const healthy of [false, true]) {
        for (const trace of traces) {
          const label = `${owner}, healthy=${healthy}: ${trace.join(" -> ") || "initial"}`
          const context = new FakeContext()
          connect(context)
          const page = context.addPage("original")
          const unrelated = context.addPage("unrelated")
          const sandbox = new ExecuteSandbox({ endpointUrl: "http://relay.test", pageHealthCheckTimeoutMs: 1_000 })
          sandbox.restore({ id: page.targetId, owner })
          try {
            await Effect.runPromise(sandbox.execute("page.url()"))
            page.evaluate.mockRejectedValue(new Error("Execution context was destroyed"))
            await Effect.runPromise(sandbox.execute("page.evaluate(() => true)"))
            let crashed = false
            for (const event of trace) {
              switch (event) {
                case "crash":
                  crashed = true
                  sandbox.markTargetCrashed(page.targetId)
                  break
                case "main-navigation":
                  crashed = false
                  page.emit("framenavigated", page.mainFrame())
                  break
                case "child-navigation":
                  page.emit("framenavigated", { url: () => "https://child.example.test" })
                  break
                case "foreign-crash":
                  sandbox.markTargetCrashed(unrelated.targetId)
                  break
              }
            }
            // Model the probe outcome directly. Retryable context errors plus a
            // 1ms deadline made healthy cases depend on CI scheduling latency.
            if (healthy) page.evaluate.mockResolvedValue(true)
            else page.evaluate.mockRejectedValue(new Error("Synthetic health probe failure"))
            const result = await Effect.runPromise(sandbox.execute("page.url()"))
            const replace = owner === "relay" && crashed && !healthy
            expect(page.close.mock.calls.length, label).toBe(replace ? 1 : 0)
            expect(context.newPage.mock.calls.length, label).toBe(replace ? 1 : 0)
            expect(result.isError, label).toBe(!healthy && !replace)
            expect(unrelated.close.mock.calls.length, label).toBe(0)
            checked++
          } finally {
            await Effect.runPromise(sandbox.disconnectSettled())
          }
          expect(page.listenerCount("framenavigated"), label).toBe(0)
          expect(page.listenerCount("close"), label).toBe(0)
        }
      }
    }
    expect(checked).toBe(1364)
  }, 30_000)

  it("finishes an execute with a stalled title and keeps the adopted page usable", async () => {
    vi.useFakeTimers()
    const context = new FakeContext()
    const page = context.addPage("stalled-title")
    page.title = () => new Promise(() => {})
    connect(context)
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://relay.test" })
    try {
      await Effect.runPromise(sandbox.adoptPage({ targetId: page.targetId, url: page.url() }))
      const read = Effect.runPromise(sandbox.execute("return await page.title()"))
      await vi.advanceTimersByTimeAsync(5_100)
      expect(await read).toMatchObject({ isError: true, text: expect.stringContaining("page.title() timed out") })
      expect(await Effect.runPromise(sandbox.execute("return page.url()"))).toMatchObject({ isError: false, value: page.url() })
      expect(page.close).not.toHaveBeenCalled()
    } finally {
      await Effect.runPromise(sandbox.disconnectSettled())
      vi.useRealTimers()
    }
  })
  it("binds screenshotDiff to the session page and returns its image as execute media", async () => {
    const context = new FakeContext()
    connect(context)
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://relay.test" })
    try {
      const result = await Effect.runPromise(sandbox.execute("state.before = await page.screenshot(); return await screenshotDiff({ baseline: state.before })"))
      expect(result).toMatchObject({ isError: false, value: { matches: true, changedPixels: 0, changedRatio: 0 } })
      expect(result.media).toHaveLength(1)
      expect(result.media?.[0]).toMatchObject({ mimeType: "image/png" })
      expect(context.targets[0]?.screenshot).toHaveBeenLastCalledWith({ type: "png", scale: "css", fullPage: false })
    } finally {
      await Effect.runPromise(sandbox.closeSettled())
    }
  })
  it.each(["success", "failure"] as const)("awaits owned page close %s before disconnecting and cleans only its own listeners", async (outcome) => {
    await Effect.runPromise(Effect.gen(function* () {
      const context = new FakeContext()
      const browser = connect(context)
      const onDefaultTargetChange = vi.fn()
      const sandbox = new ExecuteSandbox({ endpointUrl: "http://relay.test", onDefaultTargetChange })
      expect(yield* sandbox.execute("state.saved = 42")).toMatchObject({ isError: false })
      const page = context.targets[0]
      if (!page) throw new Error("Expected a relay-owned page")
      page.evaluate.mockResolvedValue({ entries: [{ depth: 0, role: "link", name: "Next", selector: "#next" }], truncated: false })
      const events = ["close", "framenavigated", "request", "response", "requestfinished", "requestfailed"]
      const sentinel = vi.fn()
      for (const event of events) page.on(event, sentinel)
      expect(yield* sandbox.execute("await network.start(); await snapshot()")).toMatchObject({ isError: false })
      for (const event of events) expect(page.listenerCount(event)).toBe(event === "framenavigated" ? 3 : 2)

      const pageClosing = yield* Latch.make()
      const releasePage = yield* Latch.make()
      const browserClosing = yield* Latch.make()
      const releaseBrowser = yield* Latch.make()
      page.close.mockImplementation(async () => {
        pageClosing.openUnsafe()
        await Effect.runPromise(releasePage.await)
        if (outcome === "failure") throw new Error("Page close failed")
        page.closed = true
        page.emit("close")
      })
      browser.close.mockImplementation(async () => {
        browserClosing.openUnsafe()
        await Effect.runPromise(releaseBrowser.await)
      })
      const closing = yield* Effect.forkChild(sandbox.closeSettled())
      yield* pageClosing.await
      yield* TestClock.adjust("3 seconds")
      expect(closing.pollUnsafe()).toBeUndefined()
      expect(browser.close).not.toHaveBeenCalled()
      expect(sandbox.networkStatus().active).toBe(false)
      expect(sandbox.getStatus()).toMatchObject({ connected: false, pageUrl: null, stateKeys: ["saved"] })
      expect(onDefaultTargetChange.mock.calls).toEqual([[{ id: page.targetId, owner: "relay" }], [undefined]])
      for (const event of events) expect(page.listeners(event)).toEqual([sentinel])

      yield* releasePage.open
      yield* browserClosing.await
      yield* TestClock.adjust("3 seconds")
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* releaseBrowser.open
      yield* Fiber.join(closing)
      expect(page.close).toHaveBeenCalledOnce()
      expect(browser.close).toHaveBeenCalledOnce()
      expect(onDefaultTargetChange).toHaveBeenCalledTimes(2)

      expect(yield* sandbox.execute("state.saved")).toMatchObject({ value: 42, isError: false })
      expect(yield* sandbox.execute('ref("e1")')).toMatchObject({ isError: true, text: expect.stringContaining("Snapshot refs are stale") })
      expect(yield* sandbox.execute("snapshot({ diff: true })")).toMatchObject({ isError: true, text: expect.stringContaining("requires a previous snapshot() baseline") })
      const changes = onDefaultTargetChange.mock.calls.length
      page.emit("close")
      expect(onDefaultTargetChange).toHaveBeenCalledTimes(changes)
      expect(sandbox.getStatus().connected).toBe(true)
      yield* sandbox.closeSettled()
    }).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["relay", "user"] as const)("disconnects without closing or forgetting a %s-owned target", async (owner) => {
    await Effect.runPromise(Effect.gen(function* () {
      const context = new FakeContext()
      const browser = connect(context)
      const onDefaultTargetChange = vi.fn()
      const sandbox = new ExecuteSandbox({ endpointUrl: "http://relay.test", onDefaultTargetChange })
      if (owner === "user") {
        const adopted = context.addPage("adopted")
        yield* sandbox.adoptPage({ targetId: adopted.targetId, url: adopted.url() })
      }
      expect(yield* sandbox.execute("state.saved = 42; await network.start()")).toMatchObject({ isError: false })
      const page = context.targets[0]
      if (!page) throw new Error("Expected a default page")
      page.evaluate.mockResolvedValue({ entries: [], truncated: false })
      expect(yield* sandbox.execute("snapshot()")).toMatchObject({ isError: false })
      const changes = onDefaultTargetChange.mock.calls.length
      const closing = yield* Latch.make()
      const release = yield* Latch.make()
      browser.close.mockImplementation(async () => {
        closing.openUnsafe()
        await Effect.runPromise(release.await)
      })

      const disconnecting = yield* Effect.forkChild(sandbox.disconnectSettled())
      yield* closing.await
      yield* TestClock.adjust("3 seconds")
      expect(disconnecting.pollUnsafe()).toBeUndefined()
      expect(page.close).not.toHaveBeenCalled()
      expect(onDefaultTargetChange).toHaveBeenCalledTimes(changes)
      expect(sandbox.networkStatus().active).toBe(false)
      expect(page.eventNames()).toEqual([])
      yield* release.open
      yield* Fiber.join(disconnecting)

      const nextContext = new FakeContext()
      const decoy = nextContext.addPage("decoy", page.url())
      const rebound = nextContext.addPage(page.targetId, page.url())
      connect(nextContext)
      expect(yield* sandbox.execute("state.saved")).toMatchObject({ isError: false, value: 42, warnings: [] })
      expect(nextContext.newPage).not.toHaveBeenCalled()
      expect(rebound.listenerCount("close")).toBe(1)
      expect(decoy.listenerCount("close")).toBe(0)
      page.emit("close")
      expect(onDefaultTargetChange).toHaveBeenCalledTimes(changes)
      expect(sandbox.getStatus().connected).toBe(true)
      expect(yield* sandbox.execute("snapshot({ diff: true })")).toMatchObject({ isError: true, text: expect.stringContaining("requires a previous snapshot() baseline") })
      yield* sandbox.closeSettled()
      expect(rebound.close).toHaveBeenCalledTimes(owner === "relay" ? 1 : 0)
      expect(decoy.close).not.toHaveBeenCalled()
      expect(onDefaultTargetChange.mock.calls.at(-1)).toEqual([undefined])
    }).pipe(Effect.provide(TestClock.layer())))
  })

  it.each(["explicit selection", "non-default page"] as const)("checks the actual handoff destination for %s", async (mode) => {
    const context = new FakeContext()
    connect(context)
    const requestHandoff = vi.fn(async () => "resolved" as const)
    const onDefaultTargetChange = vi.fn()
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://relay.test", requestHandoff, onDefaultTargetChange })
    if (mode === "non-default page") {
      expect((await Effect.runPromise(sandbox.execute("page.url()"))).isError).toBe(false)
    } else {
      context.addPage("decoy")
    }
    const selected = context.addPage("handoff", "https://example.test/handoff")
    selected.evaluate.mockRejectedValue(new Error("Handoff destination unavailable"))
    const changes = onDefaultTargetChange.mock.calls.length
    const creations = context.newPage.mock.calls.length

    const result = await Effect.runPromise(mode === "explicit selection"
      ? sandbox.execute('await handoff("Continue")', { targetSelection: { index: 1 } })
      : sandbox.execute('await handoff("Continue", { page: context.pages()[1] })'))

    expect(requestHandoff).toHaveBeenCalledWith(expect.objectContaining({ target: { targetId: "handoff" } }))
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining("Handoff destination unavailable") })
    expect(selected.evaluate).toHaveBeenCalledOnce()
    expect(context.newPage).toHaveBeenCalledTimes(creations)
    expect(onDefaultTargetChange).toHaveBeenCalledTimes(changes)
    await Effect.runPromise(sandbox.closeSettled())
  })

  it("does not carry a retired target's crash into its unresponsive replacement", async () => {
    const context = new FakeContext()
    connect(context)
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://relay.test", pageHealthCheckTimeoutMs: 10 })
    try {
      expect(await Effect.runPromise(sandbox.execute("page.url()"))).toMatchObject({ isError: false })
      const previous = context.targets[0]
      if (!previous) throw new Error("Expected a default page")
      const replacement = context.addPage("replacement", "https://example.test/restored-form")
      const unrelated = context.addPage("unrelated")
      replacement.evaluate.mockRejectedValue(new Error("Execution context was destroyed"))
      expect(sandbox.markTargetCrashed(previous.targetId)).toBe(true)
      expect(sandbox.markTargetReplaced(previous.targetId, replacement.targetId)).toBe(true)
      previous.closed = true
      previous.emit("close")

      await Effect.runPromise(sandbox.execute("page.evaluate(() => true)"))
      const result = await Effect.runPromise(sandbox.execute("page.url()"))
      expect(replacement.close).not.toHaveBeenCalled()
      expect(unrelated.close).not.toHaveBeenCalled()
      expect(context.newPage).toHaveBeenCalledOnce()
      expect(result).toMatchObject({ isError: true, diagnostic: "session-page/owned-unresponsive" })
    } finally {
      await Effect.runPromise(sandbox.disconnectSettled())
    }
  })

  it("forgets a recovered document's crash after main-frame navigation", async () => {
    const context = new FakeContext()
    connect(context)
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://relay.test", pageHealthCheckTimeoutMs: 10 })
    try {
      await Effect.runPromise(sandbox.execute("page.url()"))
      const page = context.targets[0]
      if (!page) throw new Error("Expected a default page")
      sandbox.markTargetCrashed(page.targetId)
      page.emit("framenavigated", page.mainFrame())
      page.evaluate.mockRejectedValue(new Error("Execution context was destroyed"))
      const result = await Effect.runPromise(sandbox.execute("page.url()"))
      expect(page.close).not.toHaveBeenCalled()
      expect(result).toMatchObject({ isError: true, diagnostic: "session-page/owned-unresponsive" })
    } finally {
      await Effect.runPromise(sandbox.disconnectSettled())
    }
  })

  it("reacquires the exact replacement target when the handoff began on the default page", async () => {
    const context = new FakeContext()
    connect(context)
    const requestHandoff = vi.fn<RequestHandoff>()
    const onDefaultTargetChange = vi.fn()
    const sandbox = new ExecuteSandbox({ endpointUrl: "http://relay.test", requestHandoff, onDefaultTargetChange })
    expect(await Effect.runPromise(sandbox.execute("state.saved = 42"))).toMatchObject({ isError: false })
    const previous = context.targets[0]
    if (!previous) throw new Error("Expected a default page")
    const decoy = context.addPage("decoy", previous.url())
    const replacement = context.addPage("replacement", previous.url())
    requestHandoff.mockImplementation(async ({ target }) => {
      expect(target.targetId).toBe(previous.targetId)
      expect(sandbox.markTargetReplaced(previous.targetId, replacement.targetId)).toBe(true)
      previous.closed = true
      previous.emit("close")
      return "resolved"
    })

    expect(await Effect.runPromise(sandbox.execute('await handoff("Continue"); return null'))).toMatchObject({
      isError: false,
      warnings: [defaultPageReplacedWarning],
      aftermath: { handoffs: 1 },
    })
    expect(replacement.evaluate).toHaveBeenCalledOnce()
    expect(previous.evaluate).not.toHaveBeenCalled()
    expect(decoy.evaluate).not.toHaveBeenCalled()
    expect(context.newPage).toHaveBeenCalledOnce()
    expect(onDefaultTargetChange.mock.calls).toEqual([[{ id: previous.targetId, owner: "relay" }]])
    expect(await Effect.runPromise(sandbox.execute("state.saved"))).toMatchObject({ value: 42, warnings: [] })
    await replacement.close()
    expect(onDefaultTargetChange.mock.calls.at(-1)).toEqual([undefined])
    await Effect.runPromise(sandbox.closeSettled())
  })

  it("fails a stale non-default handoff page rather than checking a different page", async () => {
    const context = new FakeContext()
    connect(context)
    const selected = context.addPage("selected")
    const replacement = context.addPage("replacement", selected.url())
    const sandbox = new ExecuteSandbox({
      endpointUrl: "http://relay.test",
      requestHandoff: async () => {
        await selected.close()
        return "resolved"
      },
    })
    expect(await Effect.runPromise(sandbox.execute('await handoff("Continue")', { targetSelection: { index: 0 } }))).toMatchObject({
      isError: true,
      text: expect.stringContaining("Target page has been closed"),
    })
    expect(context.newPage).not.toHaveBeenCalled()
    expect(replacement.evaluate).not.toHaveBeenCalled()
    await Effect.runPromise(sandbox.closeSettled())
  })

  it("waits for actual disconnection when cancelling a non-settling handoff action", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const context = new FakeContext()
      const browser = connect(context)
      const closing = yield* Latch.make()
      const release = yield* Latch.make()
      browser.close.mockImplementation(async () => {
        closing.openUnsafe()
        await Effect.runPromise(release.await)
      })
      const sandbox = new ExecuteSandbox({
        endpointUrl: "http://relay.test",
        requestHandoff: (request) => awaitHandoffAction({
          ...request,
          outcome: Promise.resolve("timeout"),
          cancel: () => {},
        }),
      })
      const execute = yield* Effect.forkChild(sandbox.execute('await handoff("Continue", { start: () => new Promise(() => {}) })'))
      yield* closing.await
      yield* TestClock.adjust("3 seconds")
      expect(execute.pollUnsafe()).toBeUndefined()
      yield* release.open
      expect(yield* Fiber.join(execute)).toMatchObject({ isError: true, text: expect.stringContaining("Handoff timed out") })
      const page = context.targets[0]
      if (!page) throw new Error("Expected a default page")
      expect(page.close).not.toHaveBeenCalled()
      expect(page.eventNames()).toEqual([])
    }).pipe(Effect.provide(TestClock.layer())))
  })
})
