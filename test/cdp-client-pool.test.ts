import { describe, expect, it } from "vitest"
import { CdpClientPool } from "../src/cdp-client-pool.ts"
import type { ChildTarget, ConnectedTarget } from "../src/relay-types.ts"

const rootTarget: ConnectedTarget = {
  tabId: 7,
  sessionId: "bc-tab-7",
  targetInfo: {
    targetId: "root-7",
    type: "page",
    title: "Root",
    url: "https://example.com/",
    attached: true,
    canAccessOpener: false,
  },
  owner: "user",
}

const childTarget: ChildTarget = {
  tabId: 7,
  sessionId: "chrome-child-7",
  parentSessionId: "bc-tab-7",
  targetInfo: {
    targetId: "child-7",
    type: "iframe",
    title: "Child",
    url: "https://child.example.com/",
    attached: true,
    canAccessOpener: false,
  },
  waitingForDebugger: false,
}

describe("CdpClientPool", () => {
  it("owns registration and cleanup for all per-client state", () => {
    const pool = new CdpClientPool<object>()
    const client = {}
    pool.register(client, "session-a")
    pool.setAutoAttachParams(client, { autoAttach: true, flatten: true })
    const aliasId = pool.createBrowserAlias(client)

    expect(pool.size).toBe(1)
    expect([...pool]).toEqual([client])
    expect(pool.sessionId(client)).toBe("session-a")
    expect(pool.autoAttachParams(client)).toEqual({ autoAttach: true, flatten: true })
    expect(pool.alias(client, aliasId)).toEqual({ kind: "browser" })
    expect(pool.announcements(client)).toBeDefined()

    expect(pool.unregister(client)).toBeTypeOf("number")
    expect(pool.size).toBe(0)
    expect(pool.sessionId(client)).toBeUndefined()
    expect(pool.alias(client, aliasId)).toBeUndefined()
    expect(() => pool.announcements(client)).toThrow("CDP client is not registered")
  })

  it("keeps conflicting auto-attach settings scoped to their clients", () => {
    const pool = new CdpClientPool<object>()
    const first = {}
    const second = {}
    pool.register(first)
    pool.register(second)
    pool.setAutoAttachParams(first, { autoAttach: true, waitForDebuggerOnStart: false })
    pool.setAutoAttachParams(second, { autoAttach: false, waitForDebuggerOnStart: true })

    expect(pool.autoAttachParams(first)).toEqual({ autoAttach: true, waitForDebuggerOnStart: false })
    expect(pool.autoAttachParams(second)).toEqual({ autoAttach: false, waitForDebuggerOnStart: true })
  })

  it("rejects duplicate registration and aliases for unknown clients", () => {
    const pool = new CdpClientPool<object>()
    const client = {}
    pool.register(client)

    expect(() => pool.register(client)).toThrow("CDP client is already registered")
    expect(() => pool.createBrowserAlias({})).toThrow("CDP client is not registered")
  })

  it("invalidates an idle generation when another client registers", () => {
    const pool = new CdpClientPool<object>()
    const first = {}
    pool.register(first)
    const idleGeneration = pool.unregister(first)
    expect(idleGeneration).toBeDefined()
    if (idleGeneration === undefined) throw new Error("Expected idle generation")
    expect(pool.isCurrentIdleGeneration(idleGeneration)).toBe(true)

    pool.register({})
    expect(pool.isCurrentIdleGeneration(idleGeneration)).toBe(false)
  })

  it("produces an idle generation only when the last client leaves", () => {
    const pool = new CdpClientPool<object>()
    const first = {}
    const second = {}
    pool.register(first)
    pool.register(second)

    expect(pool.unregister(first)).toBeUndefined()
    const idleGeneration = pool.unregister(second)
    expect(idleGeneration).toBeDefined()
    expect(pool.unregister(second)).toBeUndefined()
  })

  it("routes root aliases without a Chrome session and child aliases with one", () => {
    const pool = new CdpClientPool<object>()
    const client = {}
    pool.register(client)

    const rootAlias = pool.createTargetAlias(client, rootTarget, rootTarget.sessionId)
    const childAlias = pool.createTargetAlias(client, childTarget, rootTarget.sessionId)

    expect(pool.alias(client, rootAlias)).toEqual({ kind: "target", tabId: 7, targetId: "root-7" })
    expect(pool.alias(client, childAlias)).toEqual({
      kind: "target",
      tabId: 7,
      targetId: "child-7",
      chromeSessionId: "chrome-child-7",
    })
  })

  it("removes matching target aliases across clients without touching browser aliases", () => {
    const pool = new CdpClientPool<object>()
    const first = {}
    const second = {}
    pool.register(first)
    pool.register(second)
    const browserAlias = pool.createBrowserAlias(first)
    const firstTargetAlias = pool.createTargetAlias(first, rootTarget, rootTarget.sessionId)
    const secondTargetAlias = pool.createTargetAlias(second, rootTarget, rootTarget.sessionId)

    pool.removeTargetAliases((alias) => alias.tabId === 7)

    expect(pool.alias(first, browserAlias)).toEqual({ kind: "browser" })
    expect(pool.alias(first, firstTargetAlias)).toBeUndefined()
    expect(pool.alias(second, secondTargetAlias)).toBeUndefined()
  })

  it("can prune one client's target aliases without affecting another client", () => {
    const pool = new CdpClientPool<object>()
    const first = {}
    const second = {}
    pool.register(first)
    pool.register(second)
    const firstAlias = pool.createTargetAlias(first, rootTarget, rootTarget.sessionId)
    const secondAlias = pool.createTargetAlias(second, rootTarget, rootTarget.sessionId)

    pool.removeClientTargetAliases(first, (alias) => alias.tabId === 7)

    expect(pool.alias(first, firstAlias)).toBeUndefined()
    expect(pool.alias(second, secondAlias)).toBeDefined()
  })
})
