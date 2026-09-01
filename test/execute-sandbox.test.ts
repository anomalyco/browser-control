import { EventEmitter } from "node:events"
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
  closed = false
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
      for (const event of events) expect(page.listenerCount(event)).toBe(2)

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
