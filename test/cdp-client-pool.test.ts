import { describe, expect, it } from "vitest"
import { CdpClientPool, ClientCdpSessionAlias } from "../src/cdp-client-pool.ts"
import type { CdpEvent } from "../src/protocol.ts"
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

const grandchildTarget: ChildTarget = {
  ...childTarget,
  sessionId: "chrome-grandchild-7",
  parentSessionId: childTarget.sessionId,
  targetInfo: { ...childTarget.targetInfo, targetId: "grandchild-7" },
}

function setup() {
  const pool = new CdpClientPool<{ events: CdpEvent[] }>((client, event) => client.events.push(event))
  const client: { events: CdpEvent[] } = { events: [] }
  pool.register(client)
  return { pool, client, events: client.events }
}

describe("CdpClientPool", () => {
  it("treats named external clients as raw unless they identify a sandbox transport", () => {
    const pool = new CdpClientPool<object>(() => {})
    const named = {}, sandbox = {}, unnamed = {}
    pool.register(named, "alpha")
    pool.register(sandbox, "alpha", "sandbox")
    pool.register(unnamed, undefined, "sandbox")
    expect(pool.isSandbox(named)).toBe(false)
    expect(pool.isSandbox(sandbox)).toBe(true)
    expect(pool.isSandbox(unnamed)).toBe(false)
    pool.unregister(sandbox)
    expect(pool.isSandbox(sandbox)).toBe(false)
  })
  it("owns registration and cleanup for all per-client state", () => {
    const pool = new CdpClientPool<object>(() => {})
    const client = {}
    pool.register(client, "session-a")
    pool.setAutoAttachParams(client, { autoAttach: true, flatten: true })
    const aliasId = pool.createBrowserAlias(client)
    pool.announce(client, rootTarget)

    expect(pool.size).toBe(1)
    expect([...pool]).toEqual([client])
    expect(pool.sessionId(client)).toBe("session-a")
    expect(pool.autoAttachParams(client)).toEqual({ autoAttach: true, flatten: true })
    expect(pool.alias(client, aliasId)).toEqual(ClientCdpSessionAlias.Browser())
    expect(pool.hasSession(client, rootTarget.sessionId)).toBe(true)

    expect(pool.unregister(client)).toBeTypeOf("number")
    expect(pool.size).toBe(0)
    expect(pool.sessionId(client)).toBeUndefined()
    expect(pool.alias(client, aliasId)).toBeUndefined()
    expect(pool.autoAttachParams(client)).toBeUndefined()
    expect(pool.hasSession(client, rootTarget.sessionId)).toBe(false)

    pool.register(client)
    expect(pool.hasSession(client, rootTarget.sessionId)).toBe(false)
    expect(pool.alias(client, aliasId)).toBeUndefined()
  })

  it("keeps conflicting auto-attach settings scoped to their clients", () => {
    const pool = new CdpClientPool<object>(() => {})
    const first = {}
    const second = {}
    pool.register(first)
    pool.register(second)
    pool.setAutoAttachParams(first, { autoAttach: true, waitForDebuggerOnStart: false })
    pool.setAutoAttachParams(second, { autoAttach: false, waitForDebuggerOnStart: true })

    expect(pool.autoAttachParams(first)).toEqual({ autoAttach: true, waitForDebuggerOnStart: false })
    expect(pool.autoAttachParams(second)).toEqual({ autoAttach: false, waitForDebuggerOnStart: true })
    pool.setAutoAttachParams(first, undefined)
    expect(pool.autoAttachParams(first)).toBeUndefined()
    expect(pool.autoAttachParams(second)).toEqual({ autoAttach: false, waitForDebuggerOnStart: true })
  })

  it("rejects duplicate registration and aliases for unknown clients", () => {
    const pool = new CdpClientPool<object>(() => {})
    const client = {}
    pool.register(client)

    expect(() => pool.register(client)).toThrow("CDP client is already registered")
    expect(() => pool.createBrowserAlias({})).toThrow("CDP client is not registered")
    expect(() => pool.announce({}, rootTarget)).toThrow("CDP client is not registered")
  })

  it("invalidates an idle generation when another client registers", () => {
    const pool = new CdpClientPool<object>(() => {})
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
    const pool = new CdpClientPool<object>(() => {})
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
    const pool = new CdpClientPool<object>(() => {})
    const client = {}
    pool.register(client)

    const rootAlias = pool.createTargetAlias(client, rootTarget)
    const childAlias = pool.createTargetAlias(client, childTarget)

    expect(pool.alias(client, rootAlias)).toEqual(ClientCdpSessionAlias.Target({ tabId: 7, targetId: "root-7" }))
    expect(pool.alias(client, childAlias)).toEqual(ClientCdpSessionAlias.Target({
      tabId: 7,
      targetId: "child-7",
      chromeSessionId: "chrome-child-7",
    }))
  })

  it("detaches alias-only tabs across clients without touching browser aliases or other tabs", () => {
    const pool = new CdpClientPool<object>(() => {})
    const first = {}
    const second = {}
    pool.register(first)
    pool.register(second)
    const browserAlias = pool.createBrowserAlias(first)
    const firstTargetAlias = pool.createTargetAlias(first, rootTarget)
    const secondTargetAlias = pool.createTargetAlias(second, childTarget)
    const otherAlias = pool.createTargetAlias(first, {
      ...rootTarget,
      tabId: 8,
      sessionId: "bc-tab-8",
      targetInfo: { ...rootTarget.targetInfo, targetId: "root-8" },
    })

    pool.detachTab(7)
    pool.detachTab(7)

    expect(pool.alias(first, browserAlias)).toEqual(ClientCdpSessionAlias.Browser())
    expect(pool.alias(first, firstTargetAlias)).toBeUndefined()
    expect(pool.alias(second, secondTargetAlias)).toBeUndefined()
    expect(pool.alias(first, otherAlias)).toBeDefined()
  })

  it("prunes hidden alias-only targets for one client without touching another client", () => {
    const pool = new CdpClientPool<object>(() => {})
    const first = {}
    const second = {}
    pool.register(first)
    pool.register(second)
    const firstAlias = pool.createTargetAlias(first, rootTarget)
    const secondAlias = pool.createTargetAlias(second, rootTarget)
    const browserAlias = pool.createBrowserAlias(first)

    pool.pruneInvisible(first, (tabId) => tabId !== 7)

    expect(pool.alias(first, firstAlias)).toBeUndefined()
    expect(pool.alias(second, secondAlias)).toBeDefined()
    expect(pool.alias(first, browserAlias)).toEqual(ClientCdpSessionAlias.Browser())
  })

  it("announces roots and children once per client with the correct parent envelope", () => {
    const { pool, client, events } = setup()
    const other: { events: CdpEvent[] } = { events: [] }
    pool.register(other)

    pool.announce(client, rootTarget)
    pool.announce(client, rootTarget)
    pool.announce(client, childTarget)
    pool.announce(client, childTarget)

    expect(events).toEqual([
      {
        method: "Target.attachedToTarget",
        params: { sessionId: rootTarget.sessionId, targetInfo: rootTarget.targetInfo, waitingForDebugger: false },
      },
      {
        sessionId: rootTarget.sessionId,
        method: "Target.attachedToTarget",
        params: { sessionId: childTarget.sessionId, targetInfo: childTarget.targetInfo, waitingForDebugger: false },
      },
    ])
    expect(other.events).toEqual([])
    expect(pool.hasSession(other, rootTarget.sessionId)).toBe(false)

    pool.announce(other, rootTarget)
    expect(other.events).toEqual([events[0]])
    expect(events).toHaveLength(2)
  })

  it("replaces the same target id under a new session after purging descendants and aliases", () => {
    const { pool, client, events } = setup()
    const aliases = [rootTarget, childTarget, grandchildTarget].map((target) => {
      pool.announce(client, target)
      return pool.createTargetAlias(client, target)
    })
    const browserAlias = pool.createBrowserAlias(client)
    events.length = 0

    pool.announce(client, { ...rootTarget, sessionId: "replacement-root-session" })

    expect(events).toEqual([
      {
        sessionId: childTarget.sessionId,
        method: "Target.detachedFromTarget",
        params: { sessionId: grandchildTarget.sessionId, targetId: grandchildTarget.targetInfo.targetId },
      },
      {
        sessionId: rootTarget.sessionId,
        method: "Target.detachedFromTarget",
        params: { sessionId: childTarget.sessionId, targetId: childTarget.targetInfo.targetId },
      },
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: rootTarget.sessionId, targetId: rootTarget.targetInfo.targetId },
      },
      {
        method: "Target.attachedToTarget",
        params: { sessionId: "replacement-root-session", targetInfo: rootTarget.targetInfo, waitingForDebugger: false },
      },
    ])
    for (const target of [rootTarget, childTarget, grandchildTarget]) {
      expect(pool.hasSession(client, target.sessionId)).toBe(false)
    }
    for (const alias of aliases) expect(pool.alias(client, alias)).toBeUndefined()
    expect(pool.alias(client, browserAlias)).toEqual(ClientCdpSessionAlias.Browser())
    expect(pool.hasSession(client, "replacement-root-session")).toBe(true)
  })

  it("clears the previous identity when a session id is reused for a different target", () => {
    const { pool, client, events } = setup()
    pool.announce(client, rootTarget)
    pool.announce(client, childTarget)
    const rootAlias = pool.createTargetAlias(client, rootTarget)
    const childAlias = pool.createTargetAlias(client, childTarget)
    const replacement = { ...rootTarget, targetInfo: { ...rootTarget.targetInfo, targetId: "replacement-target" } }
    events.length = 0

    pool.announce(client, replacement)
    pool.announce(client, replacement)

    expect(events.map((event) => [event.method, event.params?.sessionId])).toEqual([
      ["Target.detachedFromTarget", childTarget.sessionId],
      ["Target.detachedFromTarget", rootTarget.sessionId],
      ["Target.attachedToTarget", rootTarget.sessionId],
    ])
    expect(events[1]?.params?.targetId).toBe(rootTarget.targetInfo.targetId)
    expect(events[2]?.params?.targetInfo).toEqual(replacement.targetInfo)
    expect(pool.alias(client, rootAlias)).toBeUndefined()
    expect(pool.alias(client, childAlias)).toBeUndefined()
    expect(pool.hasSession(client, childTarget.sessionId)).toBe(false)
    expect(pool.hasSession(client, rootTarget.sessionId)).toBe(true)
  })

  it("detaches duplicate child target ids on the old parent before re-announcing", () => {
    const { pool, client, events } = setup()
    pool.announce(client, childTarget)
    const alias = pool.createTargetAlias(client, childTarget)
    events.length = 0
    const replacement = { ...childTarget, sessionId: "replacement-child", parentSessionId: "replacement-parent" }

    pool.announce(client, replacement)

    expect(events).toEqual([
      {
        sessionId: rootTarget.sessionId,
        method: "Target.detachedFromTarget",
        params: { sessionId: childTarget.sessionId, targetId: childTarget.targetInfo.targetId },
      },
      {
        sessionId: "replacement-parent",
        method: "Target.attachedToTarget",
        params: { sessionId: "replacement-child", targetInfo: childTarget.targetInfo, waitingForDebugger: false },
      },
    ])
    expect(pool.alias(client, alias)).toBeUndefined()
    expect(pool.hasSession(client, childTarget.sessionId)).toBe(false)
    expect(pool.hasSession(client, replacement.sessionId)).toBe(true)
  })

  it.each([false, true])("detaches a tab's descendants before its root, idempotently (destroyed=%s)", (destroyed) => {
    const { pool, client, events } = setup()
    const other: { events: CdpEvent[] } = { events: [] }
    pool.register(other)
    for (const target of [rootTarget, childTarget, grandchildTarget]) pool.announce(client, target)
    events.length = 0

    pool.detachTab(rootTarget.tabId, { destroyed })
    pool.detachTab(rootTarget.tabId, { destroyed })

    expect(events.map((event) => [event.method, event.params?.targetId])).toEqual([
      ["Target.detachedFromTarget", grandchildTarget.targetInfo.targetId],
      ["Target.detachedFromTarget", childTarget.targetInfo.targetId],
      ...(destroyed ? [["Target.targetDestroyed", rootTarget.targetInfo.targetId]] : []),
      ["Target.detachedFromTarget", rootTarget.targetInfo.targetId],
    ])
    expect(events[0]?.sessionId).toBe(childTarget.sessionId)
    expect(events[1]?.sessionId).toBe(rootTarget.sessionId)
    expect(events.at(-1)?.sessionId).toBeUndefined()
    for (const target of [rootTarget, childTarget, grandchildTarget]) {
      expect(pool.hasSession(client, target.sessionId)).toBe(false)
    }
    expect(other.events).toEqual([])
  })

  it.each([false, true])("detaches a child subtree and its aliases without detaching the root (notify=%s)", (notify) => {
    const { pool, client, events } = setup()
    for (const target of [rootTarget, childTarget, grandchildTarget]) pool.announce(client, target)
    const rootAlias = pool.createTargetAlias(client, rootTarget)
    const childAlias = pool.createTargetAlias(client, childTarget)
    const grandchildAlias = pool.createTargetAlias(client, grandchildTarget)
    events.length = 0

    pool.detachTarget(childTarget, { notify })
    pool.detachTarget(childTarget, { notify })

    expect(events.map((event) => [event.method, event.params?.sessionId])).toEqual(notify ? [
      ["Target.detachedFromTarget", grandchildTarget.sessionId],
      ["Target.detachedFromTarget", childTarget.sessionId],
    ] : [])
    expect(pool.hasSession(client, rootTarget.sessionId)).toBe(true)
    expect(pool.hasSession(client, childTarget.sessionId)).toBe(false)
    expect(pool.hasSession(client, grandchildTarget.sessionId)).toBe(false)
    expect(pool.alias(client, rootAlias)).toBeDefined()
    expect(pool.alias(client, childAlias)).toBeUndefined()
    expect(pool.alias(client, grandchildAlias)).toBeUndefined()
  })

  it("removes an unannounced child alias on target detach", () => {
    const { pool, client, events } = setup()
    const alias = pool.createTargetAlias(client, childTarget)

    pool.detachTarget(childTarget)

    expect(pool.alias(client, alias)).toBeUndefined()
    expect(events).toEqual([])
  })

  it("silently detaches a client-requested alias without detaching the real session", () => {
    const { pool, client, events } = setup()
    pool.announce(client, rootTarget)
    pool.announce(client, childTarget)
    const rootAlias = pool.createTargetAlias(client, rootTarget)
    const childAlias = pool.createTargetAlias(client, childTarget)
    const browserAlias = pool.createBrowserAlias(client)
    events.length = 0

    for (const alias of [rootAlias, childAlias, browserAlias]) {
      pool.detach(client, alias)
      pool.detach(client, alias)
      expect(pool.alias(client, alias)).toBeUndefined()
    }

    expect(pool.hasSession(client, rootTarget.sessionId)).toBe(true)
    expect(pool.hasSession(client, childTarget.sessionId)).toBe(true)
    expect(events).toEqual([])
  })

  it("silently detaches a client-requested real session subtree only for that client", () => {
    const { pool, client, events } = setup()
    const other: { events: CdpEvent[] } = { events: [] }
    pool.register(other)
    const browserAlias = pool.createBrowserAlias(client)
    const aliases = [rootTarget, childTarget, grandchildTarget].map((target) => {
      pool.announce(client, target)
      pool.announce(other, target)
      return pool.createTargetAlias(client, target)
    })
    events.length = 0
    other.events.length = 0

    pool.detach(client, rootTarget.sessionId)
    pool.detach(client, rootTarget.sessionId)

    for (const target of [rootTarget, childTarget, grandchildTarget]) {
      expect(pool.hasSession(client, target.sessionId)).toBe(false)
      expect(pool.hasSession(other, target.sessionId)).toBe(true)
    }
    for (const alias of aliases) expect(pool.alias(client, alias)).toBeUndefined()
    expect(pool.alias(client, browserAlias)).toEqual(ClientCdpSessionAlias.Browser())
    expect(events).toEqual([])
    expect(other.events).toEqual([])
  })

  it("delivers events only to announced visible clients and prunes hidden subtrees", () => {
    const { pool, client, events } = setup()
    const hidden: { events: CdpEvent[] } = { events: [] }
    const unannounced: { events: CdpEvent[] } = { events: [] }
    pool.register(hidden)
    pool.register(unannounced)
    for (const target of [rootTarget, childTarget]) {
      pool.announce(client, target)
      pool.announce(hidden, target)
    }
    const visibleAlias = pool.createTargetAlias(client, childTarget)
    const hiddenAlias = pool.createTargetAlias(hidden, childTarget)
    const browserAlias = pool.createBrowserAlias(hidden)
    events.length = 0
    hidden.events.length = 0
    const event: CdpEvent = { sessionId: childTarget.sessionId, method: "Runtime.executionContextsCleared", params: {} }

    pool.sendToViewers(rootTarget.sessionId, event, (viewer, tabId) => viewer !== hidden && tabId === 7)

    expect(events).toEqual([event])
    expect(unannounced.events).toEqual([])
    expect(hidden.events.map((event) => [event.method, event.params?.sessionId])).toEqual([
      ["Target.detachedFromTarget", childTarget.sessionId],
      ["Target.detachedFromTarget", rootTarget.sessionId],
    ])
    expect(pool.hasSession(hidden, rootTarget.sessionId)).toBe(false)
    expect(pool.hasSession(hidden, childTarget.sessionId)).toBe(false)
    expect(pool.alias(hidden, hiddenAlias)).toBeUndefined()
    expect(pool.alias(hidden, browserAlias)).toEqual(ClientCdpSessionAlias.Browser())
    expect(pool.alias(client, visibleAlias)).toBeDefined()

    hidden.events.length = 0
    pool.sendToViewers(rootTarget.sessionId, event, () => true)
    expect(hidden.events).toEqual([])
    expect(unannounced.events).toEqual([])
    expect(events).toEqual([event, event])
  })
})
