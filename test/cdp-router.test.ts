import { describe, expect, it } from "vitest"
import { CdpClientPool } from "../src/cdp-client-pool.ts"
import { CdpRouter } from "../src/cdp-router.ts"
import type { ConnectedTarget } from "../src/relay-types.ts"
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
  const clients = new CdpClientPool<object>()
  const registry = new TargetRegistry()
  const router = new CdpRouter(clients, registry)
  return { clients, registry, router }
}

describe("CdpRouter", () => {
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
    const child = {
      tabId: 1,
      sessionId: "child-session",
      parentSessionId: target.sessionId,
      targetInfo: { ...target.targetInfo, targetId: "child-target", type: "iframe" as const },
      waitingForDebugger: false,
    }
    registry.addChildTarget(child)
    const rootAlias = clients.createTargetAlias(client, target, target.sessionId)
    const childAlias = clients.createTargetAlias(client, child, target.sessionId)

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
    const alias = clients.createTargetAlias(client, target, target.sessionId)

    registry.addRootTarget(root({ tabId: 1, sessionId: "bc-tab-2", targetId: "target-2" }))
    expect(router.session(client, alias)).toBeUndefined()

    registry.detachRootTargetState(1)
    const orphan = {
      tabId: 1,
      sessionId: "orphan-session",
      parentSessionId: "bc-tab-missing",
      targetInfo: { ...target.targetInfo, targetId: "orphan-target", type: "iframe" as const },
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
    const { clients, registry, router } = setup()
    const client = {}
    clients.register(client, "session-a")
    const rawTarget = root({ tabId: 1, sessionId: "raw-session", targetId: "raw-target" })
    registry.addRootTarget(rawTarget)
    const alias = clients.createTargetAlias(client, rawTarget, rawTarget.sessionId)
    registry.addRootTarget(root({
      tabId: 2,
      sessionId: "owned-session",
      targetId: "owned-target",
      browserControlSessionId: "session-a",
    }))

    router.pruneInvisibleAliases(client, [rawTarget.tabId])

    expect(clients.alias(client, alias)).toBeUndefined()
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
