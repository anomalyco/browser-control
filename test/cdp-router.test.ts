import { describe, expect, it } from "vitest"
import { CdpClientPool } from "../src/cdp-client-pool.ts"
import { CdpRouter, isRootRoutableBrowserContextMethod } from "../src/cdp-router.ts"
import type { CdpEvent } from "../src/protocol.ts"
import type { ChildTarget, ConnectedTarget } from "../src/relay-types.ts"
import { TargetRegistry } from "../src/target-registry.ts"

function root(options: {
  readonly tabId: number
  readonly sessionId: string
  readonly targetId: string
  readonly browserControlSessionId?: string
  readonly owner?: "relay" | "user"
}): ConnectedTarget {
  return {
    tabId: options.tabId,
    sessionId: options.sessionId,
    targetInfo: {
      targetId: options.targetId,
      type: "page",
      title: options.targetId,
      url: `https://example.com/${options.targetId}`,
      attached: true,
      canAccessOpener: false,
    },
    owner: options.owner ?? "relay",
    ...(options.browserControlSessionId ? { browserControlSessionId: options.browserControlSessionId } : {}),
  }
}

function setup() {
  const events: { client: object; event: CdpEvent }[] = []
  const clients = new CdpClientPool<object>((client, event) => events.push({ client, event }))
  const registry = new TargetRegistry()
  const router = new CdpRouter(clients, registry)
  return { clients, registry, router, events }
}

describe("CdpRouter", () => {
  it("does not reinterpret a disconnected client as a raw client", () => {
    const { clients, registry, router } = setup()
    const client = {}
    clients.register(client)
    registry.addRootTarget(root({ tabId: 1, sessionId: "root", targetId: "target", owner: "user" }))
    expect(router.session(client, "root")).toBeDefined()
    clients.unregister(client)
    expect(router.session(client, "root")).toBeUndefined()
    expect(router.visibleTargetInfos(client)).toEqual([])
  })
  it("classifies browser-context methods that Chrome routes through a root tab", () => {
    for (const method of [
      "Browser.grantPermissions",
      "Browser.resetPermissions",
      "Storage.getCookies",
      "Storage.setCookies",
      "Storage.clearCookies",
    ]) {
      expect(isRootRoutableBrowserContextMethod(method)).toBe(true)
    }
    expect(isRootRoutableBrowserContextMethod("Runtime.evaluate")).toBe(false)
  })

  it("prefers a session-owned root for a named client", () => {
    const { clients, registry, router } = setup()
    const client = {}
    clients.register(client, "session-a")
    const owned = root({
      tabId: 1,
      sessionId: "owned-root",
      targetId: "owned-target",
      browserControlSessionId: "session-a",
    })
    registry.addRootTarget(owned)
    registry.addRootTarget(root({
      tabId: 2,
      sessionId: "unrelated-root",
      targetId: "unrelated-target",
      owner: "user",
    }))

    expect(router.preferredRoot(client)).toBe(owned)

    registry.addRootTarget(root({
      tabId: 3,
      sessionId: "second-owned-root",
      targetId: "second-owned-target",
      browserControlSessionId: "session-a",
    }))
    expect(router.preferredRoot(client)).toBe(owned)
  })

  it("recognizes browser session aliases", () => {
    const { clients, router } = setup()
    const client = {}
    clients.register(client, "session-a")
    const browserAlias = clients.createBrowserAlias(client)

    expect(router.isBrowserAlias(client, browserAlias)).toBe(true)
    expect(router.isBrowserAlias(client, "unknown-session")).toBe(false)
  })

  it("does not fall through from an empty named session to an unrelated root", () => {
    const { clients, registry, router } = setup()
    const client = {}
    clients.register(client, "session-a")
    registry.addRootTarget(root({
      tabId: 1,
      sessionId: "unrelated-root",
      targetId: "unrelated-target",
    }))

    expect(router.visibleRoots(client)).toHaveLength(1)
    expect(router.preferredRoot(client)).toBeUndefined()
  })

  it("selects exactly one visible root for a raw client", () => {
    const { clients, registry, router } = setup()
    const client = {}
    clients.register(client)
    const visible = root({ tabId: 1, sessionId: "root-1", targetId: "target-1" })
    registry.addRootTarget(visible)

    expect(router.preferredRoot(client)).toBe(visible)

    registry.addRootTarget(root({ tabId: 2, sessionId: "root-2", targetId: "target-2" }))
    expect(router.preferredRoot(client)).toBeUndefined()
  })

  it("resolves only targets visible to the client", () => {
    const { clients, registry, router } = setup()
    const owner = {}
    const other = {}
    clients.register(owner, "session-a")
    clients.register(other, "session-b")
    const target = root({
      tabId: 1,
      sessionId: "bc-tab-1",
      targetId: "target-1",
      browserControlSessionId: "session-a",
    })
    registry.addRootTarget(target)

    expect(router.targetForAttach(owner, "target-1")).toBe(target)
    expect(router.targetInfo(owner, { sessionId: "bc-tab-1" })).toBe(target)
    expect(router.targetForAttach(other, "target-1")).toBeUndefined()
    expect(router.targetInfo(other, { targetId: "target-1" })).toBeUndefined()
  })

  it("routes root aliases without a Chrome session and child aliases with one", () => {
    const { clients, registry, router } = setup()
    const client = {}
    clients.register(client)
    const target = root({ tabId: 1, sessionId: "bc-tab-1", targetId: "target-1" })
    registry.addRootTarget(target)
    const child: ChildTarget = {
      tabId: 1,
      sessionId: "child-session",
      parentSessionId: target.sessionId,
      targetInfo: { ...target.targetInfo, targetId: "child-target", type: "iframe" },
      waitingForDebugger: false,
    }
    registry.addChildTarget(child)
    const rootAlias = clients.createTargetAlias(client, target)
    const childAlias = clients.createTargetAlias(client, child)

    expect(router.session(client, rootAlias)).toEqual({ tabId: 1, rootSessionId: "bc-tab-1" })
    expect(router.session(client, childAlias)).toEqual({
      tabId: 1,
      rootSessionId: "bc-tab-1",
      chromeSessionId: "child-session",
    })
  })

  it("does not resolve identity-free or hidden session routes", () => {
    const { clients, registry, router } = setup()
    const client = {}
    clients.register(client, "session-b")
    registry.addRootTarget(root({
      tabId: 1,
      sessionId: "bc-tab-1",
      targetId: "target-1",
      browserControlSessionId: "session-a",
    }))

    expect(router.targetInfo(client, {})).toBeUndefined()
    expect(router.session(client, "bc-tab-1")).toBeUndefined()
    expect(router.rootForSession(client, "bc-tab-1")).toBeUndefined()
  })

  it("rejects stale aliases and children without a live root", () => {
    const { clients, registry, router } = setup()
    const client = {}
    clients.register(client)
    const target = root({ tabId: 1, sessionId: "bc-tab-1", targetId: "target-1" })
    registry.addRootTarget(target)
    const alias = clients.createTargetAlias(client, target)

    registry.addRootTarget(root({ tabId: 1, sessionId: "bc-tab-2", targetId: "target-2" }))
    expect(router.session(client, alias)).toBeUndefined()

    registry.detachRootTargetState(1)
    const orphan: ChildTarget = {
      tabId: 1,
      sessionId: "orphan-session",
      parentSessionId: "bc-tab-missing",
      targetInfo: { ...target.targetInfo, targetId: "orphan-target", type: "iframe" },
      waitingForDebugger: false,
    }
    registry.addChildTarget(orphan)
    expect(router.targetForAttach(client, "orphan-target")).toBeUndefined()
    expect(router.session(client, "orphan-session")).toBeUndefined()
  })

  it("does not fall through from an explicit hidden target to a visible session", () => {
    const { clients, registry, router } = setup()
    const client = {}
    clients.register(client, "session-a")
    const visible = root({ tabId: 1, sessionId: "visible-session", targetId: "visible-target", browserControlSessionId: "session-a" })
    const hidden = root({ tabId: 2, sessionId: "hidden-session", targetId: "hidden-target", browserControlSessionId: "session-b" })
    registry.addRootTarget(visible)
    registry.addRootTarget(hidden)

    expect(router.targetInfo(client, {
      targetId: "hidden-target",
      sessionId: "visible-session",
    })).toBeUndefined()
  })

  it("prunes aliases when ownership hides a tab even without an announcement", () => {
    const { clients, registry, router, events } = setup()
    const client = {}
    clients.register(client, "session-a")
    const rawTarget = root({ tabId: 1, sessionId: "raw-session", targetId: "raw-target" })
    registry.addRootTarget(rawTarget)
    const alias = clients.createTargetAlias(client, rawTarget)
    const browserAlias = clients.createBrowserAlias(client)
    registry.addRootTarget(root({
      tabId: 2,
      sessionId: "owned-session",
      targetId: "owned-target",
      browserControlSessionId: "session-a",
    }))

    router.reconcileClient(client)

    expect(clients.alias(client, alias)).toBeUndefined()
    expect(router.isBrowserAlias(client, browserAlias)).toBe(true)
    expect(events).toEqual([])
  })

  it("reconciles announcements and aliases across ownership reservation and rollback", () => {
    const { clients, registry, router, events } = setup()
    const owner = { name: "owner" }
    const other = { name: "other" }
    const raw = { name: "raw" }
    clients.register(owner, "session-a")
    clients.register(other, "session-b")
    clients.register(raw)
    const target = root({ tabId: 1, sessionId: "user-root", targetId: "user-target", owner: "user" })
    const child: ChildTarget = {
      tabId: 1,
      sessionId: "user-child",
      parentSessionId: target.sessionId,
      targetInfo: { ...target.targetInfo, targetId: "child-target", type: "iframe" },
      waitingForDebugger: false,
    }
    const rawTarget = root({ tabId: 2, sessionId: "raw-root", targetId: "raw-target" })
    registry.addRootTarget(target)
    registry.addRootTarget(rawTarget)
    registry.addChildTarget(child)
    for (const client of clients) {
      expect(router.canSeeTarget(client, target)).toBe(true)
      clients.announce(client, target)
      clients.announce(client, child)
    }
    const ownerAlias = clients.createTargetAlias(owner, target)
    const otherAlias = clients.createTargetAlias(other, target)
    const otherChildAlias = clients.createTargetAlias(other, child)
    const rawAlias = clients.createTargetAlias(raw, target)
    const aliasOnly = clients.createTargetAlias(owner, rawTarget)
    const browserAlias = clients.createBrowserAlias(other)
    events.length = 0

    const reservation = registry.reserveTargetOwnership(target.targetInfo.targetId, "session-a")
    for (const client of clients) router.reconcileClient(client)

    const detached: CdpEvent[] = [
      {
        sessionId: target.sessionId,
        method: "Target.detachedFromTarget",
        params: { sessionId: child.sessionId, targetId: child.targetInfo.targetId },
      },
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: target.sessionId, targetId: target.targetInfo.targetId },
      },
    ]
    expect(events).toEqual([
      ...detached.map((event) => ({ client: other, event })),
      ...detached.map((event) => ({ client: raw, event })),
    ])
    for (const client of [other, raw]) {
      expect(router.canSeeTab(client, target.tabId)).toBe(false)
      expect(clients.hasSession(client, target.sessionId)).toBe(false)
      expect(clients.hasSession(client, child.sessionId)).toBe(false)
      expect(router.session(client, target.sessionId)).toBeUndefined()
      expect(router.targetForAttach(client, child.targetInfo.targetId)).toBeUndefined()
    }
    expect(clients.alias(other, otherAlias)).toBeUndefined()
    expect(clients.alias(other, otherChildAlias)).toBeUndefined()
    expect(clients.alias(raw, rawAlias)).toBeUndefined()
    expect(clients.alias(owner, aliasOnly)).toBeUndefined()
    expect(router.isBrowserAlias(other, browserAlias)).toBe(true)
    expect(router.session(owner, ownerAlias)).toEqual({ tabId: 1, rootSessionId: target.sessionId })
    expect(clients.hasSession(owner, child.sessionId)).toBe(true)

    events.length = 0
    registry.rollbackTargetOwnership(reservation)
    for (const client of clients) router.reconcileClient(client)
    expect(events).toEqual([])
    for (const client of clients) expect(router.canSeeTab(client, target.tabId)).toBe(true)
    expect(router.canSeeTab(owner, rawTarget.tabId)).toBe(true)
    expect(clients.alias(owner, aliasOnly)).toBeUndefined()

    const event: CdpEvent = { sessionId: child.sessionId, method: "Runtime.executionContextsCleared", params: {} }
    clients.sendToViewers(target.sessionId, event, (client, tabId) => router.canSeeTab(client, tabId))
    expect(events).toEqual([{ client: owner, event }])

    events.length = 0
    for (const client of [other, raw]) {
      clients.announce(client, target)
      clients.announce(client, child)
      expect(clients.hasSession(client, target.sessionId)).toBe(true)
      expect(clients.hasSession(client, child.sessionId)).toBe(true)
    }
    expect(events.map(({ event }) => event.method)).toEqual([
      "Target.attachedToTarget",
      "Target.attachedToTarget",
      "Target.attachedToTarget",
      "Target.attachedToTarget",
    ])
    expect(router.session(other, otherAlias)).toBeUndefined()
    expect(router.session(other, otherChildAlias)).toBeUndefined()
    expect(router.session(raw, rawAlias)).toBeUndefined()
    const newAlias = clients.createTargetAlias(other, child)
    expect(router.session(other, newAlias)).toEqual({ tabId: 1, rootSessionId: target.sessionId, chromeSessionId: child.sessionId })
  })

  it("keeps real session routes alive after a client detaches only its alias", () => {
    const { clients, registry, router, events } = setup()
    const client = {}
    clients.register(client)
    const target = root({ tabId: 1, sessionId: "bc-tab-1", targetId: "target-1" })
    registry.addRootTarget(target)
    clients.announce(client, target)
    const alias = clients.createTargetAlias(client, target)
    events.length = 0

    clients.detach(client, alias)

    expect(router.session(client, alias)).toBeUndefined()
    expect(router.session(client, target.sessionId)).toEqual({ tabId: 1, rootSessionId: target.sessionId })
    expect(registry.getRootTargetByTabId(1)).toBe(target)
    expect(clients.hasSession(client, target.sessionId)).toBe(true)
    expect(events).toEqual([])
  })

  it("lists only visible roots and exposed children", () => {
    const { clients, registry, router } = setup()
    const client = {}
    clients.register(client, "session-a")
    const visible = root({ tabId: 1, sessionId: "bc-tab-1", targetId: "target-1", browserControlSessionId: "session-a" })
    const hidden = root({ tabId: 2, sessionId: "bc-tab-2", targetId: "target-2", browserControlSessionId: "session-b" })
    registry.addRootTarget(visible)
    registry.addRootTarget(hidden)
    registry.addChildTarget({
      tabId: 1,
      sessionId: "child-visible",
      parentSessionId: visible.sessionId,
      targetInfo: { ...visible.targetInfo, targetId: "child-visible-target", type: "worker" },
      waitingForDebugger: false,
    })
    registry.addChildTarget({
      tabId: 1,
      sessionId: "child-held",
      parentSessionId: visible.sessionId,
      targetInfo: { ...visible.targetInfo, targetId: "child-held-target", type: "page", url: "" },
      waitingForDebugger: false,
    })

    expect(router.visibleTargetInfos(client).map((target) => target.targetId)).toEqual(["target-1", "child-visible-target"])
  })
})
